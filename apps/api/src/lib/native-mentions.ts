import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  NativeMentionRefsSchema, NativeMentionSourceSchema, extractNativeMentions,
  nativeMentionKey, nativeMentionRef,
  NativeMentionLimitError,
  type NativeMentionRef, type NativeMentionSource,
} from '@deft/shared';
import { nativeReferenceStates, nativeMentionDeliveries, notifications, users, orgMembers, agentEmployees, attentionItems } from '@deft/db/schema';
import { db, withDbAdvisoryLock } from './db.js';
import { enqueue, QUEUE_NAMES, RetryLaterJobError } from './queues.js';
import { explainNotificationPolicy } from './notification-policy.js';
import { upsertAttentionItem } from './attention.js';
import { emitToUser } from '../socket.js';
import { nativeSourceAccessSql, nativeTaskAccessSql, nativeDeliveryAccessSql } from './native-mention-visibility.js';

export const nativeMentionsEnabled = () => process.env.DEFT_NATIVE_MENTIONS_ENABLED === 'true';
export type NativeMentionContext = { orgId: string; userId: string; employeeId?: string };
type Executor = Pick<typeof db, 'execute'>;
type NativeSourceRow = Record<string, unknown> & {
  id: string; content: string; label: string; owner_user_id: string | null;
  space_id: string | null; project_id: string | null; href: string;
};
export type NativeMentionProjection = {
  ref: NativeMentionRef; state: 'available' | 'unavailable'; label?: string;
  href?: string; group?: 'People' | 'Agents' | 'Tasks' | 'Wikis';
  avatar_url?: string | null; description?: string | null;
};
export class NativeMentionError extends Error {
  constructor(public code: string, message: string, public status: 400 | 403 | 404 | 409 = 400) { super(message); }
}
export const nativeContentHash = (content: string) => createHash('sha256').update(content).digest('hex');
const rows = <T extends Record<string, unknown>>(result: unknown): T[] =>
  ((result as { rows?: T[] }).rows ?? []) as T[];

async function activeActor(ctx: NativeMentionContext, executor: Executor = db) {
  return rows<{ role: string; kind: string; employee_id: string | null; allowed_space_ids: string[] | null; project_ids: string[] | null; runtime_kind: string | null }>(
    await executor.execute(sql`SELECT om.role, u.kind, ae.id AS employee_id, ae.space_ids AS allowed_space_ids, ae.project_ids, ae.runtime_kind
      FROM org_members om JOIN users u ON u.id = om.user_id
      LEFT JOIN agent_employees ae ON ae.user_id = u.id AND ae.org_id = om.org_id
        AND ae.is_active = true AND (ae.is_deleted = false OR ae.runtime_kind = 'defty_system')
      WHERE om.org_id = ${ctx.orgId} AND om.user_id = ${ctx.userId} AND om.is_active = true
      LIMIT 1`),
  )[0] ?? null;
}

async function employeeBoundary(ctx: NativeMentionContext, source: { project_id: string | null; space_id: string | null }, executor: Executor = db): Promise<boolean> {
  const actor = await activeActor(ctx, executor);
  if (!actor) return false;
  if (ctx.employeeId && actor.employee_id !== ctx.employeeId) return false;
  if (actor.kind !== 'agent') return !ctx.employeeId;
  if (!actor.employee_id) return false;
  if (source.project_id && actor.runtime_kind !== 'defty_system' && actor.project_ids?.length
    && !actor.project_ids.includes(source.project_id)) return false;
  return !source.space_id || !actor.allowed_space_ids?.length || actor.allowed_space_ids.includes(source.space_id);
}

