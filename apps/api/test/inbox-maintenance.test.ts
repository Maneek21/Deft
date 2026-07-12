import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addInboxCompactionMetadata,
  inboxCompactionRunId,
  planLegacyTaskNudgeCompaction,
  removeInboxCompactionMetadata,
  type InboxMaintenanceRow,
} from '../src/lib/inbox-maintenance.js';

function row(overrides: Partial<InboxMaintenanceRow> & Pick<InboxMaintenanceRow, 'id'>): InboxMaintenanceRow {
  return {
    id: overrides.id,
    user_id: overrides.user_id ?? 'user-1',
    title: overrides.title ?? overrides.id,
    is_read: overrides.is_read ?? false,
    metadata: overrides.metadata ?? { nudge_type: 'overdue' },
    created_at: overrides.created_at ?? '2026-07-12T00:00:00.000Z',
  };
}

test('keeps the newest unread nudge per user and nudge type', () => {
  const groups = planLegacyTaskNudgeCompaction([
    row({ id: 'old', created_at: '2026-07-10T00:00:00.000Z' }),
    row({ id: 'new', created_at: '2026-07-12T00:00:00.000Z' }),
    row({ id: 'middle', created_at: '2026-07-11T00:00:00.000Z' }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep.id, 'new');
  assert.deepEqual(groups[0].compact.map((candidate) => candidate.id), ['middle', 'old']);
});

test('does not cross user or nudge-type boundaries', () => {
  const groups = planLegacyTaskNudgeCompaction([
    row({ id: 'u1-overdue-new', user_id: 'user-1', created_at: '2026-07-12T00:00:00.000Z' }),
    row({ id: 'u1-overdue-old', user_id: 'user-1', created_at: '2026-07-11T00:00:00.000Z' }),
    row({ id: 'u2-overdue', user_id: 'user-2' }),
    row({ id: 'u1-stalled', user_id: 'user-1', metadata: { nudge_type: 'stalled' } }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'user-1:overdue');
  assert.deepEqual(groups[0].compact.map((candidate) => candidate.id), ['u1-overdue-old']);
});

test('ignores read rows and non-task agent suggestions', () => {
  const groups = planLegacyTaskNudgeCompaction([
    row({ id: 'read-old', is_read: true }),
    row({ id: 'unread-new' }),
    row({ id: 'duplicate-alert', metadata: { nudge_type: 'duplicate_detected' } }),
    row({ id: 'seed-suggestion', metadata: { seed: 'pilot-living' } }),
  ]);
  assert.deepEqual(groups, []);
});

test('compaction metadata carries a restorable run id without losing existing metadata', () => {
  const metadata = addInboxCompactionMetadata({
    metadata: { nudge_type: 'overdue', task_id: 'task-1' },
    runId: 'run-123',
    compactedAt: '2026-07-12T01:00:00.000Z',
    keptNotificationId: 'keeper',
  });

  assert.equal(inboxCompactionRunId(metadata), 'run-123');
  assert.equal(metadata.nudge_type, 'overdue');
  assert.equal(metadata.task_id, 'task-1');
  assert.deepEqual(removeInboxCompactionMetadata(metadata), {
    nudge_type: 'overdue',
    task_id: 'task-1',
  });
});
