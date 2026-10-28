import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCompiledToolCalls, sanitizeAgentReplyActionMetadata } from '../src/lib/agent-action-proposals.js';

const pendingParams = (answer: string, draftParams: Record<string, any> = {}, question = 'Which project?') => ({
  orgId: 'org', sourceMessageId: 'answer', promptContent: answer,
  pendingDraft: {
    request_message_id: 'original-request', request_text: 'make a task for what Rahul said',
    question, answer,
    draft: { actions: [{ action: 'create_task', params: {
      title: 'Write rollback script', project_name: 'Deft v1', assignee_name: 'Rahul Mehta',
      due_date: '2026-10-29', source_message_id: 'rahul-message', ...draftParams,
    } }] },
  },
});

test('pending clarification drafts use the action-history projection for privileged action values', () => {
  const params = { module_id: 'com.deft.contacts', collection_key: 'contacts', record_id: 'private-record',
    expected_revision: 3, expected_manifest_digest: 'manifest', patch: { notes: 'PRIVATE-PENDING-VALUE' } };
  const action = { action: 'module_record_update', params };
  const sanitized = sanitizeAgentReplyActionMetadata({
    defty_pending: { kind: 'action_draft', request_message_id: 'request',
      draft: { actions: [action], pendingActions: [action] } },
    action_graph: { actions: [{ tool: action.action, params }] },
  });
  assert.equal(JSON.stringify(sanitized).includes('PRIVATE-PENDING-VALUE'), false);
  assert.deepEqual(sanitized.defty_pending.draft.actions[0].params, sanitized.action_graph.actions[0].params);
  assert.deepEqual(sanitized.defty_pending.draft.pendingActions[0].params, sanitized.action_graph.actions[0].params);
  assert.equal(params.patch.notes, 'PRIVATE-PENDING-VALUE', 'server-side compiler input is left intact');
});

test('combined project, owner and weekday replacements override a pending task draft', () => {
  const params = {
    orgId: 'org', sourceMessageId: 'answer', promptContent: 'Deft v1; Sara instead of Rahul, next Monday instead of Thursday',
    pendingDraft: {
      request_message_id: 'original-request', request_text: 'make a task for what Rahul said',
      question: 'Which project: Deft v1 or Deft v2?',
      answer: 'Deft v1; Sara instead of Rahul, next Monday instead of Thursday',
      draft: { actions: [{ action: 'create_task', params: {
        title: 'Write rollback script', assignee_name: 'Rahul Mehta', due_date: '2026-10-29',
        source_message_id: 'rahul-message',
      } }] },
    },
  };
  const normalized = normalizeCompiledToolCalls([{ name: 'create_task', input: {
    project_name: 'Deft v1', assignee_name: 'Sara Khan', due_date: '2026-10-26',
  } }], params);
  assert.equal(normalized.actions.length, 1);
  const action = normalized.actions[0]!;
  assert.equal(action.params.project_name, 'Deft v1');
  assert.equal(action.params.assignee_name, 'Sara Khan');
  assert.equal(action.params.due_date, '2026-10-26');
  assert.equal(action.params.title, 'Write rollback script');
  assert.equal(action.params.source_message_id, 'rahul-message');
});

test('an owner replacement alone keeps the pending date and source', () => {
  const normalized = normalizeCompiledToolCalls([{ name: 'create_task', input: {
    project_name: 'Deft v1', assignee_name: 'Sara Khan', due_date: '2026-10-26',
  } }], {
    orgId: 'org', sourceMessageId: 'answer', promptContent: 'Sara instead of Rahul',
    pendingDraft: {
      request_message_id: 'original-request', request_text: 'make a task for what Rahul said',
      question: 'Which project?', answer: 'Deft v1; Sara instead of Rahul',
      draft: { actions: [{ action: 'create_task', params: {
        title: 'Write rollback script', assignee_name: 'Rahul Mehta', due_date: '2026-10-29', source_message_id: 'rahul-message',
      } }] },
    },
  });
  assert.equal(normalized.actions[0]!.params.assignee_name, 'Sara Khan');
  assert.equal(normalized.actions[0]!.params.due_date, '2026-10-29');
  assert.equal(normalized.actions[0]!.params.source_message_id, 'rahul-message');
});

