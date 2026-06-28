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
import { handleMemoryCapture } from '../src/workers/handlers/memory-capture.js';

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

test('memory-capture routes explicit facts through a Defty wiki_create approval', async () => {
  const content = 'Preference: use concise buyer updates. Policy: never promise same-day delivery after 2pm.';
  const messageId = await seedMessage(content);

  await runMemoryCapture(messageId, content, [
    'use concise buyer updates',
    'never promise same-day delivery after 2pm',
    'never promise same-day delivery after 2pm',
    'Never promise same day delivery after 2 pm',
  ]);

  const [intent] = await db
    .select({
      id: workIntents.id,
      kind: workIntents.kind,
      status: workIntents.status,
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

  assert.ok(intent, 'expected a proposed work intent');
  assert.equal(intent.kind, 'note_candidate');
  assert.equal(intent.status, 'proposed');
  assert.equal(intent.proposed_action, 'wiki_create');

  const params = intent.proposed_params as Record<string, any>;
  assert.equal(params.source_message_id, messageId);
  assert.equal(params.capture_kind, 'note_candidate');
  assert.equal(params.type, 'fact');

  const metadata = intent.metadata as Record<string, any>;
  assert.deepEqual(metadata.classifier_facts, [
    'use concise buyer updates',
    'never promise same-day delivery after 2pm',
  ]);

  const [action] = await db
    .select({
      id: agentActions.id,
      action: agentActions.action,
      approval_status: agentActions.approval_status,
    })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ORG_ID),
      eq(agentActions.source, 'defty_capture'),
      sql`${agentActions.params}->>'work_intent_id' = ${intent.id}`,
    ))
    .limit(1);

  assert.ok(action, 'expected a pending approval action');
  assert.equal(action.action, 'wiki_create');
  assert.equal(action.approval_status, 'pending');
});

test('memory-capture routes explicit decisions through a Defty wiki_create approval', async () => {
  const content = 'Decision: ship the chef-sample bundles in blue crates on Friday.';
  const messageId = await seedMessage(content);

  await runMemoryCapture(messageId, content, [], SPACE_ID, 'ship the chef-sample bundles in blue crates on Friday');

  const [intent] = await db
    .select({
      kind: workIntents.kind,
      title: workIntents.title,
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

  assert.ok(intent, 'expected a decision work intent');
  assert.equal(intent.kind, 'decision_candidate');
  assert.equal(intent.proposed_action, 'wiki_create');
  assert.match(intent.title, /chef-sample bundles/i);
  const params = intent.proposed_params as Record<string, any>;
  assert.equal(params.type, 'decision');
  assert.equal(params.scope, 'org');
  assert.equal(params.capture_kind, 'decision_candidate');
  const metadata = intent.metadata as Record<string, any>;
  assert.equal(metadata.classifier_decision, 'ship the chef-sample bundles in blue crates on Friday');
});

test('memory-capture routes explicit resources but ignores bare links', async () => {
  const resourceContent =
    'Resource: buyer launch checklist https://example.com/testers-tomatoes/buyer-launch';
  const resourceMessageId = await seedMessage(resourceContent);

  await runMemoryCapture(resourceMessageId, resourceContent);

  const [resourceIntent] = await db
    .select({
      kind: workIntents.kind,
      title: workIntents.title,
      proposed_action: workIntents.proposed_action,
      proposed_params: workIntents.proposed_params,
    })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, resourceMessageId),
    ))
    .limit(1);

  assert.ok(resourceIntent, 'expected an explicit resource work intent');
  assert.equal(resourceIntent.kind, 'resource_candidate');
  assert.equal(resourceIntent.proposed_action, 'wiki_create');
  const params = resourceIntent.proposed_params as Record<string, any>;
  assert.equal(params.type, 'resource');
  assert.equal(params.capture_kind, 'resource_candidate');
  assert.equal(params.metadata?.url, 'https://example.com/testers-tomatoes/buyer-launch');

  const bareLinkContent = 'Saw this pricing deck: https://example.com/random-thread';
  const bareLinkMessageId = await seedMessage(bareLinkContent);

  await runMemoryCapture(bareLinkMessageId, bareLinkContent);

  const bareLinkRows = await db
    .select({ id: workIntents.id })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, bareLinkMessageId),
    ));

  assert.equal(bareLinkRows.length, 0, 'bare links should not become durable resources');
});

test('memory-capture keeps private-space knowledge proposals space-scoped', async () => {
  const content = 'Decision: keep the wholesale pricing rescue plan inside this private launch channel.';
  const messageId = await seedMessage(content, PRIVATE_SPACE_ID);

  await runMemoryCapture(messageId, content, [], PRIVATE_SPACE_ID, content);

  const [intent] = await db
    .select({
      id: workIntents.id,
      proposed_params: workIntents.proposed_params,
    })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ))
    .limit(1);

  assert.ok(intent, 'expected a proposed private-space work intent');
  const params = intent.proposed_params as Record<string, any>;
  assert.equal(params.scope, 'space');
  assert.equal(params.space_id, PRIVATE_SPACE_ID);
  assert.equal(params.source_space_id, PRIVATE_SPACE_ID);
});

test('memory-capture does not create approvals for ordinary chatter', async () => {
  const content = 'I think the tomatoes look nice today.';
  const messageId = await seedMessage(content);

  await runMemoryCapture(messageId, content);

  const rows = await db
    .select({ id: workIntents.id })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, messageId),
    ));

  assert.equal(rows.length, 0);
});

test('memory-capture ignores ambiguous planning chatter unless classifier data is explicit', async () => {
  const ambiguousContent =
    'Maybe we should discuss whether the chef sample crates need new labels next week.';
  const ambiguousMessageId = await seedMessage(ambiguousContent);

  await runMemoryCapture(ambiguousMessageId, ambiguousContent);

  const ambiguousRows = await db
    .select({ id: workIntents.id })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, ambiguousMessageId),
    ));
  assert.equal(ambiguousRows.length, 0);

  const explicitClassifierMessageId = await seedMessage(ambiguousContent);
  await runMemoryCapture(
    explicitClassifierMessageId,
    ambiguousContent,
    ['Chef sample crates need new labels next week'],
  );

  const [explicitIntent] = await db
    .select({ kind: workIntents.kind })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      eq(workIntents.source_message_id, explicitClassifierMessageId),
    ))
    .limit(1);
  assert.ok(explicitIntent, 'explicit classifier facts should still create a reviewable proposal');
  assert.equal(explicitIntent.kind, 'note_candidate');
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
