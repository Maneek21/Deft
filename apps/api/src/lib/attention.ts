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
} from '@deft/db/schema';
import { db } from './db.js';
import { emitToUser } from '../socket.js';
import { isModuleGovernedWriteActionName } from './module-action-visibility.js';
import { scheduleAttentionDeliveries, scheduleAttentionDelivery } from './web-push.js';
import { nativeDeliveryAccessSql } from './native-mention-visibility.js';
import { actionRequesterIdSql, loadActionReviewers } from './agent-action-requester.js';
import { currentRoleReviewableActionSql } from './agent-action-review-gate.js';

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
  sourceType: string;
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

export function visibleAttentionCondition(userId: string) {
  return sql<boolean>`(
    ${attentionItems.source_type} NOT IN ('message', 'space', 'agent_action', 'native_mention')
    OR (${attentionItems.source_type} = 'native_mention'
      AND ${nativeDeliveryAccessSql(userId, sql`${attentionItems.source_id}`, sql`${attentionItems.org_id}`)})
    OR (
      ${attentionItems.source_type} = 'message'
      AND EXISTS (
        SELECT 1
        FROM ${messages}
        INNER JOIN ${spaces} ON ${spaces.id} = ${messages.space_id}
        LEFT JOIN ${spaceMembers}
          ON ${spaceMembers.space_id} = ${spaces.id}
          AND ${spaceMembers.user_id} = ${userId}
        WHERE ${messages.id} = ${attentionItems.source_id}
          AND ${messages.org_id} = ${attentionItems.org_id}
          AND ${messages.is_deleted} = false
          AND (${spaces.type} = 'public' OR ${spaceMembers.id} IS NOT NULL)
      )
    )
    OR (
      ${attentionItems.source_type} = 'space'
      AND EXISTS (
        SELECT 1
        FROM ${spaces}
        LEFT JOIN ${spaceMembers}
          ON ${spaceMembers.space_id} = ${spaces.id}
          AND ${spaceMembers.user_id} = ${userId}
        WHERE ${spaces.id} = ${attentionItems.source_id}
          AND ${spaces.org_id} = ${attentionItems.org_id}
          AND (${spaces.type} = 'public' OR ${spaceMembers.id} IS NOT NULL)
      )
    )
    OR (
      ${attentionItems.source_type} = 'agent_action'
      AND EXISTS (
        SELECT 1
        FROM ${agentActions}
        WHERE ${agentActions.id} = ${attentionItems.source_id}
          AND ${agentActions.org_id} = ${attentionItems.org_id}
          AND ${currentApprovalRecipientSql(userId)}
      )
    )
  )`;
}

/**
 * An approval item is served to its owner while the owner may review the
 * action through the approve and reject routes (agent-action-review-gate.ts),
 * under the owner's current role. Every read, count, mutation, emission,
 * delivery and backfill of an approval item goes through it.
 */
export function currentApprovalRecipientSql(userId: string | SQL): SQL {
  return currentRoleReviewableActionSql(userId);
}

