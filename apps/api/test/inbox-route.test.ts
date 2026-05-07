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
