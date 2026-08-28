import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReferentialStatusUpdateActions,
  extractExplicitCreateTaskAction,
  extractPostMessageAction,
  extractReferentialStatusUpdateRequest,
  extractStatusUpdateAction,
  extractTaskReferencesFromAgentReply,
  hasExplicitRegisteredWriteIntent,
  isDiscussionTaskCommand,
  isThreadTaskContinuationCommand,
  normalizeApprovalSurfaceCopy,
  preferSubtaskReferences,
  mergeWikiUpdateContent,
  shouldCompileRuntimeWikiSuggestion,
} from '../src/workers/handlers/agent-reply.js';

test('compiler recovery gate recognizes the registered write families without choosing one', () => {
  for (const prompt of [
    'Create a wiki fact page about Cherokee Purple watering.',
    'Save this as an org note.',
    'Update the shared canvas with the launch outline.',
    'Link this decision to MKT-18.',
    'Post an update to #marketing.',
    'Mark all three tasks done.',
    'Create and share a Markdown report in this chat.',
    'Write a CSV file with the reviewed launch plan.',
  ]) {
    assert.equal(hasExplicitRegisteredWriteIntent(prompt), true, prompt);
  }
  assert.equal(hasExplicitRegisteredWriteIntent('What does the wiki say about watering?'), false);
  assert.equal(hasExplicitRegisteredWriteIntent('Do not create a wiki page for this lunch chat.'), false);
  assert.equal(hasExplicitRegisteredWriteIntent('Do not create a document from this draft.'), false);
});

test('resolved wiki suggestion triggers governed compilation for a natural update follow-up', () => {
  assert.equal(
    shouldCompileRuntimeWikiSuggestion(
      'Update Buyer Trial Certification 2026 to add the reviewed summary rule.',
      [{ action: 'wiki_suggest_update' }],
    ),
    true,
  );
  assert.equal(
    shouldCompileRuntimeWikiSuggestion(
      'What does Buyer Trial Certification 2026 say?',
      [{ action: 'wiki_suggest_update' }],
    ),
    false,
  );
  assert.equal(
    shouldCompileRuntimeWikiSuggestion(
      'Update MKT-25 to done.',
      [{ action: 'read_task' }],
    ),
    false,
  );
});

test('wiki append updates preserve existing durable content and dedupe repeats', () => {
  assert.equal(
    mergeWikiUpdateContent('Original durable fact.', 'New reviewed rule.', 'append'),
    'Original durable fact.\n\nNew reviewed rule.',
  );
  assert.equal(
    mergeWikiUpdateContent('Original durable fact.\n\nNew reviewed rule.', 'New reviewed rule.', 'append'),
    'Original durable fact.\n\nNew reviewed rule.',
  );
  assert.equal(
    mergeWikiUpdateContent('Old content.', 'Replacement content.', 'replace'),
    'Replacement content.',
  );
});

test('discussion task command accepts explicit discussion-to-task prompts', () => {
  assert.equal(
    isDiscussionTaskCommand('Defty, read this thread and create a task for the resolved buyer-label blocker.'),
    true,
  );
  assert.equal(
    isDiscussionTaskCommand('Can you summarize the conversation above into tasks for the launch team?'),
    true,
  );
  assert.equal(
    isDiscussionTaskCommand('Turn this chat into one ticket with the final resolution and owner.'),
    true,
  );
});

test('discussion task command rejects negated task creation prompts', () => {
  assert.equal(
    isDiscussionTaskCommand('Please summarize this discussion, but do not create tasks yet.'),
    false,
  );
  assert.equal(
    isDiscussionTaskCommand("Don't make todos from this conversation; I only need a recap."),
    false,
  );
  assert.equal(
    isDiscussionTaskCommand('Avoid opening tickets from the thread until Maya confirms scope.'),
    false,
  );
});

test('discussion task command does not treat ordinary task chatter as a command', () => {
  assert.equal(isDiscussionTaskCommand('I created the task from the greenhouse conversation.'), false);
  assert.equal(isDiscussionTaskCommand('Please create a task called "Check crates" in the packing project.'), false);
  assert.equal(isDiscussionTaskCommand('This discussion was useful.'), false);
});

