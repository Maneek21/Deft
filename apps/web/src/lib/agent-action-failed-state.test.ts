// Lane W2-a2 — E04: an approved action whose execution failed renders as
// failed (with its error), never as a green "done", on every surface that
// renders the shared approval card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getAgentActionDisplayStatus,
  getApprovalMutationStatus,
} from './agent-action-presentation';

test('E04: an approved native action with an error is shown as failed', () => {
  assert.equal(getAgentActionDisplayStatus({
    action: 'create_note', approval_status: 'approved', error: 'Note could not be saved',
  }), 'failed');
  assert.equal(getAgentActionDisplayStatus({ action: 'create_note', approval_status: 'approved', error: null }), 'approved');
  assert.equal(getAgentActionDisplayStatus({ action: 'create_note', approval_status: 'approved', error: '  ' }), 'approved');
});

test('E04: a claimed approval that is still running is shown as executing', () => {
  assert.equal(getAgentActionDisplayStatus({
    action: 'create_task', approval_status: 'approved', result: { lifecycle_state: 'executing' },
  }), 'executing');
});

test('E04: pending and rejected rows keep their status even with an error recorded', () => {
  assert.equal(getAgentActionDisplayStatus({ action: 'create_task', approval_status: 'pending', error: 'retry me' }), 'pending');
  assert.equal(getAgentActionDisplayStatus({ action: 'create_task', approval_status: 'rejected', error: 'reason' }), 'rejected');
});

test('E04: App Run actions keep their own run-state presentation', () => {
  assert.equal(getAgentActionDisplayStatus({
    action: 'app_run_invoke', approval_status: 'approved', error: 'provider failed',
  }), 'approved');
});

test('E04: approve answers map failed and executing instead of defaulting to approved', () => {
  assert.equal(getApprovalMutationStatus({ status: 'failed', error: 'x' }, 'approved'), 'failed');
  assert.equal(getApprovalMutationStatus({ status: 'executing' }, 'approved'), 'executing');
  assert.equal(getApprovalMutationStatus({ status: 'approved', success: false }, 'approved'), 'failed');
  assert.equal(getApprovalMutationStatus({ status: 'approved' }, 'approved'), 'approved');
  assert.equal(getApprovalMutationStatus({ status: 'rejected' }, 'approved'), 'rejected');
  assert.equal(getApprovalMutationStatus(undefined, 'rejected'), 'rejected');
});

test('E04: the card derives its server status from the shared display status', () => {
  const card = readFileSync(new URL('../components/agent-action-card.tsx', import.meta.url), 'utf8');
  assert.match(card, /const serverStatus = getAgentActionDisplayStatus\(action\);/);
  assert.match(card, /getApprovalMutationStatus\(result, 'approved'\)/);
});

test('E04: inbox and Needs-you hydration pass the execution outcome to the card', () => {
  for (const path of ['../app/(app)/inbox/page.tsx', '../components/notification-panel.tsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /error: item\.approval\.error/, path);
    assert.match(source, /approval_status: item\.approval\.approval_status/, path);
    assert.match(source, /result: item\.approval\.result/, path);
  }
});
