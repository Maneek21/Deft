import { and, eq, inArray } from 'drizzle-orm';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  notifications,
  spaceMembers,
  users,
  type UserNotificationPreferences,
} from '@deft/db/schema';
import { db } from './db.js';
import { syncNotificationToAttention, syncNotificationsToAttention } from './attention.js';
import { enqueue, QUEUE_NAMES } from './queues.js';

type NotificationChannel = keyof UserNotificationPreferences['channels'];
type NotificationInsert = typeof notifications.$inferInsert;

export type NotificationPolicyOptions = {
  channel?: NotificationChannel | null;
  spaceId?: string | null;
  isMention?: boolean;
  respectDnd?: boolean;
  bypassUserPreferences?: boolean;
};

export type NotificationPolicyDecision = {
  allowed: boolean;
  reason:
    | 'allowed'
    | 'recipient_not_found'
    | 'do_not_disturb'
    | 'channel_disabled'
    | 'not_space_member'
    | 'space_muted'
    | 'space_mentions_only';
  channel: NotificationChannel | null;
};

function normalizePreferences(value: unknown): UserNotificationPreferences {
  const candidate = value as Partial<UserNotificationPreferences> | null | undefined;
  return {
    keywords: Array.isArray(candidate?.keywords)
      ? candidate.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
      : [],
    channels: {
      chat: candidate?.channels?.chat ?? DEFAULT_NOTIFICATION_PREFERENCES.channels.chat,
      tasks: candidate?.channels?.tasks ?? DEFAULT_NOTIFICATION_PREFERENCES.channels.tasks,
      approvals:
        candidate?.channels?.approvals ??
        DEFAULT_NOTIFICATION_PREFERENCES.channels.approvals,
      calendar:
        candidate?.channels?.calendar ??
        DEFAULT_NOTIFICATION_PREFERENCES.channels.calendar,
      agents: candidate?.channels?.agents ?? DEFAULT_NOTIFICATION_PREFERENCES.channels.agents,
    },
    push: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.push,
      ...(candidate?.push ?? {}),
      quiet_hours: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.push.quiet_hours,
        ...(candidate?.push?.quiet_hours ?? {}),
      },
    },
  };
}

export function notificationChannelForType(
  type: string,
): NotificationChannel | null {
  switch (type) {
    case 'mention':
    case 'message':
    case 'huddle_started':
      return 'chat';
    case 'task':
    case 'task_assigned':
    case 'task_updated':
    case 'blocked':
    case 'workload_imbalance':
      return 'tasks';
    case 'reminder':
      return 'calendar';
    case 'agent_suggestion':
    case 'skill_update_available':
      return 'agents';
    default:
      return null;
  }
}

function spaceLevelAllowsNotification(
  level: string | null | undefined,
  isMention: boolean,
): boolean {
  if (level === 'nothing') return false;
  if (level === 'mentions') return isMention;
  return true;
}

export async function explainNotificationPolicy(
  values: Pick<NotificationInsert, 'user_id' | 'type'>,
  options: NotificationPolicyOptions = {},
): Promise<NotificationPolicyDecision> {
  const inferredChannel =
    options.channel === undefined
      ? notificationChannelForType(String(values.type))
      : options.channel;

  const [recipient] = await db
    .select({
      notification_preferences: users.notification_preferences,
      status_text: users.status_text,
    })
    .from(users)
    .where(eq(users.id, values.user_id))
    .limit(1);

  if (!recipient) {
    return { allowed: false, reason: 'recipient_not_found', channel: inferredChannel ?? null };
  }

  if (options.respectDnd && recipient.status_text === 'Do Not Disturb') {
    return { allowed: false, reason: 'do_not_disturb', channel: inferredChannel ?? null };
  }

  if (inferredChannel && !options.bypassUserPreferences) {
    const preferences = normalizePreferences(recipient.notification_preferences);
    if (preferences.channels[inferredChannel] === false) {
      return { allowed: false, reason: 'channel_disabled', channel: inferredChannel };
    }
  }

  if (options.spaceId) {
    const [membership] = await db
      .select({
        is_muted: spaceMembers.is_muted,
        notification_level: spaceMembers.notification_level,
      })
      .from(spaceMembers)
      .where(
        and(
          eq(spaceMembers.space_id, options.spaceId),
          eq(spaceMembers.user_id, values.user_id),
        ),
      )
      .limit(1);

    if (!membership) {
      return { allowed: false, reason: 'not_space_member', channel: inferredChannel ?? null };
    }
    if (membership.is_muted) {
      return { allowed: false, reason: 'space_muted', channel: inferredChannel ?? null };
    }
    if (!spaceLevelAllowsNotification(membership.notification_level, !!options.isMention)) {
      return { allowed: false, reason: 'space_mentions_only', channel: inferredChannel ?? null };
    }
  }

  return { allowed: true, reason: 'allowed', channel: inferredChannel ?? null };
}

export async function shouldCreateNotification(
  values: Pick<NotificationInsert, 'user_id' | 'type'>,
  options: NotificationPolicyOptions = {},
): Promise<boolean> {
  const decision = await explainNotificationPolicy(values, options);
  return decision.allowed;
}

