import { withoutUnverifiableReplyText } from './reply-notification-text.js';
import { and, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  agentActionApprovers,
  agentActions,
  attentionEvents,
  attentionItems,
  notifications,
  orgMembers,
  messages,
  projects,
  spaceMembers,
  spaces,
  tasks,
  users,
} from '@deft/db/schema';
import { db } from './db.js';
import { emitToUser } from '../socket.js';
import { isModuleGovernedWriteActionName } from './module-action-visibility.js';
import { scheduleAttentionDeliveries, scheduleAttentionDelivery } from './web-push.js';
import { nativeDeliveryAccessSql, nativeNotificationAccessSql } from './native-mention-visibility.js';
import { taskHiddenFromGuestSql } from './task-visibility.js';
import { publicSpaceVisibleSql } from './space-visibility.js';
import { visibleDocumentIdSql } from './document-access.js';
import { DOCUMENT_DRAFT_ACTION, DOCUMENT_DRAFT_ITEM_BODY, documentTextHiddenFrom, draftItemBodySql } from './document-draft-params.js';
import type { AnyNotificationType } from './notification-types.js';
import { actionReviewerCandidateSql, loadActionReviewers } from './agent-action-requester.js';
import {
  currentRoleReviewableActionSql, EVERY_REVIEW_GATE_ACTION, readReviewGateScope, type ReviewGateScope,
} from './agent-action-review-gate.js';

export type AttentionLane = 'needs_you' | 'updates';
export type AttentionPriority = 'critical' | 'high' | 'normal' | 'low';
export type AttentionState =
  | 'open_unseen'
  | 'open_seen'
  | 'acknowledged'
  | 'snoozed'
  | 'resolved'
  | 'expired'
  | 'superseded';

export type AttentionDraft = {
  orgId: string;
  userId: string;
  kind: string;
  lane: AttentionLane;
  priority: AttentionPriority;
  dedupeKey: string;
  /** One of `ATTENTION_SOURCE_TYPES`: a new type needs a decision about its access rule there. */
  sourceType: AttentionSourceType;
  sourceId: string;
  sourceEventId: string;
  title: string;
  body?: string | null;
  link?: string | null;
  metadata?: Record<string, unknown>;
  dueAt?: Date | null;
  urgentAt?: Date | null;
  occurredAt?: Date;
};

/**
 * Every `attention_items.source_type` the code writes (the column is free
 * text). A type with an entry in `SOURCE_TYPE_ACCESS` is shown only while its
 * source's own access rule passes; every other type is shown to the item's
 * owner on the legacy-notification check alone. A new source type goes here,
 * with a deliberate choice about whether it needs an access rule there:
 * `AttentionDraft.sourceType` will not compile without it, and
 * test/attention-visibility-narrowing-db.test.ts scans the API for
 * `sourceType` literals. A direct insert into the table bypasses both.
 */
export const ATTENTION_SOURCE_TYPES = [
  'agent', 'agent_action', 'agent_channel_event', 'app_integration_source', 'app_run', 'calendar',
  'cross_reference', 'document', 'message', 'native_mention', 'note', 'notification', 'space', 'task', 'wiki_page',
] as const;

export type AttentionSourceType = typeof ATTENTION_SOURCE_TYPES[number];

/** What `readAttentionWithSourceTypes` read: the rows' source types, and the scope of the approval items' actions. */
function isReadScope(scope: AttentionSourceScope): scope is AttentionReadScope {
  return scope !== 'all' && !Array.isArray(scope);
}

/**
 * The review gate's scope for approval items: narrowed only by what a read
 * found on its snapshot (`AttentionReadScope.approvals`), never by source type
 * strings, which are stored free text. Otherwise the whole gate.
 */
function approvalGateScope(scope: AttentionSourceScope): ReviewGateScope {
  return isReadScope(scope) ? scope.approvals : EVERY_REVIEW_GATE_ACTION;
}

/** The access rule of each source type that has one, for reader `userId`. */
const SOURCE_TYPE_ACCESS: Partial<Record<AttentionSourceType, (userId: string, sourceTypes: AttentionSourceScope) => SQL>> = {
  // A guest sees a task item only while they may see the task (task-visibility.ts);
  // for an owner, admin or member, and for an id naming no task, always true.
  task: (userId) => sql`NOT ${taskHiddenFromGuestSql(userId, sql`${attentionItems.source_id}`, sql`${attentionItems.org_id}`)}`,
  // An agent's request for help on a task (cooperative.ts) names the task in its metadata.
  agent_channel_event: (userId) => sql`NOT ${taskHiddenFromGuestSql(userId, sql`${attentionItems.metadata}->>'task_id'`, sql`${attentionItems.org_id}`)}`,
  native_mention: (userId) => nativeDeliveryAccessSql(userId, sql`${attentionItems.source_id}`, sql`${attentionItems.org_id}`),
  // A document shared with the reader (F9): shown only while they can open it (lib/document-access.ts).
  document: (userId) => visibleDocumentIdSql(userId, sql`${attentionItems.org_id}`, sql`${attentionItems.source_id}`),
  message: (userId) => sql`EXISTS (
        SELECT 1
        FROM ${messages}
        INNER JOIN ${spaces} ON ${spaces.id} = ${messages.space_id}
        LEFT JOIN ${spaceMembers}
          ON ${spaceMembers.space_id} = ${spaces.id}
          AND ${spaceMembers.user_id} = ${userId}
        WHERE ${messages.id} = ${attentionItems.source_id}
          AND ${messages.org_id} = ${attentionItems.org_id}
          AND ${messages.is_deleted} = false
          AND ((${spaces.is_archived} = false AND ${publicSpaceVisibleSql(spaces.type, spaces.org_id, userId)}) OR ${spaceMembers.id} IS NOT NULL)
      )`,
  space: (userId) => sql`EXISTS (
        SELECT 1
        FROM ${spaces}
        LEFT JOIN ${spaceMembers}
          ON ${spaceMembers.space_id} = ${spaces.id}
          AND ${spaceMembers.user_id} = ${userId}
        WHERE ${spaces.id} = ${attentionItems.source_id}
          AND ${spaces.org_id} = ${attentionItems.org_id}
          AND ((${spaces.is_archived} = false AND ${publicSpaceVisibleSql(spaces.type, spaces.org_id, userId)}) OR ${spaceMembers.id} IS NOT NULL)
      )`,
  // The gate as the value of a lookup by primary key, not inside EXISTS:
  // PostgreSQL plans an EXISTS here twice (per row, and hashed over every
  // action), which doubled the review gate's planning memory.
  agent_action: (userId, sourceTypes) => sql`COALESCE((
        SELECT ${currentRoleReviewableActionSql(userId, approvalGateScope(sourceTypes))}
        FROM ${agentActions}
        WHERE ${agentActions.id} = ${attentionItems.source_id}
          AND ${agentActions.org_id} = ${attentionItems.org_id}
      ), false)`,
};

