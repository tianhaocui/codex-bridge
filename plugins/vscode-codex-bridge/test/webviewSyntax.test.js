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

function loadGetHtml() {
  const file = path.resolve(__dirname, '../out/extension.js');
  const source = fs.readFileSync(file, 'utf8') + '\nmodule.exports.__getHtml = getHtml;';
  const localRequire = createRequire(file);
  const moduleObj = { exports: {} };
  const context = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id) => (id === 'vscode' ? {} : localRequire(id)),
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
  return moduleObj.exports.__getHtml;
}

test('webview inline script is syntactically valid', () => {
  const getHtml = loadGetHtml();
  const html = getHtml({});
  const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(match, 'webview html should contain inline script');
  assert.doesNotThrow(() => {
    new vm.Script(match[1], { filename: 'codex-bridge-webview.js' });
  });
});
