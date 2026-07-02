import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentActions,
  agentEmployees,
  actionReceipts,
  db,
  messages,
  orgMembers,
  orgs,
  projects,
  projectSpaces,
  spaceMembers,
  spaces,
  tasks,
  users,
  wikiOpsLog,
  wikiPages,
  workIntents,
} from '@deft/db';
import {
  queueDeftyCreateTaskCapture,
  queueDeftyKnowledgeCapture,
} from '../src/lib/defty-capture.js';

const RUN_ID = crypto.randomUUID().slice(0, 8);
const ORG_ID = `defty-capture-org-${RUN_ID}`;
const USER_ID = `defty-capture-user-${RUN_ID}`;
const SPACE_ID = `defty-capture-space-${RUN_ID}`;
const PROJECT_ID = `defty-capture-project-${RUN_ID}`;
const PROJECT_PREFIX = `DC${RUN_ID.replace(/-/g, '').slice(0, 5).toUpperCase()}`;

async function seedMessage(content: string): Promise<string> {
  const id = `defty-capture-message-${crypto.randomUUID()}`;
  await db.insert(messages).values({
    id,
    org_id: ORG_ID,
    space_id: SPACE_ID,
    user_id: USER_ID,
    content,
  });
  return id;
}

before(async () => {
  await db.insert(orgs).values({
    id: ORG_ID,
    name: 'Defty Capture Dedupe Test Org',
    slug: ORG_ID,
  });
  await db.insert(users).values({
    id: USER_ID,
    email: `${USER_ID}@test.local`,
    name: 'Defty Capture User',
  });
  await db.insert(orgMembers).values({
    id: crypto.randomUUID(),
    org_id: ORG_ID,
    user_id: USER_ID,
    role: 'admin',
  });
  await db.insert(spaces).values({
    id: SPACE_ID,
    org_id: ORG_ID,
    name: 'defty-capture',
    type: 'public',
    created_by: USER_ID,
  });
  await db.insert(spaceMembers).values({
    id: crypto.randomUUID(),
    space_id: SPACE_ID,
    user_id: USER_ID,
  });
  await db.insert(projects).values({
    id: PROJECT_ID,
    org_id: ORG_ID,
    name: 'Defty Capture Launch',
    prefix: PROJECT_PREFIX,
    lead_id: USER_ID,
    task_counter: 30,
  });
  await db.insert(projectSpaces).values({
    id: crypto.randomUUID(),
    project_id: PROJECT_ID,
    space_id: SPACE_ID,
  });
});

after(async () => {
  await db.delete(actionReceipts).where(eq(actionReceipts.org_id, ORG_ID));
  await db.delete(agentActions).where(eq(agentActions.org_id, ORG_ID));
  await db.delete(workIntents).where(eq(workIntents.org_id, ORG_ID));
  await db.delete(agentEmployees).where(eq(agentEmployees.org_id, ORG_ID));
  await db.delete(wikiOpsLog).where(eq(wikiOpsLog.org_id, ORG_ID));
  await db.delete(wikiPages).where(eq(wikiPages.org_id, ORG_ID));
  await db.delete(tasks).where(eq(tasks.org_id, ORG_ID));
  await db.delete(messages).where(eq(messages.org_id, ORG_ID));
  await db.delete(projectSpaces).where(eq(projectSpaces.project_id, PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, SPACE_ID));
  await db.delete(spaces).where(eq(spaces.id, SPACE_ID));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, ORG_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  await db.delete(orgs).where(eq(orgs.id, ORG_ID));
});

