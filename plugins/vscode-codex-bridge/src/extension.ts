import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs, Dirent } from 'node:fs';
import {
  composeOutboundMessage,
  DEFAULT_STAGE_DONE_MARKERS,
  isStageDone,
  sanitizedRelayPayload
} from './core/bridgeProtocol';
import { resolveClaudeExecutable } from './core/claudeExecutable';
import { resolveCodexExecutable } from './core/codexExecutable';

type Side = 'A' | 'B';
type Role = 'user' | 'assistant' | 'system';
type CliTool = 'codex' | 'claude' | 'remote';
type LocalCliTool = 'codex' | 'claude';
type RemoteMode = 'off' | 'host' | 'client';
type ChatChannel = 'bridge' | 'remote';
type ChatPeer = 'local' | 'remote';

type ChatItem = {
  id: string;
  time: number;
  side?: Side;
  role: Role;
  text: string;
  turnId?: string;
  channel?: ChatChannel;
  peer?: ChatPeer;
};

type SessionOption = {
  id: string;
  displayLabel: string;
  cwd?: string;
  tool: CliTool;
};

type BridgeState = {
  projectAPath: string;
  projectBPath: string;
  toolA: CliTool;
  toolB: CliTool;
  sessionA: string;
  sessionB: string;
  projectOptions: string[];
  sessionOptions: SessionOption[];
  autoRelayEnabled: boolean;
  stopOnStageDone: boolean;
  chatControlExpanded: boolean;
  stageDoneMarkers: string;
  chatItems: ChatItem[];
  isSendingA: boolean;
  isSendingB: boolean;
  remoteMode: RemoteMode;
  remoteUrl: string;
  remoteToken: string;
  remoteListenPort: number;
  remoteExportSide: Side;
  remoteStatus: string;
  remoteHubUrl: string;
  remotePeerId: string;
  remoteDeviceName: string;
  remotePeerOptions: Array<{ id: string; label: string }>;
  remotePeerLinked: boolean;
  remoteConnectionSnippet: string;
  remoteConnectivity: 'idle' | 'ok' | 'error' | 'checking';
  remoteTokenHint: string;
  remoteTargetTool: LocalCliTool;
  remoteTargetProjectPath: string;
  remoteTargetSessionId: string;
  remoteTargetLabel: string;
  remoteAutoRelayEnabled: boolean;
  availableHostTools: LocalCliTool[];
  remoteHostTool: LocalCliTool;
  remoteHostProjectPath: string;
  remoteHostSessionId: string;
};

type PendingTurn = {
  onDelta: (chunk: string) => void;
  onReasoning: (turnId: string, summaryIndex: number, delta: string) => void;
  onDone: (result: { ok: true; text: string } | { ok: false; message: string }) => void;
};

type SendContext = {
  channel?: ChatChannel;
  userPeer?: ChatPeer;
  assistantPeer?: ChatPeer;
};

interface BridgeWorker {
  send(
    message: string,
    cwd: string,
    resumeThreadId: string | undefined,
    onDelta: (chunk: string) => void,
    onReasoning: (turnId: string, summaryIndex: number, delta: string) => void,
    onDone: (result: { ok: true; text: string } | { ok: false; message: string }) => void
  ): Promise<void>;
  interrupt(): void;
  shutdown(): void;
}

class RemoteInvokeServer {
  private server: http.Server | null = null;
  private currentPort = 0;
  private currentToken = '';

  constructor(
    private readonly onInvoke: (payload: {
      text: string;
      onDelta: (delta: string) => void;
      onDone: (text: string) => void;
      targetTool?: LocalCliTool;
      targetProjectPath?: string;
      targetSessionId?: string;
      sourceInterruptUrl?: string;
      sourceNodeId?: string;
    }) => Promise<{ ok: true; text: string } | { ok: false; message: string }>,
    private readonly onInterrupt: () => Promise<void>
  ) {}

  async start(port: number, token: string): Promise<number> {
    if (this.server && this.currentPort === port && this.currentToken === token) {
      return this.currentPort;
    }
    await this.stop();

    this.currentToken = token;

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const sendJson = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };

        if (!req.url) {
          sendJson(404, { ok: false, message: 'not found' });
          return;
        }

        if (req.method === 'GET' && req.url === '/health') {
          sendJson(200, { ok: true, port: this.currentPort });
          return;
        }

        if (req.method === 'POST' && req.url === '/interrupt') {
          const auth = req.headers['x-bridge-token'];
          if (auth !== this.currentToken) {
            sendJson(401, { ok: false, message: 'invalid token' });
            return;
          }
          try {
            await this.onInterrupt();
            sendJson(200, { ok: true });
          } catch (err: any) {
            sendJson(500, { ok: false, message: err?.message || 'interrupt failed' });
          }
          return;
        }

        if (req.method !== 'POST' || req.url !== '/invoke') {
          sendJson(404, { ok: false, message: 'not found' });
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const payload = raw ? JSON.parse(raw) : {};
            if (payload?.token !== this.currentToken) {
              sendJson(401, { ok: false, message: 'invalid token' });
              return;
            }
            if (typeof payload?.text !== 'string' || !payload.text.trim()) {
              sendJson(400, { ok: false, message: 'text required' });
              return;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');

            let finished = false;
            let aggregate = '';
            const writeStreamLine = (body: unknown) => {
              if (res.writableEnded) return;
              res.write(JSON.stringify(body) + '\n');
            };

            const result = await this.onInvoke({
              text: payload.text,
              targetTool: payload.targetTool,
              targetProjectPath: payload.targetProjectPath,
              targetSessionId: payload.targetSessionId,
              sourceInterruptUrl: typeof payload.sourceInterruptUrl === 'string' ? payload.sourceInterruptUrl : undefined,
              sourceNodeId: typeof payload.sourceNodeId === 'string' ? payload.sourceNodeId : undefined,
              onDelta: (delta) => {
                if (!delta || finished) return;
                aggregate += delta;
                writeStreamLine({ type: 'delta', delta });
              },
              onDone: (text) => {
                if (finished) return;
                finished = true;
                writeStreamLine({ type: 'done', text: text || aggregate || '(空回复)' });
                res.end();
              }
            });

            if (finished) return;
            if (result.ok) {
              writeStreamLine({ type: 'done', text: result.text || aggregate || '(空回复)' });
            } else {
              res.statusCode = 500;
              writeStreamLine({ type: 'error', message: result.message });
            }
            res.end();
          } catch (err: any) {
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
            }
            res.end(JSON.stringify({ type: 'error', message: err?.message || 'invoke failed' }) + '\n');
          }
        });
      });

      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        this.server = server;
        const address = server.address();
        this.currentPort =
          typeof address === 'object' && address && typeof address.port === 'number' ? address.port : port;
        resolve();
      });
    });

    return this.currentPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.currentPort = 0;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

class RemoteWorker implements BridgeWorker {
  private abortController: AbortController | null = null;

  constructor(
    private readonly getConfig: () => {
      mode: RemoteMode;
      url: string;
      token: string;
      hubUrl: string;
      peerId: string;
      targetTool: LocalCliTool;
      targetProjectPath: string;
      targetSessionId: string;
      sourceInterruptUrl?: string;
      sourceNodeId?: string;
    }
  ) {}

  async send(
    message: string,
    _cwd: string,
    _resumeThreadId: string | undefined,
    onDelta: (chunk: string) => void,
    _onReasoning: (turnId: string, summaryIndex: number, delta: string) => void,
    onDone: (result: { ok: true; text: string } | { ok: false; message: string }) => void
  ): Promise<void> {
    const config = this.getConfig();
    if (config.mode !== 'client') {
      onDone({ ok: false, message: '远端模式未切换到客户端' });
      return;
    }
    const rawUrl = config.url.trim();
    const token = config.token.trim();
    const hubUrl = config.hubUrl.trim();
    const peerId = config.peerId.trim();
    if (!rawUrl && !(hubUrl && peerId)) {
      onDone({ ok: false, message: '远端 URL 为空' });
      return;
    }
    if (!token) {
      onDone({ ok: false, message: '远端 Token 为空' });
      return;
    }

    try {
      this.abortController = new AbortController();
      const request = hubUrl && peerId
        ? {
            url: `${hubUrl.replace(/\/$/, '')}/relay/invoke`,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token,
              targetNodeId: peerId,
              text: message,
              stream: true,
              targetTool: config.targetTool,
              targetProjectPath: config.targetProjectPath,
              targetSessionId: config.targetSessionId,
              sourceNodeId: config.sourceNodeId
            })
          }
        : {
            url: RemoteWorker.resolveInvokeUrl(rawUrl),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token,
              text: message,
              stream: true,
              targetTool: config.targetTool,
              targetProjectPath: config.targetProjectPath,
              targetSessionId: config.targetSessionId,
              sourceInterruptUrl: config.sourceInterruptUrl
            })
          };
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: this.abortController.signal
      });
      if (!response.ok) {
        const text = await response.text();
        this.abortController = null;
        onDone({ ok: false, message: text || `远端调用失败 (${response.status})` });
        return;
      }
      await RemoteWorker.consumeStreamingResponse(response, onDelta, onDone);
      this.abortController = null;
    } catch (err: any) {
      this.abortController = null;
      onDone({ ok: false, message: err?.message || '远端调用失败' });
    }
  }

  interrupt(): void {
    this.abortController?.abort();
    this.abortController = null;

    const config = this.getConfig();
    if (config.mode !== 'client' || !config.token.trim()) return;
    const hubUrl = config.hubUrl.trim();
    const peerId = config.peerId.trim();
    const directUrl = config.url.trim();
    const interruptUrl = hubUrl && peerId
      ? `${hubUrl.replace(/\/$/, '')}/relay/interrupt`
      : RemoteWorker.resolveInterruptUrl(directUrl);
    const body = hubUrl && peerId ? JSON.stringify({ token: config.token.trim(), targetNodeId: peerId }) : undefined;
    fetch(interruptUrl, {
      method: 'POST',
      headers: hubUrl && peerId
        ? { 'Content-Type': 'application/json' }
        : { 'x-bridge-token': config.token.trim() },
      body
    }).catch(() => undefined);
  }

  shutdown(): void {}

  static async consumeStreamingResponse(
    response: Response,
    onDelta: (chunk: string) => void,
    onDone: (result: { ok: true; text: string } | { ok: false; message: string }) => void
  ): Promise<void> {
    const contentType = response.headers.get('content-type') || '';
    if (!response.body) {
      const text = await response.text();
      onDelta(text);
      onDone({ ok: true, text });
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let aggregate = '';
    const reader = response.body.getReader();

    const handleJsonObject = (payload: any): boolean => {
      const parsed = RemoteWorker.extractStreamingPayload(payload);
      if (parsed.type === 'delta') {
        aggregate += parsed.text;
        onDelta(parsed.text);
        return false;
      }
      if (parsed.type === 'done') {
        const finalText = parsed.text || aggregate || '(空回复)';
        onDone({ ok: true, text: finalText });
        return true;
      }
      if (parsed.type === 'error') {
        onDone({ ok: false, message: parsed.text || '远端流失败' });
        return true;
      }
      return false;
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      if (contentType.includes('text/event-stream')) {
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const eventBlock = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = eventBlock
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) continue;
          const payloadText = dataLines.join('\n');
          if (payloadText === '[DONE]') {
            onDone({ ok: true, text: aggregate || '(空回复)' });
            return;
          }
          try {
            if (handleJsonObject(JSON.parse(payloadText))) return;
          } catch {
            aggregate += payloadText;
            onDelta(payloadText);
          }
        }
      } else {
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            if (handleJsonObject(JSON.parse(line))) return;
          } catch {
            aggregate += line;
            onDelta(line);
          }
        }
      }

      if (done) break;
    }

    const tail = buffer.trim();
    if (tail) {
      try {
        if (handleJsonObject(JSON.parse(tail))) return;
      } catch {
        aggregate += tail;
        onDelta(tail);
      }
    }

    if (contentType.includes('application/json') && aggregate.trim() === '') {
      try {
        const parsed = JSON.parse(tail || '{}');
        const result = RemoteWorker.extractStreamingPayload(parsed);
        if (result.type === 'error') {
          onDone({ ok: false, message: result.text || '远端返回错误' });
          return;
        }
        const text = result.text || aggregate || '(空回复)';
        if (text && text !== aggregate) onDelta(text);
        onDone({ ok: true, text });
        return;
      } catch {}
    }

    onDone({ ok: true, text: aggregate || '(空回复)' });
  }

  static extractStreamingPayload(payload: any): { type: 'delta' | 'done' | 'error' | 'ignore'; text: string } {
    if (!payload || typeof payload !== 'object') {
      return { type: 'ignore', text: '' };
    }

    if (payload.type === 'delta' && typeof payload.delta === 'string') {
      return { type: 'delta', text: payload.delta };
    }
    if (payload.type === 'done') {
      return { type: 'done', text: typeof payload.text === 'string' ? payload.text : '' };
    }
    if (payload.type === 'error') {
      return { type: 'error', text: typeof payload.message === 'string' ? payload.message : '' };
    }
    if (payload.ok === true && typeof payload.text === 'string') {
      return { type: 'done', text: payload.text };
    }
    if (payload.ok === false) {
      return { type: 'error', text: typeof payload.message === 'string' ? payload.message : '' };
    }
    if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      return { type: 'delta', text: payload.delta };
    }
    if (payload.type === 'response.completed') {
      return { type: 'done', text: '' };
    }
    if (Array.isArray(payload.choices)) {
      const delta = payload.choices
        .map((choice: any) => choice?.delta?.content || choice?.message?.content || '')
        .filter(Boolean)
        .join('');
      if (delta) {
        return { type: payload.choices.some((choice: any) => choice?.delta?.content) ? 'delta' : 'done', text: delta };
      }
    }
    if (Array.isArray(payload.content)) {
      const text = payload.content
        .map((item: any) => item?.text || '')
        .filter(Boolean)
        .join('');
      if (text) return { type: 'done', text };
    }
    if (typeof payload.result === 'string') {
      return { type: 'done', text: payload.result };
    }
    return { type: 'ignore', text: '' };
  }

  static resolveInterruptUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim().replace(/\/$/, '');
    if (!trimmed) return '/interrupt';
    if (trimmed.endsWith('/interrupt')) return trimmed;
    if (trimmed.endsWith('/invoke')) return trimmed.slice(0, -'/invoke'.length) + '/interrupt';
    return `${trimmed}/interrupt`;
  }

  static resolveInvokeUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim().replace(/\/$/, '');
    if (!trimmed) return '/invoke';
    if (trimmed.endsWith('/invoke')) return trimmed;
    if (trimmed.endsWith('/interrupt')) return trimmed.slice(0, -'/interrupt'.length) + '/invoke';
    return `${trimmed}/invoke`;
  }
}

class CodexWorker implements BridgeWorker {
  private static timeoutForMethod(method: string): number {
    switch (method) {
      case 'initialize':
        return 45_000;
      case 'thread/start':
      case 'thread/resume':
        return 25_000;
      case 'turn/start':
        return 20_000;
      case 'turn/interrupt':
        return 5_000;
      default:
        return 20_000;
    }
  }
  private process: ChildProcessWithoutNullStreams | null = null;
  private outBuffer = '';
  private nextRequestId = 1;
  private pending = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private configuredCwd: string | null = null;
  private configuredResumeId: string | null = null;
  private streamingText = '';
  private stderrText = '';
  private activeTurn: PendingTurn | null = null;

  async send(
    message: string,
    cwd: string,
    resumeThreadId: string | undefined,
    onDelta: (chunk: string) => void,
    onReasoning: (turnId: string, summaryIndex: number, delta: string) => void,
    onDone: (result: { ok: true; text: string } | { ok: false; message: string }) => void
  ): Promise<void> {
    try {
      await this.ensureReady(cwd, resumeThreadId);
      this.startTurn(message, { onDelta, onReasoning, onDone });
    } catch (err: any) {
      onDone({ ok: false, message: err?.message || 'worker 初始化失败' });
    }
  }