/** The source types with an access rule of their own. */
export const ATTENTION_SOURCE_TYPES_WITH_ACCESS_RULE: readonly string[] = Object.keys(SOURCE_TYPE_ACCESS);

/**
 * What `readAttentionWithSourceTypes` read on its snapshot: the source types
 * of the rows, and the review gate's scope for the actions of the approval
 * items among them (`ReviewGateScope`), kept apart from the types.
 */
export type AttentionReadScope = Readonly<{ types: readonly string[]; approvals: ReviewGateScope }>;

/**
 * Which rows a visibility condition must cover: `'all'`, the types of the
 * rows it will be evaluated on (`attentionSourceTypesOf`,
 * `writeAttentionWithSourceTypes`: the approval rule is the whole gate), or
 * what `readAttentionWithSourceTypes` read (the approval rule narrowed).
 */
export type AttentionSourceScope = 'all' | readonly string[] | AttentionReadScope;

/**
 * Whether `userId` may see an attention item (the Inbox's visibility rule).
 *
 * PostgreSQL plans every branch of the condition whatever the row, and a
 * backend keeps the memory planning took until its connection closes. Pass
 * the source types the rows can have so only their rules are planned (a
 * message item: a few MB; an approval item, the review gate, more; the whole
 * condition, the sum). A row whose type has a rule that was not
 * asked for is not visible (fail closed), so name every type the statement
 * can meet; on rows of the named types and of types with no rule the result
 * is exactly the `'all'` result. A read's scope (`AttentionReadScope`) narrows
 * the approval rule the same way, by the kinds of the items' actions. A task
 * item, an agent's help request naming a task, and a notice (legacy
 * notification) naming a task in its metadata or link, are hidden from a guest
 * who may not see that task (task-visibility.ts).
 */
export function visibleAttentionCondition(userId: string, sourceTypes: AttentionSourceScope) {
  const ruled = Object.keys(SOURCE_TYPE_ACCESS) as AttentionSourceType[];
  const types = isReadScope(sourceTypes) ? sourceTypes.types : sourceTypes;
  const planned = types === 'all' ? ruled : ruled.filter((type) => types.includes(type));
  return sql<boolean>`(
    (${attentionItems.metadata}->>'legacy_notification_id' IS NULL OR
      ${nativeNotificationAccessSql(userId, sql`${attentionItems.metadata}`, sql`${attentionItems.org_id}`, sql`${attentionItems.link}`)})
    AND (
    ${attentionItems.source_type} NOT IN (${sql.join(ruled.map((type) => sql.raw(`'${type}'`)), sql`, `)})
    ${sql.join(planned.map((type) => sql`OR (${attentionItems.source_type} = ${sql.raw(`'${type}'`)} AND ${SOURCE_TYPE_ACCESS[type]!(userId, sourceTypes)})`), sql` `)}
    )
  )`;
}

/** The distinct source types of `rows`, for `visibleAttentionCondition`. */
export function attentionSourceTypesOf(rows: ReadonlyArray<{ source_type: string }>): string[] {
  return [...new Set(rows.map((row) => row.source_type))];
}

export type AttentionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * For a read that cannot know its rows' types in advance (a list, a count, a
 * lookup by id): reads the source types of the items `where` selects and runs
 * `read` on the SAME snapshot (one REPEATABLE READ, read-only transaction),
 * so `visibleAttentionCondition(user, sourceTypes)` there answers exactly as
 * the whole rule would on that snapshot. `where` must select every row `read`
 * applies the condition to. Run every statement of `read` on `tx`.
 *
 * When approval items are among them it also reads the kinds of their actions
 * (`AttentionReadScope.approvals`), so the approval rule plans only the
 * checks those actions need (release 152).
 */
export async function readAttentionWithSourceTypes<T>(
  where: SQL | undefined,
  read: (tx: AttentionTx, sourceTypes: AttentionReadScope) => Promise<T>,
): Promise<T> {
  if (!where) throw new Error('readAttentionWithSourceTypes needs a filter');
  return db.transaction(async (tx) => {
    const rows = await tx.selectDistinct({ source_type: attentionItems.source_type }).from(attentionItems).where(where);
    const types = rows.map((row) => row.source_type);
    const approvals = types.includes('agent_action')
      ? await readReviewGateScope(tx, sql`FROM ${attentionItems}
        JOIN ${agentActions} approval_action
          ON approval_action.id = ${attentionItems.source_id} AND approval_action.org_id = ${attentionItems.org_id}
        WHERE ${where} AND ${attentionItems.source_type} = 'agent_action'`, 'approval_action')
      : EVERY_REVIEW_GATE_ACTION;
    return read(tx, Object.freeze({ types, approvals }));
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/**
 * For a change gated on visibility: locks the items `where` selects (FOR NO
 * KEY UPDATE, as the update itself would, in id order: an insert that only
 * references an item, such as its events and deliveries, does not wait) and
 * runs `write` in the same transaction with their
 * source types and ids. `write` changes ONLY those locked ids (`lockedIds`),
 * so no item's type can change before `write` reads it, and the change never
 * waits on, or partly takes, an item that arrived or reopened after the lock:
 * such an item is left out of it whole, as if it had arrived a moment later.
 * `write` is not called when nothing was locked. A deadlock (another writer
 * locking the same items in another order) retries the whole transaction, at
 * most twice. Run every statement of `write` on `tx`.
 */
export async function writeAttentionWithSourceTypes<T>(
  where: SQL | undefined,
  write: (tx: AttentionTx, sourceTypes: string[], lockedIds: string[]) => Promise<T>,
  nothingLocked: T,
): Promise<T> {
  if (!where) throw new Error('writeAttentionWithSourceTypes needs a filter');
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const rows = await tx.select({ id: attentionItems.id, source_type: attentionItems.source_type }).from(attentionItems)
          .where(where).orderBy(attentionItems.id).for('no key update');
        if (rows.length === 0) return nothingLocked;
        return write(tx, attentionSourceTypesOf(rows), rows.map((row) => row.id));
      });
    } catch (error) {
      if (attempt >= 3 || !isDeadlock(error)) throw error;
    }
  }
}

/**
 * `attention_items.id` is one of `lockedIds`, bound as ONE array parameter:
 * a lock can hold more items than a statement may have parameters (65,535).
 */
export function lockedAttentionIdsSql(lockedIds: readonly string[]): SQL {
  return sql`${attentionItems.id} = ANY(${sql.param([...lockedIds])}::text[])`;
}

