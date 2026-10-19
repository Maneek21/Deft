import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentActivityCopy } from './agent-activity-copy';

const task = { action: 'create_task', params: { title: 'Review evidence', project_name: 'Synthetic launch' }, approval_status: 'pending', executed_at: null, error: null };

test('pending and approved-but-unexecuted task proposals never claim creation', () => {
  assert.match(agentActivityCopy(task), /^Proposed task/);
  assert.match(agentActivityCopy({ ...task, approval_status: 'approved' }), /^Approved, awaiting execution:/);
});

test('only approved successful execution uses completed wording', () => {
  assert.match(agentActivityCopy({ ...task, approval_status: 'approved', executed_at: '2026-10-19T00:00:00Z' }), /^Created task/);
  for (const outcome of [{ error: 'Action error' }, { result: { success: false } }, { result: { status: 'failed' } }]) {
    assert.match(agentActivityCopy({ ...task, approval_status: 'approved', executed_at: '2026-10-19T00:00:00Z', ...outcome }), /^Failed action:/);
  }
});

test('rejected and expired proposals retain their actual decision', () => {
  assert.match(agentActivityCopy({ ...task, approval_status: 'rejected' }), /^Rejected proposal:/);
  assert.match(agentActivityCopy({ ...task, approval_status: 'expired' }), /^Expired proposal:/);
});
