import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentActions,
  agentEmployees,
  db,
  messages,
  orgMembers,
  orgs,
  projects,
  projectSpaces,
  spaceMembers,
  spaces,
  users,
  workIntents,
} from '@deft/db';
import { queueDeftyCreateTaskCapture } from '../src/lib/defty-capture.js';
import {
  extractResourceCandidate,
  handleMemoryCapture,
} from '../src/workers/handlers/memory-capture.js';

const ORG_ID = `memory-capture-org-${crypto.randomUUID()}`;
const USER_ID = `memory-capture-user-${crypto.randomUUID()}`;
const SPACE_ID = `memory-capture-space-${crypto.randomUUID()}`;
const PRIVATE_SPACE_ID = `memory-capture-private-space-${crypto.randomUUID()}`;
const PROJECT_ID = `memory-capture-project-${crypto.randomUUID()}`;

async function seedMessage(content: string, spaceId = SPACE_ID): Promise<string> {
  const id = `memory-capture-msg-${crypto.randomUUID()}`;
  await db.insert(messages).values({
    id,
    org_id: ORG_ID,
    space_id: spaceId,
    user_id: USER_ID,
    content,
  });
  return id;
}

async function runMemoryCapture(
  messageId: string,
  content: string,
  facts: string[] = [],
  spaceId = SPACE_ID,
  decision: string | null = null,
) {
  await handleMemoryCapture({
    name: 'memory-capture',
    data: {
      messageId,
      spaceId,
      content,
      orgId: ORG_ID,
      userId: USER_ID,
      facts,
      decision,
    },
  } as any);
}

async function intentsForMessage(messageId: string) {
  return db
    .select()
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ));
}

async function actionsForMessage(messageId: string) {
  return db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ORG_ID),
      eq(agentActions.message_id, messageId),
      eq(agentActions.source, 'defty_capture'),
    ));
}

async function assertNoMemoryWork(messageId: string) {
  const intents = await intentsForMessage(messageId);
  assert.equal(intents.length, 0, 'immediate memory capture should be quiet by default');
  const actions = await actionsForMessage(messageId);
  assert.equal(actions.length, 0, 'immediate memory capture should not queue approvals by default');
}

before(async () => {
  await db.insert(orgs).values({
    id: ORG_ID,
    name: 'Memory Capture Test Org',
    slug: ORG_ID,
  });
  await db.insert(users).values({
    id: USER_ID,
    email: `${USER_ID}@test.local`,
    name: 'Memory Capture User',
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
    name: 'memory-capture',
    type: 'public',
    created_by: USER_ID,
  });
  await db.insert(spaces).values({
    id: PRIVATE_SPACE_ID,
    org_id: ORG_ID,
    name: 'memory-capture-private',
    type: 'private',
    created_by: USER_ID,
  });
  await db.insert(spaceMembers).values({
    id: crypto.randomUUID(),
    space_id: SPACE_ID,
    user_id: USER_ID,
  });
  await db.insert(spaceMembers).values({
    id: crypto.randomUUID(),
    space_id: PRIVATE_SPACE_ID,
    user_id: USER_ID,
  });
  await db.insert(projects).values({
    id: PROJECT_ID,
    org_id: ORG_ID,
    name: 'Memory Capture Launch',
    prefix: `MC${Math.floor(Math.random() * 100000)}`,
    lead_id: USER_ID,
  });
  await db.insert(projectSpaces).values({
    id: crypto.randomUUID(),
    project_id: PROJECT_ID,
    space_id: SPACE_ID,
  });
});

after(async () => {
  await db.delete(agentActions).where(eq(agentActions.org_id, ORG_ID));
  await db.delete(workIntents).where(eq(workIntents.org_id, ORG_ID));
  await db.delete(agentEmployees).where(eq(agentEmployees.org_id, ORG_ID));
  await db.delete(messages).where(eq(messages.org_id, ORG_ID));
  await db.delete(projectSpaces).where(eq(projectSpaces.project_id, PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, SPACE_ID));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, PRIVATE_SPACE_ID));
  await db.delete(spaces).where(eq(spaces.id, SPACE_ID));
  await db.delete(spaces).where(eq(spaces.id, PRIVATE_SPACE_ID));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, ORG_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  await db.delete(orgs).where(eq(orgs.id, ORG_ID));
});

test('memory-capture skips explicit facts by default', async () => {
  const content = 'Preference: use concise buyer updates. Policy: never promise same-day delivery after 2pm.';
  const messageId = await seedMessage(content);

  await runMemoryCapture(messageId, content, [
    'use concise buyer updates',
    'never promise same-day delivery after 2pm',
  ]);

  await assertNoMemoryWork(messageId);
});