export async function createNotificationIfAllowed(
  values: NotificationInsert,
  options: NotificationPolicyOptions = {},
): Promise<typeof notifications.$inferSelect | null> {
  const decision = await explainNotificationPolicy(values, options);
  if (!decision.allowed) return null;

  const existingMetadata =
    values.metadata && typeof values.metadata === 'object' && !Array.isArray(values.metadata)
      ? values.metadata as Record<string, unknown>
      : {};
  const [notification] = await db.insert(notifications).values({
    ...values,
    metadata: {
      ...existingMetadata,
      delivery_policy: {
        status: 'delivered',
        reason: decision.reason,
        channel: decision.channel,
        evaluated_at: new Date().toISOString(),
      },
    },
  }).returning();
  if (notification) {
    await syncNotificationToAttention(notification).catch((error) => {
      console.warn('[notification-policy] Attention dual-write failed', {
        notificationId: notification.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return notification ?? null;
}

/**
 * Apply one shared policy context to many recipients with a single policy
 * read and a single insert. This is the hot path for messages in large rooms.
 */
export async function createNotificationsIfAllowed(
  values: NotificationInsert[],
  options: NotificationPolicyOptions = {},
): Promise<Array<typeof notifications.$inferSelect>> {
  if (values.length === 0) return [];
  const traceEnabled = process.env.DEFT_CAPACITY_TRACE === '1';
  const startedAt = performance.now();
  const first = values[0]!;

  const inferredChannel = options.channel === undefined
    ? notificationChannelForType(String(first.type))
    : options.channel;
  const userIds = Array.from(new Set(values.map((value) => value.user_id)));
  const recipients = await db
    .select({
      id: users.id,
      notification_preferences: users.notification_preferences,
      status_text: users.status_text,
      is_muted: spaceMembers.is_muted,
      notification_level: spaceMembers.notification_level,
    })
    .from(users)
    .leftJoin(
      spaceMembers,
      options.spaceId
        ? and(eq(spaceMembers.user_id, users.id), eq(spaceMembers.space_id, options.spaceId))
        : eq(spaceMembers.user_id, sqlNeverMatches()),
    )
    .where(inArray(users.id, userIds));
  const policyReadAt = performance.now();
  const recipientById = new Map(recipients.map((recipient) => [recipient.id, recipient]));
  const evaluatedAt = new Date().toISOString();

  const allowed = values.flatMap((value) => {
    const recipient = recipientById.get(value.user_id);
    if (!recipient) return [];
    if (options.respectDnd && recipient.status_text === 'Do Not Disturb') return [];
    if (inferredChannel && !options.bypassUserPreferences) {
      const preferences = normalizePreferences(recipient.notification_preferences);
      if (preferences.channels[inferredChannel] === false) return [];
    }
    if (options.spaceId) {
      if (recipient.is_muted === null || recipient.is_muted === undefined) return [];
      if (recipient.is_muted) return [];
      if (!spaceLevelAllowsNotification(recipient.notification_level, !!options.isMention)) return [];
    }
    const existingMetadata = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      ? value.metadata as Record<string, unknown>
      : {};
    return [{
      ...value,
      metadata: {
        ...existingMetadata,
        delivery_policy: { status: 'delivered', reason: 'allowed', channel: inferredChannel ?? null, evaluated_at: evaluatedAt },
      },
    }];
  });

  if (allowed.length === 0) {
    if (traceEnabled) {
      console.info(`[capacity-profile] ${JSON.stringify({
        event: 'notification_fanout',
        requested: values.length,
        allowed: 0,
        policy_read_ms: Math.round((policyReadAt - startedAt) * 10) / 10,
        notification_insert_ms: 0,
        attention_sync_ms: 0,
        total_ms: Math.round((performance.now() - startedAt) * 10) / 10,
      })}`);
    }
    return [];
  }
  const inserted = await db.insert(notifications).values(allowed).returning();
  const insertedAt = performance.now();
  const byOrg = new Map<string, Array<typeof notifications.$inferSelect>>();
  for (const notification of inserted) {
    const group = byOrg.get(notification.org_id) ?? [];
    group.push(notification);
    byOrg.set(notification.org_id, group);
  }
  let attentionMode = 'queued';
  for (const [orgId, orgNotifications] of byOrg) {
    try {
      await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, 'notification-attention-sync', {
        orgId,
        notificationIds: orgNotifications.map((notification) => notification.id),
        enqueuedAt: new Date().toISOString(),
      }, { maxAttempts: 5 });
    } catch (error) {
      attentionMode = 'synchronous_fallback';
      console.warn('[notification-policy] Attention queue insert failed; projecting synchronously', {
        notificationCount: orgNotifications.length,
        error: error instanceof Error ? error.message : String(error),
      });
      await syncNotificationsToAttention(orgNotifications);
    }
  }
  const attentionQueuedAt = performance.now();
  if (traceEnabled) {
    console.info(`[capacity-profile] ${JSON.stringify({
      event: 'notification_fanout',
      requested: values.length,
      allowed: inserted.length,
      policy_read_ms: Math.round((policyReadAt - startedAt) * 10) / 10,
      notification_insert_ms: Math.round((insertedAt - policyReadAt) * 10) / 10,
      attention_enqueue_ms: Math.round((attentionQueuedAt - insertedAt) * 10) / 10,
      attention_mode: attentionMode,
      total_ms: Math.round((attentionQueuedAt - startedAt) * 10) / 10,
    })}`);
  }
  return inserted;
}

// Drizzle requires an expression for a LEFT JOIN even when no space policy is
// requested. A false text comparison keeps the join empty in that uncommon path.
function sqlNeverMatches() {
  return '__deft_no_space__';
}
