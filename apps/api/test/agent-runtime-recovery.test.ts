import assert from 'node:assert/strict';
import test from 'node:test';
import { describeAgentRuntimeRecovery } from '../src/lib/agent-runtime-recovery.js';

const now = new Date('2026-07-13T12:00:00Z');
const base = { hasChannelToken: true, connectionStatus: 'connected', lastSeenAt: now, failedDeliveries: 0, pendingDeliveries: 0, now };

test('runtime recovery prioritizes setup, failures, offline state, and backlog', () => {
  assert.equal(describeAgentRuntimeRecovery({ ...base, hasChannelToken: false }).action, 'regenerate_channel_token');
  assert.equal(describeAgentRuntimeRecovery({ ...base, failedDeliveries: 2 }).action, 'inspect_queue');
  assert.equal(describeAgentRuntimeRecovery({ ...base, lastSeenAt: new Date(now.getTime() - 180_000) }).state, 'offline');
  assert.equal(describeAgentRuntimeRecovery({ ...base, pendingDeliveries: 6 }).state, 'backlogged');
  assert.equal(describeAgentRuntimeRecovery(base).state, 'healthy');
});
