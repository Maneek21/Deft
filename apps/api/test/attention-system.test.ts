import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import {
  agentActionApprovers,
  agentActions,
  attentionEvents,
  attentionItems,
  messages,
  orgMembers,
  orgs,
  spaceMembers,
  spaces,
  users,
} from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import {
  recordActionApproverDecision,
  filterVisibleAttentionItems,
  recordAttentionFeedback,
  resolveAttentionBySource,
  transitionAttentionItem,
  syncApprovalToAttention,
  upsertAttentionItem,
  visibleAttentionCondition,
} from '../src/lib/attention.js';

let orgId: string;
let authorId: string;
let recipientId: string;
let privateSpaceId: string;
let privateMessageId: string;

before(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(orgs).values({ name: `attention-${stamp}`, slug: `attention-${stamp}` }).returning();
  orgId = org!.id;
  const createdUsers = await db.insert(users).values([
    { email: `attention-author-${stamp}@test.local`, name: 'Attention Author', kind: 'human' },
    { email: `attention-recipient-${stamp}@test.local`, name: 'Attention Recipient', kind: 'human' },
  ]).returning();
  authorId = createdUsers[0]!.id;
  recipientId = createdUsers[1]!.id;
  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: authorId, role: 'member' },
    { org_id: orgId, user_id: recipientId, role: 'member' },
  ]);
  const [space] = await db.insert(spaces).values({
    org_id: orgId,
    name: `private-${stamp}`,
    type: 'private',
    created_by: authorId,
  }).returning();
  privateSpaceId = space!.id;
  await db.insert(spaceMembers).values([
    { space_id: privateSpaceId, user_id: authorId },
    { space_id: privateSpaceId, user_id: recipientId },
  ]);
  const [message] = await db.insert(messages).values({
    org_id: orgId,
    space_id: privateSpaceId,
    user_id: authorId,
    content: 'Please review this private launch decision.',
  }).returning();
  privateMessageId = message!.id;
});