test('explicit task reference plus status language queues task_update, not duplicate task_create', async () => {
  const taskId = `defty-capture-task-${crypto.randomUUID()}`;
  await db.insert(tasks).values({
    id: taskId,
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    number: 17,
    title: 'Finish blue crate label proof',
    description: 'Label proof for Saturday market crates.',
    status: 'in_progress',
    priority: 'p2',
    created_by: USER_ID,
  });
  const content = `${PROJECT_PREFIX}-17 is done now; please close it out.`;
  const messageId = await seedMessage(content);

  const queued = await queueDeftyCreateTaskCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    captureKind: 'task_candidate',
    captureReason: 'Test status update from chat.',
    extraction: 'deterministic',
  });

  assert.equal(queued.queued, true);

  const [intent] = await db
    .select({
      proposed_action: workIntents.proposed_action,
      proposed_params: workIntents.proposed_params,
      metadata: workIntents.metadata,
    })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ))
    .limit(1);

  assert.ok(intent, 'expected a work intent for the status update');
  assert.equal(intent.proposed_action, 'task_update');
  const params = intent.proposed_params as Record<string, any>;
  assert.equal(params.task_id, taskId);
  assert.equal(params.patch.status, 'done');
  assert.equal(params.target_task_ref, `${PROJECT_PREFIX}-17`);
  const metadata = intent.metadata as Record<string, any>;
  assert.equal(metadata.update_kind, 'task_status');
  assert.equal(metadata.target_task_id, taskId);

  const [action] = await db
    .select({ action: agentActions.action, params: agentActions.params })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ORG_ID),
      eq(agentActions.message_id, messageId),
    ))
    .limit(1);

  assert.ok(action, 'expected a pending task_update approval');
  assert.equal(action.action, 'task_update');
  assert.equal((action.params as Record<string, any>).patch.status, 'done');
});

test('explicit task reference queues richer task_update fields', async () => {
  const taskId = `defty-capture-task-${crypto.randomUUID()}`;
  await db.insert(tasks).values({
    id: taskId,
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    number: 19,
    title: 'Confirm chef sample delivery',
    description: 'Initial delivery plan.',
    status: 'todo',
    priority: 'p2',
    created_by: USER_ID,
  });
  const taskRef = `${PROJECT_PREFIX}-19`;
  const content = `${taskRef} priority to p1 and due 2026-08-20. assign ${taskRef} to Defty Capture User. add task comment: Vendor confirmed the delivery window.`;
  const messageId = await seedMessage(content);

  const queued = await queueDeftyCreateTaskCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    captureKind: 'task_candidate',
    captureReason: 'Test richer task update from chat.',
    extraction: 'deterministic',
  });

  assert.equal(queued.queued, true);

  const [intent] = await db
    .select({
      proposed_action: workIntents.proposed_action,
      proposed_params: workIntents.proposed_params,
      metadata: workIntents.metadata,
    })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ))
    .limit(1);

  assert.ok(intent, 'expected a work intent for the richer update');
  assert.equal(intent.proposed_action, 'task_update');
  const params = intent.proposed_params as Record<string, any>;
  assert.equal(params.task_id, taskId);
  assert.equal(params.patch.priority, 'p1');
  assert.equal(params.patch.due_date, '2026-08-20');
  assert.equal(params.patch.assignee_id, USER_ID);
  assert.equal(params.patch.comment, 'Vendor confirmed the delivery window.');
  const metadata = intent.metadata as Record<string, any>;
  assert.deepEqual(metadata.update_fields, ['assignee_id', 'comment', 'due_date', 'priority']);
  assert.equal(metadata.proposed_due_date, '2026-08-20');
  assert.equal(metadata.proposed_assignee_id, USER_ID);

  const [action] = await db
    .select({ action: agentActions.action, params: agentActions.params })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ORG_ID),
      eq(agentActions.message_id, messageId),
    ))
    .limit(1);

  assert.ok(action, 'expected a pending task_update approval');
  assert.equal(action.action, 'task_update');
  assert.equal((action.params as Record<string, any>).patch.comment, 'Vendor confirmed the delivery window.');
});

test('repeated status capture for the same message reuses the existing task_update approval', async () => {
  const taskId = `defty-capture-task-${crypto.randomUUID()}`;
  await db.insert(tasks).values({
    id: taskId,
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    number: 21,
    title: 'Pack the wholesale rescue crate',
    description: 'Rescue crate for the Saturday wholesale buyer.',
    status: 'todo',
    priority: 'p2',
    created_by: USER_ID,
  });
  const content = `${PROJECT_PREFIX}-21 is in progress now.`;
  const messageId = await seedMessage(content);

  const first = await queueDeftyCreateTaskCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    captureKind: 'task_candidate',
    extraction: 'deterministic',
  });
  const second = await queueDeftyCreateTaskCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    captureKind: 'task_candidate',
    extraction: 'deterministic',
  });

  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(second.skippedReason, 'duplicate');
  assert.equal(second.actionId, first.actionId);

  const intentCount = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM work_intents
    WHERE org_id = ${ORG_ID}
      AND source_message_id = ${messageId}
      AND proposed_action = 'task_update'
  `);
  assert.equal(Number(intentCount.rows[0]?.count ?? 0), 1);

  const actionCount = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM agent_actions
    WHERE org_id = ${ORG_ID}
      AND message_id = ${messageId}
      AND action = 'task_update'
  `);
  assert.equal(Number(actionCount.rows[0]?.count ?? 0), 1);
});

