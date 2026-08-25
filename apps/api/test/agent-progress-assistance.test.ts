import assert from 'node:assert/strict';
import test from 'node:test';

import { progressAssistanceDraft } from '../src/lib/mcp-tools/cooperative.js';

const base = {
  orgId: 'org-1',
  userId: 'user-1',
  employeeId: 'employee-1',
  employeeName: 'Rita',
  eventId: 'event-1',
  taskId: 'task-1',
  summary: 'I need the buyer to confirm the approved sending domain.',
  idempotencyDigest: 'sha256:milestone-1',
};

test('blocked progress creates a high-priority needs-you draft for the assigner', () => {
  const draft = progressAssistanceDraft({ ...base, status: 'blocked' });
  assert.ok(draft);
  assert.equal(draft.userId, 'user-1');
  assert.equal(draft.lane, 'needs_you');
  assert.equal(draft.priority, 'high');
  assert.equal(draft.sourceId, 'event-1');
  assert.equal(draft.link, '/tasks?task=task-1');
  assert.match(draft.title, /Rita needs help/i);
});

test('retrying progress does not interrupt the assigner', () => {
  assert.equal(
    progressAssistanceDraft({ ...base, status: 'retrying' }),
    null,
  );
});

test('assistance events are idempotent per progress milestone', () => {
  const first = progressAssistanceDraft({ ...base, status: 'needs_human' });
  const replay = progressAssistanceDraft({ ...base, status: 'needs_human' });
  assert.equal(first?.sourceEventId, replay?.sourceEventId);
  assert.equal(first?.dedupeKey, replay?.dedupeKey);
});

