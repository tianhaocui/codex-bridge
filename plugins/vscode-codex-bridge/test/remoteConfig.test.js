const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function loadBridgeController() {
  const file = path.resolve(__dirname, '../out/extension.js');
  const source = fs.readFileSync(file, 'utf8') + '\nmodule.exports.__BridgeController = BridgeController;';
  const localRequire = createRequire(file);
  const moduleObj = { exports: {} };
  const context = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id) => {
      if (id === 'vscode') {
        return {
          env: {
            clipboard: {
              writeText: async () => undefined
            }
          }
        };
      }
      return localRequire(id);
    },
    __filename: file,
    __dirname: path.dirname(file),
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  context.global = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: file });
  return moduleObj.exports.__BridgeController;
}

test('applyRemoteConfig keeps the configured local workspace side and assigns remote to the emptier side', () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.projectAPath = '/workspace/current-project';
  controller.state.toolA = 'codex';
  controller.state.toolB = 'codex';

  controller.applyRemoteConfigSnippet(`
# Agent Bridge Remote 连接配置
mode=client
remoteUrl=http://192.168.3.110:9238
token=62e49d80-d628-481c-a9c1-f6c9d4452a47
tool=remote
targetTool=codex
targetProjectPath=/Users/wulingren/Desktop/codex-bridge-fix
targetLabel=remote-host | codex | /Users/wulingren/Desktop/codex-bridge-fix | new-session
`);

  assert.equal(controller.state.toolA, 'codex');
  assert.equal(controller.state.toolB, 'remote');
  assert.equal(controller.state.remoteTargetTool, 'codex');
  assert.equal(controller.state.remoteTargetProjectPath, '/Users/wulingren/Desktop/codex-bridge-fix');
});

test('applyRemoteConfig clears stale target fields when the new snippet omits them', () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.remoteUrl = 'http://old-host:9238';
  controller.state.remoteHubUrl = 'https://old-hub.example';
  controller.state.remotePeerId = 'old-peer';
  controller.state.remoteTargetTool = 'claude';
  controller.state.remoteTargetProjectPath = '/old/project';
  controller.state.remoteTargetSessionId = '32be157d-ba50-4dd6-932d-546d65e47410';
  controller.state.remoteTargetLabel = 'old-label';

  controller.applyRemoteConfigSnippet(`
# Agent Bridge Remote 连接配置
mode=client
remoteUrl=http://192.168.3.110:9238
token=62e49d80-d628-481c-a9c1-f6c9d4452a47
tool=remote
targetTool=codex
`);

  assert.equal(controller.state.remoteUrl, 'http://192.168.3.110:9238');
  assert.equal(controller.state.remoteHubUrl, '');
  assert.equal(controller.state.remotePeerId, '');
  assert.equal(controller.state.remoteTargetTool, 'codex');
  assert.equal(controller.state.remoteTargetProjectPath, '');
  assert.equal(controller.state.remoteTargetSessionId, '');
  assert.equal(controller.state.remoteTargetLabel, '');
});

test('buildRemoteConnectionSnippet includes selected host cli and export session when present', () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.remoteMode = 'host';
  controller.state.remoteToken = 'token-12345678';
  controller.state.remoteListenPort = 9238;
  controller.state.remoteExportSide = 'B';
  controller.state.remoteDeviceName = 'device-name';
  controller.state.availableHostTools = ['codex', 'claude'];
  controller.state.toolB = 'claude';
  controller.state.projectBPath = '/Users/wulingren/Desktop/codex-bridge-fix';
  controller.state.sessionB = '12345678-1234-1234-1234-123456789abc';
  controller.state.sessionOptions = [
    {
      id: '12345678-1234-1234-1234-123456789abc',
      displayLabel: '12345678 - claude session',
      cwd: '/Users/wulingren/Desktop/codex-bridge-fix',
      tool: 'claude'
    }
  ];

  const snippet = controller.buildRemoteConnectionSnippet();
  assert.match(snippet, /targetTool=claude/);
  assert.match(snippet, /targetProjectPath=\/Users\/wulingren\/Desktop\/codex-bridge-fix/);
  assert.match(snippet, /targetSessionId=12345678-1234-1234-1234-123456789abc/);
});