  interrupt(): void {
    if (!this.threadId || !this.activeTurnId) return;
    this.sendRequest('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeTurnId
    }).catch(() => undefined);
  }

  shutdown(): void {
    this.cleanupProcess();
    if (this.activeTurn) {
      const done = this.activeTurn.onDone;
      this.activeTurn = null;
      done({ ok: false, message: 'Codex worker 已终止' });
    }
  }

  private async ensureReady(cwd: string, resumeThreadId?: string): Promise<void> {
    const normalizedResume = (resumeThreadId || '').trim() || null;
    if (
      this.process &&
      this.threadId &&
      this.configuredCwd === cwd &&
      this.configuredResumeId === normalizedResume
    ) {
      return;
    }

    this.cleanupProcess();
    this.threadId = null;
    this.activeTurnId = null;
    this.configuredCwd = cwd;
    this.configuredResumeId = normalizedResume;

    await this.startInitializedProcess();

    if (normalizedResume) {
      const result = await this.sendRequest('thread/resume', {
        threadId: normalizedResume,
        cwd,
        approvalPolicy: 'never',
        sandbox: 'workspace-write'
      });
      this.threadId = this.extractThreadId(result) || normalizedResume;
      return;
    }

    const result = await this.sendRequest('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write'
    });

    const tid = this.extractThreadId(result);
    if (!tid) throw new Error('thread/start 未返回 thread.id');
    this.threadId = tid;
  }

  private startTurn(message: string, turn: PendingTurn): void {
    if (!this.threadId) {
      turn.onDone({ ok: false, message: 'thread 未初始化' });
      return;
    }
    if (this.activeTurn) {
      turn.onDone({ ok: false, message: '当前已有进行中的 turn' });
      return;
    }

    this.streamingText = '';
    this.activeTurn = turn;
    this.activeTurnId = null;

    this.sendRequest('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: message }]
    }).catch((err: any) => {
      this.failTurn(err?.message || 'turn/start 失败');
    });
  }

  private startProcess(): void {
    const codexExec = resolveCodexExecutable();
    const child = spawn(codexExec, ['app-server', '--listen', 'stdio://'], {
      stdio: 'pipe'
    });
    this.stderrText = '';

    child.stdout.on('data', (chunk: Buffer) => {
      this.outBuffer += chunk.toString('utf8');
      while (true) {
        const idx = this.outBuffer.indexOf('\n');
        if (idx < 0) break;
        const line = this.outBuffer.slice(0, idx).trim();
        this.outBuffer = this.outBuffer.slice(idx + 1);
        if (!line) continue;
        this.handleJsonLine(line);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrText += chunk.toString('utf8');
    });

    child.on('exit', (code, signal) => {
      const exitMessage = this.buildExitMessage(code, signal);
      this.cleanupProcess(exitMessage);
      this.failTurn(exitMessage);
    });

    child.on('error', (err) => {
      this.cleanupProcess(err.message || 'Codex worker 启动失败');
      this.failTurn(err.message || 'Codex worker 启动失败');
    });

    this.process = child;
  }

  private async startInitializedProcess(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.startProcess();
      try {
        await this.sendRequest('initialize', {
          clientInfo: { name: 'agent-bridge-vscode', version: '0.1.1' },
          capabilities: { experimentalApi: true }
        });
        return;
      } catch (err) {
        lastError = err;
        this.cleanupProcess();
      }
    }
    throw lastError instanceof Error ? lastError : new Error('initialize 失败');
  }

  private cleanupProcess(reason?: string): void {
    if (this.process) {
      this.process.stdout.removeAllListeners();
      this.process.removeAllListeners();
      if (!this.process.killed) {
        this.process.kill();
      }
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      if (reason) {
        pending.reject(new Error(reason));
      }
    }
    this.process = null;
    this.pending.clear();
    this.outBuffer = '';
    this.stderrText = '';
  }

  private sendRequest(method: string, params: any): Promise<any> {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error('app-server stdin 不可用'));
    }

    const id = String(this.nextRequestId++);
    const payload = { jsonrpc: '2.0', id: Number(id), method, params };

    return new Promise((resolve, reject) => {
      const timeoutMs = CodexWorker.timeoutForMethod(method);
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timeout
      });

      try {
        this.process?.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err: any) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(err?.message || '发送请求失败'));
      }
    });
  }

  private handleJsonLine(line: string): void {
    let dict: any;
    try {
      dict = JSON.parse(line);
    } catch {
      return;
    }

    if (dict.id !== undefined) {
      const key = String(dict.id);
      const pending = this.pending.get(key);
      this.pending.delete(key);
      if (!pending) return;
      clearTimeout(pending.timeout);
      if (dict.error) {
        pending.reject(new Error(dict.error.message || '未知错误'));
      } else {
        pending.resolve(dict.result || {});
      }
      return;
    }

    const method = dict.method;
    const params = dict.params || {};

    switch (method) {
      case 'item/agentMessage/delta': {
        const threadId = params.threadId;
        const turnId = params.turnId;
        if (threadId !== this.threadId) return;
        if (this.activeTurnId && turnId && this.activeTurnId !== turnId) return;
        const delta = params.delta;
        if (typeof delta === 'string' && delta.length > 0 && this.activeTurn) {
          this.streamingText += delta;
          this.activeTurn.onDelta(delta);
        }
        break;
      }
      case 'item/reasoning/summaryTextDelta': {
        const threadId = params.threadId;
        const turnId = params.turnId;
        const summaryIndex = params.summaryIndex;
        const delta = params.delta;
        if (threadId !== this.threadId) return;
        if (this.activeTurnId && turnId && this.activeTurnId !== turnId) return;
        if (
          this.activeTurn &&
          typeof turnId === 'string' &&
          Number.isInteger(summaryIndex) &&
          typeof delta === 'string' &&
          delta.length > 0
        ) {
          this.activeTurn.onReasoning(turnId, summaryIndex, delta);
        }
        break;
      }
      case 'turn/started': {
        const threadId = params.threadId;
        if (threadId !== this.threadId) return;
        const turn = params.turn || {};
        if (typeof turn.id === 'string') {
          this.activeTurnId = turn.id;
        }
        break;
      }
      case 'turn/completed': {
        const threadId = params.threadId;
        if (threadId !== this.threadId) return;
        this.completeTurn();
        break;
      }
      case 'error': {
        const threadId = params.threadId;
        if (threadId !== this.threadId) return;
        const willRetry = !!params.willRetry;
        const message = params.error?.message || '未知错误';
        if (!willRetry) {
          this.failTurn(message);
        }
        break;
      }
      default:
        break;
    }
  }

  private completeTurn(): void {
    if (!this.activeTurn) return;
    const done = this.activeTurn.onDone;
    const output = this.streamingText.trim() || '(空回复)';
    this.activeTurn = null;
    this.activeTurnId = null;
    this.streamingText = '';
    done({ ok: true, text: output });
  }

  private failTurn(message: string): void {
    if (!this.activeTurn) return;
    const done = this.activeTurn.onDone;
    this.activeTurn = null;
    this.activeTurnId = null;
    this.streamingText = '';
    done({ ok: false, message });
  }

  private extractThreadId(result: any): string | null {
    if (result?.thread?.id && typeof result.thread.id === 'string') return result.thread.id;
    if (result?.threadId && typeof result.threadId === 'string') return result.threadId;
    return null;
  }

  private buildExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const parts = ['Codex worker 已退出'];
    if (typeof code === 'number') parts.push(`exit=${code}`);
    if (signal) parts.push(`signal=${signal}`);
    const stderr = this.stderrText.trim();
    if (stderr) {
      const compact = stderr.replace(/\s+/g, ' ').trim();
      parts.push(compact.length > 220 ? `${compact.slice(0, 220)}...` : compact);
    }
    return parts.join(' | ');
  }
}

class ClaudeWorker implements BridgeWorker {
  private process: ChildProcessWithoutNullStreams | null = null;
  private outBuffer = '';
  private stderrText = '';
  private sessionId: string | null = null;
  private streamingText = '';
  private reasoningText = '';
  private activeTurn: PendingTurn | null = null;

  async send(
    message: string,
    cwd: string,
    resumeThreadId: string | undefined,
    onDelta: (chunk: string) => void,
    onReasoning: (turnId: string, summaryIndex: number, delta: string) => void,
    onDone: (result: { ok: true; text: string } | { ok: false; message: string }) => void
  ): Promise<void> {
    if (this.activeTurn) {
      onDone({ ok: false, message: '当前已有进行中的 Claude 请求' });
      return;
    }

    const resumeId = (resumeThreadId || '').trim() || this.sessionId || undefined;
    this.streamingText = '';
    this.reasoningText = '';
    this.activeTurn = { onDelta, onReasoning, onDone };

    const args = [
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'dontAsk'
    ];
    if (resumeId) {
      args.push('--resume', resumeId);
    }
    args.push(message);

    const child = spawn(resolveClaudeExecutable(), args, {
      cwd,
      stdio: 'pipe'
    });
    this.process = child;
    this.stderrText = '';
    child.stdin.end();

    child.stdout.on('data', (chunk: Buffer) => {
      this.outBuffer += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrText += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      this.failTurn(err.message || 'Claude worker 启动失败');
      this.cleanupProcess();
    });

    child.on('exit', (code, signal) => {
      const pending = this.activeTurn;
      const output = this.outBuffer.trim();
      const stderr = this.stderrText.trim();
      this.cleanupProcess();
      if (!pending) return;
      if (signal) {
        this.failTurn('Claude 请求已中断');
        return;
      }
      if (code !== 0) {
        this.failTurn(this.buildExitMessage(code, stderr));
        return;
      }
      if (!output) {
        this.failTurn(stderr ? `Claude 未返回可解析结果：${stderr}` : 'Claude 未返回可解析结果');
        return;
      }
      this.handleJsonOutput(output);
    });
  }

  interrupt(): void {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }

  shutdown(): void {
    this.interrupt();
    this.cleanupProcess();
    if (this.activeTurn) {
      const done = this.activeTurn.onDone;
      this.activeTurn = null;
      done({ ok: false, message: 'Claude worker 已终止' });
    }
  }

  private handleJsonOutput(output: string): void {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let payload: any;
      try {
        payload = JSON.parse(lines[index]);
      } catch {
        continue;
      }

      if (typeof payload.session_id === 'string' && payload.session_id) {
        this.sessionId = payload.session_id;
      }

      if (!this.activeTurn) return;

      if (payload.type === 'result') {
        if (payload.subtype === 'success' && !payload.is_error) {
          const text = (typeof payload.result === 'string' && payload.result.trim()) || '(空回复)';
          this.activeTurn.onDelta(text);
          this.completeTurn(text);
        } else {
          this.failTurn(payload.result || 'Claude 执行失败');
        }
        return;
      }
    }

    if (this.activeTurn) {
      const stderr = this.stderrText.trim();
      this.failTurn(stderr ? `Claude 返回内容不可解析：${stderr}` : 'Claude 返回内容不可解析');
    }
  }

  private completeTurn(text: string): void {
    if (!this.activeTurn) return;
    const done = this.activeTurn.onDone;
    this.activeTurn = null;
    this.streamingText = '';
    this.reasoningText = '';
    done({ ok: true, text });
  }

  private failTurn(message: string): void {
    if (!this.activeTurn) return;
    const done = this.activeTurn.onDone;
    this.activeTurn = null;
    this.streamingText = '';
    this.reasoningText = '';
    done({ ok: false, message });
  }

  private cleanupProcess(): void {
    if (this.process) {
      this.process.stdout.removeAllListeners();
      this.process.stderr.removeAllListeners();
      this.process.removeAllListeners();
    }
    this.process = null;
    this.outBuffer = '';
    this.stderrText = '';
  }

  private buildExitMessage(code: number | null, stderr: string): string {
    const compact = stderr.replace(/\s+/g, ' ').trim();
    if (compact) {
      return `Claude worker 已退出 (exit=${code ?? 'unknown'})：${compact}`;
    }
    return `Claude worker 已退出 (exit=${code ?? 'unknown'})`;
  }
}

class BridgeController {
  private static readonly maxSessionOptions = 80;

  private workers: Record<Side, Record<CliTool, BridgeWorker>> = {
    A: { codex: new CodexWorker(), claude: new ClaudeWorker(), remote: new RemoteWorker(() => this.remoteConfig()) },
    B: { codex: new CodexWorker(), claude: new ClaudeWorker(), remote: new RemoteWorker(() => this.remoteConfig()) }
  };
  private panel: vscode.WebviewPanel | null = null;
  private webview: vscode.Webview | null = null;
  private reasoningMap = new Map<string, string>();
  private claudeProjectPathCache = new Map<string, Promise<string>>();
  private cliHealthCache = new Map<LocalCliTool, { ok: boolean; message: string }>();
  private remoteCallbackBaseUrl = '';
  private lastRemoteInterruptPeer: { directInterruptUrl?: string; hubNodeId?: string } | null = null;
  private interruptedBySide: Record<Side, boolean> = { A: false, B: false };
  private remoteHeartbeatTimer: NodeJS.Timeout | null = null;
  private remotePeerRefreshTimer: NodeJS.Timeout | null = null;
  private readonly localRemoteNodeId = randomUUID();
  private remoteServer = new RemoteInvokeServer(
    async ({ text, onDelta, onDone, targetTool, targetProjectPath, targetSessionId, sourceInterruptUrl, sourceNodeId }) =>
      this.handleRemoteInvoke(text, onDelta, onDone, {
        tool: targetTool,
        projectPath: targetProjectPath,
        sessionId: targetSessionId,
        sourceInterruptUrl,
        sourceNodeId
      }),
    async () => this.handleIncomingRemoteInterrupt()
  );

  private state: BridgeState = {
    projectAPath: '',
    projectBPath: '',
    toolA: 'codex',
    toolB: 'codex',
    sessionA: '',
    sessionB: '',
    projectOptions: [],
    sessionOptions: [],
    autoRelayEnabled: false,
    stopOnStageDone: true,
    chatControlExpanded: false,
    stageDoneMarkers: DEFAULT_STAGE_DONE_MARKERS,
    chatItems: [],
    isSendingA: false,
    isSendingB: false,
    remoteMode: 'off',
    remoteUrl: '',
    remoteToken: randomUUID(),
    remoteListenPort: 9238,
    remoteExportSide: 'A',
    remoteStatus: '未启用',
    remoteHubUrl: '',
    remotePeerId: '',
    remoteDeviceName: os.hostname(),
    remotePeerOptions: [],
    remotePeerLinked: false,
    remoteConnectionSnippet: '',
    remoteConnectivity: 'idle',
    remoteTokenHint: '这里是当前连接的访问 Key，不是 Hub 全局口令。直连时双方保持一致；Hub 模式下它会随分享配置一起传递，用于访问目标节点。',
    remoteTargetTool: 'codex',
    remoteTargetProjectPath: '',
    remoteTargetSessionId: '',
    remoteTargetLabel: '',
    remoteAutoRelayEnabled: false,
    availableHostTools: [],
    remoteHostTool: 'codex',
    remoteHostProjectPath: '',
    remoteHostSessionId: ''
  };

  attachPanel(panel: vscode.WebviewPanel, projectAPath: string): void {
    this.panel = panel;
    this.webview = panel.webview;
    if (!this.state.projectAPath.trim()) {
      this.state.projectAPath = projectAPath;
    }
    this.startRemotePeerRefreshLoop();
    this.loadCliOptions()
      .then(() => this.refreshRemoteBridge())
      .then(() => this.sync())
      .catch(() => undefined);
    this.sync();
  }

  attachWebview(webview: vscode.Webview, projectAPath: string): void {
    this.panel = null;
    this.webview = webview;
    if (!this.state.projectAPath.trim()) {
      this.state.projectAPath = projectAPath;
    }
    this.startRemotePeerRefreshLoop();
    this.loadCliOptions()
      .then(() => this.refreshRemoteBridge())
      .then(() => this.sync())
      .catch(() => undefined);
    this.sync();
  }

  dispose(): void {
    for (const side of ['A', 'B'] as const) {
      for (const tool of ['codex', 'claude', 'remote'] as const) {
        this.workers[side][tool].shutdown();
      }
    }
    this.remoteServer.stop().catch(() => undefined);
    this.unregisterFromHub().catch(() => undefined);
    this.stopRemoteHeartbeat();
    this.stopRemotePeerRefreshLoop();
    this.panel = null;
    this.webview = null;
  }

  onWebviewMessage(message: any): void {
    switch (message.type) {
      case 'updateSettings':
        {
          const prevToolA = this.state.toolA;
          const prevToolB = this.state.toolB;
          const prevProjectAPath = this.state.projectAPath;
          const prevProjectBPath = this.state.projectBPath;
          const prevRemoteExportSide = this.state.remoteExportSide;
          const prevRemoteHostTool = this.state.remoteHostTool;
          const prevRemoteHostProjectPath = this.state.remoteHostProjectPath;
          const prevRemoteTargetTool = this.state.remoteTargetTool;
          const prevRemoteTargetProjectPath = this.state.remoteTargetProjectPath;
          const nextProjectAPath = String(message.projectAPath || this.state.projectAPath || '');
          const nextProjectBPath = String(message.projectBPath || '');
          const nextRemoteExportSide = this.normalizeSide(message.remoteExportSide);
          const nextRemoteHostProjectPath = String(message.remoteHostProjectPath || '');
          const nextRemoteTargetProjectPath = String(message.remoteTargetProjectPath || '');
          const prevMirroredHostTool = this.localToolForSide(prevRemoteExportSide);
          this.state.toolA = this.normalizeCliTool(message.toolA);
          this.state.toolB = this.normalizeCliTool(message.toolB);
          this.state.projectAPath = nextProjectAPath;
          this.state.projectBPath = nextProjectBPath;
          this.state.remoteExportSide = nextRemoteExportSide;
          this.state.sessionA =
            prevToolA !== this.state.toolA || prevProjectAPath !== nextProjectAPath
              ? ''
              : String(message.sessionA || '');
          this.state.sessionB =
            prevToolB !== this.state.toolB || prevProjectBPath !== nextProjectBPath
              ? ''
              : String(message.sessionB || '');
          const requestedRemoteHostTool = this.normalizeHostTool(message.remoteHostTool);
          const nextMirroredHostTool = this.localToolForSide(nextRemoteExportSide);
          const shouldFollowExportTool =
            !!prevMirroredHostTool &&
            prevRemoteHostTool === prevMirroredHostTool &&
            !!nextMirroredHostTool;
          this.state.remoteHostTool = shouldFollowExportTool
            ? this.normalizeHostTool(nextMirroredHostTool)
            : requestedRemoteHostTool;
          this.state.remoteHostProjectPath = nextRemoteHostProjectPath;
          this.state.remoteHostSessionId =
            prevRemoteHostTool !== this.state.remoteHostTool || prevRemoteHostProjectPath !== nextRemoteHostProjectPath
              ? ''
              : String(message.remoteHostSessionId || '');
          this.state.remoteTargetTool = this.normalizeLocalCliTool(message.remoteTargetTool);
          this.state.remoteTargetProjectPath = nextRemoteTargetProjectPath;
          this.state.remoteTargetSessionId =
            prevRemoteTargetTool !== this.state.remoteTargetTool || prevRemoteTargetProjectPath !== nextRemoteTargetProjectPath
              ? ''
              : String(message.remoteTargetSessionId || '');
        }
        this.state.autoRelayEnabled = !!message.autoRelayEnabled;
        this.state.stopOnStageDone = !!message.stopOnStageDone;
        this.state.chatControlExpanded = !!message.chatControlExpanded;
        this.state.stageDoneMarkers = String(message.stageDoneMarkers || this.state.stageDoneMarkers);
        this.state.remoteMode = this.normalizeRemoteMode(message.remoteMode);
        this.state.remoteUrl = String(message.remoteUrl || '');
        this.state.remoteToken = this.normalizeRemoteToken(message.remoteToken);
        this.state.remoteListenPort = this.normalizePort(message.remoteListenPort);
        this.state.remoteHubUrl = String(message.remoteHubUrl || '');
        this.state.remotePeerId = String(message.remotePeerId || '');
        this.state.remoteDeviceName = String(message.remoteDeviceName || this.state.remoteDeviceName || os.hostname());
        this.state.remoteAutoRelayEnabled = !!message.remoteAutoRelayEnabled;
        this.refreshRemoteBridge()
          .then(() => this.sync())
          .catch(() => this.sync());
        break;
      case 'refreshOptions':
        this.loadCliOptions()
          .then(() => this.refreshRemoteBridge())
          .then(() => {
            this.sync();
            this.webview?.postMessage({ type: 'refreshOptionsResult', ok: true });
          })
          .catch((err: any) => {
            this.appendSystem(`刷新下拉数据失败：${err?.message || '未知错误'}`);
            this.webview?.postMessage({
              type: 'refreshOptionsResult',
              ok: false,
              message: err?.message || '未知错误'
            });
          });
        break;
      case 'send':
        {
          const rawTarget = String(message.target || 'A');
          const target: 'A' | 'B' | 'BOTH' =
            rawTarget === 'B' || rawTarget === 'BOTH' ? rawTarget : 'A';
          this.handleSend(target, String(message.text || ''));
        }
        break;
      case 'sendRemote':
        {
          const rawTarget = String(message.target || 'REMOTE');
          const target =
            rawTarget === 'LOCAL' || rawTarget === 'REMOTE' || rawTarget === 'A' || rawTarget === 'B' || rawTarget === 'BOTH'
              ? rawTarget
              : 'REMOTE';
          this.handleRemoteSend(target, String(message.text || ''));
        }
        break;
      case 'interrupt':
        this.handleInterrupt(String(message.target || 'BOTH'));
        break;
      case 'interruptRemote':
        this.handleRemoteUiInterrupt();
        break;
      case 'webviewError':
        this.appendSystem(`前端异常：${String(message.message || '未知错误')}`);
        break;
      case 'requestState':
        this.sync();
        break;
      case 'refreshRemotePeers':
        this.refreshRemoteBridge()
          .then(() => this.sync())
          .catch(() => this.sync());
        break;
      case 'copyShareLink':
        {
          const text = String(message.text || this.state.remoteConnectionSnippet || '');
          void vscode.env.clipboard.writeText(text).then(
            () => {
              this.webview?.postMessage({ type: 'copyShareLinkResult', ok: true });
            },
            (err: any) => {
              this.webview?.postMessage({
                type: 'copyShareLinkResult',
                ok: false,
                message: err?.message || '复制失败'
              });
            }
          );
        }
        break;
      case 'applyRemoteConfigSnippet':
        {
          const source = message.source === 'auto' ? 'auto' : 'manual';
          const result = this.applyRemoteConfigSnippetInternal(String(message.text || ''));
          this.refreshRemoteBridge()
            .then(() => {
              this.sync();
              this.webview?.postMessage({
                type: 'applyRemoteConfigResult',
                ok: result.ok,
                message: result.message,
                source
              });
            })
            .catch((err: any) => {
              this.sync();
              this.webview?.postMessage({
                type: 'applyRemoteConfigResult',
                ok: false,
                message: err?.message || result.message || '应用配置失败',
                source
              });
            });
        }
        break;
      default:
        break;
    }
  }