/** Outbound attention item: approval items never carry action params. */
export function projectAttentionItem<T extends { metadata: unknown }>(item: T): T {
  if (!item.metadata || typeof item.metadata !== 'object' || !Object.hasOwn(item.metadata, 'params')) return item;
  const { params: _params, ...metadata } = item.metadata as Record<string, unknown>;
  return { ...item, metadata };
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
  let sourceType = 'notification';
  let sourceId = notification.id;
  let dedupeKey = explicitDedupe ?? `notification:${notification.id}`;

  switch (notification.type) {
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

function approvalActionLabel(action: AgentAction): string {
  if (isModuleGovernedWriteActionName(action.action)) return action.action.replaceAll('_', ' ');
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
    body: approvalActionLabel(action),
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
    if (item.source_type === 'agent_action') {
      const [visible] = await db.select({ id: agentActions.id }).from(agentActions).where(and(
        eq(agentActions.id, item.source_id), eq(agentActions.org_id, item.org_id), currentApprovalRecipientSql(item.user_id),
      )).limit(1);
      if (!visible) return;
    }
    emitToUser(item.org_id, item.user_id, event, projectAttentionItem(item));
  } catch (error) {
    console.warn('[attention] realtime delivery skipped:', error instanceof Error ? error.message : error);
  }
}

export async function upsertAttentionItem(
  draft: AttentionDraft,
  options: { deliver?: boolean; executor?: Pick<typeof db, 'select' | 'insert'>;
    afterCommit?: (effect: () => Promise<void>) => void } = {},
) {
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
        console.warn('[attention] push scheduling failed:', error instanceof Error ? error.message : error);
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
  return upsertAttentionItem(draft, options);
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

  const items = await db.transaction(async (tx) => {
    const existingEvents = await tx
      .select({ source_event_id: attentionEvents.source_event_id })
      .from(attentionEvents)
      .where(and(
        inArray(attentionEvents.source_event_id, sourceEventIds),
        eq(attentionEvents.event_type, 'source_event'),
      ));
    const alreadyProjected = new Set(existingEvents.map((event) => event.source_event_id));
    const pendingDrafts = drafts.filter((draft) => !alreadyProjected.has(draft.sourceEventId));
    if (pendingDrafts.length === 0) return [];

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

    return projected;
  });

  for (const item of items) await emitAttention(item.event_count > 1 ? 'attention:updated' : 'attention:new', item);
  if (options.deliver !== false) {
    await scheduleAttentionDeliveries(items).catch((error) => {
      console.warn('[attention] push scheduling failed:', error instanceof Error ? error.message : error);
      return [];
    });
  }
  return items;
}

export async function filterVisibleAttentionItems<T extends typeof attentionItems.$inferSelect>(
  userId: string,
  rows: T[],
): Promise<T[]> {
  const nativeIds = rows.filter(item => item.source_type === 'native_mention').map(item => item.id);
  const visibleNative = nativeIds.length ? await db.select({ id: attentionItems.id }).from(attentionItems).where(and(
    inArray(attentionItems.id, nativeIds),
    nativeDeliveryAccessSql(userId, sql`${attentionItems.source_id}`, sql`${attentionItems.org_id}`),
  )) : [];
  const allowedNative = new Set(visibleNative.map(item => item.id));
  const messageIds = rows.filter((item) => item.source_type === 'message').map((item) => item.source_id);
  const spaceIds = rows.filter((item) => item.source_type === 'space').map((item) => item.source_id);
  const actionIds = rows.filter((item) => item.source_type === 'agent_action').map((item) => item.source_id);
  const visibleMessages = messageIds.length > 0
    ? await db
      .select({ id: messages.id, type: spaces.type, member_id: spaceMembers.id })
      .from(messages)
      .innerJoin(spaces, eq(spaces.id, messages.space_id))
      .leftJoin(spaceMembers, and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, userId)))
      .where(and(inArray(messages.id, messageIds), eq(messages.is_deleted, false)))
    : [];
  const visibleSpaces = spaceIds.length > 0
    ? await db
      .select({ id: spaces.id, type: spaces.type, member_id: spaceMembers.id })
      .from(spaces)
      .leftJoin(spaceMembers, and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, userId)))
      .where(inArray(spaces.id, spaceIds))
    : [];
  const knownActions = actionIds.length > 0
    ? await db
      .select({ id: agentActions.id, allowed: sql<boolean>`coalesce((${currentApprovalRecipientSql(userId)}), false)` })
      .from(agentActions)
      .where(inArray(agentActions.id, actionIds))
    : [];
  const existingActions = new Set(knownActions.map((row) => row.id));
  const visibleActions = knownActions.filter((row) => row.allowed);
  const allowedMessages = new Set(visibleMessages.filter((row) => row.type === 'public' || row.member_id).map((row) => row.id));
  const allowedSpaces = new Set(visibleSpaces.filter((row) => row.type === 'public' || row.member_id).map((row) => row.id));
  const allowedActions = new Set(visibleActions.map((row) => row.id));
  const inaccessible = rows.filter((item) =>
    (item.source_type === 'native_mention' && !allowedNative.has(item.id))
    ||
    (item.source_type === 'message' && !allowedMessages.has(item.source_id))
    || (item.source_type === 'space' && !allowedSpaces.has(item.source_id))
    || (item.source_type === 'agent_action' && !existingActions.has(item.source_id)));
  // Approval items are held back, not closed, while their owner cannot review
  // the action; attention maintenance resolves those that stay that way.
  const heldBack = rows.filter((item) => item.source_type === 'agent_action'
    && existingActions.has(item.source_id) && !allowedActions.has(item.source_id));
  for (const item of inaccessible) {
    await transitionAttentionItem({
      orgId: item.org_id,
      userId: item.user_id,
      itemId: item.id,
      state: 'resolved',
      resolution: 'source_access_removed',
      actorUserId: userId,
    });
  }
  const hidden = new Set([...inaccessible, ...heldBack].map((item) => item.id));
  return rows.filter((item) => !hidden.has(item.id));
}