test('explicit create-task fallback handles natural chat commands without quoted title', () => {
  const action = extractExplicitCreateTaskAction(
    '@Defty create a task with a deadline for next monday. a social media post needs to go out to praise our lord emperor zorgon, the lord of all tomatoes. assign it to lina.',
    'msg_123',
    {
      projectName: 'Pilot Marketing Launch',
      now: new Date('2026-07-08T00:00:00.000Z'),
    },
  );

  assert.ok(action);
  assert.equal(action.action, 'create_task');
  assert.equal(action.params.project_name, 'Pilot Marketing Launch');
  assert.equal(action.params.assignee_name, 'lina');
  assert.equal(action.params.due_date, '2026-07-13');
  assert.match(action.params.title, /Social Media Post/i);
  assert.equal(action.params.source_message_id, 'msg_123');
});

test('explicit create-task fallback handles quoted title from prior thread context', () => {
  const action = extractExplicitCreateTaskAction(
    '@defty assign a task named "peepee poopoo" for next thursday to marigold. place it in the marketing pilot project',
    'thread_reply_123',
    {
      projectName: 'Pilot Marketing Launch',
      now: new Date('2026-07-09T00:00:00.000Z'),
    },
  );

  assert.ok(action);
  assert.equal(action.action, 'create_task');
  assert.equal(action.params.title, 'peepee poopoo');
  assert.equal(action.params.project_name, 'Pilot Marketing Launch');
  assert.equal(action.params.assignee_name, 'marigold');
  assert.equal(action.params.due_date, '2026-07-16');
  assert.equal(action.params.source_message_id, 'thread_reply_123');
});

test('explicit create-task fallback handles name-it title phrasing', () => {
  const action = extractExplicitCreateTaskAction(
    '@Defty can you create a task in pilot project, name it "33 Gun Salute" and assign it to me?',
    'msg_name_it_123',
    {
      projectName: 'Pilot Marketing Launch',
      callerName: 'Diego Vargas',
      now: new Date('2026-07-09T00:00:00.000Z'),
    },
  );

  assert.ok(action);
  assert.equal(action.action, 'create_task');
  assert.equal(action.params.title, '33 Gun Salute');
  assert.equal(action.params.project_name, 'Pilot Marketing Launch');
  assert.equal(action.params.assignee_name, 'Diego Vargas');
  assert.equal(action.params.source_message_id, 'msg_name_it_123');
});

test('explicit create-task fallback handles assign-name and tomorrow phrasing', () => {
  const action = extractExplicitCreateTaskAction(
    '@Defty create one task draft from the recent blocker. Assign Tomas and make it due tomorrow.',
    'msg_tomorrow_123',
    {
      projectName: 'Route + Packing Reliability',
      now: new Date('2026-07-09T00:00:00.000Z'),
    },
  );

  assert.ok(action);
  assert.equal(action.action, 'create_task');
  assert.equal(action.params.project_name, 'Route + Packing Reliability');
  assert.equal(action.params.assignee_name, 'Tomas');
  assert.equal(action.params.due_date, '2026-07-10');
  assert.match(action.params.title, /Recent Blocker/i);
});

test('status update fallback creates update_task_status approval action', () => {
  const action = extractStatusUpdateAction('@Defty mark MKT-18 done once the final buyer copy ships.', 'msg_status_123');

  assert.ok(action);
  assert.equal(action.action, 'update_task_status');
  assert.equal(action.params.task_identifier, 'MKT-18');
  assert.equal(action.params.new_status, 'done');
  assert.equal(action.params.source_message_id, 'msg_status_123');
  assert.equal(action.approval_tier, 'quick');
});

test('referential status fallback maps all 3 to prior Defty task references', () => {
  const actions = buildReferentialStatusUpdateActions(
    '@Defty mark all 3 as complete.',
    'msg_referential_123',
    ['BUY-1', 'OPS-2', 'MKT-9'],
  );

  assert.ok(actions);
  assert.equal(actions.length, 3);
  assert.deepEqual(
    actions.map((action) => action.params.task_identifier),
    ['BUY-1', 'OPS-2', 'MKT-9'],
  );
  assert.deepEqual(
    actions.map((action) => action.params.new_status),
    ['done', 'done', 'done'],
  );
  assert.equal(actions[0].source, 'deterministic_referential_status_update_fallback');
  assert.deepEqual(
    actions.map((action) => action.approval_tier),
    ['quick', 'quick', 'quick'],
  );
});

