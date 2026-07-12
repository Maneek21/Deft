// apps/api/test/inbox-route.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { db } from '../src/lib/db.js';
import {
  users, orgs, orgMembers, spaces, spaceMembers, messages,
  notifications, agentActions, agentEmployees,
} from '@deft/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { inboxRoutes } from '../src/routes/inbox.js';

let testOrgId: string;
let userId: string;
let dmSpaceId: string;
let dmPartnerId: string;
let publicSpaceId: string;
const createdNotifIds: string[] = [];
const createdActionIds: string[] = [];
const createdMessageIds: string[] = [];
let app: Hono;

before(async () => {
  const ts = Date.now();
  const [org] = await db.insert(orgs).values({
    name: `inbox-test-${ts}`,
    slug: `inbox-${ts}`,
  }).returning();
  testOrgId = org.id;

  const [user] = await db.insert(users).values({
    email: `inbox-user-${ts}@test.com`,
    name: 'Inbox User',
    kind: 'human',
  }).returning();
  userId = user.id;

  const [partner] = await db.insert(users).values({
    email: `inbox-partner-${ts}@test.com`,
    name: 'DM Partner',
    kind: 'human',
  }).returning();
  dmPartnerId = partner.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: userId, role: 'owner' },
    { org_id: testOrgId, user_id: dmPartnerId, role: 'member' },
  ]);

  const [dmSpace] = await db.insert(spaces).values({
    name: 'dm-test',
    type: 'dm',
    org_id: testOrgId,
    created_by: userId,
  }).returning();
  dmSpaceId = dmSpace.id;
  await db.insert(spaceMembers).values([
    { space_id: dmSpaceId, user_id: userId, last_read_at: new Date(Date.now() - 60_000) },
    { space_id: dmSpaceId, user_id: dmPartnerId },
  ]);

  const [publicSpace] = await db.insert(spaces).values({
    name: 'general',
    type: 'public',
    org_id: testOrgId,
    created_by: userId,
  }).returning();
  publicSpaceId = publicSpace.id;
  await db.insert(spaceMembers).values({ space_id: publicSpaceId, user_id: userId });

  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: testOrgId } as never);
    await next();
  });
  app.route('/api/inbox', inboxRoutes);
});

after(async () => {
  if (createdActionIds.length) {
    await db.delete(agentActions).where(inArray(agentActions.id, createdActionIds));
  }
  if (createdNotifIds.length) {
    await db.delete(notifications).where(inArray(notifications.id, createdNotifIds));
  }
  if (createdMessageIds.length) {
    await db.delete(messages).where(inArray(messages.id, createdMessageIds));
  }
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, dmSpaceId));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, publicSpaceId));
  await db.delete(spaces).where(eq(spaces.id, dmSpaceId));
  await db.delete(spaces).where(eq(spaces.id, publicSpaceId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
  await db.delete(users).where(inArray(users.id, [userId, dmPartnerId]));
  await db.delete(orgs).where(eq(orgs.id, testOrgId));
});

test('GET /api/inbox returns mention notifications', async () => {
  const [n] = await db.insert(notifications).values({
    org_id: testOrgId,
    user_id: userId,
    type: 'mention',
    title: 'Alice mentioned you',
    body: '@you check this out',
    link: `/chat?space=${publicSpaceId}`,
    is_read: false,
  }).returning();
  createdNotifIds.push(n.id);

  const res = await app.request('/api/inbox');
  assert.equal(res.status, 200);
  const body = await res.json() as { items: { kind: string; id: string }[] };
  const mention = body.items.find((it) => it.id === `notif:${n.id}`);
  assert.ok(mention, 'mention should appear in inbox');
  assert.equal(mention.kind, 'mention');
});