export async function loadNativeSource(
  ctx: NativeMentionContext | { orgId: string }, source: NativeMentionSource,
  executor: Executor = db, lock = false,
): Promise<NativeSourceRow | null> {
  const src = NativeMentionSourceSchema.parse(source);
  let query;
  switch (src.kind) {
    case 'message':
      query = sql`SELECT m.id, m.content, 'Chat message' AS label, m.user_id AS owner_user_id,
        m.space_id, NULL::text AS project_id,
        '/chat?space=' || m.space_id || '&message=' || m.id
          || CASE WHEN m.parent_id IS NULL THEN '' ELSE '&thread=' || m.parent_id END AS href
        FROM messages m WHERE m.org_id = ${ctx.orgId} AND m.id = ${src.id} AND m.is_deleted = false
        ${lock ? sql`FOR UPDATE OF m` : sql``}`; break;
    case 'task':
      query = sql`SELECT t.id, coalesce(t.description, '') AS content, t.title AS label,
        t.created_by AS owner_user_id, NULL::text AS space_id, t.project_id,
        '/tasks?task=' || t.id || '&field=description' AS href
        FROM tasks t JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
        WHERE t.org_id = ${ctx.orgId} AND t.id = ${src.id} AND t.is_deleted = false AND p.is_deleted = false
        ${lock ? sql`FOR UPDATE OF t` : sql``}`; break;
    case 'task_comment':
      query = sql`SELECT tc.id, tc.content, t.title || ' · Comment' AS label,
        tc.user_id AS owner_user_id, NULL::text AS space_id, t.project_id,
        '/tasks?task=' || t.id || '&comment=' || tc.id AS href
        FROM task_comments tc JOIN tasks t ON t.id = tc.task_id AND t.org_id = tc.org_id
        JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
        WHERE tc.org_id = ${ctx.orgId} AND tc.id = ${src.id} AND tc.is_deleted = false
          AND t.is_deleted = false AND p.is_deleted = false
        ${lock ? sql`FOR UPDATE OF tc` : sql``}`; break;
    case 'wiki_page':
      query = sql`SELECT w.id, w.content, w.title AS label, w.user_id AS owner_user_id,
        w.space_id, NULL::text AS project_id, '/knowledge?slug=' || w.slug AS href
        FROM wiki_pages w WHERE w.org_id = ${ctx.orgId} AND w.id = ${src.id} AND w.is_deleted = false
        ${lock ? sql`FOR UPDATE OF w` : sql``}`; break;
  }
  const row = rows<NativeSourceRow>(await executor.execute(query))[0] ?? null;
  if (!row || !('userId' in ctx)) return row;
  const visible = rows(await executor.execute(sql`SELECT 1 WHERE
    ${nativeSourceAccessSql(ctx.userId, sql`${src.kind}`, sql`${src.id}`, sql`${ctx.orgId}`)}`));
  return visible.length && await employeeBoundary(ctx, row, executor) ? row : null;
}

async function reconcileWithin(executor: Parameters<Parameters<typeof db.transaction>[0]>[0], orgId: string, source: NativeMentionSource) {
  const current = await loadNativeSource({ orgId }, source, executor, true);
  if (!current) {
    await executor.update(nativeReferenceStates).set({ current_refs: [], is_deleted: true, updated_at: new Date() })
      .where(and(eq(nativeReferenceStates.org_id, orgId), eq(nativeReferenceStates.source_kind, source.kind), eq(nativeReferenceStates.source_id, source.id)));
    return null;
  }
  let refs: NativeMentionRef[];
  let quarantined = false;
  try { refs = extractNativeMentions(current.content); }
  catch (error) { if (!(error instanceof NativeMentionLimitError)) throw error; refs = []; quarantined = true; }
  const contentHash = nativeContentHash(current.content);
  const [state] = await executor.insert(nativeReferenceStates).values({
    org_id: orgId, source_kind: source.kind, source_id: source.id,
    content_hash: contentHash, current_refs: refs,
  }).onConflictDoUpdate({
    target: [nativeReferenceStates.org_id, nativeReferenceStates.source_kind, nativeReferenceStates.source_id],
    set: {
      current_refs: refs, content_hash: contentHash, is_deleted: false, updated_at: new Date(),
      revision: sql`CASE WHEN ${nativeReferenceStates.content_hash} = ${contentHash}
        THEN ${nativeReferenceStates.revision} ELSE ${nativeReferenceStates.revision} + 1 END`,
    },
  }).returning();
  return { state: state!, current, refs, quarantined };
}

export async function reconcileNativeMentions(orgId: string, source: NativeMentionSource) {
  NativeMentionSourceSchema.parse(source);
  return db.transaction(tx => reconcileWithin(tx, orgId, source));
}

