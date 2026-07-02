import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import {
  agentActions,
  agentEmployees,
  actionReceipts,
  db,
  messageClassifications,
  messages,
  orgMembers,
  orgs,
  projects,
  projectSpaces,
  spaceMembers,
  spaces,
  users,
  wikiOpsLog,
  wikiPages,
  workIntents,
} from '@deft/db';

const RUN_ID = crypto.randomUUID().slice(0, 8);
const ORG_ID = `chat-batch-org-${RUN_ID}`;
const USER_ID = `chat-batch-user-${RUN_ID}`;
const USER_TWO_ID = `chat-batch-user-two-${RUN_ID}`;
const PROJECT_ID = `chat-batch-project-${RUN_ID}`;
const BASE_TIME = Date.now() - 12 * 60 * 1000;
let handleChatKnowledgeBatch: (job: any) => Promise<void>;

async function createSpace(name: string): Promise<string> {
  const id = `chat-batch-space-${name}-${crypto.randomUUID()}`;
  await db.insert(spaces).values({
    id,
    org_id: ORG_ID,
    name,
    type: 'public',
    created_by: USER_ID,
  });
  await db.insert(spaceMembers).values([
    {
      id: crypto.randomUUID(),
      space_id: id,
      user_id: USER_ID,
    },
    {
      id: crypto.randomUUID(),
      space_id: id,
      user_id: USER_TWO_ID,
    },
  ]);
  await db.insert(projectSpaces).values({
    id: crypto.randomUUID(),
    project_id: PROJECT_ID,
    space_id: id,
  });
  return id;
}

async function seedMessage(
  spaceId: string,
  content: string,
  offsetSeconds: number,
  userId = USER_ID,
  classification?: {
    intent?: string;
    confidence?: number;
    agentMentioned?: boolean;
    facts?: string[];
    decision?: string | null;
  },
): Promise<string> {
  const id = `chat-batch-msg-${crypto.randomUUID()}`;
  const createdAt = new Date(BASE_TIME + offsetSeconds * 1000);
  await db.insert(messages).values({
    id,
    org_id: ORG_ID,
    space_id: spaceId,
    user_id: userId,
    content,
    created_at: createdAt,
    updated_at: createdAt,
  });
  if (classification) {
    await db.insert(messageClassifications).values({
      org_id: ORG_ID,
      message_id: id,
      intent: classification.intent ?? 'discussion',
      confidence: classification.confidence ?? 0.8,
      agent_mentioned: classification.agentMentioned ?? false,
      blocked: false,
      task_references: [],
      entities: {},
      memorable_facts: classification.facts ?? [],
      decision: classification.decision ?? null,
      created_at: createdAt,
    });
  }
  return id;
}

async function runBatch(spaceId: string) {
  await handleChatKnowledgeBatch({
    name: 'chat-knowledge-batch',
    data: {
      orgId: ORG_ID,
      spaceId,
      lookbackMs: 60 * 60 * 1000,
      quietMs: 0,
    },
  } as any);
}

async function intentsForMessages(messageIds: string[]) {
  if (messageIds.length === 0) return [];
  return db
    .select({
      id: workIntents.id,
      kind: workIntents.kind,
      proposed_action: workIntents.proposed_action,
      proposed_params: workIntents.proposed_params,
      metadata: workIntents.metadata,
    })
    .from(workIntents)
    .where(and(
      eq(workIntents.org_id, ORG_ID),
      inArray(workIntents.source_message_id, messageIds),
    ));
}

before(async () => {
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.OLLAMA_URL = '';
  ({ handleChatKnowledgeBatch } = await import('../src/workers/handlers/chat-knowledge-batch.js'));

  await db.insert(orgs).values({
    id: ORG_ID,
    name: 'Chat Knowledge Batch Test Org',
    slug: ORG_ID,
  });
  await db.insert(users).values([
    {
      id: USER_ID,
      email: `${USER_ID}@test.local`,
      name: 'Diego Batch',
    },
    {
      id: USER_TWO_ID,
      email: `${USER_TWO_ID}@test.local`,
      name: 'Maya Batch',
    },
  ]);
  await db.insert(orgMembers).values([
    {
      id: crypto.randomUUID(),
      org_id: ORG_ID,
      user_id: USER_ID,
      role: 'admin',
    },
    {
      id: crypto.randomUUID(),
      org_id: ORG_ID,
      user_id: USER_TWO_ID,
      role: 'member',
    },
  ]);
  await db.insert(projects).values({
    id: PROJECT_ID,
    org_id: ORG_ID,
    name: 'Chat Batch Launch',
    prefix: `CB${RUN_ID.toUpperCase().slice(0, 5)}`,
    lead_id: USER_ID,
  });
});

after(async () => {
  await db.delete(actionReceipts).where(eq(actionReceipts.org_id, ORG_ID));
  await db.delete(agentActions).where(eq(agentActions.org_id, ORG_ID));
  await db.delete(workIntents).where(eq(workIntents.org_id, ORG_ID));
  await db.delete(agentEmployees).where(eq(agentEmployees.org_id, ORG_ID));
  await db.delete(wikiOpsLog).where(eq(wikiOpsLog.org_id, ORG_ID));
  await db.delete(wikiPages).where(eq(wikiPages.org_id, ORG_ID));
  await db.delete(messageClassifications).where(eq(messageClassifications.org_id, ORG_ID));
  await db.delete(messages).where(eq(messages.org_id, ORG_ID));
  await db.delete(projectSpaces).where(eq(projectSpaces.project_id, PROJECT_ID));
  const testSpaces = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.org_id, ORG_ID));
  for (const space of testSpaces) {
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, space.id));
  }
  await db.delete(spaces).where(eq(spaces.org_id, ORG_ID));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, ORG_ID));
  await db.delete(users).where(inArray(users.id, [USER_ID, USER_TWO_ID]));
  await db.delete(orgs).where(eq(orgs.id, ORG_ID));
});

