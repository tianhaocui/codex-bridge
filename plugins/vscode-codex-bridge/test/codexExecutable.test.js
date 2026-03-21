const assert = require('node:assert/strict');
const { resolveCodexExecutable } = require('../out/core/codexExecutable.js');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('prefers CODEX_BIN when executable', () => {
  const resolved = resolveCodexExecutable({
    env: { CODEX_BIN: '/custom/codex', PATH: '/usr/bin:/bin' },
    existsSync: (p) => p === '/custom/codex',
    accessSync: (p) => {
      if (p !== '/custom/codex') throw new Error('not executable');
    },
    shellLookup: () => null
  });
  assert.equal(resolved, '/custom/codex');
});

test('falls back to PATH entry when CODEX_BIN missing', () => {
  const resolved = resolveCodexExecutable({
    env: { PATH: '/opt/bin:/usr/local/bin' },
    existsSync: (p) => p === '/usr/local/bin/codex',
    accessSync: (p) => {
      if (p !== '/usr/local/bin/codex') throw new Error('not executable');
    },
    shellLookup: () => null
  });
  assert.equal(resolved, '/usr/local/bin/codex');
});

test('uses shell lookup when direct candidates miss', () => {
  const resolved = resolveCodexExecutable({
    env: { PATH: '' },
    existsSync: (p) => p === '/shell/codex',
    accessSync: (p) => {
      if (p !== '/shell/codex') throw new Error('not executable');
    },
    shellLookup: () => '/shell/codex'
  });
  assert.equal(resolved, '/shell/codex');
});

test('throws when executable cannot be resolved', () => {
  assert.throws(
    () =>
      resolveCodexExecutable({
        env: { PATH: '' },
        existsSync: () => false,
        accessSync: () => {
          throw new Error('nope');
        },
        shellLookup: () => null
      }),
    /未找到 codex 可执行文件/
  );
});