export async function publishNativeMentions(ctx: NativeMentionContext, source: NativeMentionSource, expectedHash: string) {
  if (!nativeMentionsEnabled()) throw new NativeMentionError('NATIVE_MENTIONS_DISABLED', 'Native mention publication is disabled', 403);
  const actor = await activeActor(ctx);
  if (!actor) throw new NativeMentionError('NOT_FOUND', 'Source not found', 404);
  if (actor.kind !== 'human') throw new NativeMentionError('FORBIDDEN', 'Human publication intent is required', 403);
  return db.transaction(async tx => {
    const current = await loadNativeSource(ctx, source, tx, true);
    if (!current) throw new NativeMentionError('NOT_FOUND', 'Source not found', 404);
    if ((source.kind === 'message' || source.kind === 'task_comment')
      && current.owner_user_id !== ctx.userId) {
      throw new NativeMentionError('FORBIDDEN', 'Only the content author can publish mentions', 403);
    }
    if (actor.role === 'guest' && source.kind !== 'message') {
      throw new NativeMentionError('FORBIDDEN', 'Mention publication is not available for this source', 403);
    }
    if (nativeContentHash(current.content) !== expectedHash) {
      throw new NativeMentionError('NATIVE_MENTION_REVISION_CONFLICT', 'Content changed. Save or reload before notifying mentions.', 409);
    }
    try { extractNativeMentions(current.content); }
    catch (error) {
      if (error instanceof NativeMentionLimitError) throw new NativeMentionError('NATIVE_MENTION_LIMIT', error.message, 400);
      throw error;
    }
    const reconciled = await reconcileWithin(tx, ctx.orgId, source);
    if (!reconciled) throw new NativeMentionError('NOT_FOUND', 'Source not found', 404);
    const { state, refs } = reconciled;
    const currentIds = refs.filter(ref => ref.resource_type === 'person').map(ref => ref.resource_id).filter(id => id !== ctx.userId);
    const oldIds = state.published_person_ids;
    const additions = currentIds.filter(id => !oldIds.includes(id));
    const eligible: string[] = [];
    let blocked = 0;
    for (const id of additions) {
      if (await loadNativeSource({ orgId: ctx.orgId, userId: id }, source, tx)) eligible.push(id);
      else blocked++;
    }
    const publishedIds = currentIds.filter(id => oldIds.includes(id) || eligible.includes(id));
    const changed = eligible.length > 0 || oldIds.some(id => !currentIds.includes(id));
    if (!changed) return { source, content_hash: expectedHash, status: 'unchanged' as const, queued_count: 0, blocked_count: blocked };
    const publicationRevision = state.publication_revision + 1;
    await tx.update(nativeReferenceStates).set({
      published_person_ids: publishedIds, publication_revision: publicationRevision, updated_at: new Date(),
    }).where(and(eq(nativeReferenceStates.id, state.id), eq(nativeReferenceStates.org_id, ctx.orgId)));
    for (const recipient of eligible) {
      const [delivery] = await tx.insert(nativeMentionDeliveries).values({
        org_id: ctx.orgId, source_state_id: state.id, publication_revision: publicationRevision,
        recipient_user_id: recipient, actor_user_id: ctx.userId,
      }).onConflictDoNothing().returning();
      if (delivery) await enqueue(QUEUE_NAMES.AGENT_JOBS, 'native-mention-deliver',
        { orgId: ctx.orgId, deliveryId: delivery.id },
        { orgId: ctx.orgId, dedupeKey: `native-mention:${delivery.id}`, executor: tx, maxAttempts: 5 });
    }
    return { source, content_hash: expectedHash, status: 'queued' as const, queued_count: eligible.length, blocked_count: blocked };
  });
}

export async function handleNativeMentionReconciliation(data: { orgId: string; source: NativeMentionSource; publishOnCreate?: boolean }) {
  const parsed = NativeMentionSourceSchema.parse(data.source);
  await reconcileNativeMentions(data.orgId, parsed);
}

/** Called only at authenticated human Send/Post boundaries, in the content transaction. */
export async function enqueueNativeMentionPublication(
  executor: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ctx: NativeMentionContext, source: NativeMentionSource, content: string,
) {
  if (!nativeMentionsEnabled()) return;
  const actor = await activeActor(ctx, executor);
  if (actor?.kind !== 'human') return;
  const refs = extractNativeMentions(content);
  if (!refs.some(ref => ref.resource_type === 'person')) {
    const [state] = await executor.select({ published: nativeReferenceStates.published_person_ids }).from(nativeReferenceStates).where(and(
      eq(nativeReferenceStates.org_id, ctx.orgId), eq(nativeReferenceStates.source_kind, source.kind), eq(nativeReferenceStates.source_id, source.id),
    ));
    if (!state?.published.length) return;
  }
  const contentHash = nativeContentHash(content);
  await enqueue(QUEUE_NAMES.AGENT_JOBS, 'native-mention-publish',
    { orgId: ctx.orgId, actorUserId: ctx.userId, source, contentHash },
    { orgId: ctx.orgId, dedupeKey: `native-publish:${source.kind}:${source.id}:${contentHash}`, executor, maxAttempts: 5 });
}

