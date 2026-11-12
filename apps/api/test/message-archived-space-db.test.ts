import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { messages, orgMembers, orgs, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';

const orgId = randomUUID();
const humanId = randomUUID();
const archivedId = randomUUID();
const liveId = randomUUID();
let app: Hono;

before(async () => {
  await db.insert(orgs).values({ id: orgId, name: 'Archived post', slug: `arch-${orgId}` });
  await db.insert(users).values({ id: humanId, name: 'Poster', email: `arch-${humanId}@test.local`, kind: 'human', is_agent: false, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: humanId, role: 'owner' });
  await db.insert(spaces).values([
    { id: archivedId, org_id: orgId, name: 'arch-old', type: 'public', created_by: humanId, is_archived: true },
    { id: liveId, org_id: orgId, name: 'arch-live', type: 'public', created_by: humanId },
  ]);
  await db.insert(spaceMembers).values([{ space_id: archivedId, user_id: humanId }, { space_id: liveId, user_id: humanId }]);
  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: humanId, org_id: orgId, email: `arch-${humanId}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/messages', messageRoutes);
});

after(async () => {
  await db.delete(messages).where(inArray(messages.space_id, [archivedId, liveId]));
  await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, [archivedId, liveId]));
  await db.delete(spaces).where(inArray(spaces.id, [archivedId, liveId]));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
  await db.delete(users).where(eq(users.id, humanId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

async function post(spaceId: string, body: Record<string, unknown>) {
  const response = await app.request(`/messages/${spaceId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { code?: string } };
}

test('W2-3: an archived space does not accept a new message', async () => {
  const result = await post(archivedId, { content: 'into the archive' });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SPACE_ARCHIVED');
  const rows = await db.select({ id: messages.id }).from(messages).where(eq(messages.space_id, archivedId));
  assert.equal(rows.length, 0);
});

test('W2-3: an archived space does not accept a thread reply', async () => {
  const [parent] = await db.insert(messages).values({ org_id: orgId, space_id: archivedId, user_id: humanId, content: 'older root' }).returning();
  const result = await post(archivedId, { content: 'late reply', parent_id: parent!.id });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SPACE_ARCHIVED');
  const replies = await db.select({ id: messages.id }).from(messages).where(eq(messages.parent_id, parent!.id));
  assert.equal(replies.length, 0);
});

test('W2-3: a live space still accepts a message', async () => {
  const result = await post(liveId, { content: 'hello' });
  assert.equal(result.status, 201);
});
