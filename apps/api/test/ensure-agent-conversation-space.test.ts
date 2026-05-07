/**
 * Verifies ensureAgentConversationSpace is idempotent and creates spaces correctly.
 * Phase 2 of agent-chat unification.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/ensure-agent-conversation-space.test.ts
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { ensureAgentConversationSpace } from '../src/lib/ensure-agent-conversation-space.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';

let orgId: string;
let userId: string;
let deftyUserId: string;
const convoId = `conv-${Date.now()}`;

before(async () => {
  const [org] = await db.insert(orgs).values({ name: 'EACS Test', slug: `eacs-${Date.now()}` }).returning();
  orgId = org!.id;
  const [u] = await db.insert(users).values({
    email: `eacs-u-${Date.now()}@test.local`, name: 'Test User', kind: 'human', email_verified: true,
  }).returning();
  userId = u!.id;
  await db.insert(orgMembers).values({ org_id: orgId, user_id: userId, role: 'owner' });
  deftyUserId = await ensureDeftyMembership(orgId);
});

after(async () => {
  try {
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, convoId));
    await db.delete(spaces).where(eq(spaces.id, convoId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  } catch {}
});

test('ensureAgentConversationSpace creates spaces row with type=agent_conversation', async () => {
  await ensureAgentConversationSpace({ orgId, userId, agentUserId: deftyUserId, conversationId: convoId, title: 'Test convo' });
  const [s] = await db.select().from(spaces).where(eq(spaces.id, convoId)).limit(1);
  assert.ok(s, 'space row exists');
  assert.equal(s!.type, 'agent_conversation');
  assert.equal(s!.org_id, orgId);
  assert.equal(s!.name, 'Test convo');
});

test('ensureAgentConversationSpace adds both user and agent as members', async () => {
  await ensureAgentConversationSpace({ orgId, userId, agentUserId: deftyUserId, conversationId: convoId, title: 'Test convo' });
  const members = await db.select().from(spaceMembers).where(eq(spaceMembers.space_id, convoId));
  const ids = members.map((m) => m.user_id).sort();
  assert.deepEqual(ids, [userId, deftyUserId].sort());
});

test('ensureAgentConversationSpace is idempotent', async () => {
  await ensureAgentConversationSpace({ orgId, userId, agentUserId: deftyUserId, conversationId: convoId, title: 'Test convo' });
  await ensureAgentConversationSpace({ orgId, userId, agentUserId: deftyUserId, conversationId: convoId, title: 'Test convo' });
  const spacesRows = await db.select().from(spaces).where(eq(spaces.id, convoId));
  assert.equal(spacesRows.length, 1);
  const memberRows = await db.select().from(spaceMembers).where(eq(spaceMembers.space_id, convoId));
  assert.equal(memberRows.length, 2);
});
