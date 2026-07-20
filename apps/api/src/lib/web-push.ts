import webpush from 'web-push';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import {
  attentionDeliveries,
  attentionItems,
  DEFAULT_NOTIFICATION_PREFERENCES,
  users,
  webPushSubscriptions,
  type UserNotificationPreferences,
} from '@deft/db/schema';
import { db } from './db.js';
import { env } from './env.js';
import { revealPushSubscription } from './push-subscription.js';
import { enqueue, QUEUE_NAMES } from './queues.js';

type AttentionItem = typeof attentionItems.$inferSelect;
export const PUSH_MAX_ATTEMPTS = 4;

export function webPushConfigured() {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

if (webPushConfigured()) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

function normalizedPreferences(value: unknown): UserNotificationPreferences {
  const incoming = value && typeof value === 'object' ? value as Partial<UserNotificationPreferences> : {};
  return {
    keywords: Array.isArray(incoming.keywords) ? incoming.keywords.filter((entry): entry is string => typeof entry === 'string') : [],
    channels: { ...DEFAULT_NOTIFICATION_PREFERENCES.channels, ...(incoming.channels ?? {}) },
    push: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.push,
      ...(incoming.push ?? {}),
      quiet_hours: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.push.quiet_hours,
        ...(incoming.push?.quiet_hours ?? {}),
      },
    },
  };
}

function pushCategory(item: AttentionItem): keyof Omit<UserNotificationPreferences['push'], 'enabled' | 'quiet_hours'> | null {
  if (item.kind === 'approval' || item.source_type === 'agent_action') return 'approvals';
  if (item.source_type === 'task' || item.kind.startsWith('task') || item.kind === 'blocked') return 'tasks';
  if (item.source_type === 'calendar' || item.kind === 'reminder') return 'calendar';
  if (item.source_type === 'agent' || item.kind.startsWith('agent_')) return 'agents';
  if (item.source_type === 'message' || item.source_type === 'space' || ['mention', 'message', 'huddle_started'].includes(item.kind)) return 'chat';
  return null;
}