test('updateSettings makes remote host cli follow the selected export side tool by default', () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.refreshRemoteBridge = async () => {};
  controller.sync = () => {};
  controller.state.availableHostTools = ['codex', 'claude'];
  controller.state.toolA = 'codex';
  controller.state.toolB = 'codex';
  controller.state.remoteExportSide = 'A';
  controller.state.remoteHostTool = 'codex';

  controller.onWebviewMessage({
    type: 'updateSettings',
    toolA: 'codex',
    toolB: 'claude',
    projectAPath: '/workspace/a',
    projectBPath: '/workspace/b',
    sessionA: '',
    sessionB: '',
    remoteMode: 'off',
    remoteExportSide: 'B',
    remoteHostTool: 'codex',
    remoteHostProjectPath: '',
    remoteHostSessionId: '',
    remoteTargetTool: 'codex',
    remoteTargetProjectPath: '',
    remoteTargetSessionId: ''
  });

  assert.equal(controller.state.remoteExportSide, 'B');
  assert.equal(controller.state.remoteHostTool, 'claude');
});

test('buildRemoteConnectionSnippet mirrors the export side session when host override is empty', () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.remoteMode = 'host';
  controller.state.remoteToken = 'token-12345678';
  controller.state.remoteListenPort = 9238;
  controller.state.remoteExportSide = 'B';
  controller.state.remoteDeviceName = 'device-name';
  controller.state.availableHostTools = ['codex', 'claude'];
  controller.state.toolB = 'claude';
  controller.state.projectBPath = '/Users/wulingren/Desktop/codex-bridge-fix';
  controller.state.sessionB = '32be157d-ba50-4dd6-932d-546d65e47410';
  controller.state.sessionOptions = [
    {
      id: '32be157d-ba50-4dd6-932d-546d65e47410',
      displayLabel: '32be157d - claude session',
      cwd: '/Users/wulingren/Desktop/codex-bridge-fix',
      tool: 'claude'
    }
  ];

  const snippet = controller.buildRemoteConnectionSnippet();
  assert.match(snippet, /targetTool=claude/);
  assert.match(snippet, /targetSessionId=32be157d-ba50-4dd6-932d-546d65e47410/);
});

test('buildRemoteConnectionSnippet omits known sessions that do not belong to the selected cli', () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.remoteMode = 'host';
  controller.state.remoteToken = 'token-12345678';
  controller.state.remoteListenPort = 9238;
  controller.state.remoteExportSide = 'B';
  controller.state.remoteDeviceName = 'device-name';
  controller.state.availableHostTools = ['codex', 'claude'];
  controller.state.toolB = 'claude';
  controller.state.projectBPath = '/Users/wulingren/Desktop/codex-bridge-fix';
  controller.state.sessionB = '12345678-1234-1234-1234-123456789abc';
  controller.state.sessionOptions = [
    {
      id: '12345678-1234-1234-1234-123456789abc',
      displayLabel: '12345678 - codex session',
      cwd: '/Users/wulingren/Desktop/codex-bridge-fix',
      tool: 'codex'
    }
  ];

  const snippet = controller.buildRemoteConnectionSnippet();
  assert.match(snippet, /targetTool=claude/);
  assert.doesNotMatch(snippet, /targetSessionId=/);
});

test('sendTo retries with a new session when restoring the previous codex session times out', async () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.projectAPath = '/workspace/current-project';
  controller.state.toolA = 'codex';
  controller.state.sessionA = '12345678-1234-1234-1234-123456789abc';

  const calls = [];
  controller.workers.A.codex = {
    send(_message, cwd, resumeId, onDelta, _onReasoning, onDone) {
      calls.push({ cwd, resumeId });
      if (calls.length === 1) {
        onDone({ ok: false, message: 'thread/resume 超时 (15000ms)' });
        return Promise.resolve();
      }
      onDelta('恢复后重试成功');
      onDone({ ok: true, text: '恢复后重试成功' });
      return Promise.resolve();
    },
    interrupt() {},
    shutdown() {}
  };

  controller.sendTo('A', '你好', false);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [
    { cwd: '/workspace/current-project', resumeId: '12345678-1234-1234-1234-123456789abc' },
    { cwd: '/workspace/current-project', resumeId: undefined }
  ]);
  assert.equal(controller.state.sessionA, '');
  assert.equal(controller.state.isSendingA, false);
  assert.ok(
    controller.state.chatItems.some((item) => item.role === 'assistant' && item.text === '恢复后重试成功')
  );
  assert.ok(
    controller.state.chatItems.some((item) => item.role === 'system' && /自动切换为新会话重试/.test(item.text))
  );
});