  private handleSend(target: 'A' | 'B' | 'BOTH', text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (target === 'A' || target === 'BOTH') {
      this.sendTo('A', trimmed, false);
    }
    if (target === 'B' || target === 'BOTH') {
      this.sendTo('B', trimmed, false);
    }
  }

  private handleRemoteSend(target: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (target === 'LOCAL' || target === 'BOTH') {
      for (const side of this.remoteConversationLocalSendSides()) {
        this.sendTo(side, trimmed, false, {
          channel: 'remote',
          userPeer: 'local',
          assistantPeer: 'local'
        });
      }
    }

    if (target === 'REMOTE' || target === 'BOTH') {
      if (this.state.remoteMode === 'host') {
        this.sendToConnectedRemotePeer(trimmed);
      } else {
        for (const side of this.remoteConversationRemoteSendSides()) {
          this.sendTo(side, trimmed, false, {
            channel: 'remote',
            userPeer: 'local',
            assistantPeer: 'remote'
          });
        }
      }
      return;
    }

    if (target === 'A' || target === 'B') {
      const side = target;
      const tool = this.selectedTool(side);
      this.sendTo(side, trimmed, false, {
        channel: 'remote',
        userPeer: 'local',
        assistantPeer: tool === 'remote' ? 'remote' : 'local'
      });
    }
  }

  private remoteConversationSides(): Side[] {
    if (this.state.remoteMode === 'host') {
      return [this.state.remoteExportSide];
    }
    const sides: Side[] = [];
    if (this.state.toolA === 'remote') sides.push('A');
    if (this.state.toolB === 'remote') sides.push('B');
    return sides;
  }

  private remoteConversationLocalSendSides(): Side[] {
    if (this.state.remoteMode === 'host') {
      return [this.state.remoteExportSide];
    }
    const remoteSides = this.remoteConversationSides();
    if (remoteSides.length === 1) {
      const remoteSide = remoteSides[0];
      const localSide: Side = remoteSide === 'A' ? 'B' : 'A';
      if (this.selectedTool(localSide) !== 'remote') {
        return [localSide];
      }
    }
    return [];
  }

  private remoteConversationRemoteSendSides(): Side[] {
    if (this.state.remoteMode === 'host') {
      return this.canSendToConnectedRemotePeer() ? [this.state.remoteExportSide] : [];
    }
    return this.remoteConversationSides();
  }

  private remoteConversationSendSides(): Side[] {
    const localSides = this.remoteConversationLocalSendSides();
    const remoteSides = this.remoteConversationRemoteSendSides();
    return [...new Set([...localSides, ...remoteSides])];
  }

  private nextRemoteRelayTarget(fromSide: Side): { side: Side; userPeer: ChatPeer; assistantPeer: ChatPeer } | null {
    if (this.state.remoteMode !== 'client') return null;
    const remoteSides = this.remoteConversationSides();
    if (remoteSides.length !== 1) return null;

    const remoteSide = remoteSides[0];
    const localSide: Side = remoteSide === 'A' ? 'B' : 'A';
    if (this.selectedTool(localSide) === 'remote') return null;

    if (fromSide === remoteSide) {
      return { side: localSide, userPeer: 'remote', assistantPeer: 'local' };
    }
    if (fromSide === localSide) {
      return { side: remoteSide, userPeer: 'local', assistantPeer: 'remote' };
    }
    return null;
  }

  private canSendToConnectedRemotePeer(): boolean {
    return !!(
      this.lastRemoteInterruptPeer &&
      (this.lastRemoteInterruptPeer.hubNodeId || this.lastRemoteInterruptPeer.directInterruptUrl)
    );
  }

  private sendTo(side: Side, message: string, initiatedByRelay: boolean, context?: SendContext): void {
    const projectPath = side === 'A' ? this.state.projectAPath : this.state.projectBPath;
    const tool = this.selectedTool(side);
    const worker = this.workers[side][tool];
    const sessionId = this.normalizedResumeId(
      tool,
      side === 'A' ? this.state.sessionA : this.state.sessionB,
      projectPath
    );
    const channel = context?.channel || (tool === 'remote' ? 'remote' : 'bridge');
    const userPeer = context?.userPeer || (channel === 'remote' ? 'local' : undefined);
    const assistantPeer =
      context?.assistantPeer || (tool === 'remote' ? 'remote' : channel === 'remote' ? 'local' : undefined);

    if (tool !== 'remote' && !projectPath.trim()) {
      this.appendSystem(`${side} 发送失败：项目路径为空`, side, channel);
      return;
    }

    const cliFailure = this.localCliFailureMessage(tool);
    if (cliFailure) {
      this.appendSystem(`${side} 发送失败：${cliFailure}`, side, channel);
      return;
    }

    if (side === 'A' ? this.state.isSendingA : this.state.isSendingB) {
      this.appendSystem(`${side} 忙碌中，稍后再试`, side, channel);
      return;
    }

    if (!initiatedByRelay) {
      this.appendChat({ id: randomUUID(), time: Date.now(), side, role: 'user', text: message, channel, peer: userPeer });
    } else if (channel !== 'remote') {
      this.appendSystem(`自动转发到 ${side}`, side, channel);
    }

    this.setSending(side, true);
    const assistantId = randomUUID();
    this.appendChat({
      id: assistantId,
      time: Date.now(),
      side,
      role: 'assistant',
      text: '',
      channel,
      peer: assistantPeer
    });

    const outboundMessage = this.composeOutboundMessage(message);
    const runAttempt = (resumeId: string | undefined, allowRetryWithoutSession: boolean): void => {
      worker.send(
        outboundMessage,
        projectPath,
        resumeId,
        (delta) => {
          this.appendAssistantDelta(assistantId, delta);
        },
        (turnId, summaryIndex, delta) => {
          this.bindTurnId(assistantId, turnId);
          const key = `${side}|${turnId}|${summaryIndex}`;
          this.reasoningMap.set(key, (this.reasoningMap.get(key) || '') + delta);
          this.sync();
        },
        (result) => {
          if (!result.ok && allowRetryWithoutSession && this.shouldRetryWithoutSession(tool, resumeId, result.message)) {
            this.clearSelectedSession(side);
            this.appendSystem(`${side} 最近会话恢复失败，已自动切换为新会话重试`, side, channel);
            runAttempt(undefined, false);
            return;
          }

          this.setSending(side, false);
          const interrupted = this.interruptedBySide[side];
          if (interrupted) {
            this.interruptedBySide[side] = false;
          }
          if (!result.ok) {
            this.appendSystem(`${side} 执行失败：${result.message}`, side, channel);
            return;
          }

          this.upsertAssistant(assistantId, result.text, side);
          if (interrupted) {
            this.appendSystem(`${side} 已打断`, side, channel);
            return;
          }

          if (channel === 'remote') {
            if (this.state.remoteAutoRelayEnabled && this.state.stopOnStageDone && this.isStageDone(result.text)) {
              this.state.remoteAutoRelayEnabled = false;
              this.appendSystem('检测到阶段完成，已停止跨设备自动接力', undefined, 'remote');
              this.sync();
              return;
            }

            if (this.state.remoteAutoRelayEnabled) {
              const relay = this.nextRemoteRelayTarget(side);
              const payload = this.sanitizedRelayPayload(result.text);
              if (relay && payload.trim()) {
                this.sendTo(relay.side, payload, true, {
                  channel: 'remote',
                  userPeer: relay.userPeer,
                  assistantPeer: relay.assistantPeer
                });
              }
            }
            return;
          }

          if (this.state.autoRelayEnabled && this.state.stopOnStageDone && this.isStageDone(result.text)) {
            this.state.autoRelayEnabled = false;
            this.appendSystem('检测到阶段完成，已停止自动互发');
            this.sync();
            return;
          }

          if (this.state.autoRelayEnabled) {
            const payload = this.sanitizedRelayPayload(result.text);
            if (payload.trim()) {
              this.sendTo(side === 'A' ? 'B' : 'A', payload, true);
            }
          }
        }
      );
    };

    runAttempt(sessionId || undefined, !!sessionId && tool !== 'remote');
  }