export async function handleNativeMentionPublication(data: {
  orgId: string; actorUserId: string; source: NativeMentionSource; contentHash: string;
}) {
  if (!nativeMentionsEnabled()) throw new RetryLaterJobError('Native mention publication paused', 60_000);
  try { await publishNativeMentions({ orgId: data.orgId, userId: data.actorUserId }, data.source, data.contentHash); }
  catch (error) {
    // Removed/revoked sources and superseded explicit edits are terminal, never replayed against newer content.
    if (error instanceof NativeMentionError && ['NOT_FOUND', 'FORBIDDEN', 'NATIVE_MENTION_REVISION_CONFLICT'].includes(error.code)) return;
    throw error;
  }
}

export async function resolveNativeMentions(ctx: NativeMentionContext, refs: NativeMentionRef[]): Promise<NativeMentionProjection[]> {
  NativeMentionRefsSchema.parse(refs);
  if (!(await activeActor(ctx))) return refs.map(ref => ({ ref, state: 'unavailable' }));
  return Promise.all(refs.map(async ref => {
    let row: Record<string, unknown> | undefined;
    if (ref.resource_type === 'person') {
      row = rows(await db.execute(sql`SELECT u.name AS label, u.avatar_url, u.kind, u.title AS description
        FROM users u JOIN org_members om ON om.user_id = u.id
        LEFT JOIN agent_employees ae ON ae.user_id = u.id AND ae.org_id = om.org_id
        WHERE om.org_id = ${ctx.orgId} AND om.is_active = true AND u.id = ${ref.resource_id}
          AND (u.kind <> 'agent' OR (ae.is_active = true AND (ae.is_deleted = false OR ae.runtime_kind = 'defty_system'))) LIMIT 1`))[0];
    } else if (ref.resource_type === 'task') {
      row = rows(await db.execute(sql`SELECT p.prefix || '-' || t.number || ' · ' || t.title AS label,
        '/tasks?task=' || t.id AS href, t.project_id
        FROM tasks t JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
        WHERE t.org_id = ${ctx.orgId} AND t.id = ${ref.resource_id} AND t.is_deleted = false
          AND p.is_deleted = false AND ${nativeTaskAccessSql(ctx.userId)} LIMIT 1`))[0];
      if (row && !(await employeeBoundary(ctx, { project_id: row.project_id as string, space_id: null }))) row = undefined;
    } else {
      const source = await loadNativeSource(ctx, { kind: 'wiki_page', id: ref.resource_id });
      if (source) row = { label: source.label, href: source.href };
    }
    if (!row) return { ref, state: 'unavailable' as const };
    return {
      ref, state: 'available' as const, label: String(row.label),
      href: typeof row.href === 'string' ? row.href : undefined,
      group: ref.resource_type === 'task' ? 'Tasks' as const : ref.resource_type === 'wiki_page' ? 'Wikis' as const :
        row.kind === 'agent' ? 'Agents' as const : 'People' as const,
      avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
      description: typeof row.description === 'string' ? row.description : null,
    };
  }));
}

