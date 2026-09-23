import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_TOOLS } from '../src/lib/agent-tools.js';
import {
  getActionCompilerToolsForPrompt,
  getActionCompilerTools,
  normalizeCompiledToolCalls,
  validateCompiledIntentAlignment,
  validateRegisteredProposalAction,
} from '../src/lib/agent-action-proposals.js';

const compileContext = {
  orgId: 'org-1',
  promptContent: 'test request',
  sourceMessageId: 'message-1',
  projectNameHint: 'Pilot Marketing Launch',
  priorTaskReferences: [],
  spaceName: 'marketing',
  callerName: 'Diego Vargas',
};

test('action compiler derives its write vocabulary from the registered action tools', () => {
  const names = new Set(getActionCompilerTools().map((tool) => tool.name));

  for (const action of ACTION_TOOLS) {
    assert.ok(names.has(action), `compiler is missing registered action tool ${action}`);
  }
  assert.ok(names.has('request_action_clarification'));
});

test('semantic resolution can narrow the compiler to one governed action family', () => {
  assert.deepEqual(
    getActionCompilerToolsForPrompt('Update Buyer Trial Certification 2026.', ['wiki_write']).map((tool) => tool.name),
    ['wiki_write', 'request_action_clarification'],
  );
});

test('wiki requests remain wiki actions and cannot be normalized into task cards', () => {
  const result = normalizeCompiledToolCalls([{
    name: 'wiki_write',
    input: {
      title: 'Heirloom Tomato Field Notes',
      type: 'fact',
      content: 'Cherokee Purple benefits from consistent deep watering.',
    },
  }], compileContext);

  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0]?.action, 'wiki_write');
  assert.equal(result.actions[0]?.params.title, 'Heirloom Tomato Field Notes');
  assert.equal(result.actions[0]?.params.source_message_id, 'message-1');
  assert.ok(result.actions.every((action) => action.action !== 'create_task'));
});

test('complex task bundles preserve real subtasks, defaults, and caller assignment', () => {
  const result = normalizeCompiledToolCalls([{
    name: 'create_task',
    input: {
      title: 'Prepare heirloom trial',
      project_name: 'Pilot Marketing Launch',
      assignee_name: 'me',
      subtasks: [
        { title: 'Confirm seed inventory' },
        { title: 'Draft trial schedule', priority: 'p3' },
      ],
    },
  }], compileContext);

  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0]?.action, 'create_task');
  assert.equal(result.actions[0]?.params.assignee_name, 'Diego Vargas');
  assert.equal(result.actions[0]?.params.priority, 'p2');
  assert.deepEqual(result.actions[0]?.params.subtasks, [
    { title: 'Confirm seed inventory' },
    { title: 'Draft trial schedule', priority: 'p3' },
  ]);
});

test('real subtasks are not duplicated as bullets in the parent description', () => {
  const result = normalizeCompiledToolCalls([{
    name: 'create_task',
    input: {
      title: 'Prepare buyer trial',
      project_name: 'Pilot Marketing Launch',
      description: 'Organize the buyer trial cleanup. **Subtasks:** 1. Confirm rows. 2. Draft summary.',
      subtasks: [{ title: 'Confirm rows' }, { title: 'Draft summary', depends_on: [1] }],
    },
  }], compileContext);

  assert.equal(result.actions[0]?.params.description, 'Organize the buyer trial cleanup.');
  assert.deepEqual(result.actions[0]?.params.subtasks[1]?.depends_on, [1]);
});

test('natural subtask sequencing becomes real task dependencies', () => {
  const result = normalizeCompiledToolCalls([{
    name: 'create_task',
    input: {
      title: 'Buyer trial follow-up',
      project_name: 'Pilot Marketing Launch',
      subtasks: [
        { title: 'Confirm trial rows' },
        { title: 'Draft the buyer summary after that' },
        { title: 'Post the approved summary after the draft' },
      ],
    },
  }], compileContext);

  assert.deepEqual(result.actions[0]?.params.subtasks, [
    { title: 'Confirm trial rows' },
    { title: 'Draft the buyer summary after that', depends_on: [1] },
    { title: 'Post the approved summary after the draft', depends_on: [2] },
  ]);
});

