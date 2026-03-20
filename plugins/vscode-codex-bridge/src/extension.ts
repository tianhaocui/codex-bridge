import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs, Dirent } from 'node:fs';
import {
  composeOutboundMessage,
  DEFAULT_STAGE_DONE_MARKERS,
  isStageDone,
  sanitizedRelayPayload
} from './core/bridgeProtocol';
import { resolveCodexExecutable } from './core/codexExecutable';

type Side = 'A' | 'B';
type Role = 'user' | 'assistant' | 'system';

type ChatItem = {
  id: string;
  time: number;
  side?: Side;
  role: Role;
  text: string;
  turnId?: string;
};

type SessionOption = {
  id: string;
  displayLabel: string;
  cwd?: string;
};

type BridgeState = {
  projectAPath: string;
  projectBPath: string;
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
};

type PendingTurn = {
  onDelta: (chunk: string) => void;
  onReasoning: (turnId: string, summaryIndex: number, delta: string) => void;
  onDone: (result: { ok: true; text: string } | { ok: false; message: string }) => void;
};

class CodexWorker {
  private process: ChildProcessWithoutNullStreams | null = null;
  private outBuffer = '';
  private nextRequestId = 1;
  private pending = new Map<string, (payload: any) => void>();
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private configuredCwd: string | null = null;
  private configuredResumeId: string | null = null;
  private streamingText = '';
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

    this.startProcess(cwd);

    await this.sendRequest('initialize', {
      clientInfo: { name: 'codex-bridge-vscode', version: '0.1.1' },
      capabilities: { experimentalApi: true }
    });

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

  private startProcess(cwd: string): void {
    const codexExec = resolveCodexExecutable();
    const child = spawn(codexExec, ['app-server', '--listen', 'stdio://'], {
      cwd,
      stdio: 'pipe'
    });

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

    child.on('exit', () => {
      this.cleanupProcess();
      this.failTurn('Codex worker 已退出');
    });

    child.on('error', (err) => {
      this.cleanupProcess();
      this.failTurn(err.message || 'Codex worker 启动失败');
    });

    this.process = child;
  }

  private cleanupProcess(): void {
    if (this.process) {
      this.process.stdout.removeAllListeners();
      this.process.removeAllListeners();
      if (!this.process.killed) {
        this.process.kill();
      }
    }
    this.process = null;
    this.pending.clear();
    this.outBuffer = '';
  }

