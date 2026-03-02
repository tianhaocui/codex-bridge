import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs, Dirent } from 'node:fs';

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

    this.startProcess();

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

  private startProcess(): void {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
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
    stageDoneMarkers: '{"bridge_stage":"done"},任务完成,阶段完成,END_OF_TASK,[DONE]',
    chatItems: [],
    isSendingA: false,
    isSendingB: false
  };

  private stageJsonPattern = /^\s*\{\s*"bridge_stage"\s*:\s*"(done|continue)"\s*\}\s*$/i;

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

    const outboundMessage = this.composeOutboundMessage(message);
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

  private composeOutboundMessage(message: string): string {
    if (!this.state.autoRelayEnabled || !this.state.stopOnStageDone) return message;
    return `${message}\n\n[Bridge 控制协议]\n- 回复最后一行必须是单行 JSON：{"bridge_stage":"continue"} 或 {"bridge_stage":"done"}`;
  }

  private isStageDone(text: string): boolean {
    const lines = text.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    const last = lines.length > 0 ? lines[lines.length - 1] : '';
    const match = this.stageJsonPattern.exec(last);
    if (match?.[1]?.toLowerCase() === 'done') return true;

    const markers = this.state.stageDoneMarkers
      .split(/[\n,;|]/)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);

    const normalized = text.toLowerCase();
    return markers.some((m) => normalized.includes(m));
  }

  private sanitizedRelayPayload(text: string): string {
    const lines = text.split(/\r?\n/);
    if (lines.length === 0) return text;
    const last = lines[lines.length - 1].trim();
    if (this.stageJsonPattern.test(last)) {
      return lines.slice(0, -1).join('\n').trim();
    }
    return text;
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
    body { font-family: var(--vscode-font-family); margin: 0; padding: 12px; color: var(--vscode-foreground); }
    .panel { border: 1px solid var(--vscode-editorWidget-border); padding: 10px; border-radius: 6px; margin-bottom: 10px; }
    .row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .row input:not([type="checkbox"]), textarea {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px;
      outline: none;
      font: inherit;
      caret-color: var(--vscode-editorCursor-foreground);
    }
    .row select {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px 28px 6px 6px;
      outline: none;
      font: inherit;
      appearance: auto;
      -webkit-appearance: menulist;
    }
    .row input:not([type="checkbox"])::placeholder, textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .row input:not([type="checkbox"]):focus, .row select:focus, textarea:focus {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset;
    }
    .row input[readonly] {
      opacity: 0.95;
    }
    input:-webkit-autofill, textarea:-webkit-autofill, select:-webkit-autofill {
      -webkit-text-fill-color: var(--vscode-input-foreground);
      -webkit-box-shadow: 0 0 0px 1000px var(--vscode-input-background) inset;
      transition: background-color 9999s ease-in-out 0s;
    }
    .row input[type="checkbox"] { width: auto; margin: 0; }
    textarea { min-height: 72px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .icon-btn {
      min-width: 30px;
      width: 30px;
      height: 30px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      line-height: 1;
      border-radius: 6px;
    }
    .stop-btn {
      border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-button-secondaryForeground) 8%, transparent);
    }
    .stop-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .stop-btn:active {
      transform: translateY(1px);
      filter: brightness(0.96);
    }
    .toggle { display: inline-flex; align-items: center; gap: 6px; }
    .chat { max-height: 52vh; overflow: auto; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 8px; }
    .msg { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 8px; margin-bottom: 8px; }
    .meta { font-size: 11px; opacity: 0.8; margin-bottom: 4px; }
    .thinking { font-size: 11px; padding: 6px; margin-bottom: 6px; border-radius: 4px; background: var(--vscode-editor-inactiveSelectionBackground); white-space: pre-wrap; }
    .text { white-space: pre-wrap; }
    .typing {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-descriptionForeground);
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
    .muted { opacity: 0.8; font-size: 12px; }
  </style>
</head>
<body>
  <div class="panel">
    <div class="row"><strong>Project A（固定）</strong><input id="projectA" readonly /></div>
    <div class="row"><strong>Project B</strong><select id="projectBSelect"></select></div>
    <div class="row"><input id="projectB" placeholder="Project B 可手动输入（优先）" /></div>
    <div class="row">
      <select id="sessionASelect"></select>
      <select id="sessionBSelect"></select>
    </div>
    <div class="row">
      <input id="sessionA" placeholder="A会话ID 可手动输入（优先）" />
      <input id="sessionB" placeholder="B会话ID 可手动输入（优先）" />
    </div>
    <div class="row">
      <label class="toggle">自动互发 <input type="checkbox" id="autoRelay" /></label>
      <label class="toggle">阶段完成自动停止 <input type="checkbox" id="stopOnStageDone" /></label>
    </div>
  </div>

  <div class="panel">
    <div class="chat" id="chat"></div>
    <div class="row" style="margin-top:8px;"><textarea id="message" placeholder="输入消息"></textarea></div>
    <div class="muted">回车发送，Shift+回车换行</div>
    <div class="row">
      <button id="sendA">发给A</button>
      <button id="sendB" class="secondary">发给B</button>
      <button id="sendBoth" class="secondary">同时发送</button>
      <button id="interrupt" class="secondary icon-btn stop-btn" title="停止" aria-label="停止">■</button>
      <span id="status" class="muted"></span>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    let latestState = null;
    let reasoningByTurn = {};

    function syncSettings() {
      const projectBFromSelect = $('projectBSelect').value || '';
      const sessionAFromSelect = $('sessionASelect').value || '';
      const sessionBFromSelect = $('sessionBSelect').value || '';
      vscode.postMessage({
        type: 'updateSettings',
        projectBPath: $('projectB').value.trim() || projectBFromSelect,
        sessionA: $('sessionA').value.trim() || sessionAFromSelect,
        sessionB: $('sessionB').value.trim() || sessionBFromSelect,
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
      'sessionASelect',
      'sessionB',
      'sessionBSelect',
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

      $('status').textContent =
        'A: ' + (latestState.isSendingA ? '发送中' : '空闲') +
        ' | B: ' + (latestState.isSendingB ? '发送中' : '空闲');

      const chat = $('chat');
      chat.innerHTML = '';
      for (const item of latestState.chatItems) {
        const div = document.createElement('div');
        div.className = 'msg';
        const side = item.side || 'SYS';
        const role = item.role.toUpperCase();
        const t = new Date(item.time).toLocaleTimeString();
        div.innerHTML = '<div class=\"meta\">' + t + ' · ' + role + ' · ' + side + '</div>';

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
      addDefault(selectA, 'A会话（可空）');
      addDefault(selectB, 'B会话（可空）');

      for (const item of optionsForA) {
        const optA = document.createElement('option');
        optA.value = item.id;
        optA.textContent = item.displayLabel;
        selectA.appendChild(optA);
      }

      for (const item of optionsForB) {
        const optB = document.createElement('option');
        optB.value = item.id;
        optB.textContent = item.displayLabel;
        selectB.appendChild(optB);
      }

      const idsA = optionsForA.map((v) => v.id);
      const idsB = optionsForB.map((v) => v.id);
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

    vscode.postMessage({ type: 'requestState' });
  </script>
</body>
</html>`;
}
