import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDeftyApprovalReply, formatDeftyTaskCandidates, normalizeCompiledToolCalls } from '../src/lib/agent-action-proposals.js';
import { resolveProjectTargetFromRows, type ProjectTargetRow } from '../src/lib/resolve-project-target.js';
const project = (id: string, name: string): ProjectTargetRow => ({ id, name, prefix: 'DEFT', is_archived: false, is_deleted: false });
const compileContext = { orgId: 'org-1', promptContent: 'Make a task for the rollback script.', sourceMessageId: 'message-1' };
test('create task with no project named uses the only accessible project', () => {
  const resolution = resolveProjectTargetFromRows([project('deft', 'Deft v1')], {});
  assert.equal(resolution.status, 'resolved');
  if (resolution.status !== 'resolved') return;
  assert.equal(resolution.project.name, 'Deft v1');
  const result = normalizeCompiledToolCalls([{ name: 'create_task', input: { title: 'Write rollback script' } }], { ...compileContext, projectNameHint: resolution.project.name });
  assert.equal(result.actions[0]?.params.project_name, 'Deft v1');
});
test('unnamed project clarification names at most five active candidate projects', () => {
  const result = resolveProjectTargetFromRows(Array.from({ length: 7 }, (_, index) => project(String(index), `Project ${index}`)), {});
  assert.equal(result.status, 'ambiguous');
  if (result.status !== 'ambiguous') return;
  assert.equal(result.candidates.length, 5);
  assert.match(result.message, /Project 0/); assert.match(result.message, /Project 4/);
  assert.doesNotMatch(result.message, /Project 5|Project 6/);
});
test('a single linked project takes precedence over other accessible projects', () => {
  const result = resolveProjectTargetFromRows([project('one', 'Deft v1'), project('two', 'Launch')], { linkedProjectIds: new Set(['one']) });
  assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') assert.equal(result.project.id, 'one');
});
test('clarification between tasks lists keys with exact titles', () => {
  assert.equal(formatDeftyTaskCandidates([{ identifier: 'DEFT-13', title: 'Review: feat(auth) — server-side logout' }, { identifier: 'DEFT-14', title: 'Review UI accessibility' }]), 'DEFT-13 "Review: feat(auth) — server-side logout" or DEFT-14 "Review UI accessibility"');
});
test('approval reply states exact task title, requested status and assignee', () => {
  assert.equal(formatDeftyApprovalReply([{ action: 'update_task_status', params: { task_identifier: 'DEFT-7', new_status: 'in_progress' } }, { action: 'assign_task', params: { task_identifier: 'DEFT-7', assignee_name: 'Arjun Rao' } }], [{ identifier: 'DEFT-7', title: 'Wire Sentry error tracking' }]), 'Drafted for approval: DEFT-7 "Wire Sentry error tracking" → In progress, assigned to Arjun Rao.');
});
test('compiler retains an incomplete task draft for a project clarification', () => {
  const result = normalizeCompiledToolCalls([{ name: 'create_task', input: { title: 'Write rollback script', assignee_name: 'Rahul Mehta', due_date: '2026-10-29' } }], compileContext);
  assert.deepEqual(result.actions, []);
  assert.equal(result.pendingActions?.[0]?.params.assignee_name, 'Rahul Mehta');
  assert.equal(result.pendingActions?.[0]?.params.due_date, '2026-10-29');
  assert.equal(result.pendingActions?.[0]?.params.source_message_id, 'message-1');
});
test('clarification continuation preserves the original owner, due date and source', () => {
  const result = normalizeCompiledToolCalls([{ name: 'create_task', input: { title: 'Write rollback script', project_name: 'Deft v1', assignee_name: 'Priya Shah', due_date: '2026-10-22' } }], { ...compileContext, sourceMessageId: 'answer-message', pendingDraft: { request_text: compileContext.promptContent, request_message_id: 'original-request', answer: 'Deft v1', draft: [{ action: 'create_task', params: { title: 'Write rollback script', assignee_name: 'Rahul Mehta', due_date: '2026-10-29', source_message_id: 'rahul-message' } }] } });
  assert.equal(result.actions[0]?.params.assignee_name, 'Rahul Mehta');
  assert.equal(result.actions[0]?.params.due_date, '2026-10-29');
  assert.equal(result.actions[0]?.params.source_message_id, 'rahul-message');
});


test('approval reply maps a UUID task target to its exact project key and title', () => {
  assert.equal(formatDeftyApprovalReply([{ action: 'update_task_status', params: { task_identifier: 'task-id', new_status: 'in_review' } }], [
    { id: 'task-id', identifier: 'DEFT-13', title: 'Review: feat(auth) — server-side logout' },
  ]), 'Drafted for approval: DEFT-13 "Review: feat(auth) — server-side logout" → In review.');
});


test('approval reply uses the matching task title when several candidate tasks are available', () => {
  assert.equal(formatDeftyApprovalReply([{ action: 'update_task_status', params: { task_identifier: 'DEFT-14', new_status: 'done' } }], [
    { identifier: 'DEFT-13', title: 'Review: feat(auth) — server-side logout' },
    { identifier: 'DEFT-14', title: 'Review UI accessibility' },
  ]), 'Drafted for approval: DEFT-14 "Review UI accessibility" → Done.');
});


test('project-only clarification with instead preserves owner and date', () => {
  const previous = { action: 'create_task', params: { title: 'Write rollback script', assignee_name: 'Rahul Mehta', due_date: '2026-10-29', source_message_id: 'source-1' } };
  const result = normalizeCompiledToolCalls([{ name: 'create_task', input: { project_name: 'Deft v1', assignee_name: 'Priya Shah', due_date: '2026-10-22' } }], {
    orgId: 'org-1', sourceMessageId: 'answer-1', promptContent: 'Deft v1 instead',
    pendingDraft: { request_text: 'make a task for what Rahul said', request_message_id: 'request-1', answer: 'Deft v1 instead', question: 'Which project?', draft: { actions: [previous] } },
  });
  assert.equal(result.actions[0]?.params.assignee_name, 'Rahul Mehta');
  assert.equal(result.actions[0]?.params.due_date, '2026-10-29');
});