export async function searchNativeMentions(ctx: NativeMentionContext, query: string) {
  if (!(await activeActor(ctx))) return [];
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const people = rows<{ id: string }>(await db.execute(sql`SELECT id FROM (
    SELECT u.id, u.kind, u.name, row_number() OVER (PARTITION BY u.kind ORDER BY u.name, u.id) AS ordinal
    FROM users u JOIN org_members om ON om.user_id = u.id
    WHERE om.org_id = ${ctx.orgId} AND om.is_active = true AND u.name ILIKE ${pattern}
      AND u.kind IN ('human', 'agent')
      AND (u.kind = 'human' OR EXISTS (SELECT 1 FROM agent_employees ae
        WHERE ae.org_id = om.org_id AND ae.user_id = u.id AND ae.is_active = true
          AND (ae.is_deleted = false OR ae.runtime_kind = 'defty_system')))
    ) candidates WHERE ordinal <= 8 ORDER BY kind, name LIMIT 16`));
  const tasks = rows<{ id: string }>(await db.execute(sql`SELECT t.id FROM tasks t
    JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id
    WHERE t.org_id = ${ctx.orgId} AND t.is_deleted = false AND p.is_deleted = false
      AND ${nativeTaskAccessSql(ctx.userId)}
      AND (t.title ILIKE ${pattern} OR (p.prefix || '-' || t.number) ILIKE ${pattern})
    ORDER BY t.updated_at DESC LIMIT 8`));
  const wiki = rows<{ id: string }>(await db.execute(sql`SELECT w.id FROM wiki_pages w
    WHERE w.org_id = ${ctx.orgId} AND w.is_deleted = false AND w.title ILIKE ${pattern}
      AND ${nativeSourceAccessSql(ctx.userId, sql`'wiki_page'`, sql`w.id`, sql`w.org_id`)}
    ORDER BY w.updated_at DESC LIMIT 8`));
  return (await resolveNativeMentions(ctx, [
    ...people.map(row => nativeMentionRef('person', row.id)),
    ...tasks.map(row => nativeMentionRef('task', row.id)),
    ...wiki.map(row => nativeMentionRef('wiki_page', row.id)),
  ])).filter(item => item.state === 'available');
}

export async function nativeMentionBacklinks(ctx: NativeMentionContext, target: NativeMentionRef) {
  const [resolved] = await resolveNativeMentions(ctx, [target]);
  if (resolved?.state !== 'available') throw new NativeMentionError('NOT_FOUND', 'Reference not found', 404);
  const states = await db.select().from(nativeReferenceStates).where(and(
    eq(nativeReferenceStates.org_id, ctx.orgId), eq(nativeReferenceStates.is_deleted, false),
    nativeSourceAccessSql(ctx.userId, sql`${nativeReferenceStates.source_kind}`, sql`${nativeReferenceStates.source_id}`, sql`${nativeReferenceStates.org_id}`),
    sql`${nativeReferenceStates.current_refs} @> ${JSON.stringify([{ resource_type: target.resource_type, resource_id: target.resource_id }])}::jsonb`,
  )).orderBy(desc(nativeReferenceStates.updated_at)).limit(200);
  const backlinks: Array<{ source: NativeMentionSource; label: string; href: string }> = [];
  for (const state of states) {
    const source = NativeMentionSourceSchema.parse({ kind: state.source_kind, id: state.source_id });
    const current = await loadNativeSource(ctx, source);
    let references: NativeMentionRef[] = [];
    try { if (current) references = extractNativeMentions(current.content); } catch (error) { if (!(error instanceof NativeMentionLimitError)) throw error; }
    if (current && references.some(ref => nativeMentionKey(ref) === nativeMentionKey(target))) {
      backlinks.push({ source, label: current.label || 'Untitled', href: current.href });
    }
  }
  return { backlinks, count: backlinks.length, limited: backlinks.length === 200 };
}

