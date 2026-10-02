import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { nativeMentionRef, nativeMentionToken, type NativeMentionSource } from '@deft/shared';
import { messages, taskComments, tasks, notes, wikiPages, users, spaceMembers, noteShares,
  nativeReferenceStates, nativeMentionDeliveries, notifications, attentionItems, agentChannelEvents, taskWatchers, jobQueue } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { reconcileNativeMentions, handleNativeMentionReconciliation, publishNativeMentions,
  nativeContentHash, deliverNativeMention, resolveNativeMentions, nativeMentionBacklinks, loadNativeSource } from '../src/lib/native-mentions.js';
import { enqueueNativeMentionPublication, handleNativeMentionPublication } from '../src/lib/native-mentions.js';
import { nativeMentionRoutes } from '../src/routes/native-mentions.js';
import { notificationRoutes } from '../src/routes/notifications.js';
import { dailyNoteRoutes } from '../src/routes/daily-notes.js';
import { boundMentionAttention, mentionAttentionAcknowledge } from '../src/lib/mcp-tools/mention-attention.js';
import { createNativeMentionFixture } from './fixtures/native-mentions.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
const enabled = Boolean(safeTestDatabaseUrl());
let fixture: Awaited<ReturnType<typeof createNativeMentionFixture>>;
before(async () => { if (enabled) { process.env.DEFT_NATIVE_MENTIONS_ENABLED = 'true'; fixture = await createNativeMentionFixture(); } });
after(async () => {
  try {
    if (!fixture) return;
    // The wider API suite reuses its disposable DB: leave no extra workspaces.
    await db.transaction(async tx => {
      const orgIds = sql`(${fixture.orgId}, ${fixture.otherOrgId})`;
      await tx.execute(sql`DELETE FROM attention_items WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM notifications WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM native_reference_states WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM note_shares WHERE note_id IN (SELECT id FROM notes WHERE org_id IN ${orgIds})`);
      await tx.execute(sql`DELETE FROM task_watchers WHERE task_id IN (SELECT id FROM tasks WHERE org_id IN ${orgIds})`);
      await tx.execute(sql`DELETE FROM task_comments WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM messages WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM tasks WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM projects WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM wiki_pages WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM notes WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id IN ${orgIds})`);
      await tx.execute(sql`DELETE FROM spaces WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM agent_employees WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM org_members WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM job_queue WHERE org_id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM orgs WHERE id IN ${orgIds}`);
      await tx.execute(sql`DELETE FROM users WHERE id IN (${fixture.ownerId}, ${fixture.samId}, ${fixture.agentId}, ${fixture.agent2Id}, ${fixture.outsiderId})`);
    });
  } finally { await closeDb(); }
});
const token = (kind: 'person' | 'task' | 'wiki_page', id: string) => nativeMentionToken(nativeMentionRef(kind, id));
const actor = () => ({ orgId: fixture.orgId, userId: fixture.ownerId });
const appFor = (userId: string) => {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('user', { id: userId, org_id: fixture.orgId, email: 'synthetic@example.test' }); await next(); });
  app.route('/mentions', nativeMentionRoutes); app.route('/notifications', notificationRoutes); app.route('/notes', dailyNoteRoutes);
  return app;
};