test('status chatter for a task already in that status is ignored as noise', async () => {
  const taskId = `defty-capture-task-${crypto.randomUUID()}`;
  await db.insert(tasks).values({
    id: taskId,
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    number: 20,
    title: 'Close the sample invoice loop',
    description: 'Invoice loop is already closed out.',
    status: 'done',
    priority: 'p2',
    created_by: USER_ID,
  });
  const content = `${PROJECT_PREFIX}-20 is done; closing the loop here.`;
  const messageId = await seedMessage(content);

  const queued = await queueDeftyCreateTaskCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    captureKind: 'task_candidate',
    extraction: 'deterministic',
  });

  assert.equal(queued.queued, false);
  assert.equal(queued.skippedReason, 'task_status_already_current');

  const rows = await db
    .select({ id: workIntents.id })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ));
  assert.equal(rows.length, 0, 'same-status chatter should not become a create/update proposal');
});

test('fresh task capture skips when the same active task already exists', async () => {
  await db.insert(tasks).values({
    id: `defty-capture-task-${crypto.randomUUID()}`,
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    number: 18,
    title: 'Print blue crate labels',
    description: 'Print the blue crate labels before Saturday market prep.',
    status: 'todo',
    priority: 'p2',
    created_by: USER_ID,
  });
  const content = 'Please create task: Print blue crate labels';
  const messageId = await seedMessage(content);

  const queued = await queueDeftyCreateTaskCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    title: 'Print blue crate labels',
    captureKind: 'task_candidate',
    extraction: 'deterministic',
  });

  assert.equal(queued.queued, false);
  assert.equal(queued.skippedReason, 'task_already_captured');

  const rows = await db
    .select({ id: workIntents.id })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ));
  assert.equal(rows.length, 0, 'duplicate task chatter should not create a work intent');
});

test('similar task capture with a different reference code still queues a fresh proposal', async () => {
  await db.insert(tasks).values({
    id: `defty-capture-task-${crypto.randomUUID()}`,
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    number: 22,
    title: 'Print blue crate labels for TT-4101',
    description: 'Print blue crate labels for wholesale batch TT-4101 before Saturday prep.',
    status: 'todo',
    priority: 'p2',
    created_by: USER_ID,
  });
  const content = 'Please create task: Print blue crate labels for wholesale batch TT-4102';
  const messageId = await seedMessage(content);

  const queued = await queueDeftyCreateTaskCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    title: 'Print blue crate labels for TT-4102',
    description: 'Print blue crate labels for wholesale batch TT-4102 before Saturday prep.',
    captureKind: 'task_candidate',
    extraction: 'deterministic',
  });

  assert.equal(queued.queued, true);
  assert.ok(queued.actionId);

  const [intent] = await db
    .select({
      proposed_action: workIntents.proposed_action,
      proposed_params: workIntents.proposed_params,
    })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ))
    .limit(1);

  assert.ok(intent, 'expected a fresh work intent for the second reference code');
  assert.equal(intent.proposed_action, 'task_create');
  assert.equal((intent.proposed_params as Record<string, any>).title, 'Print blue crate labels for TT-4102');
});

test('blocker capture still queues even when a similar active task exists', async () => {
  await db.insert(tasks).values({
    id: `defty-capture-task-${crypto.randomUUID()}`,
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    number: 23,
    title: 'Resolve cooler label printer issue',
    description: 'Printer issue for cooler labels.',
    status: 'in_progress',
    priority: 'p1',
    created_by: USER_ID,
  });
  const content = 'I am blocked: cooler label printer issue is stopping the Saturday packing run.';
  const messageId = await seedMessage(content);

  const queued = await queueDeftyCreateTaskCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    title: 'Resolve cooler label printer issue',
    description: 'Cooler label printer issue is stopping the Saturday packing run.',
    captureKind: 'blocker_candidate',
    captureReason: 'Test blocker should surface even if related work already exists.',
    extraction: 'deterministic',
  });

  assert.equal(queued.queued, true);
  assert.ok(queued.actionId);

  const [intent] = await db
    .select({
      kind: workIntents.kind,
      proposed_action: workIntents.proposed_action,
    })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ))
    .limit(1);

  assert.ok(intent, 'expected a blocker work intent');
  assert.equal(intent.kind, 'blocker_candidate');
  assert.equal(intent.proposed_action, 'task_create');
});