  private sendRequest(method: string, params: any): Promise<any> {
    if (!this.process || !this.process.stdin.writable) {
      return Promise.reject(new Error('app-server stdin 不可用'));
    }

    const id = String(this.nextRequestId++);
    const payload = { jsonrpc: '2.0', id: Number(id), method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, (response) => {
        if (response.error) {
          reject(new Error(response.error.message || '未知错误'));
          return;
        }
        resolve(response.result || {});
      });

      try {
        this.process?.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err: any) {
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
      const cb = this.pending.get(key);
      this.pending.delete(key);
      cb?.(dict);
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
}

class BridgeController {
  private workerA = new CodexWorker();
  private workerB = new CodexWorker();
  private panel: vscode.WebviewPanel | null = null;
  private reasoningMap = new Map<string, string>();
  private interruptedBySide: Record<Side, boolean> = { A: false, B: false };

  private state: BridgeState = {
    projectAPath: '',
    projectBPath: '',
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
    isSendingB: false
  };

  attachPanel(panel: vscode.WebviewPanel, projectAPath: string): void {
    this.panel = panel;
    this.state.projectAPath = projectAPath;
    this.loadCodexOptions()
      .then(() => this.sync())
      .catch(() => undefined);
    this.sync();
  }

  dispose(): void {
    this.workerA.shutdown();
    this.workerB.shutdown();
    this.panel = null;
  }

  onWebviewMessage(message: any): void {
    switch (message.type) {
      case 'updateSettings':
        this.state.projectBPath = String(message.projectBPath || '');
        this.state.sessionA = String(message.sessionA || '');
        this.state.sessionB = String(message.sessionB || '');
        this.state.autoRelayEnabled = !!message.autoRelayEnabled;
        this.state.stopOnStageDone = !!message.stopOnStageDone;
        this.state.chatControlExpanded = !!message.chatControlExpanded;
        this.state.stageDoneMarkers = String(message.stageDoneMarkers || this.state.stageDoneMarkers);
        this.sync();
        break;
      case 'refreshOptions':
        this.loadCodexOptions()
          .then(() => this.sync())
          .catch((err: any) => {
            this.appendSystem(`刷新下拉数据失败：${err?.message || '未知错误'}`);
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
      case 'interrupt':
        this.handleInterrupt(String(message.target || 'BOTH'));
        break;
      case 'requestState':
        this.sync();
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

  private sendTo(side: Side, message: string, initiatedByRelay: boolean): void {
    const projectPath = side === 'A' ? this.state.projectAPath : this.state.projectBPath;
    const sessionId = side === 'A' ? this.state.sessionA : this.state.sessionB;
    const worker = side === 'A' ? this.workerA : this.workerB;

    if (!projectPath.trim()) {
      this.appendSystem(`${side} 发送失败：项目路径为空`, side);
      return;
    }

    if (side === 'A' ? this.state.isSendingA : this.state.isSendingB) {
      this.appendSystem(`${side} 忙碌中，稍后再试`, side);
      return;
    }

    if (!initiatedByRelay) {
      this.appendChat({ id: randomUUID(), time: Date.now(), side, role: 'user', text: message });
    } else {
      this.appendSystem(`自动转发到 ${side}`, side);
    }

    this.setSending(side, true);
    const assistantId = randomUUID();
    this.appendChat({ id: assistantId, time: Date.now(), side, role: 'assistant', text: '' });

    const outboundMessage = composeOutboundMessage(message, {
      autoRelayEnabled: this.state.autoRelayEnabled,
      stopOnStageDone: this.state.stopOnStageDone
    });
    worker.send(
      outboundMessage,
      projectPath,
      sessionId || undefined,
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
        this.setSending(side, false);
        const interrupted = this.interruptedBySide[side];
        if (interrupted) {
          this.interruptedBySide[side] = false;
        }
        if (!result.ok) {
          this.appendSystem(`${side} 执行失败：${result.message}`, side);
          return;
        }

        this.upsertAssistant(assistantId, result.text, side);
        if (interrupted) {
          this.appendSystem(`${side} 已打断`, side);
          return;
        }

        if (
          this.state.autoRelayEnabled &&
          this.state.stopOnStageDone &&
          isStageDone(result.text, this.state.stageDoneMarkers)
        ) {
          this.state.autoRelayEnabled = false;
          this.appendSystem('检测到阶段完成，已停止自动互发');
          this.sync();
          return;
        }

        if (this.state.autoRelayEnabled) {
          const payload = sanitizedRelayPayload(result.text);
          if (payload.trim()) {
            this.sendTo(side === 'A' ? 'B' : 'A', payload, true);
          }
        }
      }
    );
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
      const worker = side === 'A' ? this.workerA : this.workerB;
      worker.interrupt();
      this.setSending(side, false);
      interruptedCount += 1;
    }

    if (interruptedCount > 0) {
      this.state.autoRelayEnabled = false;
      this.appendSystem(`已打断 ${target === 'BOTH' ? 'A/B' : target}，并停止自动互发`);
      this.sync();
    } else {
      this.appendSystem('当前无进行中的任务可打断');
    }
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

  private appendSystem(text: string, side?: Side): void {
    this.state.chatItems.push({ id: randomUUID(), time: Date.now(), side, role: 'system', text });
    this.sync();
  }

  private setSending(side: Side, value: boolean): void {
    if (side === 'A') this.state.isSendingA = value;
    if (side === 'B') this.state.isSendingB = value;
    this.sync();
  }

  private sync(): void {
    if (!this.panel) return;
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

    this.panel.webview.postMessage({ type: 'state', state: this.state, reasoningByTurn });
  }

  private async loadCodexOptions(): Promise<void> {
    const home = os.homedir();
    const codexDir = path.join(home, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const historyPath = path.join(codexDir, 'history.jsonl');

    const [projects, sessions] = await Promise.all([
      this.parseProjects(configPath),
      this.parseSessions(historyPath, codexDir)
    ]);

    const mergedProjects = new Set<string>(projects);
    if (this.state.projectAPath?.trim()) mergedProjects.add(this.state.projectAPath.trim());
    this.state.projectOptions = [...mergedProjects].sort((a, b) => a.localeCompare(b));
    this.state.sessionOptions = sessions;
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

  private async parseSessions(historyPath: string, codexDir: string): Promise<SessionOption[]> {
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

      const sortedIds = [...latestTsBySession.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id)
        .slice(0, 80);

      const cwdBySession = await this.parseSessionCwds(new Set(sortedIds), codexDir);

      return sortedIds.map((id) => {
        const preview = firstTextBySession.get(id) || '(无首句)';
        return {
          id,
          displayLabel: `${id.slice(0, 8)} - ${preview}`,
          cwd: cwdBySession.get(id) || ''
        };
      });
    } catch {
      return [];
    }
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
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new BridgeController();

  context.subscriptions.push(
    vscode.commands.registerCommand('codexBridge.openWithCurrentProject', async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (!workspace) {
        vscode.window.showErrorMessage('请先打开一个项目目录。');
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        'codexBridge',
        'Codex Bridge',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      panel.webview.onDidReceiveMessage((message) => {
        controller.onWebviewMessage(message);
      });
      panel.webview.html = getHtml(panel.webview);
      controller.attachPanel(panel, workspace.uri.fsPath);

      panel.onDidDispose(() => {
        controller.dispose();
      });
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
  <title>Codex Bridge</title>
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
      --shadow: 0 10px 30px rgba(0,0,0,0.12);
      --radius: 14px;
      --radius-sm: 10px;
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      margin: 0;
      padding: 16px;
      color: var(--vscode-foreground);
      background:
        radial-gradient(circle at top right, color-mix(in srgb, var(--vscode-button-background) 14%, transparent), transparent 26%),
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editor-background) 92%, black), var(--vscode-editor-background));
    }
    .app {
      display: grid;
      grid-template-columns: minmax(320px, 360px) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .panel {
      border: 1px solid var(--border-soft);
      background: var(--panel);
      backdrop-filter: blur(8px);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow: hidden;
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
        linear-gradient(135deg, color-mix(in srgb, var(--accent) 15%, transparent), transparent 55%),
        linear-gradient(180deg, color-mix(in srgb, var(--panel-strong) 92%, transparent), transparent);
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
      font-weight: 700;
      letter-spacing: -0.02em;
      margin: 0 0 6px;
    }
    .subtitle {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
      font-size: 12px;
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
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed);
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--vscode-testing-iconPassed) 14%, transparent);
    }
    .section-title {
      margin: 0;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .section-desc {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }
    .stack { display: flex; flex-direction: column; gap: 12px; }
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
    select { padding-right: 30px; }
    input:not([type="checkbox"])::placeholder, textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    input:not([type="checkbox"]):focus, select:focus, textarea:focus {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset, 0 0 0 4px color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
    }
    input[readonly] {
      opacity: 0.92;
      background: color-mix(in srgb, var(--vscode-input-background) 80%, var(--vscode-editor-background));
    }
    textarea {
      min-height: 112px;
      resize: vertical;
      line-height: 1.5;
    }
    .hint {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
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
    .toggle-copy span {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
    }
    input[type="checkbox"] { width: auto; margin: 0; }
    .chat-shell {
      display: grid;
      grid-template-rows: auto minmax(320px, 1fr) auto;
      min-height: 72vh;
    }
    .chat {
      margin: 0 16px;
      max-height: 56vh;
      overflow: auto;
      border: 1px solid var(--border-soft);
      border-radius: 12px;
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
    .msg-b { border-left: 3px solid color-mix(in srgb, var(--vscode-terminal-ansiMagenta) 80%, white 20%); }
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
    .badge-b { background: color-mix(in srgb, var(--vscode-terminal-ansiMagenta) 15%, transparent); }
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
    }
    button {
      background: var(--accent);
      color: var(--accent-fg);
      border: 1px solid transparent;
      padding: 9px 14px;
      border-radius: 10px;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
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
    .muted { opacity: 0.85; font-size: 12px; }
    @media (max-width: 900px) {
      .app { grid-template-columns: 1fr; }
      .chat-shell { min-height: auto; }
      .chat { max-height: 42vh; }
      .dual-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <section class="panel">
      <div class="hero">
        <div class="eyebrow">Bridge Workspace</div>
        <h1 class="title">Codex Bridge</h1>
        <p class="subtitle">把 A/B 两侧会话放到同一个工作台里：选项目、选会话、控制自动互发，并在一个聊天流里查看状态。</p>
      </div>
      <div class="panel-body stack">
        <div>
          <h2 class="section-title">项目与会话</h2>
          <p class="section-desc">A 侧固定为当前工作区，B 侧可从历史项目里选，也可以手动覆盖。</p>
        </div>
        <div class="field-grid">
          <div class="field">
            <label for="projectA">Project A（当前工作区）</label>
            <input id="projectA" readonly />
          </div>
          <div class="field">
            <label for="projectBSelect">Project B（历史候选）</label>
            <select id="projectBSelect"></select>
          </div>
          <div class="field">
            <label for="projectB">Project B（手动覆盖）</label>
            <input id="projectB" placeholder="手动输入路径时优先于下拉选择" />
          </div>
          <div class="dual-grid">
            <div class="field">
              <label for="sessionA">Session A（候选）</label>
              <input id="sessionA" list="sessionAOptions" placeholder="可直接输入，或从候选会话里选择" />
              <datalist id="sessionAOptions"></datalist>
            </div>
            <div class="field">
              <label for="sessionB">Session B（候选）</label>
              <input id="sessionB" list="sessionBOptions" placeholder="可直接输入，或从候选会话里选择" />
              <datalist id="sessionBOptions"></datalist>
            </div>
          </div>
        </div>
        <div>
          <h2 class="section-title">桥接策略</h2>
          <p class="section-desc">打开自动互发后，Bridge 会把一侧结果继续转发给另一侧；启用“阶段完成自动停止”时，会识别末行 JSON 控制标记。</p>
        </div>
        <div class="toggle-row">
          <label class="toggle-card">
            <div class="toggle-copy">
              <strong>自动互发</strong>
              <span>把一边的输出继续转发到另一边</span>
            </div>
            <input type="checkbox" id="autoRelay" />
          </label>
          <label class="toggle-card">
            <div class="toggle-copy">
              <strong>阶段完成自动停止</strong>
              <span>检测 <code>{"bridge_stage":"done"}</code> 后停止链路</span>
            </div>
            <input type="checkbox" id="stopOnStageDone" />
          </label>
        </div>
      </div>
    </section>

    <section class="panel chat-shell">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Conversation</div>
          <h2 class="title" style="font-size:16px; margin:0;">Bridge Console</h2>
        </div>
        <div class="status-pill"><span class="status-dot" id="statusDot"></span><span id="status">A: 空闲 | B: 空闲</span></div>
      </div>
      <div class="chat" id="chat"></div>
      <div class="composer">
        <div class="field">
          <label for="message">发送内容</label>
          <textarea id="message" placeholder="输入消息。回车发送到 A，Shift + 回车换行。"></textarea>
        </div>
        <div class="actions">
          <div>
            <div class="hint">默认 Enter 发送到 A；也可以显式发给 B 或同时发送。</div>
          </div>
          <div class="button-group">
            <button id="sendA">发给 A</button>
            <button id="sendB" class="secondary">发给 B</button>
            <button id="sendBoth" class="secondary">同时发送</button>
            <button id="interrupt" class="icon-btn stop-btn" title="停止全部" aria-label="停止全部">■</button>
          </div>
        </div>
      </div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    let latestState = null;
    let reasoningByTurn = {};

    function syncSettings() {
      const projectBFromSelect = $('projectBSelect').value || '';
      vscode.postMessage({
        type: 'updateSettings',
        projectBPath: $('projectB').value.trim() || projectBFromSelect,
        sessionA: $('sessionA').value.trim(),
        sessionB: $('sessionB').value.trim(),
        autoRelayEnabled: $('autoRelay').checked,
        stopOnStageDone: $('stopOnStageDone').checked,
        chatControlExpanded: false,
        stageDoneMarkers: '{"bridge_stage":"done"},任务完成,阶段完成,END_OF_TASK,[DONE]'
      });
    }

    for (const id of [
      'projectB',
      'projectBSelect',
      'sessionA',
      'sessionB',
      'autoRelay',
      'stopOnStageDone'
    ]) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('change', syncSettings);
      el.addEventListener('input', syncSettings);
    }

    function send(target = 'BOTH') {
      const text = $('message').value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'send', target, text });
      $('message').value = '';
    }

    $('sendA').addEventListener('click', () => send('A'));
    $('sendB').addEventListener('click', () => send('B'));
    $('sendBoth').addEventListener('click', () => send('BOTH'));
    $('interrupt').addEventListener('click', () => {
      vscode.postMessage({ type: 'interrupt', target: 'BOTH' });
    });

    $('message').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (event.shiftKey) return;
      event.preventDefault();
      send('A');
    });


    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type !== 'state') return;
      latestState = msg.state;
      reasoningByTurn = msg.reasoningByTurn || {};
      render();
    });