test('a combined correction also replaces an existing draft project', () => {
  const normalized = normalizeCompiledToolCalls([{ name: 'create_task', input: {
    project_name: 'Deft v2', assignee_name: 'Sara Khan', due_date: '2026-11-02',
  } }], pendingParams('Deft v2; Sara instead of Rahul, next Monday instead of Thursday'));
  const params = normalized.actions[0]!.params;
  assert.equal(params.project_name, 'Deft v2');
  assert.equal(params.assignee_name, 'Sara Khan');
  assert.equal(params.due_date, '2026-11-02');
  assert.equal(params.title, 'Write rollback script');
  assert.equal(params.source_message_id, 'rahul-message');
});

for (const answer of ['Sara instead of Rahul', 'not Rahul, Sara', 'change Rahul to Sara', 'make it Sara']) {
  test(`an owner correction phrased as "${answer}" keeps the pending date, project and source`, () => {
    const normalized = normalizeCompiledToolCalls([{ name: 'create_task', input: {
      project_name: 'Deft v2', assignee_name: 'Sara Khan', due_date: '2026-11-05',
    } }], pendingParams(answer, {}, 'Who should own it?'));
    const params = normalized.actions[0]!.params;
    assert.equal(params.assignee_name, 'Sara Khan');
    assert.equal(params.due_date, '2026-10-29');
    assert.equal(params.project_name, 'Deft v1');
    assert.equal(params.source_message_id, 'rahul-message');
  });
}

test('a date correction alone keeps the pending owner and project', () => {
  const normalized = normalizeCompiledToolCalls([{ name: 'create_task', input: {
    project_name: 'Deft v2', assignee_name: 'Sara Khan', due_date: '2026-11-02',
  } }], pendingParams('make it the 2nd of November', {}, 'When is it due?'));
  const params = normalized.actions[0]!.params;
  assert.equal(params.due_date, '2026-11-02');
  assert.equal(params.assignee_name, 'Rahul Mehta');
  assert.equal(params.project_name, 'Deft v1');
  assert.equal(params.source_message_id, 'rahul-message');
});

test('a date replacement phrase keeps the pending owner and project', () => {
  const normalized = normalizeCompiledToolCalls([{ name: 'create_task', input: {
    project_name: 'Deft v2', assignee_name: 'Sara Khan', due_date: '2026-11-02',
  } }], pendingParams('not Thursday, next Monday', {}, 'When is it due?'));
  const params = normalized.actions[0]!.params;
  assert.equal(params.due_date, '2026-11-02');
  assert.equal(params.assignee_name, 'Rahul Mehta');
  assert.equal(params.project_name, 'Deft v1');
});

test('a project correction alone keeps the pending owner and date', () => {
  const normalized = normalizeCompiledToolCalls([{ name: 'create_task', input: {
    project_name: 'Deft v2', assignee_name: 'Sara Khan', due_date: '2026-11-05',
  } }], pendingParams('change the project to Deft v2'));
  const params = normalized.actions[0]!.params;
  assert.equal(params.project_name, 'Deft v2');
  assert.equal(params.assignee_name, 'Rahul Mehta');
  assert.equal(params.due_date, '2026-10-29');
  assert.equal(params.source_message_id, 'rahul-message');
});

test('an answer that only names the project keeps the earlier owner and date', () => {
  const normalized = normalizeCompiledToolCalls([{ name: 'create_task', input: {
    project_name: 'Deft v2', assignee_name: 'Sara Khan', due_date: '2026-11-05',
  } }], pendingParams('Deft v2', { project_name: undefined }));
  const params = normalized.actions[0]!.params;
  assert.equal(params.project_name, 'Deft v2');
  assert.equal(params.assignee_name, 'Rahul Mehta');
  assert.equal(params.due_date, '2026-10-29');
  assert.equal(params.source_message_id, 'rahul-message');
});