test('fresh knowledge capture skips when equivalent wiki knowledge already exists', async () => {
  await db.insert(wikiPages).values({
    id: `defty-capture-wiki-${crypto.randomUUID()}`,
    org_id: ORG_ID,
    scope: 'org',
    type: 'decision',
    title: 'Keep chef sample boxes as launch priority',
    slug: `chef-sample-boxes-${RUN_ID}`,
    summary: 'Chef sample boxes are the launch priority.',
    content: 'Decision: keep chef sample boxes as the launch priority.',
    confidence: 0.9,
  });
  const content = 'Decision: keep chef sample boxes as the launch priority.';
  const messageId = await seedMessage(content);

  const queued = await queueDeftyKnowledgeCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    title: 'Keep chef sample boxes as launch priority',
    wikiType: 'decision',
    captureKind: 'decision_candidate',
    captureReason: 'Test duplicate decision.',
    extraction: 'classifier',
    tags: ['decision', 'defty-capture'],
  });

  assert.equal(queued.queued, false);
  assert.equal(queued.skippedReason, 'knowledge_already_captured');

  const actionCount = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM agent_actions
    WHERE org_id = ${ORG_ID}
      AND message_id = ${messageId}
  `);
  assert.equal(Number(actionCount.rows[0]?.count ?? 0), 0);
});

test('similar knowledge with a different reference code still queues a fresh proposal', async () => {
  await db.insert(wikiPages).values({
    id: `defty-capture-wiki-${crypto.randomUUID()}`,
    org_id: ORG_ID,
    scope: 'org',
    type: 'decision',
    title: 'Use TT-4101 for chef sample boxes',
    slug: `chef-sample-tt-4101-${RUN_ID}`,
    summary: 'Use batch TT-4101 for chef sample boxes.',
    content: 'Decision: use batch TT-4101 for chef sample boxes.',
    confidence: 0.9,
  });
  const content = 'Decision: use batch TT-4102 for chef sample boxes.';
  const messageId = await seedMessage(content);

  const queued = await queueDeftyKnowledgeCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    title: 'Use TT-4102 for chef sample boxes',
    wikiType: 'decision',
    captureKind: 'decision_candidate',
    captureReason: 'Test similar decision with a different reference code.',
    extraction: 'classifier',
    tags: ['decision', 'defty-capture'],
  });

  assert.equal(queued.queued, true);
  assert.ok(queued.actionId);

  const [action] = await db
    .select({ action: agentActions.action, params: agentActions.params })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ORG_ID),
      eq(agentActions.message_id, messageId),
    ))
    .limit(1);

  assert.ok(action, 'expected a fresh pending approval for TT-4102');
  assert.equal(action.action, 'wiki_create');
  assert.equal((action.params as Record<string, any>).title, 'Use TT-4102 for chef sample boxes');
});

test('preferUpdate queues wiki_update for related existing knowledge instead of duplicate create', async () => {
  const slug = `brightmart-delivery-window-${RUN_ID}`;
  await db.insert(wikiPages).values({
    id: `defty-capture-wiki-${crypto.randomUUID()}`,
    org_id: ORG_ID,
    scope: 'org',
    type: 'decision',
    title: 'BrightMart delivery window stays Friday',
    slug,
    summary: 'BrightMart delivery window stays Friday.',
    content: 'Decision: BrightMart delivery window stays Friday.',
    confidence: 0.9,
  });
  const content = 'Decision: BrightMart delivery window stays Friday, and Maya owns buyer confirmation before the route sheet is sent.';
  const messageId = await seedMessage(content);

  const queued = await queueDeftyKnowledgeCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    title: 'BrightMart delivery window stays Friday',
    wikiType: 'decision',
    captureKind: 'decision_candidate',
    captureReason: 'Test related decision update.',
    extraction: 'classifier',
    tags: ['decision', 'defty-capture'],
    preferUpdate: true,
  });

  assert.equal(queued.queued, true);

  const [intent] = await db
    .select({
      proposed_action: workIntents.proposed_action,
      proposed_params: workIntents.proposed_params,
      metadata: workIntents.metadata,
    })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ))
    .limit(1);

  assert.ok(intent, 'expected a related knowledge update intent');
  assert.equal(intent.proposed_action, 'wiki_update');
  assert.equal((intent.proposed_params as Record<string, any>).slug, slug);
  assert.equal((intent.metadata as Record<string, any>).related_wiki_update, true);

  const [action] = await db
    .select({ action: agentActions.action, params: agentActions.params })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ORG_ID),
      eq(agentActions.message_id, messageId),
    ))
    .limit(1);

  assert.ok(action, 'expected a pending wiki_update approval');
  assert.equal(action.action, 'wiki_update');
  assert.equal((action.params as Record<string, any>).slug, slug);
});

test('explicit correction to existing knowledge queues wiki_update instead of duplicate wiki_create', async () => {
  const slug = `chef-sample-correction-${RUN_ID}`;
  const title = `Correct chef sample boxes ${RUN_ID}`;
  await db.insert(wikiPages).values({
    id: `defty-capture-wiki-${crypto.randomUUID()}`,
    org_id: ORG_ID,
    scope: 'org',
    type: 'decision',
    title,
    slug,
    summary: `${title} is the launch priority.`,
    content: `Decision: ${title} is the launch priority.`,
    confidence: 0.9,
  });
  const content = `Update decision: ${title} with the red lid insert.`;
  const messageId = await seedMessage(content);

  const queued = await queueDeftyKnowledgeCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    title,
    wikiType: 'decision',
    captureKind: 'decision_candidate',
    captureReason: 'Test correction to existing decision.',
    extraction: 'classifier',
    tags: ['decision', 'defty-capture'],
  });

  assert.equal(queued.queued, true);

  const [intent] = await db
    .select({
      proposed_action: workIntents.proposed_action,
      proposed_params: workIntents.proposed_params,
      metadata: workIntents.metadata,
    })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ))
    .limit(1);

  assert.ok(intent, 'expected a work intent for the knowledge update');
  assert.equal(intent.proposed_action, 'wiki_update');
  const params = intent.proposed_params as Record<string, any>;
  assert.ok(params.page_id);
  assert.equal(params.slug, slug);
  assert.equal(params.patch.content, `${title} with the red lid insert.`);
  assert.equal(params.patch.summary, `${title} with the red lid insert.`);
  assert.equal(params.target_wiki_slug, slug);
  const metadata = intent.metadata as Record<string, any>;
  assert.equal(metadata.update_kind, 'wiki_content');

  const [action] = await db
    .select({ action: agentActions.action, params: agentActions.params })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ORG_ID),
      eq(agentActions.message_id, messageId),
    ))
    .limit(1);

  assert.ok(action, 'expected a pending wiki_update approval');
  assert.equal(action.action, 'wiki_update');
  assert.equal((action.params as Record<string, any>).slug, slug);
});

test('similar but materially different knowledge still queues a fresh proposal', async () => {
  await db.insert(wikiPages).values({
    id: `defty-capture-wiki-${crypto.randomUUID()}`,
    org_id: ORG_ID,
    scope: 'org',
    type: 'decision',
    title: 'Use blue crate checklist codeword alpha',
    slug: `blue-crate-alpha-${RUN_ID}`,
    summary: 'Use blue crate checklist codeword alpha.',
    content: 'Decision: use blue crate checklist codeword alpha.',
    confidence: 0.9,
  });
  const content = 'Decision: use blue crate checklist codeword beta.';
  const messageId = await seedMessage(content);

  const queued = await queueDeftyKnowledgeCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    title: 'Use blue crate checklist codeword beta',
    wikiType: 'decision',
    captureKind: 'decision_candidate',
    captureReason: 'Test materially different decision.',
    extraction: 'classifier',
    tags: ['decision', 'defty-capture'],
  });

  assert.equal(queued.queued, true);
  assert.ok(queued.actionId);

  const [action] = await db
    .select({ action: agentActions.action, params: agentActions.params })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ORG_ID),
      eq(agentActions.message_id, messageId),
    ))
    .limit(1);

  assert.ok(action, 'expected a fresh pending approval for the beta decision');
  assert.equal(action.action, 'wiki_create');
  assert.equal((action.params as Record<string, any>).title, 'Use blue crate checklist codeword beta');
});