test('all native writers enqueue identity-only reconciliation; stale jobs use current content', { skip: !enabled }, async () => {
  const body = token('task', fixture.taskId) + ' ' + token('wiki_page', fixture.wikiId);
  const [message] = await db.insert(messages).values({ org_id: fixture.orgId, space_id: fixture.publicSpaceId, user_id: fixture.ownerId, content: body }).returning();
  const [reply] = await db.insert(messages).values({ org_id: fixture.orgId, space_id: fixture.publicSpaceId, user_id: fixture.ownerId, parent_id: message!.id, content: body }).returning();
  const [comment] = await db.insert(taskComments).values({ org_id: fixture.orgId, task_id: fixture.taskId, user_id: fixture.ownerId, content: body }).returning();
  await db.update(tasks).set({ description: body }).where(eq(tasks.id, fixture.taskId));
  await db.update(wikiPages).set({ content: body }).where(eq(wikiPages.id, fixture.wikiId));
  await db.update(notes).set({ content: body }).where(eq(notes.id, fixture.noteId));
  const sources: NativeMentionSource[] = [
    { kind: 'message', id: message!.id }, { kind: 'message', id: reply!.id }, { kind: 'task_comment', id: comment!.id },
    { kind: 'task', id: fixture.taskId }, { kind: 'wiki_page', id: fixture.wikiId }, { kind: 'note', id: fixture.noteId },
  ];
  const jobs = await db.select().from(jobQueue).where(and(eq(jobQueue.org_id, fixture.orgId), eq(jobQueue.name, 'native-mention-reconcile')));
  for (const source of sources) {
    assert(jobs.some(job => (job.data.source as NativeMentionSource)?.id === source.id));
    await reconcileNativeMentions(fixture.orgId, source);
  }
  assert(!JSON.stringify(jobs.map(job => job.data)).includes('Launch checklist'));
  const links = await nativeMentionBacklinks(actor(), nativeMentionRef('task', fixture.taskId));
  assert.equal(links.count, 6);
  assert.equal((await nativeMentionBacklinks({ orgId: fixture.orgId, userId: fixture.samId }, nativeMentionRef('task', fixture.taskId))).count, 5);
  await db.update(messages).set({ content: 'Reference removed' }).where(eq(messages.id, message!.id));
  await reconcileNativeMentions(fixture.orgId, { kind: 'message', id: message!.id });
  assert.equal((await nativeMentionBacklinks(actor(), nativeMentionRef('task', fixture.taskId))).count, 5);
  await db.update(messages).set({ is_deleted: true }).where(eq(messages.id, reply!.id));
  await reconcileNativeMentions(fixture.orgId, { kind: 'message', id: reply!.id });
  assert.equal((await nativeMentionBacklinks(actor(), nativeMentionRef('task', fixture.taskId))).count, 4);
});

test('publication uses saved hashes, blocks private recipients and retries after sharing', { skip: !enabled }, async () => {
  const body = token('person', fixture.samId);
  const source = { kind: 'note' as const, id: fixture.noteId };
  await db.update(notes).set({ content: body }).where(eq(notes.id, source.id));
  await reconcileNativeMentions(fixture.orgId, source);
  assert.equal((await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.org_id, fixture.orgId))).length, 0);
  await assert.rejects(publishNativeMentions(actor(), source, nativeContentHash('stale')), /Content changed/);
  assert.equal((await publishNativeMentions(actor(), source, nativeContentHash(body))).blocked_count, 1);
  await db.insert(noteShares).values({ note_id: source.id, shared_with_user_id: fixture.samId });
  const result = await publishNativeMentions(actor(), source, nativeContentHash(body));
  assert.equal(result.queued_count, 1);
  assert.equal((await publishNativeMentions(actor(), source, nativeContentHash(body))).queued_count, 0);
  const [delivery] = await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.org_id, fixture.orgId));
  await deliverNativeMention(fixture.orgId, delivery!.id);
  await deliverNativeMention(fixture.orgId, delivery!.id);
  assert.equal((await db.select().from(notifications).where(eq(notifications.id, delivery!.id))).length, 1);
  const [attention] = await db.select().from(attentionItems).where(eq(attentionItems.source_id, delivery!.id));
  assert.equal(attention!.event_count, 1);
  await db.delete(noteShares).where(eq(noteShares.note_id, source.id));
  const response = await appFor(fixture.samId).request('/notifications');
  const data = await response.json();
  assert.equal(data.unread_count, 0);
  assert.equal(data.notifications.length, 0);
  assert.equal((await appFor(fixture.samId).request('/notifications/' + delivery!.id + '/read', { method: 'PATCH' })).status, 404);
});

