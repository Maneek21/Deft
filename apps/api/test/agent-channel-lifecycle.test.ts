import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgentChannelLifecyclePatch,
  summarizeAgentChannelLifecycle,
  summarizeAgentChannelMetrics,
} from '../src/lib/agent-channel-lifecycle.js';

const created = new Date('2026-07-13T10:00:00.000Z');

function event(status = 'pending') {
  return {
    status,
    created_at: created,
    updated_at: created,
    delivered_at: null,
    acked_at: null,
    completed_at: null,
    failed_at: null,
  };
}

test('channel lifecycle moves monotonically from queued to completed', () => {
  const deliveredAt = new Date(created.getTime() + 100);
  const delivered = { ...event(), ...buildAgentChannelLifecyclePatch(event(), 'delivered', deliveredAt) };
  const ackedAt = new Date(created.getTime() + 250);
  const acknowledged = {
    ...delivered,
    ...buildAgentChannelLifecyclePatch(delivered, 'acknowledged', ackedAt),
  };
  const completedAt = new Date(created.getTime() + 1_000);
  const completed = {
    ...acknowledged,
    ...buildAgentChannelLifecyclePatch(acknowledged, 'completed', completedAt),
  };

  assert.equal(completed.status, 'completed');
  assert.equal(completed.delivered_at, deliveredAt);
  assert.equal(completed.acked_at, ackedAt);
  assert.equal(completed.completed_at, completedAt);
  assert.deepEqual(summarizeAgentChannelLifecycle(completed), {
    phase: 'completed',
    queue_ms: 100,
    acknowledge_ms: 150,
    execution_ms: 750,
    total_ms: 1_000,
    age_ms: null,
  });
});

test('terminal events cannot reopen or change outcome', () => {
  const completed = {
    ...event('completed'),
    delivered_at: new Date(created.getTime() + 100),
    acked_at: new Date(created.getTime() + 200),
    completed_at: new Date(created.getTime() + 300),
  };
  assert.deepEqual(buildAgentChannelLifecyclePatch(completed, 'running'), {});
  assert.deepEqual(buildAgentChannelLifecyclePatch(completed, 'failed', new Date(), 'late error'), {});
});

test('failure records all observable timing boundaries', () => {
  const failedAt = new Date(created.getTime() + 500);
  const patch = buildAgentChannelLifecyclePatch(event(), 'failed', failedAt, 'runtime unavailable');
  assert.equal(patch.status, 'failed');
  assert.equal(patch.delivered_at, failedAt);
  assert.equal(patch.acked_at, failedAt);
  assert.equal(patch.failed_at, failedAt);
  assert.equal(patch.error, 'runtime unavailable');
});

test('queued lifecycle reports age without inventing unavailable timings', () => {
  assert.deepEqual(
    summarizeAgentChannelLifecycle(event(), new Date(created.getTime() + 2_000)),
    {
      phase: 'queued',
      queue_ms: null,
      acknowledge_ms: null,
      execution_ms: null,
      total_ms: null,
      age_ms: 2_000,
    },
  );
});

test('channel metrics expose median, tail, and oldest open delivery age', () => {
  const complete = (total: number) => ({
    ...event('completed'),
    delivered_at: new Date(created.getTime() + 100),
    acked_at: new Date(created.getTime() + 200),
    completed_at: new Date(created.getTime() + total),
  });
  const metrics = summarizeAgentChannelMetrics(
    [complete(500), complete(1_000), complete(2_000), event()],
    new Date(created.getTime() + 3_000),
  );
  assert.equal(metrics.sample_count, 4);
  assert.deepEqual(metrics.completion, { p50_ms: 1_000, p95_ms: 2_000 });
  assert.equal(metrics.oldest_open_age_ms, 3_000);
});
