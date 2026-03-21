const assert = require('node:assert/strict');
const {
  composeOutboundMessage,
  isStageDone,
  sanitizedRelayPayload,
  DEFAULT_STAGE_DONE_MARKERS
} = require('../out/core/bridgeProtocol.js');

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('composeOutboundMessage appends protocol only when relay stop mode is on', () => {
  const plain = composeOutboundMessage('hello', {
    autoRelayEnabled: false,
    stopOnStageDone: true
  });
  assert.equal(plain, 'hello');

  const withProtocol = composeOutboundMessage('hello', {
    autoRelayEnabled: true,
    stopOnStageDone: true
  });
  assert.match(withProtocol, /bridge_stage/);
});

test('isStageDone detects terminal json marker', () => {
  assert.equal(isStageDone('done\n{"bridge_stage":"done"}', DEFAULT_STAGE_DONE_MARKERS), true);
  assert.equal(isStageDone('done\n{"bridge_stage":"continue"}', DEFAULT_STAGE_DONE_MARKERS), false);
});

test('isStageDone detects configured markers', () => {
  assert.equal(isStageDone('本轮任务完成，准备结束', DEFAULT_STAGE_DONE_MARKERS), true);
});

test('sanitizedRelayPayload strips final stage marker line only', () => {
  assert.equal(
    sanitizedRelayPayload('结论如下\n{"bridge_stage":"done"}'),
    '结论如下'
  );
  assert.equal(
    sanitizedRelayPayload('结论如下\n{"bridge_stage":"continue"}'),
    '结论如下'
  );
  assert.equal(sanitizedRelayPayload('没有控制标记'), '没有控制标记');
});