  private sendToConnectedRemotePeer(message: string): void {
    const peer = this.lastRemoteInterruptPeer;
    if (!peer) {
      this.appendSystem('当前还没有已连接的远端 AI，可先让对端发来一条消息建立会话', undefined, 'remote');
      return;
    }

    const side = this.state.remoteExportSide;
    const busy = side === 'A' ? this.state.isSendingA : this.state.isSendingB;
    if (busy) {
      this.appendSystem(`${side} 忙碌中，稍后再试`, side, 'remote');
      return;
    }

    const token = this.state.remoteToken.trim();
    if (!token) {
      this.appendSystem('远端发送失败：访问 Key 为空', side, 'remote');
      return;
    }

    const hubUrl = this.state.remoteHubUrl.trim();
    const callbackUrl = this.remoteCallbackBaseUrl
      ? `${this.remoteCallbackBaseUrl.replace(/\/$/, '')}/interrupt`
      : undefined;

    let requestUrl = '';
    let requestHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    let requestBody = '';

    if (peer.hubNodeId && hubUrl) {
      requestUrl = `${hubUrl.replace(/\/$/, '')}/relay/invoke`;
      requestBody = JSON.stringify({
        token,
        targetNodeId: peer.hubNodeId,
        text: message,
        stream: true,
        sourceNodeId: this.localRemoteNodeId
      });
    } else if (peer.directInterruptUrl) {
      requestUrl = RemoteWorker.resolveInvokeUrl(peer.directInterruptUrl);
      requestBody = JSON.stringify({
        token,
        text: message,
        stream: true,
        sourceInterruptUrl: callbackUrl
      });
    } else {
      this.appendSystem('当前还没有可用的远端回传地址', side, 'remote');
      return;
    }

    this.appendChat({
      id: randomUUID(),
      time: Date.now(),
      side,
      role: 'user',
      text: message,
      channel: 'remote',
      peer: 'local'
    });
    this.setSending(side, true);
    const assistantId = randomUUID();
    this.appendChat({
      id: assistantId,
      time: Date.now(),
      side,
      role: 'assistant',
      text: '',
      channel: 'remote',
      peer: 'remote'
    });

    fetch(requestUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody
    })
      .then(async (response) => {
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `远端调用失败 (${response.status})`);
        }
        await RemoteWorker.consumeStreamingResponse(
          response,
          (delta) => {
            this.appendAssistantDelta(assistantId, delta);
          },
          (result) => {
            this.setSending(side, false);
            if (!result.ok) {
              this.appendSystem(`远端发送失败：${result.message}`, side, 'remote');
              return;
            }
            this.upsertAssistant(assistantId, result.text, side);
          }
        );
      })
      .catch((err: any) => {
        this.setSending(side, false);
        this.appendSystem(`远端发送失败：${err?.message || '未知错误'}`, side, 'remote');
      });
  }

  private async handleRemoteUiInterrupt(): Promise<void> {
    const peerInterrupted = await this.propagateRemoteInterrupt();
    const sides = this.remoteConversationSendSides();
    let interruptedCount = 0;

    for (const side of sides) {
      const busy = side === 'A' ? this.state.isSendingA : this.state.isSendingB;
      if (!busy) continue;
      this.interruptedBySide[side] = true;
      for (const tool of ['codex', 'claude', 'remote'] as const) {
        this.workers[side][tool].interrupt();
      }
      this.setSending(side, false);
      interruptedCount += 1;
    }

    const hadRelay = this.state.remoteAutoRelayEnabled || this.state.autoRelayEnabled;
    this.state.remoteAutoRelayEnabled = false;
    this.state.autoRelayEnabled = false;
    if (interruptedCount > 0 || hadRelay || peerInterrupted) {
      this.appendSystem('已停止跨设备对话流，并关闭自动接力', undefined, 'remote');
      this.sync();
      return;
    }
    this.appendSystem('当前没有进行中的跨设备会话', undefined, 'remote');
  }

  private async handleIncomingRemoteInterrupt(): Promise<void> {
    if (this.state.remoteMode === 'host') {
      await this.handleRemoteInterrupt();
      return;
    }

    const sides = this.remoteConversationSendSides();
    let interruptedCount = 0;
    for (const side of sides) {
      const busy = side === 'A' ? this.state.isSendingA : this.state.isSendingB;
      if (!busy) continue;
      this.interruptedBySide[side] = true;
      for (const tool of ['codex', 'claude', 'remote'] as const) {
        this.workers[side][tool].interrupt();
      }
      this.setSending(side, false);
      interruptedCount += 1;
    }
    const hadRelay = this.state.remoteAutoRelayEnabled || this.state.autoRelayEnabled;
    this.state.remoteAutoRelayEnabled = false;
    this.state.autoRelayEnabled = false;
    if (interruptedCount > 0 || hadRelay) {
      this.appendSystem('远端已请求停止，当前跨设备对话已打断', undefined, 'remote');
      this.sync();
    }
  }

  private async propagateRemoteInterrupt(): Promise<boolean> {
    const token = this.state.remoteToken.trim();
    if (!token) return false;

    if (this.state.remoteMode === 'client') {
      const hubUrl = this.state.remoteHubUrl.trim();
      const peerId = this.state.remotePeerId.trim();
      const directUrl = this.state.remoteUrl.trim();
      if (!hubUrl && !directUrl) return false;
      try {
        if (hubUrl && peerId) {
          const response = await fetch(`${hubUrl.replace(/\/$/, '')}/relay/interrupt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, targetNodeId: peerId })
          });
          return response.ok;
        }
        if (directUrl) {
          const response = await fetch(this.resolveDirectInterruptUrl(directUrl), {
            method: 'POST',
            headers: { 'x-bridge-token': token }
          });
          return response.ok;
        }
      } catch {
        return false;
      }
      return false;
    }

    if (this.state.remoteMode !== 'host' || !this.lastRemoteInterruptPeer) return false;
    try {
      if (this.lastRemoteInterruptPeer.hubNodeId && this.state.remoteHubUrl.trim()) {
        const response = await fetch(`${this.state.remoteHubUrl.trim().replace(/\/$/, '')}/relay/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            targetNodeId: this.lastRemoteInterruptPeer.hubNodeId
          })
        });
        return response.ok;
      }
      if (this.lastRemoteInterruptPeer.directInterruptUrl) {
        const response = await fetch(this.lastRemoteInterruptPeer.directInterruptUrl, {
          method: 'POST',
          headers: { 'x-bridge-token': token }
        });
        return response.ok;
      }
    } catch {
      return false;
    }
    return false;
  }

  private resolveDirectInterruptUrl(rawUrl: string): string {
    const trimmed = rawUrl.trim().replace(/\/$/, '');
    if (!trimmed) return '/interrupt';
    if (trimmed.endsWith('/interrupt')) return trimmed;
    if (trimmed.endsWith('/invoke')) return trimmed.slice(0, -'/invoke'.length) + '/interrupt';
    return `${trimmed}/interrupt`;
  }

  private handleInterrupt(rawTarget: string): void {
    const target: 'A' | 'B' | 'BOTH' =
      rawTarget === 'A' || rawTarget === 'B' || rawTarget === 'BOTH' ? rawTarget : 'BOTH';
    const sides: Side[] = target === 'BOTH' ? ['A', 'B'] : [target];
    let interruptedCount = 0;

    for (const side of sides) {
      const busy = side === 'A' ? this.state.isSendingA : this.state.isSendingB;
      if (!busy) continue;
      this.interruptedBySide[side] = true;
      for (const tool of ['codex', 'claude', 'remote'] as const) {
        this.workers[side][tool].interrupt();
      }
      this.setSending(side, false);
      interruptedCount += 1;
    }

    if (interruptedCount > 0) {
      this.state.autoRelayEnabled = false;
      this.appendSystem(`已打断 ${target === 'BOTH' ? 'A/B' : target}，并停止自动互发`);
      this.sync();
      if (target === 'BOTH' && this.remoteConversationSides().length > 0) {
        void this.handleRemoteUiInterrupt();
      }
    } else {
      this.appendSystem('当前无进行中的任务可打断');
      if (target === 'BOTH' && this.remoteConversationSides().length > 0) {
        void this.handleRemoteUiInterrupt();
      }
    }
  }

  private composeOutboundMessage(message: string): string {
    return composeOutboundMessage(message, {
      autoRelayEnabled: this.state.autoRelayEnabled,
      stopOnStageDone: this.state.stopOnStageDone
    });
  }

  private selectedTool(side: Side): CliTool {
    return side === 'A' ? this.state.toolA : this.state.toolB;
  }

  private availableHostTools(): LocalCliTool[] {
    return this.state.availableHostTools;
  }

  private localToolForSide(side: Side): LocalCliTool | null {
    const tool = this.selectedTool(side);
    return tool === 'remote' ? null : tool;
  }

  private selectedRemoteHostTool(): LocalCliTool {
    return this.localToolForSide(this.state.remoteExportSide) || this.normalizeHostTool(this.state.remoteHostTool);
  }

  private selectedRemoteHostProjectPath(): string {
    const side = this.state.remoteExportSide;
    const mirroredProjectPath = side === 'A' ? this.state.projectAPath.trim() : this.state.projectBPath.trim();
    if (mirroredProjectPath) return mirroredProjectPath;
    return this.state.remoteHostProjectPath.trim();
  }

  private selectedRemoteHostSessionId(projectPath = this.selectedRemoteHostProjectPath()): string {
    const side = this.state.remoteExportSide;
    const mirroredTool = this.localToolForSide(side);
    if (mirroredTool) {
      const mirroredSideSession = side === 'A' ? this.state.sessionA : this.state.sessionB;
      return this.normalizedResumeId(mirroredTool, mirroredSideSession, projectPath);
    }
    const explicitSessionId = this.normalizedResumeId(
      this.selectedRemoteHostTool(),
      this.state.remoteHostSessionId,
      projectPath
    );
    if (explicitSessionId) return explicitSessionId;

    const mirroredSideSession = side === 'A' ? this.state.sessionA : this.state.sessionB;
    return this.normalizedResumeId(this.selectedRemoteHostTool(), mirroredSideSession, projectPath);
  }

  private defaultInboundRemoteSide(): Side {
    if (this.state.remoteMode === 'client') {
      const remoteSides = this.remoteConversationSides();
      if (remoteSides.length === 1) {
        const remoteSide = remoteSides[0];
        const localSide: Side = remoteSide === 'A' ? 'B' : 'A';
        if (this.selectedTool(localSide) !== 'remote') {
          return localSide;
        }
      }
    }
    return this.state.remoteExportSide;
  }

  private selectedInboundRemoteTool(side = this.defaultInboundRemoteSide()): LocalCliTool {
    const sideTool = this.selectedTool(side);
    return sideTool === 'remote' ? this.selectedRemoteHostTool() : sideTool;
  }

  private selectedInboundRemoteProjectPath(side = this.defaultInboundRemoteSide()): string {
    const sideProjectPath = side === 'A' ? this.state.projectAPath.trim() : this.state.projectBPath.trim();
    return sideProjectPath || this.selectedRemoteHostProjectPath();
  }

  private selectedInboundRemoteSessionId(
    side = this.defaultInboundRemoteSide(),
    tool = this.selectedInboundRemoteTool(side),
    projectPath = this.selectedInboundRemoteProjectPath(side)
  ): string {
    const sideTool = this.selectedTool(side);
    const sideSession = side === 'A' ? this.state.sessionA : this.state.sessionB;
    if (sideTool !== 'remote' && sideTool === tool) {
      return this.normalizedResumeId(tool, sideSession, projectPath);
    }
    return this.selectedRemoteHostSessionId(projectPath);
  }

  private pickRemoteImportSide(): Side {
    if (this.state.toolA === 'remote') return 'A';
    if (this.state.toolB === 'remote') return 'B';

    const score = (side: Side): number => {
      const projectPath = (side === 'A' ? this.state.projectAPath : this.state.projectBPath).trim();
      const sessionId = (side === 'A' ? this.state.sessionA : this.state.sessionB).trim();
      let points = 0;
      if (!projectPath) points += 4;
      if (!sessionId) points += 2;
      if (this.selectedTool(side) !== 'codex') points += 1;
      return points;
    };

    const scoreA = score('A');
    const scoreB = score('B');
    if (scoreA === scoreB) return 'B';
    return scoreA > scoreB ? 'A' : 'B';
  }

  private normalizeCliTool(value: unknown): CliTool {
    if (value === 'claude') return 'claude';
    if (value === 'remote') return 'remote';
    return 'codex';
  }

  private normalizeLocalCliTool(value: unknown): LocalCliTool {
    return value === 'claude' ? 'claude' : 'codex';
  }

  private normalizeHostTool(value: unknown): LocalCliTool {
    const normalized = this.normalizeLocalCliTool(value);
    if (this.state.availableHostTools.includes(normalized)) return normalized;
    return this.state.availableHostTools[0] || normalized;
  }

  private normalizeRemoteMode(value: unknown): RemoteMode {
    return value === 'host' || value === 'client' ? value : 'off';
  }

  private normalizeSide(value: unknown): Side {
    return value === 'B' ? 'B' : 'A';
  }

  private normalizePort(value: unknown): number {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1 || num > 65535) return 9238;
    return num;
  }

  private normalizeRemoteToken(value: unknown): string {
    const token = String(value || '').trim();
    if (!token) return this.state.remoteToken || randomUUID();
    return token;
  }

  private clearSelectedSession(side: Side): void {
    if (side === 'A') this.state.sessionA = '';
    if (side === 'B') this.state.sessionB = '';
    this.sync();
  }

  private shouldRetryWithoutSession(tool: CliTool, resumeId: string | undefined, message: string): boolean {
    if (!resumeId || tool === 'remote') return false;
    const lowered = String(message || '').toLowerCase();
    if (!lowered) return false;

    const retryHints = [
      'thread/resume',
      'resume',
      'session',
      'conversation',
      'invalid thread',
      'not found',
      '超时',
      'timeout',
      '会话'
    ];

    return retryHints.some((hint) => lowered.includes(hint));
  }

  private remoteConfig(): {
    mode: RemoteMode;
    url: string;
    token: string;
    hubUrl: string;
    peerId: string;
    targetTool: LocalCliTool;
    targetProjectPath: string;
    targetSessionId: string;
    sourceInterruptUrl?: string;
    sourceNodeId?: string;
  } {
    return {
      mode: this.state.remoteMode,
      url: this.state.remoteUrl,
      token: this.state.remoteToken,
      hubUrl: this.state.remoteHubUrl,
      peerId: this.state.remotePeerId,
      targetTool: this.state.remoteTargetTool,
      targetProjectPath: this.state.remoteTargetProjectPath,
      targetSessionId: this.state.remoteTargetSessionId,
      sourceInterruptUrl: this.state.remoteMode === 'client' && this.remoteCallbackBaseUrl
        ? `${this.remoteCallbackBaseUrl.replace(/\/$/, '')}/interrupt`
        : undefined,
      sourceNodeId: this.state.remoteMode === 'client' && this.state.remoteHubUrl.trim()
        ? this.localRemoteNodeId
        : undefined
    };
  }

  private async refreshRemoteBridge(): Promise<void> {
    const hubUrl = this.state.remoteHubUrl.trim();
    const tokenState = this.describeRemoteToken();
    this.state.remoteTokenHint = '这里是当前连接的访问 Key，不是 Hub 全局口令。直连时双方保持一致；Hub 模式下它会随分享配置一起传递，用于访问目标节点。';
    if (this.state.remoteMode !== 'client') {
      this.state.remoteAutoRelayEnabled = false;
    }
    if (this.state.remoteMode !== 'host') {
      this.state.remotePeerLinked = false;
    }
    if (this.state.remoteMode === 'off') {
      this.remoteCallbackBaseUrl = '';
      this.lastRemoteInterruptPeer = null;
      await this.unregisterFromHub().catch(() => undefined);
      await this.remoteServer.stop().catch(() => undefined);
      this.stopRemoteHeartbeat();
      this.state.remotePeerOptions = [];
      this.state.remotePeerLinked = false;
      this.state.remoteStatus = '未启用';
      this.state.remoteConnectivity = 'idle';
      this.state.remoteConnectionSnippet = this.buildRemoteConnectionSnippet();
      return;
    }

    try {
      const port = await this.remoteServer.start(this.state.remoteListenPort, this.state.remoteToken);
      const endpoints = this.formatHostEndpoints(port);
      const callbackBaseUrl = this.preferredHubEndpoint(endpoints);
      this.remoteCallbackBaseUrl = callbackBaseUrl;

      if (this.state.remoteMode === 'client') {
        if (hubUrl) {
          const registered = await this.registerWithHub(callbackBaseUrl, false);
          await this.refreshHubPeers();
          this.scheduleRemoteHeartbeat(callbackBaseUrl, false);
          const selected = this.state.remotePeerOptions.find((item) => item.id === this.state.remotePeerId);
          this.state.remoteStatus =
            `客户端模式 -> Hub ${hubUrl} / ${selected?.label || this.state.remotePeerId || '未选择节点'} / 节点数 ${this.state.remotePeerOptions.length}` +
            ` / 回调 ${registered ? '已就绪' : '注册失败'} / ${tokenState}`;
        } else {
          await this.unregisterFromHub().catch(() => undefined);
          this.stopRemoteHeartbeat();
          this.state.remotePeerOptions = [];
          this.state.remoteStatus = `客户端模式 -> ${this.state.remoteUrl || '未配置 URL'} / 回调 ${callbackBaseUrl} / ${tokenState}`;
        }
        await this.checkRemoteConnectivity();
        this.state.remoteConnectionSnippet = this.buildRemoteConnectionSnippet();
        return;
      }

      const availableTools = this.availableHostTools();
      const selectedTool = this.selectedRemoteHostTool();
      let status = `主机模式已启动: ${endpoints.join(' , ')}`;
      if (hubUrl) {
        const registered = await this.registerWithHub(callbackBaseUrl, true);
        await this.refreshHubPeers();
        this.scheduleRemoteHeartbeat(callbackBaseUrl, true);
        status += registered ? ` | Hub 已注册: ${hubUrl}` : ` | Hub 注册失败: ${hubUrl}`;
      } else {
        await this.unregisterFromHub().catch(() => undefined);
        this.stopRemoteHeartbeat();
        this.state.remotePeerOptions = [];
      }
      status += availableTools.length > 0
        ? ` | 对外 CLI: ${selectedTool === 'claude' ? 'Claude Code' : 'Codex'}`
        : ' | 未检测到本机可用 CLI';
      this.state.remoteStatus = `${status} | ${tokenState}`;
      this.state.remoteConnectivity = 'ok';
    } catch (err: any) {
      this.remoteCallbackBaseUrl = '';
      this.stopRemoteHeartbeat();
      this.state.remoteStatus = `主机启动失败: ${err?.message || '未知错误'}`;
      this.state.remoteConnectivity = 'error';
    }
    this.state.remoteConnectionSnippet = this.buildRemoteConnectionSnippet();
  }

  private formatHostEndpoints(port: number): string[] {
    const interfaces = os.networkInterfaces();
    const urls = new Set<string>();
    urls.add(`http://127.0.0.1:${port}`);
    for (const addresses of Object.values(interfaces)) {
      for (const addr of addresses || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          urls.add(`http://${addr.address}:${port}`);
        }
      }
    }
    return [...urls];
  }

  private async handleRemoteInvoke(
    text: string,
    onDelta?: (delta: string) => void,
    onDone?: (text: string) => void,
    override?: { tool?: LocalCliTool; projectPath?: string; sessionId?: string; sourceInterruptUrl?: string; sourceNodeId?: string }
  ): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    if (this.availableHostTools().length === 0) {
      return { ok: false, message: '未检测到可用本地 CLI，请先安装 Codex 或 Claude Code。' };
    }
    const side = this.defaultInboundRemoteSide();
    const tool = override?.tool || this.selectedInboundRemoteTool(side);
    if (!this.availableHostTools().includes(tool)) {
      return { ok: false, message: `本机未安装 ${tool === 'claude' ? 'Claude Code' : 'Codex'} CLI。` };
    }
    const projectPath = override?.projectPath || this.selectedInboundRemoteProjectPath(side);
    const sessionId = override?.sessionId !== undefined
      ? this.normalizedResumeId(tool, override.sessionId, projectPath)
      : this.selectedInboundRemoteSessionId(side, tool, projectPath);
    const worker = this.workers[side][tool];
    if (!projectPath.trim()) {
      return { ok: false, message: `${side} 项目路径为空` };
    }
    const cliFailure = this.localCliFailureMessage(tool);
    if (cliFailure) {
      return { ok: false, message: cliFailure };
    }
    if (side === 'A' ? this.state.isSendingA : this.state.isSendingB) {
      return { ok: false, message: `${side} 当前忙碌中` };
    }

    if (override?.sourceNodeId?.trim()) {
      this.lastRemoteInterruptPeer = { hubNodeId: override.sourceNodeId.trim() };
      this.state.remotePeerLinked = true;
    } else if (override?.sourceInterruptUrl?.trim()) {
      this.lastRemoteInterruptPeer = { directInterruptUrl: override.sourceInterruptUrl.trim() };
      this.state.remotePeerLinked = true;
    }

    const targetSummary = [tool, projectPath || '(未指定项目)', sessionId || 'new-session'].join(' / ');
    this.appendChat({ id: randomUUID(), time: Date.now(), side, role: 'user', text, channel: 'remote', peer: 'remote' });
    this.appendSystem(`收到远端请求，转发到 ${side} · ${targetSummary}`, side, 'remote');
    this.setSending(side, true);
    const assistantId = randomUUID();
    this.appendChat({
      id: assistantId,
      time: Date.now(),
      side,
      role: 'assistant',
      text: '',
      channel: 'remote',
      peer: 'local'
    });

    return await new Promise((resolve) => {
      const runAttempt = (resumeId: string | undefined, allowRetryWithoutSession: boolean): void => {
        worker.send(
          this.composeOutboundMessage(text),
          projectPath,
          resumeId,
          (delta) => {
            this.appendAssistantDelta(assistantId, delta);
            onDelta?.(delta);
          },
          (turnId, summaryIndex, delta) => {
            this.bindTurnId(assistantId, turnId);
            const key = `${side}|${turnId}|${summaryIndex}`;
            this.reasoningMap.set(key, (this.reasoningMap.get(key) || '') + delta);
            this.sync();
          },
          (result) => {
            if (!result.ok && allowRetryWithoutSession && this.shouldRetryWithoutSession(tool, resumeId, result.message)) {
              this.appendSystem('远端会话恢复失败，已自动切换为新会话重试', side, 'remote');
              runAttempt(undefined, false);
              return;
            }

            this.setSending(side, false);
            if (!result.ok) {
              this.appendSystem(`远端请求执行失败：${result.message}`, side, 'remote');
              resolve({ ok: false, message: result.message });
              return;
            }
            this.upsertAssistant(assistantId, result.text, side);
            onDone?.(result.text);
            resolve({ ok: true, text: result.text });
          }
        );
      };

      runAttempt(sessionId || undefined, !!sessionId);
    });
  }

  private async handleRemoteInterrupt(): Promise<void> {
    const side = this.state.remoteExportSide;
    for (const tool of ['codex', 'claude', 'remote'] as const) {
      this.workers[side][tool].interrupt();
    }
    this.interruptedBySide[side] = true;
    this.setSending(side, false);
    this.appendSystem(`远端请求已打断 ${side}`, side, 'remote');
  }

  private preferredHubEndpoint(urls: string[]): string {
    const preferred = urls.find((url) => !url.includes('127.0.0.1') && !url.includes('localhost'));
    return preferred || urls[0] || `http://127.0.0.1:${this.state.remoteListenPort}`;
  }

  private describeRemoteToken(): string {
    const token = this.state.remoteToken.trim();
    if (!token) return '访问 Key 缺失';
    if (token.length < 8) return '访问 Key 偏短';
    return `访问 Key 已就绪 (${token.length} 字符)`;
  }

  private buildRemoteConnectionSnippet(): string {
    const lines = ['# Agent Bridge Remote 连接配置'];
    const isHost = this.state.remoteMode === 'host';
    const exportTool = isHost ? this.selectedRemoteHostTool() : this.state.remoteTargetTool;
    const exportProjectPath = isHost ? this.selectedRemoteHostProjectPath() : this.state.remoteTargetProjectPath.trim();
    const exportSessionId = isHost ? this.selectedRemoteHostSessionId(this.selectedRemoteHostProjectPath()) : this.state.remoteTargetSessionId.trim();
    if (isHost) {
      lines.push('mode=client');
      if (this.state.remoteHubUrl.trim()) {
        lines.push(`hubUrl=${this.state.remoteHubUrl.trim()}`);
        lines.push(`peerId=${this.localRemoteNodeId}`);
      } else {
        lines.push(`remoteUrl=${this.preferredHubEndpoint(this.formatHostEndpoints(this.state.remoteListenPort))}`);
      }
    } else {
      lines.push(`mode=${this.state.remoteMode}`);
      if (this.state.remoteHubUrl.trim()) lines.push(`hubUrl=${this.state.remoteHubUrl.trim()}`);
      if (this.state.remoteUrl.trim()) lines.push(`remoteUrl=${this.state.remoteUrl.trim()}`);
      if (this.state.remotePeerId.trim()) lines.push(`peerId=${this.state.remotePeerId.trim()}`);
    }
    lines.push(`token=${this.state.remoteToken.trim()}`);
    lines.push('tool=remote');
    lines.push(`targetTool=${exportTool}`);
    if (exportProjectPath) lines.push(`targetProjectPath=${exportProjectPath}`);
    if (exportSessionId) lines.push(`targetSessionId=${exportSessionId}`);
    const targetLabel = isHost
      ? [this.state.remoteDeviceName.trim() || os.hostname(), exportTool, exportProjectPath || '(未指定项目)', exportSessionId || 'new-session'].join(' | ')
      : (this.state.remoteTargetLabel || [exportTool, exportProjectPath || '(未指定项目)', exportSessionId || 'new-session'].join(' | '));
    lines.push(`targetLabel=${targetLabel}`);
    return lines.join('\n');
  }

  public applyRemoteConfigSnippet(raw: string): { ok: boolean; message: string } {
    return this.applyRemoteConfigSnippetInternal(raw);
  }

  private applyRemoteConfigSnippetInternal(raw: string): { ok: boolean; message: string } {
    const values = new Map<string, string>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!key || !value) continue;
      values.set(key, value);
    }

    if (values.size === 0) {
      return { ok: false, message: '没有识别到可用配置' };
    }

    const mode = values.get('mode');
    if (mode === 'host' || mode === 'client' || mode === 'off') {
      this.state.remoteMode = this.normalizeRemoteMode(mode);
    }
    this.state.remoteUrl = values.get('remoteUrl') || '';
    this.state.remoteHubUrl = values.get('hubUrl') || '';
    this.state.remotePeerId = values.get('peerId') || '';
    if (values.has('token')) this.state.remoteToken = this.normalizeRemoteToken(values.get('token'));
    if (values.get('targetTool') === 'codex' || values.get('targetTool') === 'claude') {
      this.state.remoteTargetTool = values.get('targetTool') as LocalCliTool;
    }
    this.state.remoteTargetProjectPath = values.get('targetProjectPath') || '';
    this.state.remoteTargetSessionId = values.get('targetSessionId') || '';
    this.state.remoteTargetLabel = values.get('targetLabel') || '';
    if (this.state.toolA !== 'remote' && this.state.toolB !== 'remote') {
      const side = this.pickRemoteImportSide();
      if (side === 'A') {
        this.state.toolA = 'remote';
        this.state.sessionA = '';
      } else {
        this.state.toolB = 'remote';
        this.state.sessionB = '';
      }
    }
    return { ok: true, message: '配置已应用' };
  }

  private async checkRemoteConnectivity(): Promise<void> {
    if (this.state.remoteMode !== 'client') {
      this.state.remoteConnectivity = this.state.remoteMode === 'host' ? 'ok' : 'idle';
      return;
    }
    this.state.remoteConnectivity = 'checking';

    try {
      const hubUrl = this.state.remoteHubUrl.trim();
      if (hubUrl) {
        const hubHealth = await fetch(`${hubUrl.replace(/\/$/, '')}/health`);
        if (!hubHealth.ok) {
          this.state.remoteConnectivity = 'error';
          return;
        }
        if (!this.state.remotePeerId.trim()) {
          this.state.remoteConnectivity = 'error';
          return;
        }
        const response = await fetch(
          `${hubUrl.replace(/\/$/, '')}/relay/health?token=${encodeURIComponent(this.state.remoteToken.trim())}&targetNodeId=${encodeURIComponent(this.state.remotePeerId.trim())}`
        );
        this.state.remoteConnectivity = response.ok ? 'ok' : 'error';
        return;
      }

      const remoteUrl = this.state.remoteUrl.trim();
      if (!remoteUrl) {
        this.state.remoteConnectivity = 'error';
        return;
      }
      const baseUrl = remoteUrl.endsWith('/invoke')
        ? remoteUrl.slice(0, -'/invoke'.length)
        : remoteUrl.replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/health`);
      this.state.remoteConnectivity = response.ok ? 'ok' : 'error';
    } catch {
      this.state.remoteConnectivity = 'error';
    }
  }

  private stopRemoteHeartbeat(): void {
    if (!this.remoteHeartbeatTimer) return;
    clearInterval(this.remoteHeartbeatTimer);
    this.remoteHeartbeatTimer = null;
  }

  private scheduleRemoteHeartbeat(invokeBaseUrl: string, discoverable: boolean): void {
    this.stopRemoteHeartbeat();
    this.remoteHeartbeatTimer = setInterval(() => {
      this.registerWithHub(invokeBaseUrl, discoverable).catch(() => undefined);
    }, 20_000);
  }

  private startRemotePeerRefreshLoop(): void {
    this.stopRemotePeerRefreshLoop();
    this.remotePeerRefreshTimer = setInterval(() => {
      if (!this.panel) return;
      if (!this.state.remoteHubUrl.trim()) return;
      if (this.state.remoteMode !== 'client' && this.state.remoteMode !== 'host') return;
      this.refreshRemoteBridge()
        .then(() => this.sync())
        .catch(() => undefined);
    }, 15_000);
  }

  private stopRemotePeerRefreshLoop(): void {
    if (!this.remotePeerRefreshTimer) return;
    clearInterval(this.remotePeerRefreshTimer);
    this.remotePeerRefreshTimer = null;
  }

  private async registerWithHub(invokeBaseUrl: string, discoverable: boolean): Promise<boolean> {
    const hubUrl = this.state.remoteHubUrl.trim();
    const accessToken = this.state.remoteToken.trim();
    if (!hubUrl) return false;

    try {
      const response = await fetch(`${hubUrl.replace(/\/$/, '')}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: this.localRemoteNodeId,
          deviceName: this.state.remoteDeviceName.trim() || os.hostname(),
          invokeUrl: `${invokeBaseUrl.replace(/\/$/, '')}/invoke`,
          accessToken,
          exportSide: this.state.remoteExportSide,
          discoverable
        })
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async unregisterFromHub(): Promise<void> {
    const hubUrl = this.state.remoteHubUrl.trim();
    const accessToken = this.state.remoteToken.trim();
    if (!hubUrl) return;
    try {
      await fetch(`${hubUrl.replace(/\/$/, '')}/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: this.localRemoteNodeId,
          accessToken
        })
      });
    } catch {
      return;
    }
  }

  private async refreshHubPeers(): Promise<void> {
    const hubUrl = this.state.remoteHubUrl.trim();
    if (!hubUrl) {
      this.state.remotePeerOptions = [];
      return;
    }

    try {
      const response = await fetch(
        `${hubUrl.replace(/\/$/, '')}/peers?selfId=${encodeURIComponent(this.localRemoteNodeId)}`
      );
      if (!response.ok) {
        this.state.remotePeerOptions = [];
        return;
      }
      const payload = await response.json() as {
        peers?: Array<{ nodeId?: string; deviceName?: string; invokeUrl?: string; exportSide?: string }>;
      };
      const options = (payload.peers || [])
        .filter((peer) => typeof peer.nodeId === 'string' && peer.nodeId)
        .map((peer) => ({
          id: String(peer.nodeId),
          label: [
            peer.deviceName || peer.nodeId,
            peer.exportSide ? `导出${peer.exportSide}` : '',
            peer.invokeUrl || ''
          ].filter(Boolean).join(' · ')
        }));
      this.state.remotePeerOptions = options;
      if (!this.state.remotePeerId && options.length === 1) {
        this.state.remotePeerId = options[0].id;
      }
      if (this.state.remotePeerId && !options.some((item) => item.id === this.state.remotePeerId)) {
        this.state.remotePeerId = '';
      }
    } catch {
      this.state.remotePeerOptions = [];
    }
  }

  private normalizedResumeId(tool: CliTool, rawValue: string, projectPath: string): string {
    const value = (rawValue || '').trim();
    if (!value) return '';
    if (['新会话', '新对话', 'new', 'new session'].includes(value.toLowerCase())) return '';

    const matchingEntries = this.state.sessionOptions.filter((item) => item.id === value);
    if (matchingEntries.length > 0) {
      const matching = matchingEntries.find((item) =>
        item.tool === tool &&
        this.matchesProject(item.cwd || '', projectPath || '')
      );
      return matching ? value : '';
    }

    return /^(urn:uuid:)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
      ? value
      : '';
  }

  private matchesProject(sessionCwd: string, projectPath: string): boolean {
    const normalizedProject = (projectPath || '').trim();
    if (!normalizedProject) return false;
    const normalizedCwd = (sessionCwd || '').trim();
    if (!normalizedCwd) return false;

    if (normalizedCwd.startsWith(normalizedProject)) return true;

    const projectName = normalizedProject.split('/').filter(Boolean).pop() || '';
    if (!projectName) return false;

    const cwdName = normalizedCwd.split('/').filter(Boolean).pop() || '';
    if (cwdName === projectName) return true;

    const parts = normalizedCwd.split('/').filter(Boolean);
    const codexIdx = parts.indexOf('.codex');
    if (codexIdx >= 0 && codexIdx + 2 < parts.length && parts[codexIdx + 1] === 'worktrees') {
      return parts[codexIdx + 2] === projectName;
    }
    return false;
  }

  private isStageDone(text: string): boolean {
    return isStageDone(text, this.state.stageDoneMarkers);
  }

  private sanitizedRelayPayload(text: string): string {
    return sanitizedRelayPayload(text);
  }

  private bindTurnId(messageId: string, turnId: string): void {
    const idx = this.state.chatItems.findIndex((item) => item.id === messageId);
    if (idx < 0) return;
    this.state.chatItems[idx] = { ...this.state.chatItems[idx], turnId };
  }

  private appendAssistantDelta(messageId: string, delta: string): void {
    const idx = this.state.chatItems.findIndex((item) => item.id === messageId);
    if (idx < 0) return;
    const old = this.state.chatItems[idx];
    this.state.chatItems[idx] = { ...old, text: old.text + delta };
    this.sync();
  }

  private upsertAssistant(messageId: string, text: string, side: Side): void {
    const idx = this.state.chatItems.findIndex((item) => item.id === messageId);
    if (idx < 0) {
      this.appendChat({ id: messageId, time: Date.now(), side, role: 'assistant', text });
      return;
    }
    this.state.chatItems[idx] = { ...this.state.chatItems[idx], side, text };
    this.sync();
  }

  private appendChat(item: ChatItem): void {
    this.state.chatItems.push(item);
    this.sync();
  }

  private appendSystem(text: string, side?: Side, channel?: ChatChannel): void {
    this.state.chatItems.push({ id: randomUUID(), time: Date.now(), side, role: 'system', text, channel });
    this.sync();
  }

  private setSending(side: Side, value: boolean): void {
    if (side === 'A') this.state.isSendingA = value;
    if (side === 'B') this.state.isSendingB = value;
    this.sync();
  }

  private sync(): void {
    if (!this.webview) return;
    const reasoningByTurn: Record<string, string> = {};
    for (const item of this.state.chatItems) {
      if (item.role !== 'assistant' || !item.side || !item.turnId) continue;
      const keyPrefix = `${item.side}|${item.turnId}|`;
      const chunks = [...this.reasoningMap.entries()]
        .filter(([k]) => k.startsWith(keyPrefix))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, v]) => v);
      if (chunks.length > 0) reasoningByTurn[item.turnId] = chunks.join('');
    }

    this.webview.postMessage({ type: 'state', state: this.state, reasoningByTurn });
  }

  private async loadCliOptions(): Promise<void> {
    this.cliHealthCache.clear();
    const home = os.homedir();
    const codexDir = path.join(home, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const historyPath = path.join(codexDir, 'history.jsonl');
    const claudeProjectsDir = path.join(home, '.claude', 'projects');
    const availableHostTools = this.detectAvailableHostTools();

    const [projects, claudeProjects, codexSessions, claudeSessions] = await Promise.all([
      this.parseProjects(configPath),
      this.parseClaudeProjects(claudeProjectsDir),
      this.parseCodexSessions(historyPath, codexDir),
      this.parseClaudeSessions(claudeProjectsDir)
    ]);

    const mergedProjects = new Set<string>(projects);
    for (const project of claudeProjects) {
      if (project.trim()) mergedProjects.add(project.trim());
    }
    if (this.state.projectAPath?.trim()) mergedProjects.add(this.state.projectAPath.trim());
    if (this.state.projectBPath?.trim()) mergedProjects.add(this.state.projectBPath.trim());
    this.state.projectOptions = [...mergedProjects].sort((a, b) => a.localeCompare(b));
    this.state.sessionOptions = [...codexSessions, ...claudeSessions];
    this.state.availableHostTools = availableHostTools;
    this.state.remoteHostTool = this.normalizeHostTool(this.state.remoteHostTool);
  }

  private detectAvailableHostTools(): LocalCliTool[] {
    const tools: LocalCliTool[] = [];
    if (this.isCodexCliAvailable()) tools.push('codex');
    if (this.isClaudeCliAvailable()) tools.push('claude');
    return tools;
  }

  private isCodexCliAvailable(): boolean {
    return this.probeLocalCli('codex').ok;
  }

  private isClaudeCliAvailable(): boolean {
    return this.probeLocalCli('claude').ok;
  }

  private localCliFailureMessage(tool: CliTool): string {
    if (tool === 'remote') return '';
    const result = this.probeLocalCli(tool);
    return result.ok ? '' : result.message;
  }

  private probeLocalCli(tool: LocalCliTool): { ok: boolean; message: string } {
    const cached = this.cliHealthCache.get(tool);
    if (cached) return cached;

    try {
      const executable = tool === 'codex' ? resolveCodexExecutable() : resolveClaudeExecutable();
      const probe = spawnSync(executable, ['--version'], {
        encoding: 'utf8',
        timeout: 8_000
      });

      if ((probe.status ?? 1) === 0) {
        const result = { ok: true, message: '' };
        this.cliHealthCache.set(tool, result);
        return result;
      }

      const detail = `${probe.stderr || probe.stdout || ''}`.replace(/\s+/g, ' ').trim();
      const prefix = tool === 'codex' ? 'Codex CLI 不可用' : 'Claude CLI 不可用';
      const result = {
        ok: false,
        message: detail ? `${prefix}：${detail}` : `${prefix}：退出码 ${probe.status ?? 'unknown'}`
      };
      this.cliHealthCache.set(tool, result);
      return result;
    } catch (err: any) {
      const result = { ok: false, message: err?.message || `${tool} CLI 不可用` };
      this.cliHealthCache.set(tool, result);
      return result;
    }
  }

  private async parseProjects(configPath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(configPath, 'utf8');
      const regex = /^\s*\[projects\."(.+)"\]\s*$/gm;
      const projects = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const value = (match[1] || '').replace(/\\"/g, '"').trim();
        if (value) projects.add(value);
      }
      return [...projects].sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private async parseCodexSessions(historyPath: string, codexDir: string): Promise<SessionOption[]> {
    try {
      const content = await fs.readFile(historyPath, 'utf8');
      const latestTsBySession = new Map<string, number>();
      const firstTextBySession = new Map<string, string>();

      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: any;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const sessionId = typeof obj.session_id === 'string' ? obj.session_id : '';
        if (!sessionId) continue;
        const ts = Number.isFinite(obj.ts) ? Number(obj.ts) : 0;
        if (!firstTextBySession.has(sessionId)) {
          const text = typeof obj.text === 'string' ? obj.text : '';
          firstTextBySession.set(sessionId, this.firstLinePreview(text));
        }
        const prev = latestTsBySession.get(sessionId) ?? 0;
        if (ts > prev) latestTsBySession.set(sessionId, ts);
      }

      const metaEntries = await this.parseSessionMetaEntries(codexDir);
      const topIds = [...this.mergeSessionScores(latestTsBySession, metaEntries).entries()]
        .sort((a, b) => {
          if (b[1] === a[1]) return b[0].localeCompare(a[0]);
          return b[1] - a[1];
        })
        .slice(0, BridgeController.maxSessionOptions)
        .map(([id]) => id);
      if (topIds.length === 0) return [];

      const cwdBySession = await this.parseSessionCwds(new Set(topIds), codexDir);
      const metaById = new Map(metaEntries.map((entry) => [entry.id, entry]));

      return topIds.map((id) => {
        const preview = firstTextBySession.get(id) || '(无首句)';
        return {
          id,
          displayLabel: `${id.slice(0, 8)} - ${preview}`,
          cwd: cwdBySession.get(id) || metaById.get(id)?.cwd || '',
          tool: 'codex'
        };
      });
    } catch {
      const metaEntries = await this.parseSessionMetaEntries(codexDir);
      return metaEntries
        .slice(0, BridgeController.maxSessionOptions)
        .map((entry) => ({
        id: entry.id,
        displayLabel: `${entry.id.slice(0, 8)} - (无首句)`,
        cwd: entry.cwd,
        tool: 'codex'
      }));
    }
  }

  private async parseClaudeSessions(claudeProjectsDir: string): Promise<SessionOption[]> {
    const byId = new Map<string, { id: string; cwd: string; preview: string; sortTs: number }>();
    const files = await this.listJsonlFiles(claudeProjectsDir);

    for (const file of files) {
      const head = await this.readFileHead(file, 96 * 1024);
      if (!head) continue;
      const lines = head.split(/\r?\n/).filter(Boolean).slice(0, 96);
      let sessionId = '';
      let cwd = '';
      let preview = '(无首句)';
      let sortTs = 0;

      for (const line of lines) {
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const candidateId = typeof obj.sessionId === 'string' ? obj.sessionId : '';
        if (candidateId) sessionId = candidateId;
        if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd.trim();
        if (!sortTs && typeof obj.timestamp === 'string') {
          const ts = Date.parse(obj.timestamp);
          if (Number.isFinite(ts)) sortTs = ts;
        }
        if (preview === '(无首句)' && obj.type === 'user') {
          const content = this.extractClaudeMessageText(obj.message?.content);
          if (content) {
            preview = this.firstLinePreview(content);
          }
        }
      }

      if (!sessionId) {
        const base = path.basename(file, '.jsonl');
        if (base) sessionId = base;
      }
      if (!sessionId) continue;
      if (!cwd) {
        cwd = await this.resolveClaudeProjectPath(path.dirname(file));
      }
      if (!sortTs) {
        try {
          sortTs = (await fs.stat(file)).mtimeMs;
        } catch {
          sortTs = 0;
        }
      }

      const existing = byId.get(sessionId);
      if (!existing || sortTs > existing.sortTs) {
        byId.set(sessionId, { id: sessionId, cwd, preview, sortTs });
      }
    }

    return [...byId.values()]
      .sort((a, b) => b.sortTs - a.sortTs)
      .slice(0, BridgeController.maxSessionOptions)
      .map((entry) => ({
        id: entry.id,
        displayLabel: `${entry.id.slice(0, 8)} - ${entry.preview}`,
        cwd: entry.cwd,
        tool: 'claude' as const
      }));
  }

  private async parseClaudeProjects(claudeProjectsDir: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(claudeProjectsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const projects = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const decoded = await this.resolveClaudeProjectPath(path.join(claudeProjectsDir, entry.name));
      if (decoded) projects.add(decoded);
    }
    return [...projects].sort((a, b) => a.localeCompare(b));
  }

  private async resolveClaudeProjectPath(projectDir: string): Promise<string> {
    const cached = this.claudeProjectPathCache.get(projectDir);
    if (cached) return cached;

    const resolver = (async () => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(projectDir, { withFileTypes: true });
      } catch {
        return this.decodeClaudeProjectName(path.basename(projectDir));
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const head = await this.readFileHead(path.join(projectDir, entry.name), 64 * 1024);
        if (!head) continue;
        for (const line of head.split(/\r?\n/).filter(Boolean).slice(0, 64)) {
          let obj: any;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof obj.cwd === 'string' && obj.cwd.trim()) {
            return obj.cwd.trim();
          }
        }
      }

      return this.decodeClaudeProjectName(path.basename(projectDir));
    })();

    this.claudeProjectPathCache.set(projectDir, resolver);
    return resolver;
  }

  private extractClaudeMessageText(content: unknown): string {
    if (typeof content === 'string') {
      return content.trim();
    }
    if (!Array.isArray(content)) return '';

    const chunks = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          return String((item as { text: string }).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();

    return chunks;
  }

  private decodeClaudeProjectName(name: string): string {
    if (!name || name.startsWith('.')) return '';
    let decoded = '';
    for (let i = 0; i < name.length; i += 1) {
      const ch = name[i];
      if (ch !== '-') {
        decoded += ch;
        continue;
      }
      if (name[i + 1] === '-') {
        decoded += '-';
        i += 1;
      } else {
        decoded += '/';
      }
    }
    return decoded.startsWith('/') ? decoded : `/${decoded}`;
  }

  private async parseSessionMetaEntries(codexDir: string): Promise<Array<{ id: string; cwd: string; sortTs: number }>> {
    const byId = new Map<string, { id: string; cwd: string; sortTs: number }>();
    const roots = [
      path.join(codexDir, 'sessions'),
      path.join(codexDir, 'archived_sessions')
    ];

    for (const root of roots) {
      const files = await this.listJsonlFiles(root);
      for (const file of files) {
        const head = await this.readFileHead(file, 16 * 1024);
        if (!head) continue;

        const lines = head.split(/\r?\n/).slice(0, 12);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let meta: any;
          try {
            meta = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (meta?.type !== 'session_meta') continue;
          const payload = meta?.payload || {};
          const id = typeof payload.id === 'string' ? payload.id : '';
          if (!id) break;

          const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
          const payloadTs = typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : NaN;
          let fileMtime = 0;
          try {
            const stat = await fs.stat(file);
            fileMtime = stat.mtimeMs;
          } catch {
            fileMtime = 0;
          }
          const sortTs = Math.max(Number.isFinite(payloadTs) ? payloadTs : 0, fileMtime);
          const existing = byId.get(id);
          if (!existing || sortTs > existing.sortTs) {
            byId.set(id, { id, cwd, sortTs });
          }
          break;
        }
      }
    }

    return [...byId.values()].sort((a, b) => b.sortTs - a.sortTs);
  }

  private async parseSessionCwds(sessionIds: Set<string>, codexDir: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    let remaining = new Set(sessionIds);
    const roots = [
      path.join(codexDir, 'sessions'),
      path.join(codexDir, 'archived_sessions')
    ];

    for (const root of roots) {
      if (remaining.size === 0) break;
      const files = await this.listJsonlFiles(root);
      for (const file of files) {
        if (remaining.size === 0) break;
        const head = await this.readFileHead(file, 16 * 1024);
        if (!head) continue;

        const lines = head.split(/\r?\n/).slice(0, 8);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let meta: any;
          try {
            meta = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (meta?.type !== 'session_meta') continue;
          const payload = meta?.payload || {};
          const id = typeof payload.id === 'string' ? payload.id : '';
          const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
          if (!id || !remaining.has(id)) continue;
          if (cwd) result.set(id, cwd);
          remaining.delete(id);
          break;
        }
      }
    }
    return result;
  }

  private async listJsonlFiles(root: string): Promise<string[]> {
    const result: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && fullPath.endsWith('.jsonl')) {
          result.push(fullPath);
        }
      }
    };
    await walk(root);
    return result;
  }

  private async readFileHead(filePath: string, maxBytes: number): Promise<string> {
    try {
      const handle = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      return '';
    }
  }

  private firstLinePreview(raw: string): string {
    const line = (raw || '')
      .split(/\r?\n/, 1)[0]
      .replace(/\t/g, ' ')
      .trim();
    if (!line) return '(无首句)';
    if (line.length <= 40) return line;
    return line.slice(0, 40) + '...';
  }

  private mergeSessionScores(
    latestTsBySession: Map<string, number>,
    metaEntries: Array<{ id: string; cwd: string; sortTs: number }>
  ): Map<string, number> {
    const scores = new Map<string, number>();
    for (const [id, ts] of latestTsBySession.entries()) {
      scores.set(id, ts * 1000);
    }
    for (const entry of metaEntries) {
      const prev = scores.get(entry.id) ?? 0;
      scores.set(entry.id, Math.max(prev, entry.sortTs));
    }
    return scores;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new BridgeController();
  const sidebarProvider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      const projectPath = workspace?.uri.fsPath || '';
      webviewView.webview.options = {
        enableScripts: true
      };
      webviewView.webview.onDidReceiveMessage((message) => {
        controller.onWebviewMessage(message);
      });
      webviewView.webview.html = getHtml(webviewView.webview);
      controller.attachWebview(webviewView.webview, projectPath);
      webviewView.onDidDispose(() => {
        controller.dispose();
      });
    }
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codexBridge.sidebar', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('codexBridge.openWithCurrentProject', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.codexBridgeSidebar');
    })
  );
}

export function deactivate(): void {}

function getHtml(webview: vscode.Webview): string {
  const nonce = randomUUID();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Bridge</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --panel: color-mix(in srgb, var(--vscode-editorWidget-background) 86%, transparent);
      --panel-strong: color-mix(in srgb, var(--vscode-sideBar-background) 72%, var(--vscode-editor-background));
      --border: var(--vscode-editorWidget-border);
      --border-soft: color-mix(in srgb, var(--vscode-editorWidget-border) 55%, transparent);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-button-background);
      --accent-fg: var(--vscode-button-foreground);
      --accent-soft: color-mix(in srgb, var(--vscode-button-background) 16%, transparent);
      --danger-soft: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
      --warning-soft: color-mix(in srgb, #d29922 16%, transparent);
      --success-soft: color-mix(in srgb, #2ea043 16%, transparent);
      --shadow: 0 12px 28px rgba(0,0,0,0.14);
      --radius: 16px;
      --radius-sm: 12px;
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      margin: 0;
      padding: 16px;
      color: var(--vscode-foreground);
      background:
        radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 12%, transparent), transparent 24%),
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 92%, black), var(--vscode-editor-background));
    }
    .tabbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px;
      margin-bottom: 14px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--panel-strong) 88%, transparent);
      border: 1px solid var(--border-soft);
      box-shadow: var(--shadow);
      position: sticky;
      top: 0;
      z-index: 2;
      backdrop-filter: blur(10px);
    }
    .tabbar-main,
    .tabbar-side {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .tab-btn {
      background: transparent;
      color: var(--muted);
      border: 1px solid transparent;
      padding: 8px 14px;
      border-radius: 999px;
      font-weight: 700;
      letter-spacing: .02em;
      cursor: pointer;
    }
    .tab-btn.active {
      background: var(--accent);
      color: var(--accent-fg);
      border-color: color-mix(in srgb, var(--accent) 70%, white 30%);
    }
    .tab-btn.secondary {
      background: color-mix(in srgb, var(--panel) 82%, transparent);
      color: var(--vscode-foreground);
      border-color: var(--border-soft);
    }
    .tab-btn:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .tab-page { display: none; }
    .tab-page.active { display: block; }
    .app {
      display: grid;
      grid-template-columns: minmax(320px, 360px) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .panel {
      border: 1px solid var(--border-soft);
      background: var(--panel);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow: hidden;
      backdrop-filter: blur(8px);
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 14px 16px 10px;
    }
    .panel-body { padding: 0 16px 16px; }
    .hero {
      padding: 16px;
      border-bottom: 1px solid var(--border-soft);
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent 56%),
        linear-gradient(180deg, color-mix(in srgb, var(--panel-strong) 94%, transparent), transparent);
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .title {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin: 0 0 6px;
    }
    .subtitle {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
      font-size: 12px;
    }
    .stack { display: flex; flex-direction: column; gap: 12px; width: 100%; }
    .row {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 10px;
    }
    .field-grid { display: grid; gap: 10px; }
    .dual-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .field label {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
    }
    input:not([type="checkbox"]), textarea, select {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
      outline: none;
      font: inherit;
      caret-color: var(--vscode-editorCursor-foreground);
      transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
    }
    select {
      padding-right: 30px;
      appearance: auto;
      -webkit-appearance: menulist;
    }
    input:not([type="checkbox"])::placeholder, textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    input:not([type="checkbox"]):focus, select:focus, textarea:focus {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset, 0 0 0 4px color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
    }
    input[readonly] {
      opacity: 0.92;
      background: color-mix(in srgb, var(--vscode-input-background) 82%, var(--vscode-editor-background));
    }
    input:-webkit-autofill, textarea:-webkit-autofill, select:-webkit-autofill {
      -webkit-text-fill-color: var(--vscode-input-foreground);
      -webkit-box-shadow: 0 0 0px 1000px var(--vscode-input-background) inset;
      transition: background-color 9999s ease-in-out 0s;
    }
    input[type="checkbox"] { width: auto; margin: 0; }
    textarea {
      min-height: 108px;
      resize: vertical;
      line-height: 1.5;
    }
    .toggle-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .toggle-card {
      flex: 1 1 150px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 11px 12px;
      border: 1px solid var(--border-soft);
      border-radius: 12px;
      background: color-mix(in srgb, var(--panel-strong) 72%, transparent);
    }
    .toggle-copy strong {
      display: block;
      font-size: 12px;
      margin-bottom: 2px;
    }
    .toggle-copy span,
    .hint,
    .muted {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .chip-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border-radius: 999px;
      background: var(--panel-strong);
      border: 1px solid var(--border-soft);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .status-pill strong { color: var(--vscode-foreground); }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      background: var(--vscode-disabledForeground);
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--vscode-disabledForeground) 14%, transparent);
    }
    .status-dot.ok {
      background: #2ea043;
      box-shadow: 0 0 0 6px var(--success-soft);
    }
    .status-dot.error {
      background: #d1242f;
      box-shadow: 0 0 0 6px color-mix(in srgb, #d1242f 14%, transparent);
    }
    .status-dot.checking {
      background: #d29922;
      box-shadow: 0 0 0 6px var(--warning-soft);
    }
    .status-card {
      padding: 12px;
      border-radius: 14px;
      border: 1px solid var(--border-soft);
      background: color-mix(in srgb, var(--panel-strong) 76%, transparent);
    }
    .hidden { display: none !important; }
    .advanced-details {
      display: block;
      border: 1px solid var(--border-soft);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
      backdrop-filter: blur(8px);
    }
    .advanced-details summary {
      list-style: none;
      cursor: pointer;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, transparent), transparent 60%),
        color-mix(in srgb, var(--panel-strong) 84%, transparent);
    }
    .advanced-details summary::-webkit-details-marker { display: none; }
    .advanced-details[open] summary {
      border-bottom: 1px solid var(--border-soft);
    }
    .summary-copy {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .summary-copy strong {
      font-size: 13px;
      color: var(--vscode-foreground);
      letter-spacing: 0.01em;
    }
    .advanced-body {
      padding: 14px;
    }
    .remote-chat {
      max-height: 38vh;
      overflow: auto;
      border: 1px solid var(--border-soft);
      border-radius: 14px;
      padding: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, black 12%);
    }
    .empty-state {
      padding: 14px;
      border-radius: 12px;
      border: 1px dashed var(--border-soft);
      color: var(--muted);
      background: color-mix(in srgb, var(--panel-strong) 62%, transparent);
      line-height: 1.5;
    }
    .inline-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .chat-shell {
      display: grid;
      grid-template-rows: auto minmax(340px, 1fr) auto;
      min-height: 76vh;
    }
    .chat {
      margin: 0 16px;
      max-height: 58vh;
      overflow: auto;
      border: 1px solid var(--border-soft);
      border-radius: 14px;
      padding: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, black 12%);
    }
    .msg {
      border: 1px solid var(--border-soft);
      border-radius: 12px;
      padding: 10px 12px;
      margin-bottom: 10px;
      background: color-mix(in srgb, var(--panel-strong) 68%, transparent);
    }
    .msg-a { border-left: 3px solid color-mix(in srgb, var(--accent) 88%, white 12%); }
    .msg-b { border-left: 3px solid color-mix(in srgb, var(--vscode-terminal-ansiBlue) 72%, white 18%); }
    .msg-sys { border-left: 3px solid color-mix(in srgb, var(--vscode-descriptionForeground) 55%, transparent); }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      font-size: 11px;
      opacity: 0.88;
      margin-bottom: 6px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
      background: var(--accent-soft);
      color: var(--vscode-foreground);
    }
    .badge-b { background: color-mix(in srgb, var(--vscode-terminal-ansiBlue) 15%, transparent); }
    .badge-sys { background: color-mix(in srgb, var(--vscode-descriptionForeground) 12%, transparent); }
    .thinking {
      font-size: 11px;
      padding: 8px 10px;
      margin-bottom: 8px;
      border-radius: 8px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      white-space: pre-wrap;
      border: 1px dashed color-mix(in srgb, var(--border) 65%, transparent);
    }
    .text { white-space: pre-wrap; line-height: 1.55; }
    .composer {
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border-soft);
      background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--panel-strong) 78%, transparent));
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      margin-top: 10px;
    }
    .button-group {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .toggle-inline {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid var(--border-soft);
      background: color-mix(in srgb, var(--panel-strong) 76%, transparent);
    }
    button {
      background: var(--accent);
      color: var(--accent-fg);
      border: 1px solid transparent;
      padding: 9px 14px;
      border-radius: 10px;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      transition: transform 120ms ease, filter 120ms ease, border-color 120ms ease;
    }
    button:hover { filter: brightness(1.05); }
    button:active { transform: translateY(1px); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .icon-btn {
      min-width: 38px;
      width: 38px;
      height: 38px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      line-height: 1;
      border-radius: 10px;
    }
    .stop-btn {
      background: var(--danger-soft);
      color: var(--vscode-errorForeground);
      border-color: color-mix(in srgb, var(--vscode-errorForeground) 24%, transparent);
    }
    .stop-btn:hover {
      background: color-mix(in srgb, var(--vscode-errorForeground) 16%, transparent);
    }
    .typing {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-style: italic;
      letter-spacing: 0.1px;
    }
    .typing-dots {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      transform: translateY(1px);
    }
    .typing-dots span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--vscode-progressBar-background);
      opacity: 0.25;
      animation: pulse 1.1s ease-in-out infinite;
    }
    .typing-dots span:nth-child(2) { animation-delay: 0.15s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes pulse {
      0%, 80%, 100% { transform: translateY(0); opacity: 0.25; }
      40% { transform: translateY(-2px); opacity: 0.95; }
    }
    @media (max-width: 960px) {
      .app { grid-template-columns: 1fr; }
      .chat-shell { min-height: auto; }
      .chat { max-height: 46vh; }
      .dual-grid { grid-template-columns: 1fr; }
      .tabbar {
        display: flex;
        width: 100%;
        flex-wrap: wrap;
      }
      .tabbar-main,
      .tabbar-side {
        width: 100%;
      }
      .tab-btn { flex: 1 1 0; }
    }
  </style>
</head>
<body>
  <div class="tabbar">
    <div class="tabbar-main">
      <button id="tabChat" class="tab-btn active" type="button" data-tab-target="chat">桥接对话</button>
      <button id="tabRemote" class="tab-btn" type="button" data-tab-target="remote">跟我的AI说去吧</button>
    </div>
    <div class="tabbar-side">
      <span id="refreshOptionsStatus" class="hint"></span>
      <button id="refreshOptions" class="tab-btn secondary" type="button">刷新项目/线程</button>
    </div>
  </div>

  <div id="pageChat" class="tab-page active">
    <div class="app">
      <div class="stack">
        <details id="bridgeControls" class="advanced-details">
          <summary>
            <span class="summary-copy">
              <strong>桥接设置</strong>
              <span class="muted">工具、项目、最近会话和自动互发都收在这里。</span>
            </span>
            <span class="status-pill"><strong>A/B</strong><span>点击展开</span></span>
          </summary>
          <div class="advanced-body stack">
            <div class="hint">桥接对话用于让两个本地或远端 AI 在同一条对话流里接力处理任务，配置完后主视图只保留会话本身。</div>
            <div class="field-grid">
              <div class="dual-grid">
                <div class="field">
                  <label for="toolA">A 侧工具</label>
                  <select id="toolA">
                    <option value="codex">A 使用 Codex</option>
                    <option value="claude">A 使用 Claude Code</option>
                    <option value="remote">A 使用 Remote</option>
                  </select>
                </div>
                <div class="field">
                  <label for="toolB">B 侧工具</label>
                  <select id="toolB">
                    <option value="codex">B 使用 Codex</option>
                    <option value="claude">B 使用 Claude Code</option>
                    <option value="remote">B 使用 Remote</option>
                  </select>
                </div>
              </div>
              <div class="dual-grid">
                <div class="field">
                  <label for="projectASelect">A 项目</label>
                  <select id="projectASelect"></select>
                </div>
                <div class="field">
                  <label for="projectBSelect">B 项目</label>
                  <select id="projectBSelect"></select>
                </div>
              </div>
              <div class="dual-grid">
                <div class="field">
                  <label for="projectA">A 项目路径覆盖</label>
                  <input id="projectA" placeholder="Project A 可手动输入（优先）" />
                </div>
                <div class="field">
                  <label for="projectB">B 项目路径覆盖</label>
                  <input id="projectB" placeholder="Project B 可手动输入（优先）" />
                </div>
              </div>
              <div class="dual-grid">
                <div class="field">
                  <label for="sessionASelect">A 最近会话</label>
                  <select id="sessionASelect"></select>
                </div>
                <div class="field">
                  <label for="sessionBSelect">B 最近会话</label>
                  <select id="sessionBSelect"></select>
                </div>
              </div>
              <div class="dual-grid">
                <div class="field">
                  <label for="sessionA">A 会话 ID 覆盖</label>
                  <input id="sessionA" placeholder="A会话ID 可手动输入（优先）" />
                </div>
                <div class="field">
                  <label for="sessionB">B 会话 ID 覆盖</label>
                  <input id="sessionB" placeholder="B会话ID 可手动输入（优先）" />
                </div>
              </div>
            </div>
            <div class="toggle-row">
              <label class="toggle-card">
                <span class="toggle-copy">
                  <strong>自动互发</strong>
                  <span>开启后，A/B 会按回复自动接力。</span>
                </span>
                <input type="checkbox" id="autoRelay" />
              </label>
              <label class="toggle-card">
                <span class="toggle-copy">
                  <strong>阶段完成自动停止</strong>
                  <span>检测到 bridge_stage=done 时自动停下。</span>
                </span>
                <input type="checkbox" id="stopOnStageDone" />
              </label>
            </div>
            <div class="status-card">
              <div class="chip-grid">
                <span class="status-pill"><strong>A</strong><span id="statusAInline">空闲</span></span>
                <span class="status-pill"><strong>B</strong><span id="statusBInline">空闲</span></span>
              </div>
              <div class="hint" style="margin-top:8px;">发送快捷键：Enter 发给 A，Shift+Enter 换行。需要发给 B 或同时发送时，使用下方操作按钮。</div>
            </div>
          </div>
        </details>
      </div>

      <div class="panel chat-shell">
        <div class="panel-header">
          <div>
            <div class="eyebrow">Conversation Flow</div>
            <h3 class="section-title">桥接对话流</h3>
            <p class="subtitle">统一查看 A、B、Remote 和系统消息，让主界面只保留真正的对话上下文。</p>
          </div>
          <span id="status" class="status-pill">A: 空闲 | B: 空闲</span>
        </div>
        <div class="chat" id="chat"></div>
        <div class="composer">
          <div class="field">
            <label for="message">输入消息</label>
            <textarea id="message" placeholder="输入消息"></textarea>
          </div>
          <div class="actions">
            <span class="hint">回车发送到 A，Shift+回车换行。</span>
            <div class="button-group">
              <button id="sendA">发给A</button>
              <button id="sendB" class="secondary">发给B</button>
              <button id="sendBoth" class="secondary">同时发送</button>
              <button id="interrupt" class="secondary icon-btn stop-btn" title="停止" aria-label="停止">■</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="pageRemote" class="tab-page">
    <div class="app">
      <div class="stack">
        <details id="remoteModeDetails" class="advanced-details">
          <summary>
            <span class="summary-copy">
              <strong>跨设备桥接设置</strong>
              <span class="muted">定义当前设备是主机还是客户端，以及远端会话映射。</span>
            </span>
            <span class="status-pill"><strong>Remote</strong><span>点击展开</span></span>
          </summary>
          <div class="advanced-body stack">
            <div class="hint">远程对接的目标不是单向操作，而是把“本机 AI”和“其他设备 AI”拉进同一条对话流里，所以配置区默认折叠，只让对话流占主视觉。</div>
            <div class="dual-grid">
              <div class="field">
                <label for="remoteMode">远程模式</label>
                <select id="remoteMode">
                  <option value="off">跨设备: 关闭</option>
                  <option value="host">跨设备: 对外提供本机 AI</option>
                  <option value="client">跨设备: 连接远端 AI</option>
                </select>
              </div>
              <div class="field host-only">
                <label for="remoteExportSide">主机导出映射</label>
                <select id="remoteExportSide">
                  <option value="A">远端调用映射到本机 A</option>
                  <option value="B">远端调用映射到本机 B</option>
                </select>
              </div>
            </div>
          </div>
        </details>

        <details id="remoteLinkDetails" class="advanced-details">
          <summary>
            <span class="summary-copy">
              <strong>远端链路</strong>
              <span class="muted">认证、节点发现、直连地址和 Hub 信息。</span>
            </span>
            <span class="status-pill"><span id="remoteConnectivityDot" class="status-dot"></span><strong>链路状态</strong></span>
          </summary>
          <div class="advanced-body stack">
            <div class="status-card">
              <div class="hint" id="remoteStatus"></div>
            </div>
            <div class="status-card">
              <div class="field">
                <label for="remoteToken">访问 Key</label>
                <input id="remoteToken" placeholder="当前连接/分享所使用的访问 Key" />
              </div>
              <div class="hint" id="remoteTokenHint" style="margin-top:8px;"></div>
            </div>
            <div class="status-card">
              <div class="hint" id="remoteTargetLabel"></div>
            </div>
            <details id="remoteTargetDetails" class="advanced-details client-only">
              <summary>
                <span class="summary-copy">
                  <strong>远端目标</strong>
                  <span class="muted">控制远端使用的 CLI、工作目录和线程。留空线程时会新开会话。</span>
                </span>
              </summary>
              <div class="advanced-body stack">
                <div class="dual-grid">
                  <div class="field">
                    <label for="remoteTargetTool">远端 CLI</label>
                    <select id="remoteTargetTool">
                      <option value="codex">远端使用 Codex</option>
                      <option value="claude">远端使用 Claude Code</option>
                    </select>
                  </div>
                  <div class="field">
                    <label for="remoteTargetSessionId">远端线程 ID</label>
                    <input id="remoteTargetSessionId" placeholder="留空表示远端新会话" />
                  </div>
                </div>
                <div class="field">
                  <label for="remoteTargetProjectPath">远端项目路径</label>
                  <input id="remoteTargetProjectPath" placeholder="远端执行所使用的项目路径" />
                </div>
              </div>
            </details>
            <div class="inline-actions">
              <button id="refreshRemotePeers" class="secondary">刷新节点</button>
            </div>
            <details id="remoteAdvanced" class="advanced-details">
              <summary>
                <span class="summary-copy">
                  <strong>高级手动配置</strong>
                  <span class="muted">仅在不使用“粘贴连接配置”时需要。</span>
                </span>
              </summary>
              <div class="advanced-body stack">
                <div class="dual-grid">
                  <div class="field client-only">
                    <label for="remoteUrl">直连 URL</label>
                    <input id="remoteUrl" placeholder="远端直连 URL，例如 http://192.168.1.10:9238" />
                  </div>
                  <div class="field host-only">
                    <label for="remoteListenPort">监听端口</label>
                    <input id="remoteListenPort" placeholder="监听端口，默认 9238" />
                  </div>
                </div>
                <div class="dual-grid">
                  <div class="field">
                    <label for="remoteHubUrl">Hub URL</label>
                    <input id="remoteHubUrl" placeholder="Hub URL，例如 http://bridge-hub.local:9239" />
                  </div>
                  <div class="field host-only">
                    <label for="remoteDeviceName">当前设备名</label>
                    <input id="remoteDeviceName" placeholder="当前设备名（主机注册到 Hub 时展示）" />
                  </div>
                </div>
                <div class="dual-grid client-only">
                  <div class="field">
                    <label for="remotePeerSelect">Hub 节点</label>
                    <select id="remotePeerSelect"></select>
                  </div>
                  <div class="field">
                    <label for="remotePeerId">目标节点 ID</label>
                    <input id="remotePeerId" placeholder="Remote 要连接的目标节点 ID，可手填覆盖下拉" />
                  </div>
                </div>
              </div>
            </details>
          </div>
        </details>

        <details id="remoteShareDetails" class="advanced-details host-only">
          <summary>
            <span class="summary-copy">
              <strong>复制远端连接配置</strong>
              <span class="muted">直接镜像当前导出侧 A/B 的 CLI、项目路径和线程 ID，供对方一键接入。</span>
            </span>
          </summary>
          <div class="advanced-body stack">
            <div class="status-card">
              <div class="hint" id="remoteShareSummary" style="margin-top:8px;"></div>
            </div>
            <div class="inline-actions">
              <button id="copyShareLink" class="secondary">一键复制连接配置</button>
              <span id="copyShareLinkStatus" class="hint"></span>
            </div>
            <textarea id="remoteConnectionSnippet" readonly placeholder="这里会生成可直接复制给对方使用的 Remote 连接配置"></textarea>
          </div>
        </details>

        <details id="remoteImportDetails" class="advanced-details off-or-client">
          <summary>
            <span class="summary-copy">
              <strong>粘贴连接配置</strong>
              <span class="muted">推荐优先使用。粘贴后会自动补全远端地址、Token 和目标线程，也支持手动点击按钮再次应用。</span>
            </span>
          </summary>
          <div class="advanced-body stack">
            <div class="inline-actions">
              <button id="applyRemoteConfig" class="secondary">应用配置</button>
              <span id="remoteImportStatus" class="hint"></span>
            </div>
            <textarea id="remoteConfigPaste" placeholder="把别人发给你的连接配置粘贴到这里，然后点“应用配置”"></textarea>
          </div>
        </details>
      </div>

      <div class="panel chat-shell">
        <div class="panel-header">
          <div>
            <div class="eyebrow">Remote Conversation</div>
            <h3 class="section-title">跨设备对话流</h3>
            <p class="subtitle">这里展示的是本机 AI 与其他设备 AI 的共享会话，不再只是操作面板。</p>
          </div>
          <span id="remoteConversationStatus" class="status-pill">远程未启用</span>
        </div>
        <div class="chat" id="remoteChat"></div>
        <div class="composer">
          <div id="remoteEmptyState" class="empty-state">启用远程主机或客户端模式后，这里会显示跨设备对话流。</div>
          <div id="remoteChatWrap" class="hidden">
            <div class="field">
              <label for="remoteMessage">输入远程桥接消息</label>
              <textarea id="remoteMessage" placeholder="输入要注入到跨设备对话流中的消息"></textarea>
            </div>
            <div class="actions">
              <span class="hint" id="remoteSendHint"></span>
              <div class="button-group">
                <label class="toggle-inline client-only" for="remoteAutoRelay">
                  <input type="checkbox" id="remoteAutoRelay" />
                  <span>本机 AI 与远端 AI 自动接力</span>
                </label>
                <button id="remoteSendA" class="secondary">发到 Remote A</button>
                <button id="remoteSendB" class="secondary">发到 Remote B</button>
                <button id="remoteSendBoth" class="secondary">发到全部 Remote</button>
                <button id="remoteInterrupt" class="secondary icon-btn stop-btn" title="停止远程会话" aria-label="停止远程会话">■</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let webviewState = vscode.getState() || {};
    const $ = (id) => document.getElementById(id);
    let latestState = null;
    let reasoningByTurn = {};
    let isComposing = false;
    let compositionJustEndedAt = 0;
    let copyShareStatusTimer = null;
    let refreshOptionsStatusTimer = null;
    let refreshOptionsPending = false;
    let remoteImportStatusTimer = null;
    let remoteImportApplyTimer = null;
    let lastAutoAppliedRemoteConfig = '';
    let activeTab = webviewState.activeTab === 'remote' ? 'remote' : 'chat';

    window.addEventListener('error', (event) => {
      vscode.postMessage({ type: 'webviewError', message: event.message || 'unknown error' });
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason || 'promise rejected');
      vscode.postMessage({ type: 'webviewError', message: reason });
    });

    function setActiveTab(tab) {
      activeTab = tab === 'remote' ? 'remote' : 'chat';
      $('tabChat').classList.toggle('active', activeTab === 'chat');
      $('tabRemote').classList.toggle('active', activeTab === 'remote');
      $('pageChat').classList.toggle('active', activeTab === 'chat');
      $('pageRemote').classList.toggle('active', activeTab === 'remote');
      webviewState = { ...webviewState, activeTab };
      vscode.setState(webviewState);
    }

    function getRemoteConversationSides(state) {
      if (!state) return [];
      if (state.remoteMode === 'host') {
        return state.remoteExportSide ? [state.remoteExportSide] : [];
      }
      const sides = [];
      if (state.toolA === 'remote') sides.push('A');
      if (state.toolB === 'remote') sides.push('B');
      return sides;
    }

    function getRemoteSendTargets(state) {
      if (!state) return [];
      if (state.remoteMode === 'host') {
        const targets = state.remoteExportSide ? [{ id: 'LOCAL', label: '发给本机 AI' }] : [];
        if (state.remotePeerLinked) {
          targets.push({ id: 'REMOTE', label: '发给远端 AI' });
        }
        return targets;
      }

      const remoteSides = getRemoteConversationSides(state);
      if (remoteSides.length === 1) {
        const remoteSide = remoteSides[0];
        const localSide = remoteSide === 'A' ? 'B' : 'A';
        const localTool = localSide === 'A' ? state.toolA : state.toolB;
        if (localTool !== 'remote') {
          return [
            { id: 'LOCAL', label: '发给本机 AI' },
            { id: 'REMOTE', label: '发给远端 AI' }
          ];
        }
      }

      return remoteSides.map((side) => ({ id: side, label: '发给 Remote ' + side }));
    }

    function getRemoteDefaultTarget(state) {
      const targets = getRemoteSendTargets(state);
      if (targets.length === 0) return '';
      const preferred = targets.find((item) => item.label.includes('远端') || item.label.includes('Remote'));
      if (preferred) return preferred.side;
      if (targets.length >= 1) return targets[0].side;
      return '';
    }

    function getRemoteHint(state, sides) {
      if (!state || sides.length === 0) {
        return '当前没有可用的跨设备对话流';
      }
      if (state.remoteMode === 'host') {
        return state.remotePeerLinked
          ? ('当前作为主机导出本机 ' + sides[0] + '，现在可以像客户端一样分别发给本机 AI 或远端 AI')
          : ('当前作为主机导出本机 ' + sides[0] + '，先等待远端接入，接入后双方按钮会保持一致');
      }
      if (state.remoteAutoRelayEnabled) {
        return '已开启自动接力，本机 AI 和远端 AI 会按回复继续对话，直到你手动停止或命中阶段完成标记';
      }
      if (sides.length === 1) {
        return '当前将把消息注入 Remote ' + sides[0] + ' 对应的远端 AI 线程';
      }
      return '当前可同时向 Remote A/B 注入消息';
    }

    function getRemoteEmptyStateText(state) {
      if (!state || state.remoteMode === 'off') {
        return '启用远程主机或客户端模式后，这里会显示跨设备对话流。';
      }
      if (state.remoteMode === 'host') {
        return '主机模式已启用，等待远端接入或直接向共享线程注入本机消息。';
      }
      return '先把 A 或 B 的工具切到 Remote，或者先粘贴连接配置。配置完成后，就可以直接在这里继续跨设备会话。';
    }

    function getRemoteConversationStatus(state, sides) {
      if (!state || state.remoteMode === 'off' || sides.length === 0) {
        return '远程未启用';
      }
      const connectivity =
        state.remoteConnectivity === 'ok'
          ? '链路正常'
          : state.remoteConnectivity === 'checking'
            ? '检查中'
            : state.remoteConnectivity === 'error'
              ? '链路异常'
              : '待连接';
      if (state.remoteMode === 'host') {
        return '主机 ' + sides[0] + ' · ' + connectivity;
      }
      const relay = state.remoteAutoRelayEnabled ? ' · 自动接力开' : '';
      return (sides.length === 1 ? ('Remote ' + sides[0]) : 'Remote A/B') + ' · ' + connectivity + relay;
    }

    function updateRemoteSendButtons(state) {
      const targets = getRemoteSendTargets(state);
      const first = targets[0] || null;
      const second = targets[1] || null;
      $('remoteSendA').textContent = first ? first.label : '发给对话方';
      $('remoteSendA').dataset.target = first ? first.id : '';
      $('remoteSendB').textContent = second ? second.label : '发给第二对话方';
      $('remoteSendB').dataset.target = second ? second.id : '';
      $('remoteSendBoth').textContent = '同时发给双方';
      $('remoteSendA').classList.toggle('hidden', !first);
      $('remoteSendB').classList.toggle('hidden', !second);
      $('remoteSendBoth').classList.toggle('hidden', targets.length < 2);
    }

    function getSideControlIds(side) {
      return side === 'B'
        ? {
            tool: 'toolB',
            projectInput: 'projectB',
            projectSelect: 'projectBSelect',
            sessionInput: 'sessionB',
            sessionSelect: 'sessionBSelect'
          }
        : {
            tool: 'toolA',
            projectInput: 'projectA',
            projectSelect: 'projectASelect',
            sessionInput: 'sessionA',
            sessionSelect: 'sessionASelect'
          };
    }

    function currentExportSide() {
      return ($('remoteExportSide').value || (latestState && latestState.remoteExportSide) || 'A') === 'B' ? 'B' : 'A';
    }

    function renderRemoteShareSessionMirror() {
      const summary = $('remoteShareSummary');
      if (!summary) return;

      const side = currentExportSide();
      const ids = getSideControlIds(side);
      const tool = $(ids.tool).value || (latestState && (side === 'A' ? latestState.toolA : latestState.toolB)) || 'codex';
      const toolLabel = tool === 'claude' ? 'Claude Code' : 'Codex';
      const currentProjectValue = $(ids.projectInput).value.trim() || $(ids.projectSelect).value || '';
      const currentSessionValue = $(ids.sessionInput).value.trim() || $(ids.sessionSelect).value || '';
      if (tool === 'remote') {
        summary.textContent = '当前导出侧是 Remote，本机无法直接对外提供该侧。请切换到配置了 Codex 或 Claude Code 的一侧。';
        return;
      }
      summary.textContent =
        '当前会直接镜像 ' +
        side +
        ' · ' +
        toolLabel +
        ' · ' +
        (currentProjectValue || '未指定项目') +
        ' · ' +
        (currentSessionValue || 'new-session');
    }

    function setCopyShareStatus(text) {
      const status = $('copyShareLinkStatus');
      if (!status) return;
      status.textContent = text || '';
      if (copyShareStatusTimer) {
        clearTimeout(copyShareStatusTimer);
        copyShareStatusTimer = null;
      }
      if (text) {
        copyShareStatusTimer = setTimeout(() => {
          status.textContent = '';
          copyShareStatusTimer = null;
        }, 1800);
      }
    }

    function setRefreshOptionsStatus(text, isError = false) {
      const status = $('refreshOptionsStatus');
      if (!status) return;
      status.textContent = text || '';
      status.style.color = isError
        ? 'var(--vscode-errorForeground)'
        : 'var(--vscode-descriptionForeground)';
      if (refreshOptionsStatusTimer) {
        clearTimeout(refreshOptionsStatusTimer);
        refreshOptionsStatusTimer = null;
      }
      if (text) {
        refreshOptionsStatusTimer = setTimeout(() => {
          status.textContent = '';
          refreshOptionsStatusTimer = null;
        }, 1800);
      }
    }

    function setRefreshOptionsPending(pending) {
      refreshOptionsPending = !!pending;
      const button = $('refreshOptions');
      if (!button) return;
      button.disabled = refreshOptionsPending;
      button.textContent = refreshOptionsPending ? '刷新中...' : '刷新项目/线程';
    }

    function setRemoteImportStatus(text, isError = false) {
      const status = $('remoteImportStatus');
      if (!status) return;
      status.textContent = text || '';
      status.style.color = isError
        ? 'var(--vscode-errorForeground)'
        : 'var(--vscode-descriptionForeground)';
      if (remoteImportStatusTimer) {
        clearTimeout(remoteImportStatusTimer);
        remoteImportStatusTimer = null;
      }
      if (text) {
        remoteImportStatusTimer = setTimeout(() => {
          status.textContent = '';
          status.style.color = 'var(--vscode-descriptionForeground)';
          remoteImportStatusTimer = null;
        }, isError ? 3200 : 2200);
      }
    }

    function looksLikeRemoteConfig(text) {
      return /(^|\\n)\s*[A-Za-z][A-Za-z0-9_-]*\s*=/.test(text || '');
    }

    function applyRemoteConfig(source = 'manual') {
      const text = $('remoteConfigPaste').value || '';
      if (!text.trim()) {
        setRemoteImportStatus('请先粘贴连接配置', true);
        return;
      }
      if (!looksLikeRemoteConfig(text)) {
        if (source === 'manual') {
          setRemoteImportStatus('没有识别到可用配置', true);
        }
        return;
      }
      if (source === 'auto') {
        if (text === lastAutoAppliedRemoteConfig) return;
        setRemoteImportStatus('检测到配置，正在自动应用...');
      } else {
        setRemoteImportStatus('正在应用配置...');
      }
      lastAutoAppliedRemoteConfig = text;
      vscode.postMessage({ type: 'applyRemoteConfigSnippet', text, source });
      setActiveTab('remote');
    }

    function scheduleAutoApplyRemoteConfig() {
      if (remoteImportApplyTimer) {
        clearTimeout(remoteImportApplyTimer);
        remoteImportApplyTimer = null;
      }
      const text = $('remoteConfigPaste').value || '';
      if (!text.trim()) {
        lastAutoAppliedRemoteConfig = '';
        setRemoteImportStatus('');
        return;
      }
      remoteImportApplyTimer = setTimeout(() => {
        remoteImportApplyTimer = null;
        applyRemoteConfig('auto');
      }, 260);
    }

    function syncSettings() {
      const projectAFromSelect = $('projectASelect').value || '';
      const projectBFromSelect = $('projectBSelect').value || '';
      const sessionAFromSelect = $('sessionASelect').value || '';
      const sessionBFromSelect = $('sessionBSelect').value || '';
      vscode.postMessage({
        type: 'updateSettings',
        projectAPath: $('projectA').value.trim() || projectAFromSelect,
        toolA: $('toolA').value,
        toolB: $('toolB').value,
        projectBPath: $('projectB').value.trim() || projectBFromSelect,
        sessionA: $('sessionA').value.trim() || sessionAFromSelect,
        sessionB: $('sessionB').value.trim() || sessionBFromSelect,
        autoRelayEnabled: $('autoRelay').checked,
        stopOnStageDone: $('stopOnStageDone').checked,
        remoteMode: $('remoteMode').value,
        remoteUrl: $('remoteUrl').value.trim(),
        remoteHubUrl: $('remoteHubUrl').value.trim(),
        remotePeerId: $('remotePeerId').value.trim() || $('remotePeerSelect').value || '',
        remoteDeviceName: $('remoteDeviceName').value.trim(),
        remoteToken: $('remoteToken').value.trim(),
        remoteListenPort: $('remoteListenPort').value.trim(),
        remoteExportSide: $('remoteExportSide').value,
        remoteTargetTool: $('remoteTargetTool').value,
        remoteTargetProjectPath: $('remoteTargetProjectPath').value.trim(),
        remoteTargetSessionId: $('remoteTargetSessionId').value.trim(),
        remoteAutoRelayEnabled: $('remoteAutoRelay').checked,
        chatControlExpanded: $('bridgeControls').open,
        stageDoneMarkers: '{"bridge_stage":"done"},任务完成,阶段完成,END_OF_TASK,[DONE]'
      });
    }

    for (const id of [
      'toolA',
      'toolB',
      'projectA',
      'projectASelect',
      'projectB',
      'projectBSelect',
      'sessionA',
      'sessionASelect',
      'sessionB',
      'sessionBSelect',
      'autoRelay',
      'stopOnStageDone',
      'remoteMode',
      'remoteUrl',
      'remoteHubUrl',
      'remotePeerId',
      'remotePeerSelect',
      'remoteDeviceName',
      'remoteToken',
      'remoteListenPort',
      'remoteExportSide',
      'remoteTargetTool',
      'remoteTargetProjectPath',
      'remoteTargetSessionId',
      'remoteAutoRelay'
    ]) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('change', syncSettings);
      el.addEventListener('input', syncSettings);
    }
    for (const side of ['A', 'B']) {
      const ids = getSideControlIds(side);
      $(ids.projectSelect).addEventListener('change', () => {
        $(ids.projectInput).value = $(ids.projectSelect).value || '';
        $(ids.sessionInput).value = '';
        $(ids.sessionSelect).value = '';
        renderRemoteShareSessionMirror();
        syncSettings();
      });
      $(ids.projectInput).addEventListener('input', () => {
        if ($(ids.projectInput).value.trim()) {
          $(ids.projectSelect).value = '';
          $(ids.sessionInput).value = '';
          $(ids.sessionSelect).value = '';
        }
        renderRemoteShareSessionMirror();
      });
      $(ids.sessionSelect).addEventListener('change', () => {
        $(ids.sessionInput).value = $(ids.sessionSelect).value || '';
        renderRemoteShareSessionMirror();
        syncSettings();
      });
      $(ids.sessionInput).addEventListener('input', () => {
        if ($(ids.sessionInput).value.trim() && $(ids.sessionInput).value.trim() !== $(ids.sessionSelect).value) {
          $(ids.sessionSelect).value = '';
        }
        renderRemoteShareSessionMirror();
      });
    }
    $('bridgeControls').addEventListener('toggle', syncSettings);
    $('remoteExportSide').addEventListener('change', () => {
      renderRemoteShareSessionMirror();
      syncSettings();
    });
    $('remoteTargetTool').addEventListener('change', () => {
      $('remoteTargetSessionId').value = '';
      syncSettings();
    });
    $('remoteTargetProjectPath').addEventListener('input', () => {
      $('remoteTargetSessionId').value = '';
      syncSettings();
    });

    function send(target = 'BOTH') {
      const text = $('message').value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'send', target, text });
      $('message').value = '';
    }

    function sendRemote(target) {
      const text = $('remoteMessage').value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'sendRemote', target, text });
      $('remoteMessage').value = '';
    }

    function interruptRemote() {
      vscode.postMessage({ type: 'interruptRemote' });
    }

    $('sendA').addEventListener('click', () => send('A'));
    $('sendB').addEventListener('click', () => send('B'));
    $('sendBoth').addEventListener('click', () => send('BOTH'));
    $('remoteSendA').addEventListener('click', () => sendRemote($('remoteSendA').dataset.target || 'A'));
    $('remoteSendB').addEventListener('click', () => sendRemote($('remoteSendB').dataset.target || 'B'));
    $('remoteSendBoth').addEventListener('click', () => sendRemote('BOTH'));
    $('remoteInterrupt').addEventListener('click', () => interruptRemote());
    $('interrupt').addEventListener('click', () => {
      vscode.postMessage({ type: 'interrupt', target: 'BOTH' });
    });
    $('refreshRemotePeers').addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshRemotePeers' });
    });
    $('refreshOptions').addEventListener('click', () => {
      if (refreshOptionsPending) return;
      setRefreshOptionsPending(true);
      setRefreshOptionsStatus('正在刷新...');
      vscode.postMessage({ type: 'refreshOptions' });
    });
    $('copyShareLink').addEventListener('click', async () => {
      const text = $('remoteConnectionSnippet').value || '';
      if (!text.trim()) {
        setCopyShareStatus('暂无可复制配置');
        return;
      }
      $('remoteConnectionSnippet').focus();
      $('remoteConnectionSnippet').select();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          setCopyShareStatus('已复制');
        }
      } catch {}
      vscode.postMessage({ type: 'copyShareLink', text });
    });
    $('applyRemoteConfig').addEventListener('click', () => {
      applyRemoteConfig('manual');
    });
    $('remoteConfigPaste').addEventListener('input', () => {
      scheduleAutoApplyRemoteConfig();
    });
    $('remoteConfigPaste').addEventListener('paste', () => {
      setTimeout(() => {
        scheduleAutoApplyRemoteConfig();
      }, 0);
    });
    $('tabChat').addEventListener('click', () => setActiveTab('chat'));
    $('tabRemote').addEventListener('click', () => setActiveTab('remote'));
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-tab-target]') : null;
      if (!target) return;
      const tab = target.getAttribute('data-tab-target') || 'chat';
      setActiveTab(tab);
    });

    $('message').addEventListener('compositionstart', () => {
      isComposing = true;
    });

    $('message').addEventListener('compositionend', () => {
      isComposing = false;
      compositionJustEndedAt = Date.now();
    });

    $('remoteMessage').addEventListener('compositionstart', () => {
      isComposing = true;
    });

    $('remoteMessage').addEventListener('compositionend', () => {
      isComposing = false;
      compositionJustEndedAt = Date.now();
    });

    $('message').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (event.shiftKey) return;
      if (event.isComposing || isComposing || event.keyCode === 229) return;
      if (Date.now() - compositionJustEndedAt < 80) return;
      event.preventDefault();
      send('A');
    });
    $('remoteMessage').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (event.shiftKey) return;
      if (event.isComposing || isComposing || event.keyCode === 229) return;
      if (Date.now() - compositionJustEndedAt < 80) return;
      const defaultTarget = getRemoteDefaultTarget(latestState);
      if (!defaultTarget) return;
      event.preventDefault();
      sendRemote(defaultTarget);
    });


    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') {
        latestState = msg.state;
        reasoningByTurn = msg.reasoningByTurn || {};
        render();
        return;
      }
      if (msg.type === 'copyShareLinkResult') {
        setCopyShareStatus(msg.ok ? '已复制' : ('复制失败：' + (msg.message || '未知错误')));
        return;
      }
      if (msg.type === 'refreshOptionsResult') {
        setRefreshOptionsPending(false);
        setRefreshOptionsStatus(msg.ok ? '已刷新' : ('刷新失败：' + (msg.message || '未知错误')), !msg.ok);
        return;
      }
      if (msg.type === 'applyRemoteConfigResult') {
        setRemoteImportStatus(
          msg.ok
            ? (msg.source === 'auto' ? '已自动应用配置' : '配置已应用')
            : ('应用失败：' + (msg.message || '未知错误')),
          !msg.ok
        );
      }
    });

    function render() {
      if (!latestState) return;
      setActiveTab(activeTab);
      $('bridgeControls').open = !!latestState.chatControlExpanded;
      $('projectA').value = latestState.projectAPath || '';
      $('projectB').value = latestState.projectBPath || '';
      $('toolA').value = latestState.toolA || 'codex';
      $('toolB').value = latestState.toolB || 'codex';
      $('sessionA').value = latestState.sessionA || '';
      $('sessionB').value = latestState.sessionB || '';
      $('autoRelay').checked = !!latestState.autoRelayEnabled;
      $('stopOnStageDone').checked = !!latestState.stopOnStageDone;
      $('remoteMode').value = latestState.remoteMode || 'off';
      $('remoteUrl').value = latestState.remoteUrl || '';
      $('remoteHubUrl').value = latestState.remoteHubUrl || '';
      $('remotePeerId').value = latestState.remotePeerId || '';
      $('remoteDeviceName').value = latestState.remoteDeviceName || '';
      $('remoteToken').value = latestState.remoteToken || '';
      $('remoteListenPort').value = String(latestState.remoteListenPort || 9238);
      $('remoteExportSide').value = latestState.remoteExportSide || 'A';
      $('remoteTargetTool').value = latestState.remoteTargetTool === 'claude' ? 'claude' : 'codex';
      $('remoteTargetProjectPath').value = latestState.remoteTargetProjectPath || '';
      $('remoteTargetSessionId').value = latestState.remoteTargetSessionId || '';
      $('remoteAutoRelay').checked = !!latestState.remoteAutoRelayEnabled;
      $('remoteConnectionSnippet').value = latestState.remoteConnectionSnippet || '';
      $('remoteTokenHint').textContent = latestState.remoteTokenHint || '';
      $('remoteTargetLabel').textContent = latestState.remoteTargetLabel
        ? ('当前 Remote 目标: ' + latestState.remoteTargetLabel)
        : '';
      $('remoteStatus').textContent = latestState.remoteStatus || '';
      const dot = $('remoteConnectivityDot');
      dot.className = 'status-dot ' + (latestState.remoteConnectivity || 'idle');
      updateRemoteModeUI();
      renderRemotePeerOptions(latestState.remotePeerOptions || [], latestState.remotePeerId || '');
      renderProjectOptions(
        'projectASelect',
        getProjectOptionsForTool(latestState, latestState.toolA || 'codex'),
        latestState.projectAPath || '',
        '选择 Project A'
      );
      renderProjectOptions(
        'projectBSelect',
        getProjectOptionsForTool(latestState, latestState.toolB || 'codex'),
        latestState.projectBPath || '',
        '选择 Project B'
      );
      renderSessionOptions(
        latestState.sessionOptions || [],
        latestState.projectAPath || '',
        latestState.projectBPath || '',
        latestState.toolA || 'codex',
        latestState.toolB || 'codex',
        latestState.sessionA || '',
        latestState.sessionB || ''
      );
      renderRemoteShareSessionMirror();

      $('status').textContent =
        'A: ' + (latestState.isSendingA ? '发送中' : '空闲') +
        ' | B: ' + (latestState.isSendingB ? '发送中' : '空闲');
      $('statusAInline').textContent = latestState.isSendingA ? '发送中' : '空闲';
      $('statusBInline').textContent = latestState.isSendingB ? '发送中' : '空闲';

      renderChatList($('chat'), latestState.chatItems || [], 'bridge');
      const remoteSides = getRemoteConversationSides(latestState);
      const remoteItems = (latestState.chatItems || []).filter((item) => {
        if (item.channel === 'remote') return true;
        if (!item.side) return false;
        if (latestState.remoteMode === 'host') {
          return item.side === latestState.remoteExportSide;
        }
        if (remoteSides.length === 1) {
          const remoteSide = remoteSides[0];
          const localSide = remoteSide === 'A' ? 'B' : 'A';
          return item.side === remoteSide || item.side === localSide;
        }
        return remoteSides.includes(item.side);
      });
      renderChatList($('remoteChat'), remoteItems, 'remote');

      const hasRemoteSide = remoteSides.length > 0;
      const hasRemoteConversation = remoteItems.length > 0;
      $('remoteEmptyState').textContent = getRemoteEmptyStateText(latestState);
      $('remoteConversationStatus').textContent = getRemoteConversationStatus(latestState, remoteSides);
      $('remoteEmptyState').classList.toggle('hidden', hasRemoteConversation);
      $('remoteChatWrap').classList.toggle('hidden', !hasRemoteSide);
      updateRemoteSendButtons(latestState);
      $('remoteSendHint').textContent = getRemoteHint(latestState, remoteSides);
    }

    function getChatAppearance(item, view) {
      if (item.role === 'system') {
        return { side: 'SYS', role: 'SYSTEM', sideClass: 'msg-sys', badgeClass: 'badge badge-sys' };
      }
      if (view === 'remote') {
        const isRemotePeer = item.peer === 'remote';
        return {
          side: isRemotePeer ? 'REMOTE' : 'LOCAL',
          role: '',
          sideClass: isRemotePeer ? 'msg-b' : 'msg-a',
          badgeClass: isRemotePeer ? 'badge badge-b' : 'badge'
        };
      }
      const side = item.side || 'SYS';
      return {
        side,
        role: item.role.toUpperCase(),
        sideClass: side === 'A' ? 'msg-a' : side === 'B' ? 'msg-b' : 'msg-sys',
        badgeClass: side === 'B' ? 'badge badge-b' : 'badge'
      };
    }

    function renderChatList(container, items, view = 'bridge') {
      container.innerHTML = '';
      for (const item of items) {
        const div = document.createElement('div');
        const appearance = getChatAppearance(item, view);
        div.className = 'msg ' + appearance.sideClass;
        const side = appearance.side;
        const role = appearance.role;
        const t = new Date(item.time).toLocaleTimeString();
        div.innerHTML =
          '<div class=\"meta\">' +
          '<span class=\"' + appearance.badgeClass + '\">' + side + '</span>' +
          (view === 'remote' || !role ? '' : ('<span>' + role + '</span>')) +
          '<span>' + t + '</span>' +
          '</div>';

        if (item.role === 'assistant' && item.turnId && reasoningByTurn[item.turnId]) {
          const thinking = document.createElement('div');
          thinking.className = 'thinking';
          thinking.textContent = reasoningByTurn[item.turnId];
          div.appendChild(thinking);
        }

        const text = document.createElement('div');
        text.className = 'text';
        const isStreaming = item.role === 'assistant' && !item.text && (
          (item.side === 'A' && latestState.isSendingA) ||
          (item.side === 'B' && latestState.isSendingB)
        );
        if (isStreaming) {
          text.innerHTML =
            '<span class="typing">生成中' +
            '<span class="typing-dots"><span></span><span></span><span></span></span>' +
            '</span>';
        } else {
          text.textContent = item.text || '(空回复)';
        }
        div.appendChild(text);
        container.appendChild(div);
      }
      container.scrollTop = container.scrollHeight;
    }

    function updateRemoteModeUI() {
      const mode = $('remoteMode').value || 'off';
      const hostOnly = document.querySelectorAll('.host-only');
      const clientOnly = document.querySelectorAll('.client-only');
      const offOrClient = document.querySelectorAll('.off-or-client');
      hostOnly.forEach((el) => el.classList.toggle('hidden', mode !== 'host'));
      clientOnly.forEach((el) => el.classList.toggle('hidden', mode !== 'client'));
      offOrClient.forEach((el) => el.classList.toggle('hidden', mode === 'host'));
    }

    function renderProjectOptions(selectId, options, selectedValue, placeholder) {
      const select = $(selectId);
      select.innerHTML = '';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = placeholder + '（可空）';
      select.appendChild(empty);

      for (const path of options) {
        const opt = document.createElement('option');
        opt.value = path;
        opt.textContent = path;
        select.appendChild(opt);
      }
      select.value = selectedValue && options.includes(selectedValue) ? selectedValue : '';
    }

    function getProjectOptionsForTool(state, tool) {
      if (!state) return [];
      if (tool === 'remote') return [];
      const ignored = new Set([
        '/Users/wulingren',
        '/Users/wulingren/.claude',
        '/Users/wulingren/.codex'
      ]);
      if (tool === 'claude') {
        const values = new Set();
        for (const item of state.sessionOptions || []) {
          if (item.tool !== 'claude') continue;
          const cwd = (item.cwd || '').trim();
          if (cwd && !ignored.has(cwd)) values.add(cwd);
        }
        return [...values].sort((a, b) => a.localeCompare(b));
      }
      return (state.projectOptions || []).filter((item) => !ignored.has(item));
    }

    function renderRemotePeerOptions(options, selectedValue) {
      const select = $('remotePeerSelect');
      select.innerHTML = '';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '选择 Remote 要连接的 Hub 节点（可空）';
      select.appendChild(empty);
      for (const item of options) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = item.label;
        select.appendChild(opt);
      }
      select.value = selectedValue && options.some((item) => item.id === selectedValue) ? selectedValue : '';
    }

    function renderSessionOptions(options, projectAPath, projectBPath, toolA, toolB, selectedA, selectedB) {
      const optionsForA = options.filter((item) => item.tool === toolA && matchesProject(item.cwd || '', projectAPath || ''));
      const optionsForB = options.filter((item) => item.tool === toolB && matchesProject(item.cwd || '', projectBPath || ''));

      const selectA = $('sessionASelect');
      const selectB = $('sessionBSelect');
      selectA.innerHTML = '';
      selectB.innerHTML = '';

      const addDefault = (select, text) => {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = text;
        select.appendChild(opt);
      };
      addDefault(selectA, toolA === 'claude' ? 'A Claude 会话（手动输入或续用当前）' : 'A会话（可空）');
      addDefault(selectB, toolB === 'claude' ? 'B Claude 会话（手动输入或续用当前）' : 'B会话（可空）');
      if (toolA === 'remote') selectA.options[0].textContent = 'A Remote（不使用本地会话）';
      if (toolB === 'remote') selectB.options[0].textContent = 'B Remote（不使用本地会话）';

      if (toolA !== 'remote') {
        for (const item of optionsForA) {
          const optA = document.createElement('option');
          optA.value = item.id;
          optA.textContent = item.displayLabel;
          selectA.appendChild(optA);
        }
      }

      if (toolB !== 'remote') {
        for (const item of optionsForB) {
          const optB = document.createElement('option');
          optB.value = item.id;
          optB.textContent = item.displayLabel;
          selectB.appendChild(optB);
        }
      }

      const idsA = optionsForA.map((v) => v.id);
      const idsB = optionsForB.map((v) => v.id);
      selectA.disabled = false;
      selectB.disabled = false;
      selectA.value = selectedA && idsA.includes(selectedA) ? selectedA : '';
      selectB.value = selectedB && idsB.includes(selectedB) ? selectedB : '';
    }

    function matchesProject(sessionCwd, projectPath) {
      const normalizedProject = (projectPath || '').trim();
      if (!normalizedProject) return false;
      const normalizedCwd = (sessionCwd || '').trim();
      if (!normalizedCwd) return false;

      if (normalizedCwd.startsWith(normalizedProject)) return true;

      const projectName = normalizedProject.split('/').filter(Boolean).pop() || '';
      if (!projectName) return false;

      const cwdName = normalizedCwd.split('/').filter(Boolean).pop() || '';
      if (cwdName === projectName) return true;

      const parts = normalizedCwd.split('/').filter(Boolean);
      const codexIdx = parts.indexOf('.codex');
      if (codexIdx >= 0 && codexIdx + 2 < parts.length && parts[codexIdx + 1] === 'worktrees') {
        return parts[codexIdx + 2] === projectName;
      }
      return false;
    }

    setActiveTab(activeTab);
    setRefreshOptionsPending(false);
    vscode.postMessage({ type: 'requestState' });
  </script>
</body>
</html>`;
}