function isDeadlock(error: unknown): boolean {
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 4; depth += 1) {
    if ((current as { code?: unknown }).code === '40P01') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * An approval item is served to its owner while the owner may review the
 * action through the approve and reject routes (agent-action-review-gate.ts),
 * under the owner's current role. Every read, count, mutation, emission,
 * delivery and backfill of an approval item goes through it.
 */
export function currentApprovalRecipientSql(userId: string | SQL, scope = EVERY_REVIEW_GATE_ACTION): SQL {
  return currentRoleReviewableActionSql(userId, scope);
}

/**
 * Outbound attention item: approval items never carry action params, and a
 * reply notice that cannot be tied to its reply carries no reply text.
 */
export function projectAttentionItem<T extends { metadata: unknown }>(item: T): T {
  const safe = withoutUnverifiableReplyText(item);
  if (!safe.metadata || typeof safe.metadata !== 'object' || !Object.hasOwn(safe.metadata, 'params')) return safe;
  const { params: _params, ...metadata } = safe.metadata as Record<string, unknown>;
  return { ...safe, metadata };
}

type LegacyNotification = typeof notifications.$inferSelect;
type AgentAction = typeof agentActions.$inferSelect;

function objectMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function metadataString(metadata: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function notificationPriority(notification: LegacyNotification): AttentionPriority {
  const metadata = objectMetadata(notification.metadata);
  const explicit = metadataString(metadata, 'attention_priority', 'priority', 'urgency');
  if (explicit && ['critical', 'high', 'normal', 'low'].includes(explicit)) {
    return explicit as AttentionPriority;
  }
  if (notification.type === 'huddle_started') return 'critical';
  if (notification.type === 'blocked') return 'high';
  if (notification.type === 'reminder') return 'high';
  return 'normal';
}

function sourceFromLink(link: string | null): { messageId: string | null; spaceId: string | null } {
  if (!link) return { messageId: null, spaceId: null };
  try {
    const parsed = new URL(link, 'https://deft.local');
    const oldSpaceMatch = parsed.pathname.match(/^\/spaces\/([^/]+)$/);
    return {
      messageId: parsed.searchParams.get('message'),
      spaceId: parsed.searchParams.get('space') ?? (oldSpaceMatch?.[1] ? decodeURIComponent(oldSpaceMatch[1]) : null),
    };
  } catch {
    return { messageId: null, spaceId: null };
  }
}

export function notificationToAttentionDraft(notification: LegacyNotification): AttentionDraft {
  const metadata = objectMetadata(notification.metadata);
  const nativeDeliveryId = metadataString(metadata, 'native_mention_delivery_id');
  if (nativeDeliveryId) return {
    orgId: notification.org_id, userId: notification.user_id, kind: 'mention',
    lane: 'needs_you', priority: 'normal', dedupeKey: `native-mention:${nativeDeliveryId}`,
    sourceType: 'native_mention', sourceId: nativeDeliveryId,
    sourceEventId: `native-mention:${nativeDeliveryId}`, title: notification.title,
    body: notification.body, link: notification.link, metadata,
    occurredAt: notification.created_at,
  };
  const linkedSource = sourceFromLink(notification.link);
  const taskId = metadataString(metadata, 'task_id', 'taskId');
  const messageId = metadataString(metadata, 'message_id', 'messageId', 'source_message_id') ?? linkedSource.messageId;
  const eventId = metadataString(metadata, 'event_id', 'eventId', 'reminder_id');
  const wikiPageId = metadataString(metadata, 'page_id', 'wiki_page_id');
  const spaceId = metadataString(metadata, 'space_id', 'spaceId') ?? linkedSource.spaceId;
  const explicitDedupe = metadataString(metadata, 'attention_dedupe_key', 'dedupe_key');

  let lane: AttentionLane = 'updates';
  let kind = String(notification.type);
  let sourceType: AttentionSourceType = 'notification';
  let sourceId = notification.id;
  let dedupeKey = explicitDedupe ?? `notification:${notification.id}`;

  // Widened: `document_shared` exists only through upgrade SQL (lib/notification-types.ts).
  switch (notification.type as AnyNotificationType) {
    case 'mention':
      lane = 'needs_you';
      sourceType = 'message';
      sourceId = messageId ?? notification.id;
      dedupeKey = explicitDedupe ?? `mention:${sourceId}`;
      break;
    case 'message':
      lane = metadata.action_required === true || metadata.is_direct_message !== false ? 'needs_you' : 'updates';
      sourceType = 'message';
      sourceId = messageId ?? notification.id;
      dedupeKey = explicitDedupe ?? `message:${sourceId}`;
      break;
    case 'task_assigned':
      lane = 'needs_you';
      sourceType = 'task';
      sourceId = taskId ?? notification.id;
      dedupeKey = explicitDedupe ?? `task-assigned:${sourceId}`;
      break;
    case 'task_updated':
    case 'task':
      lane = 'updates';
      sourceType = 'task';
      sourceId = taskId ?? notification.id;
      dedupeKey = explicitDedupe ?? `task-update:${sourceId}`;
      break;
    case 'blocked':
      lane = 'needs_you';
      sourceType = 'task';
      sourceId = taskId ?? notification.id;
      dedupeKey = explicitDedupe ?? `task-blocked:${sourceId}`;
      break;
    case 'agent_suggestion': {
      const nudge = metadataString(metadata, 'nudge_type') ?? 'suggestion';
      lane = ['overdue', 'blocked', 'stalled'].includes(nudge) ? 'needs_you' : 'updates';
      sourceType = taskId ? 'task' : 'agent';
      sourceId = taskId ?? notification.id;
      dedupeKey = explicitDedupe ?? `agent-suggestion:${nudge}:${sourceId}`;
      break;
    }
    case 'reminder':
      lane = 'needs_you';
      sourceType = 'calendar';
      sourceId = eventId ?? notification.id;
      dedupeKey = explicitDedupe ?? `reminder:${sourceId}`;
      break;
    case 'huddle_started':
      lane = 'needs_you';
      sourceType = 'space';
      sourceId = spaceId ?? notification.id;
      dedupeKey = explicitDedupe ?? `huddle:${sourceId}`;
      break;
    case 'cross_reference':
      sourceType = taskId ? 'task' : 'cross_reference';
      sourceId = taskId ?? notification.id;
      dedupeKey = explicitDedupe ?? `cross-reference:${sourceId}`;
      break;
    case 'wiki_update':
      sourceType = 'wiki_page';
      sourceId = wikiPageId ?? notification.id;
      dedupeKey = explicitDedupe ?? `wiki-update:${sourceId}`;
      break;
    case 'system':
      lane = metadata.action_required === true ? 'needs_you' : 'updates';
      break;
    case 'document_shared': {
      // A document shared with the reader (F9) is a document item, shown only
      // while they can open it. A drive shared with them (F4, F6: drive_id and
      // no document) stays a notification item, under the notification rule.
      const documentId = metadataString(metadata, 'document_id');
      if (documentId) {
        sourceType = 'document';
        sourceId = documentId;
        dedupeKey = explicitDedupe ?? `document_shared:${documentId}:${notification.user_id}`;
      }
      break;
    }
  }

  return {
    orgId: notification.org_id,
    userId: notification.user_id,
    kind,
    lane,
    priority: notificationPriority(notification),
    dedupeKey,
    sourceType,
    sourceId,
    sourceEventId: `notification:${notification.id}`,
    title: notification.title,
    body: notification.body,
    link: notification.link,
    metadata: { ...metadata, legacy_notification_id: notification.id },
    occurredAt: notification.created_at,
  };
}

function approvalActionLabel(action: AgentAction, userId: string): string {
  if (isModuleGovernedWriteActionName(action.action)) return action.action.replaceAll('_', ' ');
  // M7 fix round 2 (I3): a document draft's item never carries its title.
  if (action.action === DOCUMENT_DRAFT_ACTION) return DOCUMENT_DRAFT_ITEM_BODY;
  // M7 fix round 4: a note or canvas draft's title or text only on the item of
  // the person who asked; a fallback reviewer's item names nothing.
  if (documentTextHiddenFrom(action, userId)) return DOCUMENT_DRAFT_ITEM_BODY;
  const params = objectMetadata(action.params);
  return metadataString(params, 'summary', 'title', 'task_title', 'page_title', 'content')
    ?? action.action.replaceAll('_', ' ');
}

export function approvalToAttentionDraft(action: AgentAction, userId: string): AttentionDraft {
  const params = objectMetadata(action.params);
  const sourceSpaceId = metadataString(params, 'source_space_id', 'origin_space_id', 'space_id')
    ?? action.conversation_id;
  const sourceMessageId = metadataString(params, 'source_message_id') ?? action.message_id;
  const destructive = /(?:delete|remove|revoke|archive)/i.test(action.action)
    || ['delete', 'remove', 'revoke'].includes(metadataString(params, 'mode') ?? '');
  const link = sourceSpaceId
    ? `/chat?space=${encodeURIComponent(sourceSpaceId)}${sourceMessageId ? `&message=${encodeURIComponent(sourceMessageId)}` : ''}`
    : `/inbox?lane=needs_you&action=${encodeURIComponent(action.id)}`;
  return {
    orgId: action.org_id,
    userId,
    kind: 'approval',
    lane: 'needs_you',
    priority: destructive || action.approval_tier === 'full' ? 'high' : 'normal',
    dedupeKey: `approval:${action.id}`,
    sourceType: 'agent_action',
    sourceId: action.id,
    sourceEventId: `approval-requested:${action.id}`,
    title: `Review ${action.action.replaceAll('_', ' ')}`,
    body: approvalActionLabel(action, userId),
    link,
    metadata: {
      action_id: action.id,
      action: action.action,
      approval_tier: action.approval_tier,
      agent_employee_id: action.agent_employee_id,
      source: action.source,
    },
    occurredAt: action.created_at,
  };
}

/** Emit only to an owner who may still open the item; never with action params. */
async function emitAttention(event: 'attention:new' | 'attention:updated', item: typeof attentionItems.$inferSelect) {
  try {
    const current = await loadVisibleAttentionSnapshot(item);
    if (!current) return;
    emitToUser(current.org_id, current.user_id, event, projectAttentionItem(current));
  } catch (error) {
    console.warn('[attention] realtime delivery skipped:');
  }
}

export async function upsertAttentionItem(
  draft: AttentionDraft,
  options: { deliver?: boolean; executor?: Pick<typeof db, 'select' | 'insert'>;
    afterCommit?: (effect: () => Promise<void>) => void } = {},
): Promise<typeof attentionItems.$inferSelect | null> {
  const executor = options.executor ?? db;
  const [existingEvent] = await executor
    .select({ attention_item_id: attentionEvents.attention_item_id })
    .from(attentionEvents)
    .where(and(
      eq(attentionEvents.org_id, draft.orgId),
      eq(attentionEvents.user_id, draft.userId),
      eq(attentionEvents.source_event_id, draft.sourceEventId),
      eq(attentionEvents.event_type, 'source_event'),
    ))
    .limit(1);
  if (existingEvent) {
    const [existingItem] = await executor
      .select()
      .from(attentionItems)
      .where(eq(attentionItems.id, existingEvent.attention_item_id))
      .limit(1);
    return existingItem ?? null;
  }

  const now = draft.occurredAt ?? new Date();
  const [item] = await executor
    .insert(attentionItems)
    .values({
      org_id: draft.orgId,
      user_id: draft.userId,
      kind: draft.kind,
      lane: draft.lane,
      priority: draft.priority,
      state: 'open_unseen',
      dedupe_key: draft.dedupeKey,
      source_type: draft.sourceType,
      source_id: draft.sourceId,
      source_event_id: draft.sourceEventId,
      title: draft.title,
      body: draft.body ?? null,
      link: draft.link ?? null,
      metadata: draft.metadata ?? {},
      due_at: draft.dueAt ?? null,
      urgent_at: draft.urgentAt ?? null,
      last_event_at: now,
    })
    .onConflictDoUpdate({
      target: [attentionItems.org_id, attentionItems.user_id, attentionItems.dedupe_key],
      set: {
        kind: draft.kind,
        lane: draft.lane,
        priority: draft.priority,
        state: 'open_unseen',
        source_type: draft.sourceType,
        source_id: draft.sourceId,
        source_event_id: draft.sourceEventId,
        title: draft.title,
        body: draft.body ?? null,
        link: draft.link ?? null,
        metadata: draft.metadata ?? {},
        due_at: draft.dueAt ?? null,
        urgent_at: draft.urgentAt ?? null,
        last_event_at: now,
        event_count: sql`${attentionItems.event_count} + 1`,
        version: sql`${attentionItems.version} + 1`,
        seen_at: null,
        acknowledged_at: null,
        snoozed_until: null,
        resolved_at: null,
        resolution: null,
        updated_at: new Date(),
      },
    })
    .returning();
  if (!item) return null;

  await executor
    .insert(attentionEvents)
    .values({
      org_id: draft.orgId,
      attention_item_id: item.id,
      user_id: draft.userId,
      event_type: 'source_event',
      source_event_id: draft.sourceEventId,
      payload: { source_type: draft.sourceType, source_id: draft.sourceId },
    })
    .onConflictDoNothing();

  const deliver = async () => {
    await emitAttention(item.event_count > 1 ? 'attention:updated' : 'attention:new', item);
    if (options.deliver !== false) {
      try {
        await scheduleAttentionDelivery(item);
      } catch (error) {
        console.warn('[attention] push scheduling failed:');
      }
    }
  };
  if (options.afterCommit) options.afterCommit(deliver); else await deliver();
  return item;
}

export async function syncNotificationToAttention(
  notification: LegacyNotification,
  options?: { deliver?: boolean },
) {
  const draft = notificationToAttentionDraft(notification);
  if (draft.sourceType === 'task' && draft.sourceId === notification.id && notification.link) {
    try {
      const parsed = new URL(notification.link, 'https://deft.local');
      const identifier = parsed.searchParams.get('task');
      const match = identifier?.match(/^([A-Z][A-Z0-9]+)-(\d+)$/);
      if (match) {
        const [task] = await db
          .select({ id: tasks.id })
          .from(tasks)
          .innerJoin(projects, eq(tasks.project_id, projects.id))
          .where(and(
            eq(tasks.org_id, notification.org_id),
            eq(projects.prefix, match[1]!),
            eq(tasks.number, Number(match[2])),
          ))
          .limit(1);
        if (task) {
          draft.sourceId = task.id;
          draft.dedupeKey = `${notification.type === 'task_assigned' ? 'task-assigned' : 'task-update'}:${task.id}`;
        }
      }
    } catch {
      // Legacy links without a parseable task target remain notification-backed.
    }
  }
  const [existingEvent] = await db.select({ itemId: attentionEvents.attention_item_id }).from(attentionEvents)
    .where(and(eq(attentionEvents.org_id, draft.orgId), eq(attentionEvents.user_id, draft.userId),
      eq(attentionEvents.source_event_id, draft.sourceEventId), eq(attentionEvents.event_type, 'source_event'))).limit(1);
  const effects: Array<() => Promise<void>> = [];
  const item = existingEvent
    ? await upsertAttentionItem(draft, { deliver: false })
    : await db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, draft.userId)).for('no key update');
      return upsertAttentionItem(draft, { deliver: false, executor: tx, afterCommit: (effect) => effects.push(effect) });
    });
  for (const effect of effects) await effect();
  if (options?.deliver !== false && item) await scheduleVisibleNotificationItems([item]);
  return item;
}

