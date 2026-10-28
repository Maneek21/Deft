import assert from 'node:assert/strict';
import test from 'node:test';
import * as pending from '../src/lib/defty-pending-action.js';

const now = new Date('2026-10-22T10:00:00Z');
const draft = {
  kind: 'action_draft', request_message_id: 'original-request', request_text: 'make a task for what Rahul said',
  draft: { actions: [{ action: 'create_task', params: { title: 'Write rollback script', assignee_name: 'Rahul Mehta', due_date: '2026-10-29', source_message_id: 'rahul-message' } }] },
  question: 'Which project: Deft v1 or Deft v2?', created_at: '2026-10-22T09:55:00Z',
};

test('pending clarification preserves the original request, owner, date and source as untrusted evidence', () => {
  const parsed = (pending as any).parsePendingDeftyDraft({ defty_pending: draft }, now);
  assert.deepEqual(parsed, draft);
  const context = (pending as any).pendingDeftyDraftContext(parsed, 'Deft v1');
  assert.match(context, /original-request/);
  assert.match(context, /Rahul Mehta/);
  assert.match(context, /2026-10-29/);
  assert.match(context, /rahul-message/);
  assert.match(context, /Deft v1/);
});

test('pending clarifications expire after 30 minutes and cannot resume after resolution', () => {
  assert.equal((pending as any).parsePendingDeftyDraft({ defty_pending: { ...draft, created_at: '2026-10-22T09:29:59Z' } }, now), null);
  assert.equal((pending as any).parsePendingDeftyDraft({ defty_pending: draft, defty_pending_resolved_at: now.toISOString() }, now), null);
  assert.equal((pending as any).parsePendingDeftyDraft({ defty_pending: { ...draft, created_at: 'invalid' } }, now), null);
});

test('member-visible metadata projections never expose privileged pending module values', () => {
  const action = { action: 'module_record_update', params: {
    module_id: 'com.deft.contacts', collection_key: 'contacts', record_id: 'private-record',
    expected_revision: 3, expected_manifest_digest: 'manifest', patch: { notes: 'PRIVATE-OUTBOUND-CANARY' },
  } };
  const projected = (pending as any).projectPendingDeftyMetadataForOutbound({
    is_agent_reply: true,
    defty_pending: { ...draft, draft: { actions: [action], pendingActions: [action] } },
  });
  assert.equal(JSON.stringify(projected).includes('PRIVATE-OUTBOUND-CANARY'), false);
  assert.equal(projected.is_agent_reply, true);
  assert.deepEqual(projected.defty_pending.draft.actions[0].params.changed_fields, ['notes']);
  assert.deepEqual(projected.defty_pending.draft.pendingActions[0].params.changed_fields, ['notes']);
  assert.equal(action.params.patch.notes, 'PRIVATE-OUTBOUND-CANARY', 'worker-side draft input is unchanged');
});
