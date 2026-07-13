import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAgentDelivery } from '../src/workers/handlers/agent-employee-message.js';

const NOW = Date.parse('2026-07-13T12:00:00Z');

test('reports sent only for a live channel connection', () => {
  assert.deepEqual(describeAgentDelivery('Rita', {
    status: 'connected',
    last_seen_at: new Date('2026-07-13T11:59:00Z'),
  }, NOW), {
    state: 'sent',
    content: 'Sent to Rita. They will reply here when they pick it up.',
  });
});

test('reports queued when a known runtime is stale or disconnected', () => {
  const result = describeAgentDelivery('Rita', {
    status: 'connected',
    last_seen_at: new Date('2026-07-13T11:50:00Z'),
  }, NOW);
  assert.equal(result.state, 'queued');
  assert.match(result.content, /runtime is offline/);
});

test('gives setup guidance when the runtime never connected', () => {
  assert.deepEqual(describeAgentDelivery('Rita', null, NOW), {
    state: 'queued',
    content: 'Queued for Rita. Connect their runtime to deliver it.',
  });
});
