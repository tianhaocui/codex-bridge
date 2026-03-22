const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

function loadClaudeWorker(spawnImpl) {
  const file = path.resolve(__dirname, '../out/extension.js');
  const source = fs.readFileSync(file, 'utf8') + '\nmodule.exports.__ClaudeWorker = ClaudeWorker;';
  const localRequire = createRequire(file);
  const moduleObj = { exports: {} };
  const actualChildProcess = require('node:child_process');
  const context = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id) => {
      if (id === 'vscode') return {};
      if (id === 'node:child_process') {
        return {
          ...actualChildProcess,
          spawn: spawnImpl
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
  return moduleObj.exports.__ClaudeWorker;
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

function createMockClaudeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
  };
  let stdinEnded = false;
  proc.stdin = {
    writable: true,
    end() {
      stdinEnded = true;
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"session-1"}\n'));
        proc.emit('exit', 0, null);
      });
    }
  };
  return { proc, didEndStdin: () => stdinEnded };
}

(async () => {
  await test('ClaudeWorker closes stdin so non-interactive runs can complete', async () => {
    const mock = createMockClaudeProcess();
    const ClaudeWorker = loadClaudeWorker(() => mock.proc);
    const worker = new ClaudeWorker();

    const result = await new Promise((resolve) => {
      worker.send(
        '请只回复OK',
        '/tmp',
        undefined,
        () => undefined,
        () => undefined,
        (finalResult) => resolve(finalResult)
      );
    });

    assert.equal(mock.didEndStdin(), true);
    assert.equal(result.ok, true);
    assert.equal(result.text, 'OK');
  });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