after(async () => {
  await db.delete(attentionItems).where(eq(attentionItems.org_id, orgId));
  await db.delete(agentActions).where(eq(agentActions.org_id, orgId));
  await db.delete(messages).where(eq(messages.org_id, orgId));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, privateSpaceId));
  await db.delete(spaces).where(eq(spaces.org_id, orgId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
  await db.delete(users).where(inArray(users.id, [authorId, recipientId]));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

test('approval ownership is persisted and the winning decision supersedes alternatives', async () => {
  const [requesterAction] = await db.insert(agentActions).values({
    org_id: orgId,
    user_id: authorId,
    action: 'task_create',
    params: { source_user_id: recipientId, title: 'Requester-owned approval' },
    approval_tier: 'quick',
  }).returning();
  assert.ok(requesterAction);

  const requesterItems = await syncApprovalToAttention(requesterAction, { deliver: false });
  assert.equal(requesterItems.length, 1);
  assert.equal(requesterItems[0]?.user_id, recipientId);

  const [requesterApprover] = await db
    .select()
    .from(agentActionApprovers)
    .where(and(
      eq(agentActionApprovers.action_id, requesterAction.id),
      eq(agentActionApprovers.user_id, recipientId),
    ));
  assert.equal(requesterApprover?.decision, 'pending');

  const [delegatedAction] = await db.insert(agentActions).values({
    org_id: orgId,
    user_id: authorId,
    action: 'task_update',
    params: { source_user_id: recipientId, task_id: 'delegated-task' },
    approval_tier: 'quick',
  }).returning();
  assert.ok(delegatedAction);
  await db.insert(agentActionApprovers).values([
    { org_id: orgId, action_id: delegatedAction.id, user_id: authorId },
    { org_id: orgId, action_id: delegatedAction.id, user_id: recipientId },
  ]);

  const delegatedItems = await syncApprovalToAttention(delegatedAction, { deliver: false });
  assert.deepEqual(
    delegatedItems.map((item) => item?.user_id).sort(),
    [authorId, recipientId].sort(),
  );

  await recordActionApproverDecision({
    orgId,
    actionId: delegatedAction.id,
    userId: recipientId,
    decision: 'approved',
  });
  const decisions = await db
    .select({ user_id: agentActionApprovers.user_id, decision: agentActionApprovers.decision })
    .from(agentActionApprovers)
    .where(eq(agentActionApprovers.action_id, delegatedAction.id));
  assert.equal(decisions.find((row) => row.user_id === recipientId)?.decision, 'approved');
  assert.equal(decisions.find((row) => row.user_id === authorId)?.decision, 'superseded');
});

test('attention dedupes source retries and appends distinct events', async () => {
  const base = {
    orgId,
    userId: recipientId,
    kind: 'human_request',
    lane: 'needs_you' as const,
    priority: 'normal' as const,
    dedupeKey: `request:${privateMessageId}:${recipientId}`,
    sourceType: 'message',
    sourceId: privateMessageId,
    sourceEventId: `request:${privateMessageId}:v1`,
    title: 'Review requested',
  };
  const first = await upsertAttentionItem(base, { deliver: false });
  const retried = await upsertAttentionItem(base, { deliver: false });
  assert.equal(retried?.id, first?.id);
  assert.equal(retried?.event_count, 1);

  const changed = await upsertAttentionItem({ ...base, sourceEventId: `request:${privateMessageId}:v2`, body: 'Updated evidence' }, { deliver: false });
  assert.equal(changed?.id, first?.id);
  assert.equal(changed?.event_count, 2);
  const events = await db.select().from(attentionEvents).where(eq(attentionEvents.attention_item_id, first!.id));
  assert.equal(events.filter((event) => event.event_type === 'source_event').length, 2);
});

test('seen, acknowledged, snoozed, reopened, and resolved are distinct states', async () => {
  const [item] = await db.select().from(attentionItems).where(and(
    eq(attentionItems.org_id, orgId),
    eq(attentionItems.dedupe_key, `request:${privateMessageId}:${recipientId}`),
  )).limit(1);
  assert.ok(item);
  const seen = await transitionAttentionItem({ orgId, userId: recipientId, itemId: item.id, state: 'open_seen' });
  assert.equal(seen?.state, 'open_seen');
  assert.ok(seen?.seen_at);
  const acknowledged = await transitionAttentionItem({ orgId, userId: recipientId, itemId: item.id, state: 'acknowledged' });
  assert.equal(acknowledged?.state, 'acknowledged');
  const snoozed = await transitionAttentionItem({
    orgId,
    userId: recipientId,
    itemId: item.id,
    state: 'snoozed',
    snoozedUntil: new Date(Date.now() + 60_000),
  });
  assert.equal(snoozed?.state, 'snoozed');
  const reopened = await transitionAttentionItem({ orgId, userId: recipientId, itemId: item.id, state: 'open_unseen' });
  assert.equal(reopened?.state, 'open_unseen');
  assert.ok(reopened?.seen_at, 'snooze wake preserves the original seen timestamp');
  const resolved = await transitionAttentionItem({
    orgId,
    userId: recipientId,
    itemId: item.id,
    state: 'resolved',
    resolution: 'completed',
  });
  assert.equal(resolved?.state, 'resolved');
  assert.equal(resolved?.resolution, 'completed');
  const regressed = await transitionAttentionItem({ orgId, userId: recipientId, itemId: item.id, state: 'open_seen' });
  assert.equal(regressed, null, 'terminal items cannot regress through the read endpoint');
});

test('AI feedback demotes urgency and source resolution clears every projection', async () => {
  const item = await upsertAttentionItem({
    orgId,
    userId: recipientId,
    kind: 'human_request',
    lane: 'needs_you',
    priority: 'high',
    dedupeKey: `feedback:${privateMessageId}:${recipientId}`,
    sourceType: 'message',
    sourceId: privateMessageId,
    sourceEventId: `feedback:${privateMessageId}:v1`,
    title: 'Input needed',
    metadata: { classification_source: 'bounded_ai' },
  }, { deliver: false });
  assert.ok(item);
  const demoted = await recordAttentionFeedback({ orgId, userId: recipientId, itemId: item.id, feedback: 'not_urgent' });
  assert.equal(demoted?.priority, 'normal');
  assert.equal(demoted?.metadata.attention_feedback, 'not_urgent');
  const resolved = await resolveAttentionBySource({
    orgId,
    sourceType: 'message',
    sourceId: privateMessageId,
    resolution: 'source_replied',
    actorUserId: authorId,
  });
  assert.ok(resolved.length >= 1);
  assert.ok(resolved.every((row) => row.state === 'resolved'));
});

test('private source is hidden and resolved after membership is removed', async () => {
  await db.insert(spaceMembers).values({ space_id: privateSpaceId, user_id: recipientId }).onConflictDoNothing();
  const item = await upsertAttentionItem({
    orgId,
    userId: recipientId,
    kind: 'mention',
    lane: 'needs_you',
    priority: 'normal',
    dedupeKey: `privacy:${privateMessageId}:${recipientId}`,
    sourceType: 'message',
    sourceId: privateMessageId,
    sourceEventId: `privacy:${privateMessageId}:v1`,
    title: 'Private mention',
  }, { deliver: false });
  assert.ok(item);
  assert.equal((await filterVisibleAttentionItems(recipientId, [item])).length, 1);
  assert.equal((await db.select({ id: attentionItems.id }).from(attentionItems).where(and(
    eq(attentionItems.id, item.id),
    visibleAttentionCondition(recipientId),
  ))).length, 1);
  await db.delete(spaceMembers).where(and(
    eq(spaceMembers.space_id, privateSpaceId),
    eq(spaceMembers.user_id, recipientId),
  ));
  assert.equal((await filterVisibleAttentionItems(recipientId, [item])).length, 0);
  assert.equal((await db.select({ id: attentionItems.id }).from(attentionItems).where(and(
    eq(attentionItems.id, item.id),
    visibleAttentionCondition(recipientId),
  ))).length, 0);
  const [stored] = await db.select().from(attentionItems).where(eq(attentionItems.id, item.id));
  assert.equal(stored?.state, 'resolved');
  assert.equal(stored?.resolution, 'source_access_removed');
});

test('deleted approval sources are hidden and resolved instead of leaving stale cards', async () => {
  const [action] = await db.insert(agentActions).values({
    org_id: orgId,
    user_id: recipientId,
    action: 'create_task',
    params: { title: 'Transient approval source' },
    approval_tier: 'quick',
  }).returning();
  assert.ok(action);
  const [item] = await syncApprovalToAttention(action, { deliver: false });
  assert.ok(item);

  await db.delete(agentActions).where(eq(agentActions.id, action.id));

  assert.equal((await db.select({ id: attentionItems.id }).from(attentionItems).where(and(
    eq(attentionItems.id, item.id),
    visibleAttentionCondition(recipientId),
  ))).length, 0);
  assert.equal((await filterVisibleAttentionItems(recipientId, [item])).length, 0);
  const [stored] = await db.select().from(attentionItems).where(eq(attentionItems.id, item.id));
  assert.equal(stored?.state, 'resolved');
  assert.equal(stored?.resolution, 'source_access_removed');
});
