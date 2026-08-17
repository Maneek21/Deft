import test from 'node:test';
import assert from 'node:assert/strict';

test('scheduled chat-knowledge-batch resolves to a real handler', async () => {
  const workers = await import('../src/workers/index.js');
  const handler = await workers._getScheduledJobHandlerForTest('chat-knowledge-batch');

  assert.equal(typeof handler, 'function');
});

test('scheduled notification-attention-sync resolves to a real handler', async () => {
  const workers = await import('../src/workers/index.js');
  const handler = await workers._getScheduledJobHandlerForTest('notification-attention-sync');

  assert.equal(typeof handler, 'function');
});

test('durable scheduled-message-send resolves to a real handler', async () => {
  const workers = await import('../src/workers/index.js');
  const handler = await workers._getScheduledJobHandlerForTest('scheduled-message-send');

  assert.equal(typeof handler, 'function');
});