/** Whether the item's owner may still open it (checked again right before a push is sent). */
export async function attentionItemStillVisible(item: { id: string; org_id: string; user_id: string }) {
  const [row] = await db.select({ id: attentionItems.id }).from(attentionItems).where(and(
    eq(attentionItems.id, item.id), eq(attentionItems.org_id, item.org_id), eq(attentionItems.user_id, item.user_id),
    visibleAttentionCondition(item.user_id),
  )).limit(1);
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

/**
 * True for every action of `orgId` that `userId` may review, and cheap to test
 * (no per-row review check): `actionReviewerSql` accepts a user only as the
 * action's requester when that is an active human member of the action's
 * workspace, and otherwise as an active owner/admin of it, so a reviewer is
 * the requester, or an owner/admin of an action whose requester is not an
 * active human member. For actions of `orgId` only.
 */
function reviewerCandidateSql(userId: string, orgId: string): SQL {
  return sql`(${actionRequesterIdSql()} = ${userId}
    OR (EXISTS (SELECT 1 FROM ${orgMembers} candidate_admin
          WHERE candidate_admin.org_id = ${orgId} AND candidate_admin.user_id = ${userId}
            AND candidate_admin.is_active = true AND candidate_admin.role IN ('owner', 'admin'))
      AND COALESCE(${actionRequesterIdSql()} NOT IN (SELECT candidate_human.id FROM users candidate_human
          INNER JOIN ${orgMembers} candidate_member ON candidate_member.user_id = candidate_human.id
          WHERE candidate_member.org_id = ${orgId} AND candidate_member.is_active = true
            AND candidate_human.is_agent = false AND candidate_human.kind = 'human'), true)))`;
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
  // candidates (see reviewerCandidateSql), and not at all when there are none.
  const awaitingApproval = and(
    eq(agentActions.org_id, params.orgId),
    eq(agentActions.approval_status, 'pending'),
    inArray(agentActions.approval_tier, ['quick', 'full']),
  );
  const candidate = sql`(${reviewerCandidateSql(params.userId, params.orgId)}
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
  const [item] = await db
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
      version: sql`${attentionItems.version} + 1`,
      updated_at: now,
    })
    .where(and(
      eq(attentionItems.id, params.itemId),
      eq(attentionItems.org_id, params.orgId),
      eq(attentionItems.user_id, params.userId),
      inArray(attentionItems.state, allowedFrom[params.state]),
      params.viewerId ? visibleAttentionCondition(params.viewerId) : sql`true`,
    ))
    .returning();
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
  return item;
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

  const [current] = await db
    .select()
    .from(attentionItems)
    .where(and(
      eq(attentionItems.id, params.itemId),
      eq(attentionItems.org_id, params.orgId),
      eq(attentionItems.user_id, params.userId),
      inArray(attentionItems.state, ['open_unseen', 'open_seen', 'acknowledged']),
      visibleAttentionCondition(params.userId),
    ))
    .limit(1);
  if (!current) return null;
  const now = new Date();
  const metadata = objectMetadata(current.metadata);
  const [item] = await db
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
    .where(and(eq(attentionItems.id, current.id), visibleAttentionCondition(params.userId)))
    .returning();
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
  return item;
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