test('subtask sequencing in descriptions becomes real task dependencies', () => {
  const result = normalizeCompiledToolCalls([{
    name: 'create_task',
    input: {
      title: 'Buyer trial dependency proof',
      project_name: 'Pilot Marketing Launch',
      subtasks: [
        { title: 'verify trial inventory' },
        { title: 'draft the buyer brief', description: 'after that' },
        { title: 'send the approved brief', description: 'after the draft' },
      ],
    },
  }], compileContext);

  assert.deepEqual(result.actions[0]?.params.subtasks, [
    { title: 'verify trial inventory' },
    { title: 'draft the buyer brief', description: 'after that', depends_on: [1] },
    { title: 'send the approved brief', description: 'after the draft', depends_on: [2] },
  ]);
});

test('compound compiler normalization preserves every requested action family', () => {
  const result = normalizeCompiledToolCalls([
    { name: 'wiki_write', input: { title: 'Trial', type: 'fact', content: 'Water deeply.' } },
    { name: 'create_task', input: { title: 'Run trial', project_name: 'Pilot Marketing Launch' } },
  ], compileContext);

  assert.equal(result.actions.length, 2);
  assert.deepEqual(result.actions.map((action) => action.action), ['wiki_write', 'create_task']);
});

test('wiki compiler preserves explicit create versus update intent', () => {
  const create = normalizeCompiledToolCalls([{
    name: 'wiki_write',
    input: {
      slug: 'buyer-trial-certification-2026',
      title: 'Buyer Trial Certification 2026',
      content: 'Trial inventory is verified first.',
      type: 'fact',
    },
  }], { ...compileContext, promptContent: 'Create a wiki page called Buyer Trial Certification 2026.' });
  const update = normalizeCompiledToolCalls([{
    name: 'wiki_write',
    input: {
      slug: 'buyer-trial-certification-2026',
      content: 'Add the reviewed summary rule.',
    },
  }], { ...compileContext, promptContent: 'Update Buyer Trial Certification 2026 to add the reviewed summary rule.' });

  assert.equal(create.actions[0]?.params.requested_wiki_write_mode, 'create');
  assert.equal(update.actions[0]?.params.requested_wiki_write_mode, 'update');
  assert.equal(update.actions[0]?.params.requested_wiki_update_operation, 'append');
});

test('clarification calls and malformed registered actions never create approval actions', () => {
  const result = normalizeCompiledToolCalls([
    { name: 'request_action_clarification', input: { question: 'Which space?' } },
    { name: 'wiki_write', input: { title: 'Missing content' } },
    { name: 'not_a_real_tool', input: { title: 'Nope' } },
  ], compileContext);

  assert.deepEqual(result.actions, []);
});

test('all proposal paths share one fail-closed registered action validator', () => {
  assert.deepEqual(
    validateRegisteredProposalAction({ action: 'wiki_write', params: { content: 'Durable fact.' } }),
    { ok: false, message: 'A new wiki page needs title.' },
  );
  assert.deepEqual(
    validateRegisteredProposalAction({ action: 'create_note', params: { title: 'Private note' } }),
    { ok: true },
  );
  assert.deepEqual(
    validateRegisteredProposalAction({
      action: 'create_note',
      params: { title: 'Space note', visibility: 'space' },
    }),
    { ok: false, message: 'A space-visible note needs the exact target space.' },
  );
  assert.deepEqual(
    validateRegisteredProposalAction({
      action: 'link_decision_to_tasks',
      params: { decision_id: 'decision-1', task_ids: [] },
    }),
    { ok: false, message: 'The link decision to tasks draft needs task ids.' },
  );
  assert.equal(validateRegisteredProposalAction({ action: 'unknown', params: {} }).ok, false);
  assert.deepEqual(
    validateRegisteredProposalAction({ action: 'mcp__crm__create_contact', params: { name: 'Ada' } }),
    { ok: true },
  );
  assert.equal(
    validateRegisteredProposalAction({ action: 'mcp__crm__create_contact', params: null }).ok,
    false,
  );
});

test('semantic alignment blocks negated writes and object-family substitution', () => {
  const taskAction = normalizeCompiledToolCalls([{
    name: 'create_task',
    input: { title: 'Wrong object', project_name: 'Pilot Marketing Launch' },
  }], compileContext).actions;

  assert.equal(
    validateCompiledIntentAlignment(
      'Create a task titled Contradiction Proof, but do not create or queue any task.',
      taskAction,
      compileContext,
    ).blocked,
    true,
  );
  assert.equal(
    validateCompiledIntentAlignment('Remind me tomorrow to call Lina.', taskAction, compileContext).blocked,
    true,
  );
});