function draftIdentity(draft: AttentionDraft) {
  return `${draft.orgId}\u0000${draft.userId}\u0000${draft.dedupeKey}`;
}

/**
 * Project freshly inserted notifications into attention with a bounded number
 * of queries. The single-item path remains the fallback for callers that need
 * legacy link resolution or isolated retries.
 */
export async function syncNotificationsToAttention(
  sourceNotifications: LegacyNotification[],
  options: { deliver?: boolean } = {},
) {
  if (sourceNotifications.length === 0) return [];
  const drafts = sourceNotifications.map(notificationToAttentionDraft);
  const sourceEventIds = drafts.map((draft) => draft.sourceEventId);

  const { projected, items } = await db.transaction(async (tx) => {
    // Serialize projection for a recipient with the single-item back-fill path.
    await tx.select({ id: users.id }).from(users)
      .where(inArray(users.id, drafts.map((draft) => draft.userId))).orderBy(users.id).for('no key update');
    const existingEvents = await tx
      .select({ source_event_id: attentionEvents.source_event_id, attention_item_id: attentionEvents.attention_item_id })
      .from(attentionEvents)
      .where(and(
        inArray(attentionEvents.org_id, drafts.map((draft) => draft.orgId)),
        inArray(attentionEvents.user_id, drafts.map((draft) => draft.userId)),
        inArray(attentionEvents.source_event_id, sourceEventIds),
        eq(attentionEvents.event_type, 'source_event'),
      ));
    const alreadyProjected = new Set(existingEvents.map((event) => event.source_event_id));
    const pendingDrafts = drafts.filter((draft) => !alreadyProjected.has(draft.sourceEventId));
    const existingItems = existingEvents.length ? await tx.select().from(attentionItems)
      .where(and(inArray(attentionItems.org_id, drafts.map((draft) => draft.orgId)),
        inArray(attentionItems.id, existingEvents.map((event) => event.attention_item_id)))) : [];
    if (pendingDrafts.length === 0) return { projected: [], items: existingItems };

    const grouped = new Map<string, { draft: AttentionDraft; eventCount: number }>();
    for (const draft of pendingDrafts) {
      const key = draftIdentity(draft);
      const existing = grouped.get(key);
      grouped.set(key, { draft, eventCount: (existing?.eventCount ?? 0) + 1 });
    }

    const projected = await tx
      .insert(attentionItems)
      .values(Array.from(grouped.values()).map(({ draft, eventCount }) => ({
        org_id: draft.orgId,
        user_id: draft.userId,
        kind: draft.kind,
        lane: draft.lane,
        priority: draft.priority,
        state: 'open_unseen',
        dedupe_key: draft.dedupeKey,
        source_type: draft.sourceType,
        source_id: draft.sourceId,
        source_event_id: draft.sourceEventId,
        title: draft.title,
        body: draft.body ?? null,
        link: draft.link ?? null,
        metadata: draft.metadata ?? {},
        due_at: draft.dueAt ?? null,
        urgent_at: draft.urgentAt ?? null,
        last_event_at: draft.occurredAt ?? new Date(),
        event_count: eventCount,
      })))
      .onConflictDoUpdate({
        target: [attentionItems.org_id, attentionItems.user_id, attentionItems.dedupe_key],
        set: {
          kind: sql`excluded.kind`,
          lane: sql`excluded.lane`,
          priority: sql`excluded.priority`,
          state: 'open_unseen',
          source_type: sql`excluded.source_type`,
          source_id: sql`excluded.source_id`,
          source_event_id: sql`excluded.source_event_id`,
          title: sql`excluded.title`,
          body: sql`excluded.body`,
          link: sql`excluded.link`,
          metadata: sql`excluded.metadata`,
          due_at: sql`excluded.due_at`,
          urgent_at: sql`excluded.urgent_at`,
          last_event_at: sql`excluded.last_event_at`,
          event_count: sql`${attentionItems.event_count} + excluded.event_count`,
          version: sql`${attentionItems.version} + 1`,
          seen_at: null,
          acknowledged_at: null,
          snoozed_until: null,
          resolved_at: null,
          resolution: null,
          updated_at: new Date(),
        },
      })
      .returning();
    const itemByIdentity = new Map(projected.map((item) => [
      `${item.org_id}\u0000${item.user_id}\u0000${item.dedupe_key}`,
      item,
    ]));

    await tx
      .insert(attentionEvents)
      .values(pendingDrafts.map((draft) => ({
        org_id: draft.orgId,
        attention_item_id: itemByIdentity.get(draftIdentity(draft))!.id,
        user_id: draft.userId,
        event_type: 'source_event',
        source_event_id: draft.sourceEventId,
        payload: { source_type: draft.sourceType, source_id: draft.sourceId },
      })))
      .onConflictDoNothing();

    const projectedIds = new Set(projected.map((item) => item.id));
    return { projected, items: [...projected, ...existingItems.filter((item) => !projectedIds.has(item.id))] };
  });

  const visible = await filterVisibleAttentionItemsForDelivery(items).catch((error) => {
    console.warn('[attention] visibility check failed:');
    return [];
  });
  const projectedIds = new Set(projected.map((item) => item.id));
  for (const item of visible) {
    if (projectedIds.has(item.id)) {
      emitToUser(item.org_id, item.user_id, item.event_count > 1 ? 'attention:updated' : 'attention:new', projectAttentionItem(item));
    }
  }
  if (options.deliver !== false) {
    await scheduleAttentionDeliveries(visible).catch((error) => {
      console.warn('[attention] push scheduling failed:');
      return [];
    });
  }
  return projected;
}