test('GET /api/inbox defaults to attention and keeps background activity separate', async () => {
  const [background, nudge] = await db.insert(notifications).values([
    {
      org_id: testOrgId,
      user_id: userId,
      type: 'system',
      title: 'Weekly background summary',
      is_read: false,
    },
    {
      org_id: testOrgId,
      user_id: userId,
      type: 'agent_suggestion',
      title: '2 overdue tasks',
      metadata: { nudge_type: 'overdue', task_ids: ['task-a', 'task-b'] },
      is_read: false,
    },
  ]).returning();
  createdNotifIds.push(background.id, nudge.id);

  const attentionRes = await app.request('/api/inbox');
  assert.equal(attentionRes.status, 200);
  const attention = await attentionRes.json() as { items: { id: string; kind: string }[] };
  assert.equal(attention.items.some((item) => item.id === `notif:${background.id}`), false);
  assert.equal(
    attention.items.find((item) => item.id === `notif:${nudge.id}`)?.kind,
    'task_updated',
  );

  const activityRes = await app.request('/api/inbox?kind=system');
  assert.equal(activityRes.status, 200);
  const activity = await activityRes.json() as { items: { id: string }[] };
  assert.equal(activity.items.some((item) => item.id === `notif:${background.id}`), true);
  assert.equal(activity.items.some((item) => item.id === `notif:${nudge.id}`), false);
});

test('GET /api/inbox hides read queue rows unless history is requested', async () => {
  const [readNotification] = await db.insert(notifications).values({
    org_id: testOrgId,
    user_id: userId,
    type: 'task_updated',
    title: 'Historical task update',
    is_read: true,
  }).returning();
  createdNotifIds.push(readNotification.id);

  const queueRes = await app.request('/api/inbox?kind=task_updated');
  const queue = await queueRes.json() as { items: { id: string }[] };
  assert.equal(queue.items.some((item) => item.id === `notif:${readNotification.id}`), false);

  const historyRes = await app.request('/api/inbox?kind=task_updated&include_read=1');
  const history = await historyRes.json() as { items: { id: string }[] };
  assert.equal(history.items.some((item) => item.id === `notif:${readNotification.id}`), true);
});

test('GET /api/inbox surfaces DM unread', async () => {
  const [m] = await db.insert(messages).values({
    org_id: testOrgId,
    space_id: dmSpaceId,
    user_id: dmPartnerId,
    content: 'hello there',
  }).returning();
  createdMessageIds.push(m.id);

  const res = await app.request('/api/inbox');
  const body = await res.json() as { items: { kind: string; id: string; dm?: { space_id: string } }[] };
  const dm = body.items.find((it) => it.kind === 'dm_unread' && it.dm?.space_id === dmSpaceId);
  assert.ok(dm, 'DM unread should appear');
  assert.equal(dm.id, `dm:${dmSpaceId}`);
});

test('GET /api/inbox surfaces pending approvals', async () => {
  const [a] = await db.insert(agentActions).values({
    org_id: testOrgId,
    user_id: userId,
    action: 'create_task',
    params: { title: 'foo' },
    approval_status: 'pending',
    approval_tier: 'quick',
    source: 'mention',
  }).returning();
  createdActionIds.push(a.id);

  const res = await app.request('/api/inbox');
  const body = await res.json() as { items: { kind: string; id: string; approval?: { action_id: string } }[] };
  const ap = body.items.find((it) => it.kind === 'pending_approval' && it.approval?.action_id === a.id);
  assert.ok(ap, 'pending approval should appear');
  assert.equal(ap.id, `approval:${a.id}`);
});