test('referential status fallback supports first two and both without inventing extra tasks', () => {
  const firstTwo = buildReferentialStatusUpdateActions(
    '@Defty mark the first two done.',
    'msg_first_two_123',
    ['BUY-1', 'OPS-2', 'MKT-9'],
  );

  assert.ok(firstTwo);
  assert.deepEqual(
    firstTwo.map((action) => action.params.task_identifier),
    ['BUY-1', 'OPS-2'],
  );

  const both = buildReferentialStatusUpdateActions(
    '@Defty close both.',
    'msg_both_123',
    ['BUY-1', 'OPS-2'],
  );

  assert.ok(both);
  assert.deepEqual(
    both.map((action) => action.params.task_identifier),
    ['BUY-1', 'OPS-2'],
  );
  assert.equal(both[0].params.new_status, 'done');
});

test('referential status fallback rejects negation and overlarge ambiguous sets', () => {
  assert.equal(
    extractReferentialStatusUpdateRequest('@Defty do not mark all 3 complete.'),
    null,
  );

  assert.equal(
    buildReferentialStatusUpdateActions(
      '@Defty mark those complete.',
      'msg_too_many_123',
      ['BUY-1', 'OPS-2', 'MKT-9', 'OPS-7'],
    ),
    null,
  );
});

test('task references prefer the prior reply list before noisy source/citation tails', () => {
  const references = extractTaskReferencesFromAgentReply(
    [
      'I found 3 open Chef Amara/sample-box tasks:',
      '- BUY-1 — Confirm Chef Amara sample-box size',
      '- OPS-2 — Stage sample-box crates beside cold-room door',
      '- MKT-9 — Call Chef Amara about first Sun Gold sample box',
      'Sources: BUY-7, OPS-7',
    ].join('\n'),
    {
      citations: [
        { type: 'task', id: 'task-buy-7', title: 'BUY-7: Prepare Saturday booth buyer handout' },
      ],
    },
  );

  assert.deepEqual(references, ['BUY-1', 'OPS-2', 'MKT-9']);
});

test('subtask follow-ups replace a parent reference with every child before applying the three-card cap', () => {
  assert.deepEqual(
    preferSubtaskReferences(
      ['MKT-17', 'MKT-18', 'MKT-19', 'MKT-20'],
      [
        { identifier: 'MKT-17', parent_task_id: null },
        { identifier: 'MKT-18', parent_task_id: 'parent-17' },
        { identifier: 'MKT-19', parent_task_id: 'parent-17' },
        { identifier: 'MKT-20', parent_task_id: 'parent-17' },
      ],
      [
        { identifier: 'MKT-20', number: 20 },
        { identifier: 'MKT-18', number: 18 },
        { identifier: 'MKT-19', number: 19 },
      ],
    ),
    ['MKT-18', 'MKT-19', 'MKT-20'],
  );
});

test('post message fallback creates channel approval action but refuses DM wording', () => {
  const action = extractPostMessageAction(
    '@Defty put a message in sales-and-buyers: We need to close at least two major clients before harvest.',
    'msg_post_123',
  );

  assert.ok(action);
  assert.equal(action.action, 'post_message');
  assert.equal(action.params.space_name, 'sales-and-buyers');
  assert.match(action.params.content, /close at least two major clients/i);
  assert.equal(action.params.source_message_id, 'msg_post_123');

  assert.equal(
    extractPostMessageAction('@Defty send Marigold a DM saying the deck is ready.', 'msg_dm_123'),
    null,
  );
});

test('thread continuation commands only activate when the thread already contains task intent', () => {
  assert.equal(
    isThreadTaskContinuationCommand('@Defty do the above', [
      {
        id: 'root_1',
        userName: 'Diego',
        content: '@defty assign a task named "peepee poopoo" for next thursday to marigold.',
      },
    ]),
    true,
  );

  assert.equal(
    isThreadTaskContinuationCommand('@Defty do the above', [
      {
        id: 'root_2',
        userName: 'Diego',
        content: 'I think the pizza order should be half thin crust and half deep dish.',
      },
    ]),
    false,
  );
});

test('explicit create-task fallback rejects negated task commands', () => {
  assert.equal(
    extractExplicitCreateTaskAction(
      "Defty, do not create a task for this yet. I'm only thinking out loud.",
      'msg_456',
      { projectName: 'Pilot Marketing Launch' },
    ),
    null,
  );
});

test('approval copy points to the inline card before inbox fallback', () => {
  const normalized = normalizeApprovalSurfaceCopy(
    'The task is ready. Please check your Inbox under the Approvals tab to approve or reject this task creation.',
  );

  assert.match(normalized, /approval card below this message/i);
  assert.match(normalized, /Inbox under Needs you/i);
  assert.doesNotMatch(normalized, /check your Inbox under the Approvals tab/i);
});