export async function deliverNativeMention(orgId: string, deliveryId: string) {
  return withDbAdvisoryLock(`native-mention-deliver:${orgId}:${deliveryId}`, () => deliverNativeMentionLocked(orgId, deliveryId));
}
async function deliverNativeMentionLocked(orgId: string, deliveryId: string) {
  if (!nativeMentionsEnabled()) throw new RetryLaterJobError('Native mention publication paused', 60_000);
  const delivery = await db.transaction(async tx => {
    const [pending] = await tx.select().from(nativeMentionDeliveries).where(and(
      eq(nativeMentionDeliveries.id, deliveryId), eq(nativeMentionDeliveries.org_id, orgId),
    )).for('update');
    if (!pending || pending.status === 'suppressed') return null;
    const [state] = await tx.select().from(nativeReferenceStates).where(and(
      eq(nativeReferenceStates.id, pending.source_state_id), eq(nativeReferenceStates.org_id, orgId),
    ));
    const source = state && NativeMentionSourceSchema.parse({ kind: state.source_kind, id: state.source_id });
    const current = source && await loadNativeSource({ orgId, userId: pending.recipient_user_id }, source, tx, true);
    const author = await activeActor({ orgId, userId: pending.actor_user_id }, tx);
    const recipient = await activeActor({ orgId, userId: pending.recipient_user_id }, tx);
    let remainsMentioned = false;
    try { remainsMentioned = Boolean(current && extractNativeMentions(current.content).some(ref =>
      ref.resource_type === 'person' && ref.resource_id === pending.recipient_user_id)); }
    catch (error) { if (!(error instanceof NativeMentionLimitError)) throw error; }
    if (!state || !source || !current || !author || !recipient || !remainsMentioned) {
      await tx.update(nativeMentionDeliveries).set({ status: 'suppressed', reason: 'source_or_recipient_unavailable', updated_at: new Date() })
        .where(eq(nativeMentionDeliveries.id, deliveryId));
      return null;
    }
    const [actor] = await tx.select({ name: users.name }).from(users).where(eq(users.id, pending.actor_user_id));
    const title = `${actor?.name ?? 'Someone'} mentioned you in ${source.kind.replaceAll('_', ' ')}`;
    if (recipient.kind !== 'agent') {
      const decision = await explainNotificationPolicy({ user_id: pending.recipient_user_id, type: 'mention' }, {
        channel: source.kind === 'task' || source.kind === 'task_comment' ? 'tasks' : 'chat',
        spaceId: source.kind === 'message' ? current.space_id : null, isMention: true, respectDnd: true,
      }, tx);
      if (!decision.allowed) {
        await tx.update(nativeMentionDeliveries).set({ status: 'suppressed', reason: decision.reason, updated_at: new Date() }).where(eq(nativeMentionDeliveries.id, deliveryId));
        return null;
      }
    }
    return { pending, source, current, title, agent: recipient.kind === 'agent' };
  });
  if (!delivery) return;
  // Stable sourceEventId makes attention repair idempotent after an uncertain response.
  const attention = await upsertAttentionItem({
    orgId, userId: delivery.pending.recipient_user_id, kind: 'mention', lane: 'needs_you', priority: 'normal',
    dedupeKey: `native-mention:${deliveryId}`, sourceType: 'native_mention', sourceId: deliveryId,
    sourceEventId: `native-mention:${deliveryId}`, title: delivery.title, link: delivery.current.href,
    metadata: { native_mention_delivery_id: deliveryId, native_mention_source: delivery.source, passive: true },
  }, { deliver: !delivery.agent });
  // Publish the legacy notification after attention has its durable source event.
  // Its normal backfill can then observe the same event without racing a second projection.
  await db.transaction(async tx => {
    if (!delivery.agent) await tx.insert(notifications).values({
      id: deliveryId, org_id: orgId, user_id: delivery.pending.recipient_user_id,
      type: 'mention', title: delivery.title, body: null, link: delivery.current.href,
      metadata: { native_mention_delivery_id: deliveryId, native_mention_source: delivery.source },
    }).onConflictDoNothing();
    await tx.update(nativeMentionDeliveries).set({
      status: 'delivered', attention_id: attention?.id ?? null, updated_at: new Date(),
    }).where(and(eq(nativeMentionDeliveries.id, deliveryId), eq(nativeMentionDeliveries.org_id, orgId)));
  });
  if (!delivery.agent && delivery.pending.status !== 'delivered') {
    const [notification] = await db.select().from(notifications).where(eq(notifications.id, deliveryId));
    if (notification) emitToUser(delivery.pending.recipient_user_id, 'notification:new', notification);
  }
}

export async function listNativeMentionAttention(ctx: NativeMentionContext) {
  if (!(await activeActor(ctx))) return [];
  const items = await db.select().from(attentionItems).where(and(
    eq(attentionItems.org_id, ctx.orgId), eq(attentionItems.user_id, ctx.userId),
    eq(attentionItems.source_type, 'native_mention'),
    sql`${attentionItems.state} IN ('open_unseen', 'open_seen', 'acknowledged')`,
    nativeDeliveryAccessSql(ctx.userId, sql`${attentionItems.source_id}`, sql`${attentionItems.org_id}`),
  )).orderBy(desc(attentionItems.last_event_at)).limit(50);
  const visible = [];
  for (const item of items) {
    const metadata = item.metadata as Record<string, unknown>;
    const source = NativeMentionSourceSchema.safeParse(metadata.native_mention_source);
    if (source.success && await loadNativeSource(ctx, source.data)) visible.push(item);
  }
  return visible;
}