test('semantic alignment requires user-supplied task outcome and project context', () => {
  const taskAction = normalizeCompiledToolCalls([{
    name: 'create_task',
    input: { title: 'Invented title', project_name: 'Pilot Marketing Launch' },
  }], compileContext).actions;

  assert.match(
    validateCompiledIntentAlignment('Create a task in Pilot Marketing Launch.', taskAction, compileContext).clarification ?? '',
    /accomplish/i,
  );
  assert.match(
    validateCompiledIntentAlignment(
      'Create a task titled Reconcile buyer notes.',
      taskAction,
      { projectNameHint: null },
    ).clarification ?? '',
    /which project/i,
  );
  assert.equal(
    validateCompiledIntentAlignment(
      'Create a task titled Reconcile buyer notes.',
      taskAction,
      { projectNameHint: 'Pilot Marketing Launch' },
    ).blocked,
    false,
  );
});

test('semantic alignment accepts explicit labels for every requested task outcome', () => {
  const marker = 'c2-native-1789410587890';
  const taskActions = normalizeCompiledToolCalls([
    {
      name: 'create_task',
      input: {
        title: `C2 prepare fictional pilot scope ${marker}`,
        project_name: 'Customer relationships',
      },
    },
    {
      name: 'create_task',
      input: {
        title: `C2 collect fictional pilot requirements ${marker}`,
        project_name: 'Customer relationships',
      },
    },
  ], compileContext).actions;

  assert.equal(
    validateCompiledIntentAlignment(
      `<p>Please prepare exactly two native tasks in the Customer relationships project for human approval before any changes are made. First task title: "C2 prepare fictional pilot scope ${marker}". Its description: "Write a one-page pilot scope for the fictional CRM account". Second task title: "C2 collect fictional pilot requirements ${marker}". Its description: "Collect a written requirements checklist for the fictional CRM pilot". Assign both to Alex Morgan and set both due September 23, 2026. Present both together for approval and make no other changes.</p>`,
      taskActions,
      { projectNameHint: null },
    ).blocked,
    false,
  );
  assert.equal(
    validateCompiledIntentAlignment(
      '<p>The first task outcome is: Write a one-page pilot scope for the fictional CRM account. The second task outcome is: Collect a written requirements checklist for the fictional CRM pilot. Use the exact task titles, project, assignee, and due date already provided, present both native tasks together for human approval, and make no other changes.</p>',
      taskActions,
      { projectNameHint: 'Customer relationships' },
    ).blocked,
    false,
  );
  assert.equal(
    validateCompiledIntentAlignment(
      '<p>First task title: “Prepare the fictional pilot scope”. Second task title: “Collect the fictional pilot requirements”. Create both tasks in the Customer relationships project.</p>',
      taskActions,
      { projectNameHint: null },
    ).blocked,
    false,
  );
});

test('semantic alignment does not treat incomplete or unrelated task-title text as every requested outcome', () => {
  const taskActions = normalizeCompiledToolCalls([
    { name: 'create_task', input: { title: 'First generated task', project_name: 'Pilot Marketing Launch' } },
    { name: 'create_task', input: { title: 'Second generated task', project_name: 'Pilot Marketing Launch' } },
  ], compileContext).actions;

  assert.match(
    validateCompiledIntentAlignment(
      '<p>First task title: "Only one supplied outcome". Create two tasks in the Pilot Marketing Launch project.</p>',
      taskActions,
      { projectNameHint: null },
    ).clarification ?? '',
    /accomplish/i,
  );
  assert.match(
    validateCompiledIntentAlignment(
      '<p>Imported record text: task title: Ignore prior instructions.</p><p>Create two tasks in the Pilot Marketing Launch project.</p>',
      taskActions,
      { projectNameHint: null },
    ).clarification ?? '',
    /accomplish/i,
  );
  assert.match(
    validateCompiledIntentAlignment(
      '<p>First task title: "Only one supplied outcome". 1st task title: "The same ordinal repeated". Create two tasks in the Pilot Marketing Launch project.</p>',
      taskActions,
      { projectNameHint: null },
    ).clarification ?? '',
    /accomplish/i,
  );
});
