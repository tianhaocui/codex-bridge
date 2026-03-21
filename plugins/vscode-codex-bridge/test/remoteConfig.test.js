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
# Codex Bridge Remote 连接配置
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

test('buildRemoteConnectionSnippet includes selected export session when present', () => {
  const BridgeController = loadBridgeController();
  const controller = new BridgeController();
  controller.state.remoteMode = 'host';
  controller.state.remoteToken = 'token-12345678';
  controller.state.remoteListenPort = 9238;
  controller.state.remoteExportSide = 'B';
  controller.state.remoteDeviceName = 'device-name';
  controller.state.toolB = 'codex';
  controller.state.projectBPath = '/Users/wulingren/Desktop/codex-bridge-fix';
  controller.state.sessionB = '12345678-1234-1234-1234-123456789abc';

  const snippet = controller.buildRemoteConnectionSnippet();
  assert.match(snippet, /targetProjectPath=\/Users\/wulingren\/Desktop\/codex-bridge-fix/);
  assert.match(snippet, /targetSessionId=12345678-1234-1234-1234-123456789abc/);
});