test('chat-knowledge-batch ignores social lunch debate even with fake policy language', async () => {
  const spaceId = await createSpace('batch-pizza-social');
  const messageIds = [
    await seedMessage(spaceId, 'I am opening the floor: thin crust or deep dish for lunch?', 0),
    await seedMessage(spaceId, 'Decision: pineapple is banned from the pizza policy forever.', 35, USER_TWO_ID, {
      confidence: 0.95,
      decision: 'pineapple is banned from the pizza policy forever',
      facts: ['Pineapple is banned from the pizza policy forever'],
    }),
    await seedMessage(spaceId, 'Counterpoint, mushroom people have been silenced for too long.', 70),
    await seedMessage(spaceId, 'Fine, two pies. One spicy, one boring. This is not company memory.', 105, USER_TWO_ID),
  ];

  await runBatch(spaceId);

  const intents = await intentsForMessages(messageIds);
  assert.equal(intents.length, 0, 'social lunch debate must not create wiki work intents');
  const actions = await db
    .select({ id: agentActions.id })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ORG_ID),
      inArray(agentActions.message_id, messageIds),
    ));
  assert.equal(actions.length, 0, 'social lunch debate must not queue actions');
});

test('chat-knowledge-batch captures a settled durable launch decision', async () => {
  const spaceId = await createSpace('batch-launch-decision');
  const messageIds = [
    await seedMessage(spaceId, 'For the Sun Gold launch, the buyer copy is ready but QA still needs label signoff.', 0),
    await seedMessage(spaceId, 'Maya can own the label signoff before the cold-chain review.', 45, USER_TWO_ID),
    await seedMessage(spaceId, 'Decision: Sun Gold trial shipments only go out after cold-chain QA confirms labels, and Maya owns buyer confirmation.', 90, USER_ID, {
      confidence: 0.96,
      decision: 'Sun Gold trial shipments only go out after cold-chain QA confirms labels, and Maya owns buyer confirmation',
    }),
  ];

  await runBatch(spaceId);

  const intents = await intentsForMessages(messageIds);
  assert.equal(intents.length, 1, 'durable decision should create one knowledge intent');
  assert.equal(intents[0]?.kind, 'decision_candidate');
  assert.equal(intents[0]?.proposed_action, 'wiki_create');
  assert.equal((intents[0]?.metadata as Record<string, unknown>).episode_capture, true);
});

test('chat-knowledge-batch does not turn blocker discussion into passive wiki or task work', async () => {
  const spaceId = await createSpace('batch-blocker');
  const messageIds = [
    await seedMessage(spaceId, 'I am blocked on the label proof because the QA sheet still has two missing crate checks.', 0),
    await seedMessage(spaceId, 'Can someone check whether Diego or Maya owns the crate checks?', 40, USER_TWO_ID),
    await seedMessage(spaceId, 'Let us wait until the handoff is clear before opening another task.', 80),
  ];

  await runBatch(spaceId);

  const intents = await intentsForMessages(messageIds);
  assert.equal(intents.length, 0, 'blocker discussion should wait for Defty/task flow, not passive wiki');
});

test('chat-knowledge-batch skips passive wiki when a resolution is immediately handed to Defty', async () => {
  const spaceId = await createSpace('batch-defty-task');
  const messageIds = [
    await seedMessage(spaceId, 'The label QA handoff is messy. Diego thinks ops owns it, Maya thinks marketing owns it.', 0),
    await seedMessage(spaceId, 'Resolution: Maya owns label copy, Diego owns cold-chain QA, and Lina checks final crates.', 45, USER_TWO_ID),
    await seedMessage(spaceId, '@defty create a task from this discussion with the owners and next checks.', 90, USER_ID, {
      confidence: 0.98,
      agentMentioned: true,
    }),
  ];

  await runBatch(spaceId);

  const intents = await intentsForMessages(messageIds);
  assert.equal(intents.length, 0, 'Defty-invoked task episodes should not also become passive wiki');
});

test('chat-knowledge-batch prefers updating related wiki over creating duplicate wiki pages', async () => {
  const spaceId = await createSpace('batch-related-update');
  const slug = `brightmart-delivery-window-${RUN_ID}`;
  await db.insert(wikiPages).values({
    id: `chat-batch-wiki-${crypto.randomUUID()}`,
    org_id: ORG_ID,
    scope: 'org',
    type: 'decision',
    title: 'BrightMart delivery window stays Friday',
    slug,
    summary: 'BrightMart delivery window stays Friday.',
    content: 'Decision: BrightMart delivery window stays Friday.',
    confidence: 0.9,
  });

  const messageIds = [
    await seedMessage(spaceId, 'BrightMart asked whether the delivery window is moving because the east route is tight.', 0),
    await seedMessage(spaceId, 'Decision: BrightMart delivery window stays Friday, and Maya owns buyer confirmation before the route sheet is sent.', 50, USER_TWO_ID, {
      confidence: 0.95,
      decision: 'BrightMart delivery window stays Friday, and Maya owns buyer confirmation before the route sheet is sent',
    }),
  ];

  await runBatch(spaceId);

  const intents = await intentsForMessages(messageIds);
  assert.equal(intents.length, 1, 'related durable decision should create one update intent');
  assert.equal(intents[0]?.proposed_action, 'wiki_update');
  assert.equal(((intents[0]?.proposed_params as Record<string, any>).slug), slug);
  assert.equal((intents[0]?.metadata as Record<string, unknown>).related_wiki_update, true);
});