test('memory-capture skips explicit decisions by default', async () => {
  const content = 'Decision: ship the chef-sample bundles in blue crates on Friday.';
  const messageId = await seedMessage(content);

  await runMemoryCapture(messageId, content, [], SPACE_ID, 'ship the chef-sample bundles in blue crates on Friday');

  await assertNoMemoryWork(messageId);
});

test('memory-capture resource extraction is strict, but immediate resource writes stay off by default', async () => {
  const resourceContent =
    'Resource: buyer launch checklist https://example.com/testers-tomatoes/buyer-launch';
  const resource = extractResourceCandidate(resourceContent);
  assert.ok(resource, 'explicit resource language should still parse as a resource candidate');
  assert.equal(resource.url, 'https://example.com/testers-tomatoes/buyer-launch');

  const bareLinkContent = 'Saw this pricing deck: https://example.com/random-thread';
  assert.equal(extractResourceCandidate(bareLinkContent), null, 'bare links should not parse as durable resources');

  const resourceMessageId = await seedMessage(resourceContent);
  await runMemoryCapture(resourceMessageId, resourceContent);

  await assertNoMemoryWork(resourceMessageId);
});

test('memory-capture keeps private-space immediate writes off by default', async () => {
  const content = 'Decision: keep the wholesale pricing rescue plan inside this private launch channel.';
  const messageId = await seedMessage(content, PRIVATE_SPACE_ID);

  await runMemoryCapture(messageId, content, [], PRIVATE_SPACE_ID, content);

  await assertNoMemoryWork(messageId);
});

test('memory-capture does not create approvals for ordinary chatter', async () => {
  const content = 'I think the tomatoes look nice today.';
  const messageId = await seedMessage(content);

  await runMemoryCapture(messageId, content);

  await assertNoMemoryWork(messageId);
});

test('memory-capture ignores ambiguous planning chatter and classifier facts by default', async () => {
  const ambiguousContent =
    'Maybe we should discuss whether the chef sample crates need new labels next week.';
  const ambiguousMessageId = await seedMessage(ambiguousContent);

  await runMemoryCapture(ambiguousMessageId, ambiguousContent);
  await assertNoMemoryWork(ambiguousMessageId);

  const explicitClassifierMessageId = await seedMessage(ambiguousContent);
  await runMemoryCapture(
    explicitClassifierMessageId,
    ambiguousContent,
    ['Chef sample crates need new labels next week'],
  );

  await assertNoMemoryWork(explicitClassifierMessageId);
});

test('defty task capture turns explicit action requests into task_create work intents', async () => {
  const content = 'Please create a task: print 40 blue crate labels before Friday pickup.';
  const messageId = await seedMessage(content);

  const queued = await queueDeftyCreateTaskCapture({
    orgId: ORG_ID,
    sourceUserId: USER_ID,
    spaceId: SPACE_ID,
    messageId,
    content,
    title: 'Print 40 blue crate labels',
    description: content,
    projectName: 'Memory Capture Launch',
    captureKind: 'task_candidate',
    captureReason: 'Test action request',
    extraction: 'deterministic',
  });

  assert.equal(queued.queued, true);

  const [intent] = await db
    .select({
      id: workIntents.id,
      kind: workIntents.kind,
      status: workIntents.status,
      proposed_action: workIntents.proposed_action,
      proposed_params: workIntents.proposed_params,
    })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ))
    .limit(1);

  assert.ok(intent, 'expected a task work intent');
  assert.equal(intent.kind, 'task_candidate');
  assert.equal(intent.status, 'proposed');
  assert.equal(intent.proposed_action, 'task_create');
  const params = intent.proposed_params as Record<string, any>;
  assert.equal(params.project_id, PROJECT_ID);
  assert.equal(params.space_id, SPACE_ID);
  assert.equal(params.source_message_id, messageId);
  assert.equal(params.capture_kind, 'task_candidate');

  const [action] = await db
    .select({ action: agentActions.action, approval_status: agentActions.approval_status })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ORG_ID),
      eq(agentActions.source, 'defty_capture'),
      sql`${agentActions.params}->>'work_intent_id' = ${intent.id}`,
    ))
    .limit(1);

  assert.ok(action, 'expected a pending approval action');
  assert.equal(action.action, 'task_create');
  assert.equal(action.approval_status, 'pending');
});
