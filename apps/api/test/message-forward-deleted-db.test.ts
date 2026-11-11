import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { messages, orgMembers, orgs, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';

const orgId = randomUUID();
const humanId = randomUUID();
const sourceId = randomUUID();
const targetId = randomUUID();
let app: Hono;

before(async () => {
  await db.insert(orgs).values({ id: orgId, name: 'Forward deleted', slug: `fwd-${orgId}` });
  await db.insert(users).values({ id: humanId, name: 'Forwarder', email: `fwd-${humanId}@test.local`, kind: 'human', is_agent: false, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: humanId, role: 'owner' });
  await db.insert(spaces).values([
    { id: sourceId, org_id: orgId, name: 'fwd-source', type: 'public', created_by: humanId },
    { id: targetId, org_id: orgId, name: 'fwd-target', type: 'public', created_by: humanId },
  ]);
  await db.insert(spaceMembers).values([{ space_id: sourceId, user_id: humanId }, { space_id: targetId, user_id: humanId }]);
  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: humanId, org_id: orgId, email: `fwd-${humanId}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/messages', messageRoutes);
});

after(async () => {
  await db.delete(messages).where(inArray(messages.space_id, [sourceId, targetId]));
  await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, [sourceId, targetId]));
  await db.delete(spaces).where(inArray(spaces.id, [sourceId, targetId]));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
  await db.delete(users).where(eq(users.id, humanId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

async function forward(messageId: string) {
  const response = await app.request('/messages/forward', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id: messageId, target_space_id: targetId }),
  });
  return { status: response.status, body: await response.json() as { code?: string } };
}

test('forward: a soft-deleted source message answers like a missing one', async () => {
  const [deleted] = await db.insert(messages).values({
    org_id: orgId, space_id: sourceId, user_id: humanId, content: 'DELETED-CANARY', is_deleted: true,
  }).returning();
  const result = await forward(deleted!.id);
  const missing = await forward(randomUUID());
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, missing.body);
  const copies = await db.select({ id: messages.id }).from(messages).where(eq(messages.space_id, targetId));
  assert.equal(copies.length, 0, 'deleted content must not be re-published');
});

test('forward: a live source message is still forwarded', async () => {
  const [live] = await db.insert(messages).values({
    org_id: orgId, space_id: sourceId, user_id: humanId, content: 'live content',
  }).returning();
  const result = await forward(live!.id);
  assert.equal(result.status, 201);
});