test('GET /api/inbox does not expire hidden Defty captures', async () => {
  let hiddenSpaceId: string | null = null;
  let hiddenMessageId: string | null = null;
  let hiddenActionId: string | null = null;

  try {
    const [hiddenSpace] = await db.insert(spaces).values({
      name: 'hidden-captures',
      type: 'private',
      org_id: testOrgId,
      created_by: dmPartnerId,
    }).returning();
    hiddenSpaceId = hiddenSpace.id;

    const [hiddenMessage] = await db.insert(messages).values({
      org_id: testOrgId,
      space_id: hiddenSpaceId,
      user_id: dmPartnerId,
      content: 'private blocker that current user cannot see',
    }).returning();
    hiddenMessageId = hiddenMessage.id;

    const [hiddenAction] = await db.insert(agentActions).values({
      org_id: testOrgId,
      user_id: dmPartnerId,
      source: 'defty_capture',
      action: 'task_create',
      params: {
        title: 'Hidden capture should stay pending',
        source_space_id: hiddenSpaceId,
        source_message_id: hiddenMessageId,
      },
      approval_status: 'pending',
      approval_tier: 'quick',
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
    }).returning();
    hiddenActionId = hiddenAction.id;

    const res = await app.request('/api/inbox');
    assert.equal(res.status, 200);
    const body = await res.json() as { items: { kind: string; approval?: { action_id: string } }[] };
    assert.equal(
      body.items.some((it) => it.approval?.action_id === hiddenActionId),
      false,
      'hidden stale capture should not appear in the current user inbox',
    );

    const [after] = await db.select()
      .from(agentActions)
      .where(eq(agentActions.id, hiddenActionId));
    assert.equal(
      after.approval_status,
      'pending',
      'hidden stale capture must not be expired by inbox polling from a non-member',
    );
  } finally {
    if (hiddenActionId) {
      await db.delete(agentActions).where(eq(agentActions.id, hiddenActionId));
    }
    if (hiddenMessageId) {
      await db.delete(messages).where(eq(messages.id, hiddenMessageId));
    }
    if (hiddenSpaceId) {
      await db.delete(spaces).where(eq(spaces.id, hiddenSpaceId));
    }
  }
});

test('GET /api/inbox sorts items desc by created_at', async () => {
  const res = await app.request('/api/inbox');
  const body = await res.json() as { items: { created_at: string }[] };
  for (let i = 1; i < body.items.length; i++) {
    const prev = new Date(body.items[i - 1].created_at).getTime();
    const cur = new Date(body.items[i].created_at).getTime();
    assert.ok(prev >= cur, `expected desc; got ${body.items[i - 1].created_at} before ${body.items[i].created_at}`);
  }
});

test('POST /api/inbox/read marks specific notifications read', async () => {
  const [n1] = await db.insert(notifications).values({
    org_id: testOrgId, user_id: userId, type: 'task_assigned',
    title: 'Task X', is_read: false,
  }).returning();
  const [n2] = await db.insert(notifications).values({
    org_id: testOrgId, user_id: userId, type: 'task_assigned',
    title: 'Task Y', is_read: false,
  }).returning();
  createdNotifIds.push(n1.id, n2.id);

  const res = await app.request('/api/inbox/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [`notif:${n1.id}`] }),
  });
  assert.equal(res.status, 200);

  const [after1] = await db.select().from(notifications).where(eq(notifications.id, n1.id));
  const [after2] = await db.select().from(notifications).where(eq(notifications.id, n2.id));
  assert.equal(after1.is_read, true);
  assert.equal(after2.is_read, false);
});