test('resolver fails closed for restricted, cross-tenant, deleted and watcher-only targets; names stay live', { skip: !enabled }, async () => {
  await db.insert(taskWatchers).values({ task_id: fixture.restrictedId, user_id: fixture.samId });
  const ctx = { orgId: fixture.orgId, userId: fixture.samId };
  const denied = await resolveNativeMentions(ctx, [nativeMentionRef('task', fixture.restrictedId),
    nativeMentionRef('wiki_page', fixture.privateWikiId), nativeMentionRef('person', fixture.outsiderId)]);
  assert(denied.every(item => item.state === 'unavailable' && item.label === undefined && item.href === undefined));
  await db.update(users).set({ name: 'Sam Updated' }).where(eq(users.id, fixture.samId));
  assert.equal((await resolveNativeMentions(actor(), [nativeMentionRef('person', fixture.samId)]))[0]!.label, 'Sam Updated');
  await db.update(wikiPages).set({ is_deleted: true }).where(eq(wikiPages.id, fixture.privateWikiId));
  assert.equal((await resolveNativeMentions(actor(), [nativeMentionRef('wiki_page', fixture.privateWikiId)]))[0]!.state, 'unavailable');
  const invalid = await appFor(fixture.ownerId).request('/mentions/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: { kind: 'note', id: fixture.noteId, org_id: fixture.otherOrgId }, content_hash: 'a'.repeat(64) }) });
  assert.equal(invalid.status, 400);
});

test('agent document mentions create two isolated passive feeds and never an execution channel event', { skip: !enabled }, async () => {
  const body = token('person', fixture.agentId) + ' ' + token('person', fixture.agent2Id);
  const source = { kind: 'task' as const, id: fixture.taskId };
  await db.update(tasks).set({ description: body }).where(eq(tasks.id, source.id));
  await handleNativeMentionReconciliation({ orgId: fixture.orgId, source }); // Autosave remains passive.
  const result = await publishNativeMentions(actor(), source, nativeContentHash(body));
  assert.equal(result.queued_count, 2);
  const deliveries = await db.select().from(nativeMentionDeliveries).where(and(eq(nativeMentionDeliveries.org_id, fixture.orgId),
    sql`${nativeMentionDeliveries.recipient_user_id} IN (${fixture.agentId}, ${fixture.agent2Id})`));
  for (const delivery of deliveries) await deliverNativeMention(fixture.orgId, delivery.id);
  const ctx = { org_id: fixture.orgId, employee_id: fixture.employeeId, employee_slug: 'bound', trust_level: 'conservative' as const,
    token_id: 'synthetic', scopes: ['read:workspace', 'read:tasks', 'write:workspace'] };
  const own = await boundMentionAttention(ctx);
  assert.equal(own.length, 1);
  assert.equal(own[0]!.user_id, fixture.agentId);
  assert.equal((await boundMentionAttention({ ...ctx, scopes: ['read:workspace'] })).length, 0);
  const second = await boundMentionAttention({ ...ctx, employee_id: fixture.employee2Id });
  assert.equal(second.length, 1);
  assert.equal((await mentionAttentionAcknowledge({ attention_id: second[0]!.id }, ctx)).isError, true);
  assert.equal((await mentionAttentionAcknowledge({ attention_id: own[0]!.id }, ctx)).isError, false);
  assert.equal((await boundMentionAttention(ctx)).length, 0);
  assert.equal((await db.select().from(agentChannelEvents).where(eq(agentChannelEvents.org_id, fixture.orgId))).length, 0);
  assert.equal(await loadNativeSource({ orgId: fixture.otherOrgId, userId: fixture.outsiderId }, source), null);
});
test('human send intent commits with content; direct and governed writes cannot infer intent from the content author', { skip: !enabled }, async () => {
  const body = token('person', fixture.samId);
  const before = (await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.org_id, fixture.orgId))).length;
  const [direct] = await db.insert(messages).values({ org_id: fixture.orgId, space_id: fixture.publicSpaceId, user_id: fixture.ownerId, content: body }).returning();
  await handleNativeMentionReconciliation({ orgId: fixture.orgId, source: { kind: 'message', id: direct!.id }, publishOnCreate: true });
  assert.equal((await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.org_id, fixture.orgId))).length, before);
  const rolledBackId = crypto.randomUUID();
  await assert.rejects(db.transaction(async tx => {
    await tx.insert(messages).values({ id: rolledBackId, org_id: fixture.orgId, space_id: fixture.publicSpaceId, user_id: fixture.ownerId, content: body });
    await enqueueNativeMentionPublication(tx, actor(), { kind: 'message', id: rolledBackId }, body);
    throw new Error('Rollback proof');
  }), /Rollback proof/);
  assert.equal((await db.select().from(messages).where(eq(messages.id, rolledBackId))).length, 0);
  assert.equal((await db.select().from(jobQueue).where(sql`${jobQueue.data}->'source'->>'id' = ${rolledBackId}`)).length, 0);
  const committed = await db.transaction(async tx => {
    const [row] = await tx.insert(messages).values({ org_id: fixture.orgId, space_id: fixture.publicSpaceId, user_id: fixture.ownerId, content: body }).returning();
    await enqueueNativeMentionPublication(tx, actor(), { kind: 'message', id: row!.id }, body);
    return row!;
  });
  const [job] = await db.select().from(jobQueue).where(and(eq(jobQueue.name, 'native-mention-publish'), sql`${jobQueue.data}->'source'->>'id' = ${committed.id}`));
  assert(job);
  assert.equal(job!.data.actorUserId, fixture.ownerId);
  await handleNativeMentionPublication(job!.data as Parameters<typeof handleNativeMentionPublication>[0]);
  assert.equal((await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.org_id, fixture.orgId))).length, before + 1);
  await assert.rejects(publishNativeMentions({ orgId: fixture.orgId, userId: fixture.agentId }, { kind: 'task', id: fixture.taskId },
    nativeContentHash(token('person', fixture.agentId))), /Human publication intent/);
});
test('unfinished removal and re-addition do not ping; separately published removal and re-addition do', { skip: !enabled }, async () => {
  const source = { kind: 'task' as const, id: fixture.taskId };
  const body = token('person', fixture.samId);
  await db.update(tasks).set({ description: body }).where(eq(tasks.id, source.id));
  assert.equal((await publishNativeMentions(actor(), source, nativeContentHash(body))).queued_count, 1);
  await db.update(tasks).set({ description: 'draft removal' }).where(eq(tasks.id, source.id));
  await reconcileNativeMentions(fixture.orgId, source);
  await db.update(tasks).set({ description: body }).where(eq(tasks.id, source.id));
  assert.equal((await publishNativeMentions(actor(), source, nativeContentHash(body))).queued_count, 0);
  await db.update(tasks).set({ description: 'published removal' }).where(eq(tasks.id, source.id));
  assert.equal((await publishNativeMentions(actor(), source, nativeContentHash('published removal'))).queued_count, 0);
  await db.update(tasks).set({ description: body }).where(eq(tasks.id, source.id));
  assert.equal((await publishNativeMentions(actor(), source, nativeContentHash(body))).queued_count, 1);
});
test('deleted sources suppress pending delivery and malformed publication JSON returns a structured client error', { skip: !enabled }, async () => {
  const [message] = await db.insert(messages).values({ org_id: fixture.orgId, space_id: fixture.publicSpaceId, user_id: fixture.ownerId, content: token('person', fixture.samId) }).returning();
  await publishNativeMentions(actor(), { kind: 'message', id: message!.id }, nativeContentHash(message!.content));
  const [state] = await db.select().from(nativeReferenceStates).where(eq(nativeReferenceStates.source_id, message!.id));
  const [delivery] = await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.source_state_id, state!.id));
  await db.update(messages).set({ is_deleted: true }).where(eq(messages.id, message!.id));
  await deliverNativeMention(fixture.orgId, delivery!.id);
  const [suppressed] = await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.id, delivery!.id));
  assert.equal(suppressed!.status, 'suppressed');
  assert.equal((await db.select().from(notifications).where(eq(notifications.id, delivery!.id))).length, 0);
  const invalid = await appFor(fixture.ownerId).request('/mentions/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'VALIDATION_ERROR');
});