    function render() {
      if (!latestState) return;
      $('projectA').value = latestState.projectAPath || '';
      $('projectB').value = latestState.projectBPath || '';
      $('sessionA').value = latestState.sessionA || '';
      $('sessionB').value = latestState.sessionB || '';
      $('autoRelay').checked = !!latestState.autoRelayEnabled;
      $('stopOnStageDone').checked = !!latestState.stopOnStageDone;
      renderProjectOptions(latestState.projectOptions || [], latestState.projectBPath || '');
      renderSessionOptions(
        latestState.sessionOptions || [],
        latestState.projectAPath || '',
        latestState.projectBPath || '',
        latestState.sessionA || '',
        latestState.sessionB || ''
      );

      const isBusyA = !!latestState.isSendingA;
      const isBusyB = !!latestState.isSendingB;
      $('status').textContent =
        'A: ' + (isBusyA ? '发送中' : '空闲') +
        ' | B: ' + (isBusyB ? '发送中' : '空闲');
      $('statusDot').style.background = (isBusyA || isBusyB)
        ? 'var(--vscode-progressBar-background)'
        : 'var(--vscode-testing-iconPassed)';
      $('statusDot').style.boxShadow = (isBusyA || isBusyB)
        ? '0 0 0 6px color-mix(in srgb, var(--vscode-progressBar-background) 16%, transparent)'
        : '0 0 0 6px color-mix(in srgb, var(--vscode-testing-iconPassed) 14%, transparent)';

      const chat = $('chat');
      chat.innerHTML = '';
      for (const item of latestState.chatItems) {
        const div = document.createElement('div');
        const side = item.side || 'SYS';
        div.className = 'msg ' + (side === 'A' ? 'msg-a' : side === 'B' ? 'msg-b' : 'msg-sys');
        const role = item.role.toUpperCase();
        const t = new Date(item.time).toLocaleTimeString();
        const sideBadgeClass = side === 'A' ? 'badge' : side === 'B' ? 'badge badge-b' : 'badge badge-sys';
        div.innerHTML = '<div class=\"meta\"><span>' + t + '</span><span class=\"badge\">' + role + '</span><span class=\"' + sideBadgeClass + '\">' + side + '</span></div>';

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
        chat.appendChild(div);
      }
      chat.scrollTop = chat.scrollHeight;
    }

    function renderProjectOptions(options, selectedValue) {
      const select = $('projectBSelect');
      select.innerHTML = '';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '选择 Project B（可空）';
      select.appendChild(empty);

      for (const path of options) {
        const opt = document.createElement('option');
        opt.value = path;
        opt.textContent = path;
        select.appendChild(opt);
      }
      select.value = selectedValue && options.includes(selectedValue) ? selectedValue : '';
    }

    function renderSessionOptions(options, projectAPath, projectBPath, selectedA, selectedB) {
      const optionsForA = options.filter((item) => matchesProject(item.cwd || '', projectAPath || ''));
      const optionsForB = options.filter((item) => matchesProject(item.cwd || '', projectBPath || ''));

      const listA = $('sessionAOptions');
      const listB = $('sessionBOptions');
      listA.innerHTML = '';
      listB.innerHTML = '';

      const addOption = (list, item) => {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.label = item.displayLabel;
        list.appendChild(opt);
      };
      for (const item of optionsForA) {
        addOption(listA, item);
      }

      for (const item of optionsForB) {
        addOption(listB, item);
      }
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

    vscode.postMessage({ type: 'requestState' });
  </script>
</body>
</html>`;
}