test('normalizedResumeId rejects short codex session ids that are only previews', () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();

  assert.equal(controller.normalizedResumeId('codex', '019d0e18', '/workspace/current-project'), '');
  assert.equal(
    controller.normalizedResumeId('codex', '019d0e18-9c2d-7452-9a86-b852e282c5cd', '/workspace/current-project'),
    '019d0e18-9c2d-7452-9a86-b852e282c5cd'
  );
});

test('normalizedResumeId rejects a known session when the cli does not match', () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.sessionOptions = [
    {
      id: '32be157d-ba50-4dd6-932d-546d65e47410',
      displayLabel: '32be157d - codex session',
      cwd: '/workspace/current-project',
      tool: 'codex'
    }
  ];

  assert.equal(
    controller.normalizedResumeId('claude', '32be157d-ba50-4dd6-932d-546d65e47410', '/workspace/current-project'),
    ''
  );
});

test('handleRemoteInvoke retries with a new session when the copied remote session is invalid', async () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.remoteExportSide = 'B';
  controller.state.availableHostTools = ['claude'];
  controller.state.remoteHostTool = 'claude';
  controller.state.remoteHostProjectPath = '/workspace/current-project';
  controller.localCliFailureMessage = () => '';

  const calls = [];
  controller.workers.B.claude = {
    send(_message, cwd, resumeId, onDelta, _onReasoning, onDone) {
      calls.push({ cwd, resumeId });
      if (calls.length === 1) {
        onDone({ ok: false, message: 'No conversation found with session ID: 32be157d-ba50-4dd6-932d-546d65e47410' });
        return Promise.resolve();
      }
      onDelta('远端自动重试成功');
      onDone({ ok: true, text: '远端自动重试成功' });
      return Promise.resolve();
    },
    interrupt() {},
    shutdown() {}
  };

  const result = await controller.handleRemoteInvoke('你好', undefined, undefined, {
    tool: 'claude',
    projectPath: '/workspace/current-project',
    sessionId: '32be157d-ba50-4dd6-932d-546d65e47410'
  });

  assert.deepEqual(calls, [
    { cwd: '/workspace/current-project', resumeId: '32be157d-ba50-4dd6-932d-546d65e47410' },
    { cwd: '/workspace/current-project', resumeId: undefined }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.text, '远端自动重试成功');
  assert.ok(
    controller.state.chatItems.some((item) => item.role === 'system' && /自动切换为新会话重试/.test(item.text))
  );
});

test('sendTo does not append a duplicate remote user message during auto relay', async () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.projectAPath = '/workspace/current-project';
  controller.state.toolA = 'codex';

  controller.workers.A.codex = {
    send(_message, _cwd, _resumeId, onDelta, _onReasoning, onDone) {
      onDelta('自动接力结果');
      onDone({ ok: true, text: '自动接力结果' });
      return Promise.resolve();
    },
    interrupt() {},
    shutdown() {}
  };

  controller.sendTo('A', '上一轮回复', true, {
    channel: 'remote',
    userPeer: 'remote',
    assistantPeer: 'local'
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const duplicateUsers = controller.state.chatItems.filter(
    (item) => item.channel === 'remote' && item.role === 'user' && item.text === '上一轮回复'
  );
  assert.equal(duplicateUsers.length, 0);
});

test('handleRemoteInvoke on client routes reverse calls to the local non-remote side', async () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.remoteMode = 'client';
  controller.state.toolA = 'remote';
  controller.state.toolB = 'claude';
  controller.state.projectBPath = '/workspace/current-project';
  controller.state.sessionB = '32be157d-ba50-4dd6-932d-546d65e47410';
  controller.state.sessionOptions = [
    {
      id: '32be157d-ba50-4dd6-932d-546d65e47410',
      displayLabel: '32be157d - claude session',
      cwd: '/workspace/current-project',
      tool: 'claude'
    }
  ];
  controller.state.availableHostTools = ['claude'];
  controller.localCliFailureMessage = () => '';

  const calls = [];
  controller.workers.B.claude = {
    send(_message, cwd, resumeId, onDelta, _onReasoning, onDone) {
      calls.push({ cwd, resumeId });
      onDelta('远端反向调用成功');
      onDone({ ok: true, text: '远端反向调用成功' });
      return Promise.resolve();
    },
    interrupt() {},
    shutdown() {}
  };

  const result = await controller.handleRemoteInvoke('你好');

  assert.deepEqual(calls, [
    { cwd: '/workspace/current-project', resumeId: '32be157d-ba50-4dd6-932d-546d65e47410' }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.text, '远端反向调用成功');
});