test('notification preferences and rollout pause preserve durable effects without delivery', { skip: !enabled }, async () => {
  const body = token('person', fixture.samId);
  const [message] = await db.insert(messages).values({ org_id: fixture.orgId, space_id: fixture.publicSpaceId, user_id: fixture.ownerId, content: body }).returning();
  const source = { kind: 'message' as const, id: message!.id };
  await publishNativeMentions(actor(), source, nativeContentHash(body));
  const [state] = await db.select().from(nativeReferenceStates).where(eq(nativeReferenceStates.source_id, source.id));
  const [delivery] = await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.source_state_id, state!.id));
  process.env.DEFT_NATIVE_MENTIONS_ENABLED = 'false';
  try {
    await assert.rejects(publishNativeMentions(actor(), source, nativeContentHash(body)), /disabled/);
    await assert.rejects(deliverNativeMention(fixture.orgId, delivery!.id), /paused/);
    assert.equal((await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.id, delivery!.id)))[0]!.status, 'pending');
  } finally { process.env.DEFT_NATIVE_MENTIONS_ENABLED = 'true'; }
  await db.update(users).set({ status_text: 'Do Not Disturb' }).where(eq(users.id, fixture.samId));
  try {
    await deliverNativeMention(fixture.orgId, delivery!.id);
    assert.equal((await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.id, delivery!.id)))[0]!.reason, 'do_not_disturb');
    assert.equal((await db.select().from(notifications).where(eq(notifications.id, delivery!.id))).length, 0);
  } finally { await db.update(users).set({ status_text: null }).where(eq(users.id, fixture.samId)); }
});