async function scheduleVisibleNotificationItems(items: Array<typeof attentionItems.$inferSelect>) {
  await filterVisibleAttentionItemsForDelivery(items).then(scheduleAttentionDeliveries).catch((error) => {
    console.warn('[attention] push scheduling failed:');
  });
}

async function filterVisibleAttentionItemsForDelivery(items: Array<typeof attentionItems.$inferSelect>) {
  const groups = new Map<string, Array<typeof attentionItems.$inferSelect>>();
  for (const item of items) {
    const key = `${item.org_id}:${item.user_id}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const visible: Array<typeof attentionItems.$inferSelect> = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const versions = new Map(group.map((item) => [item.id, item.version]));
    const rows = await db.select().from(attentionItems).where(and(
      eq(attentionItems.org_id, first.org_id), eq(attentionItems.user_id, first.user_id),
      inArray(attentionItems.id, group.map((item) => item.id)), visibleAttentionCondition(first.user_id, attentionSourceTypesOf(group)),
    ));
    visible.push(...rows.filter((item) => versions.get(item.id) === item.version));
  }
  return visible;
}

export async function filterVisibleAttentionItems<T extends typeof attentionItems.$inferSelect>(
  userId: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return [];
  // The rows' types and approval kinds read on the snapshot the check runs on,
  // so it plans only their rules (readAttentionWithSourceTypes).
  const theseRows = and(inArray(attentionItems.id, rows.map((item) => item.id)), eq(attentionItems.user_id, userId));
  const readVisible = () => readAttentionWithSourceTypes(theseRows, (tx, sourceTypes) => tx.select().from(attentionItems)
    .where(and(theseRows, visibleAttentionCondition(userId, sourceTypes))));
  const visible = await readVisible();
  const allowed = new Set(visible.map((item) => item.id));
  const hidden = rows.filter((item) => !allowed.has(item.id));
  // Keep existing approvals held back while their reviewer lacks authority;
  // missing sources are resolved, as are inaccessible message/notification sources.
  const actionIds = hidden.filter((item) => item.source_type === 'agent_action').map((item) => item.source_id);
  const knownActions = actionIds.length ? await db.select({ id: agentActions.id }).from(agentActions)
    .where(inArray(agentActions.id, actionIds)) : [];
  const existingActions = new Set(knownActions.map((item) => item.id));
  const inaccessible = hidden.filter((item) => item.source_type !== 'agent_action' || !existingActions.has(item.source_id));
  for (const item of inaccessible) {
    await transitionAttentionItem({
      orgId: item.org_id,
      userId: item.user_id,
      itemId: item.id,
      state: 'resolved',
      resolution: 'source_access_removed',
      actorUserId: userId,
      expectedVersion: item.version,
    });
  }
  const finalRows = hidden.length ? await readVisible() : visible;
  const currentById = new Map(finalRows.map((item) => [item.id, item]));
  // A thread can reuse its id for a newer reply while this read is in flight.
  // Drop stale snapshots without resolving the newly visible replacement.
  return rows.flatMap((item) => {
    const current = currentById.get(item.id);
    return current?.version === item.version ? [{ ...item, ...current }] : [];
  });
}

async function loadVisibleAttentionSnapshot(item: { id: string; org_id: string; user_id: string; version: number; source_type: string }) {
  const [row] = await db.select().from(attentionItems).where(and(
    eq(attentionItems.id, item.id), eq(attentionItems.org_id, item.org_id), eq(attentionItems.user_id, item.user_id),
    eq(attentionItems.version, item.version),
    visibleAttentionCondition(item.user_id, [item.source_type]),
  )).limit(1);
  return row;
}

/** Whether this version is still readable, including immediately before a push. */
export async function attentionItemStillVisible(item: { id: string; org_id: string; user_id: string; version: number; source_type: string }) {
  const row = await loadVisibleAttentionSnapshot(item);
  return Boolean(row);
}

let approvalSweepCursor = '';

/**
 * Resolves, in one bounded statement, open approval items whose owner can no
 * longer review the action, re-checking that inside the update.
 */
export async function resolveApprovalItemsWithoutReviewer(limit = 500) {
  const openStates: AttentionState[] = ['open_unseen', 'open_seen', 'acknowledged', 'snoozed'];
  const withoutReviewer = and(
    eq(attentionItems.source_type, 'agent_action'),
    inArray(attentionItems.state, openStates),
    sql`NOT EXISTS (SELECT 1 FROM ${agentActions} WHERE ${agentActions.id} = ${attentionItems.source_id}
      AND ${agentActions.org_id} = ${attentionItems.org_id}
      AND ${currentApprovalRecipientSql(sql`${attentionItems.user_id}`)})`,
  );
  const now = new Date();
  // Each pass checks the next `limit` open approval items by id, so the work
  // per pass is bounded and every item is reached across passes.
  const batch = db.select({ id: attentionItems.id }).from(attentionItems).where(and(
    eq(attentionItems.source_type, 'agent_action'),
    inArray(attentionItems.state, openStates),
    sql`${attentionItems.id} > ${approvalSweepCursor}`,
  )).orderBy(attentionItems.id).limit(limit);
  const scanned = await batch;
  approvalSweepCursor = scanned.length === limit ? scanned[scanned.length - 1]!.id : '';
  if (scanned.length === 0) return 0;
  const resolved = await db.update(attentionItems).set({
    state: 'resolved',
    seen_at: sql`COALESCE(${attentionItems.seen_at}, ${now})`,
    snoozed_until: null,
    resolved_at: now,
    resolution: 'source_access_removed',
    // M7 fix round 3 (I3): a document draft's item names nothing once its reviewer loses it, in this same statement.
    body: draftItemBodySql(),
    version: sql`${attentionItems.version} + 1`,
    updated_at: now,
  }).where(and(inArray(attentionItems.id, scanned.map((row) => row.id)), withoutReviewer))
    .returning({ id: attentionItems.id, org_id: attentionItems.org_id, user_id: attentionItems.user_id, version: attentionItems.version });
  if (resolved.length > 0) {
    await db.insert(attentionEvents).values(resolved.map((item) => ({
      org_id: item.org_id,
      attention_item_id: item.id,
      user_id: item.user_id,
      event_type: 'resolved',
      source_event_id: `transition:${item.id}:${item.version}:resolved:${now.getTime()}`,
      actor_user_id: item.user_id,
      payload: { resolution: 'source_access_removed', snoozed_until: null },
    })));
  }
  return resolved.length;
}

/**
 * The users who review a pending action, as approver assignments. Existing
 * assignments count when they name one of the action's reviewers; without
 * one, the reviewers are assigned.
 */
export async function ensureActionApprovers(action: AgentAction, knownReviewers?: string[]): Promise<string[]> {
  const reviewers = knownReviewers ?? (await loadActionReviewers([action])).get(action.id) ?? [];
  const explicit = (await db
    .select({
      user_id: agentActionApprovers.user_id,
      decision: agentActionApprovers.decision,
    })
    .from(agentActionApprovers)
    .where(and(
      eq(agentActionApprovers.org_id, action.org_id),
      eq(agentActionApprovers.action_id, action.id),
    ))).filter((row) => reviewers.includes(row.user_id));
  if (explicit.length === 0 && reviewers.length > 0) {
    await db.insert(agentActionApprovers).values(reviewers.map((userId) => ({
      org_id: action.org_id,
      action_id: action.id,
      user_id: userId,
    }))).onConflictDoNothing();
  }
  // Recipients are the candidates the review gate accepts: assignees who
  // still pass the room and source checks, or the reviewers when none do.
  const candidates = [...new Set([...reviewers, ...explicit.map((row) => row.user_id)])];
  if (candidates.length === 0) return [];
  const accepted = await db.selectDistinct({ user_id: orgMembers.user_id }).from(orgMembers).where(and(
    eq(orgMembers.org_id, action.org_id),
    inArray(orgMembers.user_id, candidates),
    sql`EXISTS (SELECT 1 FROM ${agentActions} WHERE ${agentActions.id} = ${action.id}
      AND ${agentActions.org_id} = ${action.org_id}
      AND ${currentApprovalRecipientSql(sql`${orgMembers.user_id}`)})`,
  ));
  return accepted.map((row) => row.user_id);
}

export async function recordActionApproverDecision(params: {
  orgId: string;
  actionId: string;
  userId: string;
  decision: 'approved' | 'rejected';
}) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(agentActionApprovers).values({
      org_id: params.orgId,
      action_id: params.actionId,
      user_id: params.userId,
      decision: params.decision,
      decided_at: now,
    }).onConflictDoUpdate({
      target: [agentActionApprovers.action_id, agentActionApprovers.user_id],
      set: {
        decision: params.decision,
        decided_at: now,
        updated_at: now,
      },
    });
    await tx
      .update(agentActionApprovers)
      .set({ decision: 'superseded', decided_at: now, updated_at: now })
      .where(and(
        eq(agentActionApprovers.org_id, params.orgId),
        eq(agentActionApprovers.action_id, params.actionId),
        eq(agentActionApprovers.decision, 'pending'),
        sql`${agentActionApprovers.user_id} <> ${params.userId}`,
      ));
  });
}

export async function syncApprovalToAttention(
  action: AgentAction,
  options?: { deliver?: boolean; reviewers?: string[] },
) {
  if (action.approval_status !== 'pending' || action.approval_tier === 'auto') return [];
  const userIds = await ensureActionApprovers(action, options?.reviewers);
  return Promise.all(userIds.map((userId) => upsertAttentionItem(approvalToAttentionDraft(action, userId), options)));
}

export async function ensureAttentionBackfillForUser(params: { orgId: string; userId: string; role: string }) {
  const legacyNotifications = await db
    .select()
    .from(notifications)
    .where(and(
      eq(notifications.org_id, params.orgId),
      eq(notifications.user_id, params.userId),
      eq(notifications.is_read, false),
    ))
    .orderBy(desc(notifications.created_at))
    .limit(250);
  for (const notification of legacyNotifications) {
    await syncNotificationToAttention(notification, { deliver: false });
  }

  // Approval items closed because the user lost access open again once the
  // user reviews the action again; items the user closed stay closed. The
  // review check runs only when the user has such an item for a pending action.
  const closedForAccess = and(
    eq(attentionItems.org_id, params.orgId),
    eq(attentionItems.user_id, params.userId),
    eq(attentionItems.source_type, 'agent_action'),
    eq(attentionItems.state, 'resolved'),
    eq(attentionItems.resolution, 'source_access_removed'),
  );
  const pendingSource = (reviewer: SQL) => sql`EXISTS (SELECT 1 FROM ${agentActions}
    WHERE ${agentActions.id} = ${attentionItems.source_id}
      AND ${agentActions.org_id} = ${attentionItems.org_id} AND ${agentActions.approval_status} = 'pending'
      AND ${reviewer})`;
  const [reopenable] = await db.select({ id: attentionItems.id }).from(attentionItems)
    .where(and(closedForAccess, pendingSource(sql`true`))).limit(1);
  if (reopenable) {
    const reopenedAt = new Date();
    await db.update(attentionItems).set({
      state: 'open_unseen', resolved_at: null, resolution: null,
      version: sql`${attentionItems.version} + 1`, updated_at: reopenedAt,
    }).where(and(closedForAccess, pendingSource(currentApprovalRecipientSql(params.userId))));
  }

  // Actions the user reviews now that have no item for the user yet, so the
  // window moves past approvals already raised. The review check runs only on
  // candidates (see actionReviewerCandidateSql), and not at all when there are none.
  const awaitingApproval = and(
    eq(agentActions.org_id, params.orgId),
    eq(agentActions.approval_status, 'pending'),
    inArray(agentActions.approval_tier, ['quick', 'full']),
  );
  const candidate = sql`(${actionReviewerCandidateSql(params.userId, params.orgId)}
    AND NOT EXISTS (SELECT 1 FROM ${attentionEvents} raised
      WHERE raised.org_id = ${agentActions.org_id} AND raised.user_id = ${params.userId}
        AND raised.event_type = 'source_event'
        AND raised.source_event_id = 'approval-requested:' || ${agentActions.id}))`;
  const [firstCandidate] = await db.select({ id: agentActions.id }).from(agentActions)
    .where(and(awaitingApproval, candidate)).limit(1);
  const pendingActions = !firstCandidate ? [] : await db
    .select()
    .from(agentActions)
    .where(and(
      awaitingApproval,
      // CASE fixes the order: the review check runs after the candidate test.
      sql`(CASE WHEN ${candidate} THEN ${currentApprovalRecipientSql(params.userId)} ELSE false END)`,
    ))
    .orderBy(desc(agentActions.created_at))
    .limit(100);
  const reviewers = await loadActionReviewers(pendingActions);
  for (const action of pendingActions) {
    await syncApprovalToAttention(action, { deliver: false, reviewers: reviewers.get(action.id) ?? [] });
  }
}

export async function transitionAttentionItem(params: {
  orgId: string;
  userId: string;
  itemId: string;
  state: AttentionState;
  resolution?: string | null;
  snoozedUntil?: Date | null;
  actorUserId?: string;
  /** A user acting on their own item: it changes only while they may still open it. */
  viewerId?: string;
  /** Background cleanup must not resolve a newer reply that reused this id. */
  expectedVersion?: number;
}) {
  const now = new Date();
  const allowedFrom: Record<AttentionState, AttentionState[]> = {
    open_unseen: ['snoozed'],
    open_seen: ['open_unseen'],
    acknowledged: ['open_unseen', 'open_seen'],
    snoozed: ['open_unseen', 'open_seen', 'acknowledged'],
    resolved: ['open_unseen', 'open_seen', 'acknowledged', 'snoozed'],
    expired: ['open_unseen', 'open_seen', 'acknowledged', 'snoozed'],
    superseded: ['open_unseen', 'open_seen', 'acknowledged', 'snoozed'],
  };
  const marksSeen = ['open_seen', 'acknowledged', 'snoozed', 'resolved', 'expired', 'superseded'].includes(params.state);
  const terminal = ['resolved', 'expired', 'superseded'].includes(params.state);
  const itemWhere = and(
    eq(attentionItems.id, params.itemId),
    eq(attentionItems.org_id, params.orgId),
    eq(attentionItems.user_id, params.userId),
  );
  // A user's change applies only while they may still open the item; the
  // item is locked first so its source type cannot change before the update
  // reads it (writeAttentionWithSourceTypes).
  const change = (executor: Pick<typeof db, 'update'>, viewerSourceTypes: AttentionSourceScope, lockedIds?: string[]) => executor
    .update(attentionItems)
    .set({
      state: params.state,
      seen_at: marksSeen ? sql`COALESCE(${attentionItems.seen_at}, ${now})` : undefined,
      acknowledged_at: params.state === 'acknowledged'
        ? sql`COALESCE(${attentionItems.acknowledged_at}, ${now})`
        : undefined,
      snoozed_until: params.state === 'snoozed' ? params.snoozedUntil ?? null : null,
      resolved_at: terminal ? now : null,
      resolution: terminal ? params.resolution ?? null : null,
      // M7 fix round 2 (I3): a document draft's approval item that settles names nothing, whenever it was made.
      body: terminal ? draftItemBodySql() : undefined,
      version: sql`${attentionItems.version} + 1`,
      updated_at: now,
    })
    .where(and(
      itemWhere,
      lockedIds ? lockedAttentionIdsSql(lockedIds) : undefined,
      inArray(attentionItems.state, allowedFrom[params.state]),
      params.viewerId ? visibleAttentionCondition(params.viewerId, viewerSourceTypes) : sql`true`,
      params.expectedVersion === undefined ? undefined : eq(attentionItems.version, params.expectedVersion),
    ))
    .returning();
  const [item] = params.viewerId
    ? await writeAttentionWithSourceTypes(itemWhere, (tx, sourceTypes, lockedIds) => change(tx, sourceTypes, lockedIds), [])
    : await change(db, 'all');
  if (!item) return null;
  await db.insert(attentionEvents).values({
    org_id: params.orgId,
    attention_item_id: item.id,
    user_id: params.userId,
    event_type: params.state,
    source_event_id: `transition:${item.id}:${item.version}:${params.state}:${now.getTime()}`,
    actor_user_id: params.actorUserId ?? params.userId,
    payload: { resolution: params.resolution ?? null, snoozed_until: params.snoozedUntil?.toISOString() ?? null },
  });
  await emitAttention('attention:updated', item);
  return params.viewerId ? (await loadVisibleAttentionSnapshot(item)) ?? null : item;
}

export async function recordAttentionFeedback(params: {
  orgId: string;
  userId: string;
  itemId: string;
  feedback: 'not_for_me' | 'not_urgent';
}) {
  if (params.feedback === 'not_for_me') {
    return transitionAttentionItem({
      orgId: params.orgId,
      userId: params.userId,
      itemId: params.itemId,
      state: 'resolved',
      resolution: 'not_for_me',
      actorUserId: params.userId,
      viewerId: params.userId,
    });
  }

  const itemWhere = and(
    eq(attentionItems.id, params.itemId),
    eq(attentionItems.org_id, params.orgId),
    eq(attentionItems.user_id, params.userId),
  );
  const now = new Date();
  // Locked first: the item's source type cannot change between the read and
  // the update (writeAttentionWithSourceTypes).
  const item = await writeAttentionWithSourceTypes(itemWhere, async (tx, sourceTypes, lockedIds) => {
    const [current] = await tx
      .select()
      .from(attentionItems)
      .where(and(
        itemWhere,
        lockedAttentionIdsSql(lockedIds),
        inArray(attentionItems.state, ['open_unseen', 'open_seen', 'acknowledged']),
        visibleAttentionCondition(params.userId, sourceTypes),
      ))
      .limit(1);
    if (!current) return null;
    const metadata = objectMetadata(current.metadata);
    const [updated] = await tx
      .update(attentionItems)
      .set({
        priority: current.priority === 'critical' ? 'high' : 'normal',
        metadata: {
          ...metadata,
          attention_feedback: 'not_urgent',
          attention_feedback_at: now.toISOString(),
        },
        version: sql`${attentionItems.version} + 1`,
        updated_at: now,
      })
      .where(and(eq(attentionItems.id, current.id), visibleAttentionCondition(params.userId, sourceTypes)))
      .returning();
    return updated ?? null;
  }, null);
  if (!item) return null;
  await db.insert(attentionEvents).values({
    org_id: params.orgId,
    attention_item_id: item.id,
    user_id: params.userId,
    event_type: 'feedback',
    source_event_id: `feedback:${item.id}:${item.version}:not_urgent`,
    actor_user_id: params.userId,
    payload: { feedback: 'not_urgent' },
  });
  await emitAttention('attention:updated', item);
  return (await loadVisibleAttentionSnapshot(item)) ?? null;
}

export async function resolveAttentionBySource(params: {
  orgId: string;
  sourceType: string;
  sourceId: string;
  resolution: string;
  actorUserId?: string;
  excludeKind?: string;
}) {
  const rows = await db
    .select()
    .from(attentionItems)
    .where(and(
      eq(attentionItems.org_id, params.orgId),
      eq(attentionItems.source_type, params.sourceType),
      eq(attentionItems.source_id, params.sourceId),
      ...(params.excludeKind ? [ne(attentionItems.kind, params.excludeKind)] : []),
      inArray(attentionItems.state, ['open_unseen', 'open_seen', 'acknowledged', 'snoozed']),
    ));
  return Promise.all(rows.map((item) => transitionAttentionItem({
    orgId: item.org_id,
    userId: item.user_id,
    itemId: item.id,
    state: 'resolved',
    resolution: params.resolution,
    actorUserId: params.actorUserId,
  })));
}