function localMinutes(date: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function inQuietHours(date: Date, timezone: string, start: string, end: string) {
  const startMinute = parseClock(start);
  const endMinute = parseClock(end);
  if (startMinute === null || endMinute === null || startMinute === endMinute) return false;
  const current = localMinutes(date, timezone);
  return startMinute < endMinute
    ? current >= startMinute && current < endMinute
    : current >= startMinute || current < endMinute;
}

function quietHoursDelay(now: Date, timezone: string, start: string, end: string) {
  if (!inQuietHours(now, timezone, start, end)) return 0;
  for (let minutes = 15; minutes <= 24 * 60; minutes += 15) {
    const candidate = new Date(now.getTime() + minutes * 60_000);
    if (!inQuietHours(candidate, timezone, start, end)) return candidate.getTime() - now.getTime();
  }
  return 24 * 60 * 60_000;
}

function baseDelay(item: AttentionItem) {
  if (item.priority === 'critical') return 0;
  if (item.priority === 'high') return 2 * 60_000;
  if (item.kind === 'approval') return 5 * 60_000;
  if (item.kind === 'mention') return 2 * 60_000;
  if (item.kind === 'task_assigned') return 15 * 60_000;
  if (item.kind === 'reminder' || item.kind === 'huddle_started') return 0;
  return 5 * 60_000;
}

function preferenceAllows(item: AttentionItem, preferences: UserNotificationPreferences) {
  const category = pushCategory(item);
  return preferences.push.enabled && category !== null && preferences.push[category] === true;
}

export const webPushPolicy = {
  baseDelay,
  preferenceAllows,
  pushCategory,
  quietHoursDelay,
  failureStatus: (attempt: number) => attempt >= PUSH_MAX_ATTEMPTS ? 'failed' as const : 'queued' as const,
};

export async function scheduleAttentionDelivery(item: AttentionItem) {
  if (!webPushConfigured() || item.state !== 'open_unseen' || item.priority === 'low') return null;
  const [user] = await db
    .select({ preferences: users.notification_preferences, timezone: users.timezone })
    .from(users)
    .where(eq(users.id, item.user_id))
    .limit(1);
  if (!user) return null;
  const preferences = normalizedPreferences(user.preferences);
  if (!preferenceAllows(item, preferences)) return null;
  const [subscriptionCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(webPushSubscriptions)
    .where(and(
      eq(webPushSubscriptions.org_id, item.org_id),
      eq(webPushSubscriptions.user_id, item.user_id),
      eq(webPushSubscriptions.is_active, true),
    ));
  if (Number(subscriptionCount?.count ?? 0) === 0) return null;

  const now = new Date();
  const quietDelay = preferences.push.quiet_hours.enabled && item.priority !== 'critical'
    ? quietHoursDelay(
        now,
        user.timezone ?? 'UTC',
        preferences.push.quiet_hours.start,
        preferences.push.quiet_hours.end,
      )
    : 0;
  const delay = Math.max(baseDelay(item), quietDelay);
  const [delivery] = await db
    .insert(attentionDeliveries)
    .values({
      org_id: item.org_id,
      attention_item_id: item.id,
      user_id: item.user_id,
      channel: 'web_push',
      status: 'queued',
      delivery_version: item.version,
      next_attempt_at: new Date(now.getTime() + delay),
    })
    .onConflictDoNothing()
    .returning();
  if (!delivery) return null;
  await enqueue(
    QUEUE_NAMES.SCHEDULED_JOBS,
    'attention-delivery',
    { delivery_id: delivery.id },
    { delay, maxAttempts: PUSH_MAX_ATTEMPTS },
  );
  return delivery;
}

function safePayload(item: AttentionItem) {
  return JSON.stringify({
    title: item.title.slice(0, 120),
    body: 'Open Deft to review.',
    url: item.link ?? `/inbox?lane=${item.lane}`,
    attention_id: item.id,
    tag: `deft-attention-${item.id}`,
  });
}

export async function sendAttentionDelivery(deliveryId: string, options: { attempt?: number } = {}) {
  if (!webPushConfigured()) throw new Error('Web Push is not configured');
  const [row] = await db
    .select({ delivery: attentionDeliveries, item: attentionItems, preferences: users.notification_preferences })
    .from(attentionDeliveries)
    .innerJoin(attentionItems, eq(attentionItems.id, attentionDeliveries.attention_item_id))
    .innerJoin(users, eq(users.id, attentionDeliveries.user_id))
    .where(eq(attentionDeliveries.id, deliveryId))
    .limit(1);
  if (!row) return { skipped: true, reason: 'missing' };
  if (row.delivery.status !== 'queued') return { skipped: true, reason: row.delivery.status };
  if (row.item.version !== row.delivery.delivery_version || row.item.state !== 'open_unseen') {
    await db.update(attentionDeliveries).set({ status: 'superseded', updated_at: new Date() }).where(eq(attentionDeliveries.id, deliveryId));
    return { skipped: true, reason: 'superseded' };
  }
  const { filterVisibleAttentionItems } = await import('./attention.js');
  if ((await filterVisibleAttentionItems(row.item.user_id, [row.item])).length === 0) {
    await db.update(attentionDeliveries).set({ status: 'suppressed', updated_at: new Date() }).where(eq(attentionDeliveries.id, deliveryId));
    return { skipped: true, reason: 'source_access_revoked' };
  }
  if (!preferenceAllows(row.item, normalizedPreferences(row.preferences))) {
    await db.update(attentionDeliveries).set({ status: 'suppressed', updated_at: new Date() }).where(eq(attentionDeliveries.id, deliveryId));
    return { skipped: true, reason: 'preference' };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60_000);
  const [sameItem] = await db
    .select({ id: attentionDeliveries.id })
    .from(attentionDeliveries)
    .where(and(
      eq(attentionDeliveries.attention_item_id, row.item.id),
      eq(attentionDeliveries.status, 'sent'),
      gte(attentionDeliveries.sent_at, oneHourAgo),
    ))
    .orderBy(desc(attentionDeliveries.sent_at))
    .limit(1);
  const [recentDeliveryCount] = await db
    .select({ sentCount: sql<number>`count(*)::int` })
    .from(attentionDeliveries)
    .where(and(
      eq(attentionDeliveries.user_id, row.item.user_id),
      eq(attentionDeliveries.status, 'sent'),
      gte(attentionDeliveries.sent_at, oneHourAgo),
    ));
  if ((sameItem || Number(recentDeliveryCount?.sentCount ?? 0) >= 8) && row.item.priority !== 'critical') {
    await db.update(attentionDeliveries).set({ status: 'rate_limited', updated_at: new Date() }).where(eq(attentionDeliveries.id, deliveryId));
    return { skipped: true, reason: 'rate_limited' };
  }

  const subscriptions = await db
    .select()
    .from(webPushSubscriptions)
    .where(and(
      eq(webPushSubscriptions.org_id, row.item.org_id),
      eq(webPushSubscriptions.user_id, row.item.user_id),
      eq(webPushSubscriptions.is_active, true),
    ));
  if (subscriptions.length === 0) {
    await db.update(attentionDeliveries).set({ status: 'no_devices', updated_at: new Date() }).where(eq(attentionDeliveries.id, deliveryId));
    return { skipped: true, reason: 'no_devices' };
  }

  let sent = 0;
  const failures: string[] = [];
  for (const subscription of subscriptions) {
    try {
      const revealed = revealPushSubscription(subscription);
      await webpush.sendNotification({
        endpoint: revealed.endpoint,
        keys: { p256dh: revealed.p256dh, auth: revealed.auth },
      }, safePayload(row.item), { TTL: row.item.priority === 'critical' ? 300 : 3600 });
      sent += 1;
      await db.update(webPushSubscriptions).set({ failure_count: 0, last_used_at: new Date(), updated_at: new Date() }).where(eq(webPushSubscriptions.id, subscription.id));
    } catch (error) {
      const statusCode = typeof error === 'object' && error && 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : null;
      if (statusCode === 404 || statusCode === 410) {
        await db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.id, subscription.id));
      } else {
        failures.push(error instanceof Error ? error.message : String(error));
        await db.update(webPushSubscriptions).set({ failure_count: sql`${webPushSubscriptions.failure_count} + 1`, updated_at: new Date() }).where(eq(webPushSubscriptions.id, subscription.id));
      }
    }
  }

  const now = new Date();
  const failedWithoutDelivery = sent === 0 && failures.length > 0;
  const failureStatus = webPushPolicy.failureStatus(options.attempt ?? row.delivery.attempt_count + 1);
  await db.update(attentionDeliveries).set({
    status: sent > 0 ? 'sent' : failedWithoutDelivery ? failureStatus : 'failed',
    attempt_count: sql`${attentionDeliveries.attempt_count} + 1`,
    sent_at: sent > 0 ? now : null,
    last_error: failures.length > 0 ? failures.join('; ').slice(0, 1000) : null,
    updated_at: now,
  }).where(eq(attentionDeliveries.id, deliveryId));
  if (failedWithoutDelivery && failureStatus === 'queued') throw new Error(failures.join('; '));
  return { sent, failed: failures.length };
}

export async function sendPushTest(params: { orgId: string; userId: string }) {
  if (!webPushConfigured()) return { sent: 0, configured: false };
  const subscriptions = await db.select().from(webPushSubscriptions).where(and(
    eq(webPushSubscriptions.org_id, params.orgId),
    eq(webPushSubscriptions.user_id, params.userId),
    eq(webPushSubscriptions.is_active, true),
  ));
  let sent = 0;
  for (const subscription of subscriptions) {
    try {
      const revealed = revealPushSubscription(subscription);
      await webpush.sendNotification({ endpoint: revealed.endpoint, keys: { p256dh: revealed.p256dh, auth: revealed.auth } }, JSON.stringify({
        title: 'Deft notifications are ready',
        body: 'This device can receive time-sensitive work alerts.',
        url: '/settings/profile',
        tag: 'deft-push-test',
      }), { TTL: 60 });
      sent += 1;
    } catch {
      // The normal delivery worker records and retries operational failures.
    }
  }
  return { sent, configured: true };
}
