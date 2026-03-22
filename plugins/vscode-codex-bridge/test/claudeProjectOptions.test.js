const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

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

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

(async () => {
  await test('claude project and session options prefer real cwd from jsonl content', async () => {
    const BridgeController = loadBridgeController();
    const controller = new BridgeController();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-claude-'));
    const projectDir = path.join(root, '-Users-test-Desktop-item-client-web');
    fs.mkdirSync(projectDir, { recursive: true });

    writeJsonl(path.join(projectDir, 'session-a.jsonl'), [
      { type: 'queue-operation', sessionId: 'session-a' },
      {
        type: 'user',
        sessionId: 'session-a',
        cwd: '/Users/test/Desktop/item-client-web',
        timestamp: '2026-03-22T10:00:00.000Z',
        message: {
          content: [{ type: 'text', text: '第一条 Claude 消息' }]
        }
      }
    ]);

    writeJsonl(path.join(projectDir, 'session-b.jsonl'), [
      { type: 'queue-operation', sessionId: 'session-b' },
      {
        type: 'user',
        sessionId: 'session-b',
        timestamp: '2026-03-22T11:00:00.000Z',
        message: {
          content: [{ type: 'text', text: '第二条 Claude 消息' }]
        }
      }
    ]);

    const projects = await controller.parseClaudeProjects(root);
    const sessions = await controller.parseClaudeSessions(root);

    assert.deepEqual(Array.from(projects), ['/Users/test/Desktop/item-client-web']);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, 'session-b');
    assert.equal(sessions[0].cwd, '/Users/test/Desktop/item-client-web');
    assert.match(sessions[0].displayLabel, /第二条 Claude 消息/);
    assert.equal(sessions[1].cwd, '/Users/test/Desktop/item-client-web');
    assert.match(sessions[1].displayLabel, /第一条 Claude 消息/);
  });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
