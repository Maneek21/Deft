/**
 * Block 2.2 — post_thread_reply executor test.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/post-thread-reply.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { db, messages, spaces, orgs, users, orgMembers } from '@deft/db';
import { executeActionDirect } from '../src/lib/agent-actions.js';

let testOrgId: string;
let testUserId: string;
let testSpaceId: string;
let parentMsgId: string;
const replyIds: string[] = [];

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) await db.insert(orgs).values({ id: testOrgId, name: 'b22', slug: 'b22' });

  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) await db.insert(users).values({ id: testUserId, email: `b22-${Date.now()}@t.local`, name: 'b22' });

  const member = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!member) {
    await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin' });
  }

  // Use any existing space; create one if none.
  const existingSpace = await db.query.spaces.findFirst({
    where: (s, { eq }) => eq(s.org_id, testOrgId),
  });
  if (existingSpace) {
    testSpaceId = existingSpace.id;
  } else {
    testSpaceId = crypto.randomUUID();
    await db.insert(spaces).values({
      id: testSpaceId,
      org_id: testOrgId,
      name: 'b22-space',
      type: 'public',
      created_by: testUserId,
    });
  }

  // Seed a parent message.
  parentMsgId = crypto.randomUUID();
  await db.insert(messages).values({
    id: parentMsgId,
    org_id: testOrgId,
    space_id: testSpaceId,
    user_id: testUserId,
    content: 'Parent message for thread',
  });
});

after(async () => {
  if (replyIds.length > 0) {
    await db.delete(messages).where(inArray(messages.id, replyIds));
  }
  await db.delete(messages).where(eq(messages.id, parentMsgId));
});

test('post_thread_reply inserts a message with parent_id + space_id', async () => {
  const r = await executeActionDirect(
    'post_thread_reply',
    { parent_message_id: parentMsgId, content: 'Thread reply body' },
    testOrgId,
    testUserId,
    null,
    'full',
  );
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(r.result.message_id);
  replyIds.push(r.result.message_id);

  const [row] = await db.select().from(messages).where(eq(messages.id, r.result.message_id));
  assert.ok(row);
  assert.equal(row!.parent_id, parentMsgId, 'reply points at parent');
  assert.equal(row!.space_id, testSpaceId, 'reply inherits parent space');
  assert.equal(row!.content, 'Thread reply body');
});

test('post_thread_reply rejects empty content', async () => {
  const r = await executeActionDirect(
    'post_thread_reply',
    { parent_message_id: parentMsgId, content: '   ' },
    testOrgId, testUserId, null, 'full',
  );
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('content is required'));
});

test('post_thread_reply rejects missing parent_message_id', async () => {
  const r = await executeActionDirect(
    'post_thread_reply',
    { content: 'hi' } as any,
    testOrgId, testUserId, null, 'full',
  );
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('parent_message_id is required'));
});

test('post_thread_reply rejects a non-existent parent', async () => {
  const r = await executeActionDirect(
    'post_thread_reply',
    { parent_message_id: crypto.randomUUID(), content: 'hi' },
    testOrgId, testUserId, null, 'full',
  );
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('Parent message not found'));
});