test('POST /api/inbox/read with all=true marks everything read', async () => {
  const [n] = await db.insert(notifications).values({
    org_id: testOrgId, user_id: userId, type: 'task_assigned',
    title: 'Z', is_read: false,
  }).returning();
  createdNotifIds.push(n.id);

  const res = await app.request('/api/inbox/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  assert.equal(res.status, 200);

  const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
  assert.equal(after.is_read, true);
});

test('POST /api/inbox/read with all=true leaves background activity unread', async () => {
  const [attention, background] = await db.insert(notifications).values([
    {
      org_id: testOrgId,
      user_id: userId,
      type: 'task_updated',
      title: 'Attention row',
      is_read: false,
    },
    {
      org_id: testOrgId,
      user_id: userId,
      type: 'system',
      title: 'Background row',
      is_read: false,
    },
  ]).returning();
  createdNotifIds.push(attention.id, background.id);

  const res = await app.request('/api/inbox/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  assert.equal(res.status, 200);

  const [attentionAfter] = await db.select().from(notifications).where(eq(notifications.id, attention.id));
  const [backgroundAfter] = await db.select().from(notifications).where(eq(notifications.id, background.id));
  assert.equal(attentionAfter.is_read, true);
  assert.equal(backgroundAfter.is_read, false);
});

test('POST /api/inbox/read scoped to current user only', async () => {
  const [otherUser] = await db.insert(users).values({
    email: `other-${Date.now()}@test.com`, name: 'O', org_id: testOrgId, kind: 'human',
  }).returning();
  const [n] = await db.insert(notifications).values({
    org_id: testOrgId, user_id: otherUser.id, type: 'mention',
    title: 'cross-user', is_read: false,
  }).returning();

  const res = await app.request('/api/inbox/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [`notif:${n.id}`] }),
  });
  assert.equal(res.status, 200);

  const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id));
  assert.equal(after.is_read, false, 'other-user notif must not be flipped');

  await db.delete(notifications).where(eq(notifications.id, n.id));
  await db.delete(users).where(eq(users.id, otherUser.id));
});

test('GET /api/inbox supports multiple task notification kinds', async () => {
  const inserted = await db.insert(notifications).values([
    {
      org_id: testOrgId,
      user_id: userId,
      type: 'task_assigned',
      title: 'Assigned task',
      is_read: false,
    },
    {
      org_id: testOrgId,
      user_id: userId,
      type: 'task_updated',
      title: 'Updated task',
      is_read: false,
    },
    {
      org_id: testOrgId,
      user_id: userId,
      type: 'mention',
      title: 'Unrelated mention',
      is_read: false,
    },
  ]).returning();
  createdNotifIds.push(...inserted.map((row) => row.id));

  const res = await app.request('/api/inbox?kind=task_assigned,task_updated');
  assert.equal(res.status, 200);
  const body = await res.json() as { items: { id: string; kind: string }[]; unread_count: number };
  const insertedIds = new Set(inserted.slice(0, 2).map((row) => `notif:${row.id}`));
  const matching = body.items.filter((item) => insertedIds.has(item.id));

  assert.deepEqual(
    new Set(matching.map((item) => item.kind)),
    new Set(['task_assigned', 'task_updated']),
  );
  assert.equal(body.items.some((item) => item.id === `notif:${inserted[2].id}`), false);
  assert.ok(body.unread_count >= 2);
});

test('POST /api/inbox/read can mark only the selected tab kinds read', async () => {
  const [taskNotification, mentionNotification] = await db.insert(notifications).values([
    {
      org_id: testOrgId,
      user_id: userId,
      type: 'task_updated',
      title: 'Scoped task update',
      is_read: false,
    },
    {
      org_id: testOrgId,
      user_id: userId,
      type: 'mention',
      title: 'Scoped mention',
      is_read: false,
    },
  ]).returning();
  createdNotifIds.push(taskNotification.id, mentionNotification.id);

  const res = await app.request('/api/inbox/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ all: true, kinds: ['task_assigned', 'task_updated'] }),
  });
  assert.equal(res.status, 200);

  const [taskAfter] = await db.select().from(notifications).where(eq(notifications.id, taskNotification.id));
  const [mentionAfter] = await db.select().from(notifications).where(eq(notifications.id, mentionNotification.id));
  assert.equal(taskAfter.is_read, true);
  assert.equal(mentionAfter.is_read, false);
});

test('GET /api/inbox rejects an invalid kind without broadening the query', async () => {
  const res = await app.request('/api/inbox?kind=not-a-real-kind');
  assert.equal(res.status, 400);
  const body = await res.json() as { code?: string };
  assert.equal(body.code, 'VALIDATION_ERROR');
});
