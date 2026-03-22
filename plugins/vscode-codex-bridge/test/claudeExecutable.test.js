const assert = require('node:assert/strict');
const { resolveClaudeExecutable } = require('../out/core/claudeExecutable.js');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('prefers CLAUDE_BIN when executable', () => {
  const resolved = resolveClaudeExecutable({
    env: { CLAUDE_BIN: '/custom/claude', PATH: '/usr/bin:/bin' },
    existsSync: (p) => p === '/custom/claude',
    accessSync: (p) => {
      if (p !== '/custom/claude') throw new Error('not executable');
    },
    shellLookup: () => null
  });
  assert.equal(resolved, '/custom/claude');
});

test('falls back to PATH entry when CLAUDE_BIN missing', () => {
  const resolved = resolveClaudeExecutable({
    env: { PATH: '/opt/bin:/usr/local/bin' },
    existsSync: (p) => p === '/usr/local/bin/claude',
    accessSync: (p) => {
      if (p !== '/usr/local/bin/claude') throw new Error('not executable');
    },
    shellLookup: () => null
  });
  assert.equal(resolved, '/usr/local/bin/claude');
});

test('uses shell lookup when direct candidates miss', () => {
  const resolved = resolveClaudeExecutable({
    env: { PATH: '' },
    existsSync: (p) => p === '/shell/claude',
    accessSync: (p) => {
      if (p !== '/shell/claude') throw new Error('not executable');
    },
    shellLookup: () => '/shell/claude'
  });
  assert.equal(resolved, '/shell/claude');
});

test('throws when executable cannot be resolved', () => {
  assert.throws(
    () =>
      resolveClaudeExecutable({
        env: { PATH: '' },
        existsSync: () => false,
        accessSync: () => {
          throw new Error('nope');
        },
        shellLookup: () => null
      }),
    /未找到 claude 可执行文件/
  );
});
