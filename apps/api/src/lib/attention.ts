import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
import { getIO } from '../socket.js';
import { scheduleAttentionDeliveries, scheduleAttentionDelivery } from './web-push.js';

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
    ${attentionItems.source_type} NOT IN ('message', 'space', 'agent_action')
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
      )
    )
  )`;
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

function actionRequesterId(action: AgentAction): string {
  const params = objectMetadata(action.params);
  return metadataString(params, 'source_user_id', 'origin_user_id') ?? action.user_id;
}

function approvalActionLabel(action: AgentAction): string {
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
      params,
      approval_tier: action.approval_tier,
      agent_employee_id: action.agent_employee_id,
      source: action.source,
    },
    occurredAt: action.created_at,
  };
}

function emitAttention(event: 'attention:new' | 'attention:updated', item: typeof attentionItems.$inferSelect) {
  getIO()?.to(`user:${item.user_id}`).emit(event, item);
}

export async function upsertAttentionItem(
  draft: AttentionDraft,
  options: { deliver?: boolean } = {},
) {
  const [existingEvent] = await db
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
    const [existingItem] = await db
      .select()
      .from(attentionItems)
      .where(eq(attentionItems.id, existingEvent.attention_item_id))
      .limit(1);
    return existingItem ?? null;
  }

  const now = draft.occurredAt ?? new Date();
  const [item] = await db
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

  await db
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

  emitAttention(item.event_count > 1 ? 'attention:updated' : 'attention:new', item);
  if (options.deliver !== false) {
    try {
      await scheduleAttentionDelivery(item);
    } catch (error) {
      console.warn('[attention] push scheduling failed:', error instanceof Error ? error.message : error);
    }
  }
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

  for (const item of items) emitAttention(item.event_count > 1 ? 'attention:updated' : 'attention:new', item);
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
  const visibleActions = actionIds.length > 0
    ? await db
      .select({ id: agentActions.id })
      .from(agentActions)
      .where(inArray(agentActions.id, actionIds))
    : [];
  const allowedMessages = new Set(visibleMessages.filter((row) => row.type === 'public' || row.member_id).map((row) => row.id));
  const allowedSpaces = new Set(visibleSpaces.filter((row) => row.type === 'public' || row.member_id).map((row) => row.id));
  const allowedActions = new Set(visibleActions.map((row) => row.id));
  const inaccessible = rows.filter((item) =>
    (item.source_type === 'message' && !allowedMessages.has(item.source_id))
    || (item.source_type === 'space' && !allowedSpaces.has(item.source_id))
    || (item.source_type === 'agent_action' && !allowedActions.has(item.source_id)));
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
  const hidden = new Set(inaccessible.map((item) => item.id));
  return rows.filter((item) => !hidden.has(item.id));
}

export async function ensureActionApprovers(action: AgentAction): Promise<string[]> {
  const explicit = await db
    .select({
      user_id: agentActionApprovers.user_id,
      decision: agentActionApprovers.decision,
    })
    .from(agentActionApprovers)
    .where(and(
      eq(agentActionApprovers.org_id, action.org_id),
      eq(agentActionApprovers.action_id, action.id),
    ));
  if (explicit.length > 0) {
    return Array.from(new Set(
      explicit.filter((row) => row.decision === 'pending').map((row) => row.user_id),
    ));
  }

  const requesterId = actionRequesterId(action);
  const [requester] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(orgMembers, and(
      eq(orgMembers.user_id, users.id),
      eq(orgMembers.org_id, action.org_id),
      eq(orgMembers.is_active, true),
    ))
    .where(and(
      eq(users.id, requesterId),
      eq(users.is_agent, false),
      eq(users.kind, 'human'),
    ))
    .limit(1);
  const userIds = requester
    ? [requester.id]
    : Array.from(new Set((await db
      .select({ user_id: orgMembers.user_id })
      .from(orgMembers)
      .where(and(
        eq(orgMembers.org_id, action.org_id),
        eq(orgMembers.is_active, true),
        inArray(orgMembers.role, ['owner', 'admin']),
      ))).map((row) => row.user_id)));

  if (userIds.length > 0) {
    await db.insert(agentActionApprovers).values(userIds.map((userId) => ({
      org_id: action.org_id,
      action_id: action.id,
      user_id: userId,
    }))).onConflictDoNothing();
  }
  return userIds;
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

export async function syncApprovalToAttention(action: AgentAction, options?: { deliver?: boolean }) {
  if (action.approval_status !== 'pending' || action.approval_tier === 'auto') return [];
  const userIds = await ensureActionApprovers(action);
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

  const pendingActions = await db
    .select()
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, params.orgId),
      eq(agentActions.approval_status, 'pending'),
      inArray(agentActions.approval_tier, ['quick', 'full']),
      sql`(
        EXISTS (
          SELECT 1 FROM ${agentActionApprovers}
          WHERE ${agentActionApprovers.action_id} = ${agentActions.id}
            AND ${agentActionApprovers.org_id} = ${params.orgId}
            AND ${agentActionApprovers.user_id} = ${params.userId}
            AND ${agentActionApprovers.decision} = 'pending'
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM ${agentActionApprovers}
            WHERE ${agentActionApprovers.action_id} = ${agentActions.id}
          )
          AND (
            COALESCE(
              ${agentActions.params}->>'source_user_id',
              ${agentActions.params}->>'origin_user_id',
              ${agentActions.user_id}
            ) = ${params.userId}
            OR (
              ${params.role === 'owner' || params.role === 'admin'}
              AND NOT EXISTS (
                SELECT 1
                FROM ${users}
                INNER JOIN ${orgMembers}
                  ON ${orgMembers.user_id} = ${users.id}
                  AND ${orgMembers.org_id} = ${agentActions.org_id}
                  AND ${orgMembers.is_active} = true
                WHERE ${users.id} = COALESCE(
                  ${agentActions.params}->>'source_user_id',
                  ${agentActions.params}->>'origin_user_id',
                  ${agentActions.user_id}
                )
                  AND ${users.is_agent} = false
                  AND ${users.kind} = 'human'
              )
            )
          )
        )
      )`,
    ))
    .orderBy(desc(agentActions.created_at))
    .limit(100);
  for (const action of pendingActions) await syncApprovalToAttention(action, { deliver: false });
}

export async function transitionAttentionItem(params: {
  orgId: string;
  userId: string;
  itemId: string;
  state: AttentionState;
  resolution?: string | null;
  snoozedUntil?: Date | null;
  actorUserId?: string;
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
  emitAttention('attention:updated', item);
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
    .where(eq(attentionItems.id, current.id))
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
  emitAttention('attention:updated', item);
  return item;
}

export async function resolveAttentionBySource(params: {
  orgId: string;
  sourceType: string;
  sourceId: string;
  resolution: string;
  actorUserId?: string;
}) {
  const rows = await db
    .select()
    .from(attentionItems)
    .where(and(
      eq(attentionItems.org_id, params.orgId),
      eq(attentionItems.source_type, params.sourceType),
      eq(attentionItems.source_id, params.sourceId),
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