test('explicit note sharing validates the owner, active tenant recipient and payload before mention retry', { skip: !enabled }, async () => {
  const share = (userId: string, body: unknown) => appFor(userId).request('/notes/' + fixture.noteId + '/shares', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await share(fixture.ownerId, {})).status, 400);
  assert.equal((await share(fixture.ownerId, { user_id: fixture.outsiderId })).status, 404);
  assert.equal((await share(fixture.samId, { user_id: fixture.agentId })).status, 404);
  assert.equal((await share(fixture.ownerId, { user_id: fixture.samId, permission: 'admin' })).status, 400);
  assert.equal((await share(fixture.ownerId, { user_id: fixture.samId })).status, 201);
  const response = await appFor(fixture.ownerId).request('/notes/' + fixture.noteId + '/shares');
  const { shares } = await response.json();
  assert(shares.some((item: { user_id: string; permission: string }) => item.user_id === fixture.samId && item.permission === 'view'));
});

test('PostgreSQL concurrent publish and retry workers create exactly one durable attention effect', {
  skip: !enabled || process.env.DEFT_NATIVE_MENTION_CONCURRENCY_CERTIFY !== 'true',
}, async () => {
  const body = token('person', fixture.samId);
  const [message] = await db.insert(messages).values({ org_id: fixture.orgId, space_id: fixture.publicSpaceId, user_id: fixture.ownerId, content: body }).returning();
  const source = { kind: 'message' as const, id: message!.id };
  const publications = await Promise.all(Array.from({ length: 8 }, () => publishNativeMentions(actor(), source, nativeContentHash(body))));
  assert.equal(publications.reduce((sum, result) => sum + result.queued_count, 0), 1);
  const [state] = await db.select().from(nativeReferenceStates).where(eq(nativeReferenceStates.source_id, source.id));
  const deliveries = await db.select().from(nativeMentionDeliveries).where(eq(nativeMentionDeliveries.source_state_id, state!.id));
  assert.equal(deliveries.length, 1);
  await Promise.all(Array.from({ length: 8 }, () => deliverNativeMention(fixture.orgId, deliveries[0]!.id)));
  assert.equal((await db.select().from(notifications).where(eq(notifications.id, deliveries[0]!.id))).length, 1);
  const attention = await db.select().from(attentionItems).where(eq(attentionItems.source_id, deliveries[0]!.id));
  assert.equal(attention.length, 1);
  assert.equal(attention[0]!.event_count, 1);
});
