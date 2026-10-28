import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { messages, orgMembers, orgs, spaces, spaceMembers, users } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const orgId = randomUUID();
const ownerId = randomUUID();
const memberId = randomUUID();
const agentUserId = randomUUID();
const spaceId = randomUUID();
const parentId = randomUUID();
let unavailable = databaseUrl ? '' : 'Set matching DEFT_TEST_DATABASE_URL and DATABASE_URL to a disposable test database';
let seeded = false;
const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user', { id: memberId, org_id: orgId, email: `${memberId}@example.test` } as any);
  await next();
});

const pendingMetadata = {
  is_agent_reply: true,
  defty_pending: {
    kind: 'action_draft', request_message_id: parentId, request_text: 'Update the private record',
    draft: { actions: [{ action: 'module_record_update', params: {
      module_id: 'com.deft.contacts', collection_key: 'contacts', record_id: 'private-record',
      expected_revision: 3, patch: { notes: 'PRIVATE-READ-CANARY' },
    } }] },
    question: 'Which record?', created_at: new Date().toISOString(),
  },
};

before(async () => {
  if (unavailable) return;
  const probe = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  try { await probe.connect(); } catch (error) {
    unavailable = `Test database unavailable: ${String(error)}`;
    return;
  } finally { await probe.end(); }
  await db.insert(orgs).values({ id: orgId, name: 'Pending outbound', slug: `pending-outbound-${orgId}` });
  await db.insert(users).values([
    { id: ownerId, email: `${ownerId}@example.test`, name: 'Requester', kind: 'human', is_agent: false },
    { id: memberId, email: `${memberId}@example.test`, name: 'Channel member', kind: 'human', is_agent: false },
    { id: agentUserId, email: `${agentUserId}@example.test`, name: 'Defty', kind: 'agent', is_agent: true },
  ]);
  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: ownerId, role: 'owner' },
    { org_id: orgId, user_id: memberId, role: 'member' },
    { org_id: orgId, user_id: agentUserId, role: 'member' },
  ]);
  await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'Pending outbound', type: 'public', created_by: ownerId });
  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: ownerId },
    { space_id: spaceId, user_id: memberId },
    { space_id: spaceId, user_id: agentUserId },
  ]);
  // Stored raw on purpose: the outbound projection must not depend on the writer.
  await db.insert(messages).values([
    { id: parentId, org_id: orgId, space_id: spaceId, user_id: ownerId, content: 'Update the private record' },
    { org_id: orgId, space_id: spaceId, user_id: agentUserId, content: 'Which record?', metadata: pendingMetadata as never },
    { org_id: orgId, space_id: spaceId, user_id: agentUserId, parent_id: parentId, content: 'Which record?', metadata: pendingMetadata as never },
  ]);
  const { messageRoutes } = await import('../src/routes/messages.js');
  app.route('/api/messages', messageRoutes);
  seeded = true;
});

after(async () => {
  if (seeded) {
    await db.delete(messages).where(eq(messages.org_id, orgId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.org_id, orgId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, memberId));
    await db.delete(users).where(eq(users.id, agentUserId));
  }
  await closeDb();
});

test('message list responses never expose privileged pending module values', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const response = await app.request(`/api/messages/${spaceId}`);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { messages: Array<{ metadata: Record<string, any> }> };
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE-READ-CANARY/);
  const pending = body.messages.find((message) => message.metadata?.defty_pending)?.metadata.defty_pending;
  assert.deepEqual(pending.draft.actions[0].params.changed_fields, ['notes']);
});

test('thread responses never expose privileged pending module values', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const response = await app.request(`/api/messages/${parentId}/thread`);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { replies: Array<{ metadata: Record<string, any> }> };
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE-READ-CANARY/);
  assert.deepEqual(body.replies[0]!.metadata.defty_pending.draft.actions[0].params.changed_fields, ['notes']);
});
