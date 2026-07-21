import { and, eq, inArray } from 'drizzle-orm';
import { notifications } from '@deft/db/schema';
import { db } from '../../lib/db.js';
import { syncNotificationsToAttention } from '../../lib/attention.js';
import type { JobData } from '../types.js';

export async function handleNotificationAttentionSync(job: JobData): Promise<void> {
  const orgId = typeof job.data.orgId === 'string' ? job.data.orgId : '';
  const notificationIds = Array.isArray(job.data.notificationIds)
    ? Array.from(new Set(job.data.notificationIds.filter((id): id is string => typeof id === 'string' && id.length > 0)))
    : [];
  if (!orgId || notificationIds.length === 0) {
    throw new Error('notification-attention-sync requires orgId and notificationIds');
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(and(
      eq(notifications.org_id, orgId),
      inArray(notifications.id, notificationIds),
    ));
  if (rows.length !== notificationIds.length) {
    throw new Error(`notification-attention-sync found ${rows.length}/${notificationIds.length} notifications`);
  }

  const startedAt = performance.now();
  const enqueuedAt = typeof job.data.enqueuedAt === 'string'
    ? Date.parse(job.data.enqueuedAt)
    : Number.NaN;
  const queueDelayMs = Number.isFinite(enqueuedAt) ? Math.max(0, Date.now() - enqueuedAt) : null;
  const projected = await syncNotificationsToAttention(rows);
  const projectionMs = performance.now() - startedAt;
  if (process.env.DEFT_CAPACITY_TRACE === '1') {
    console.info(`[capacity-profile] ${JSON.stringify({
      event: 'attention_projection',
      notifications: rows.length,
      projected_items: projected.length,
      queue_delay_ms: queueDelayMs === null ? null : Math.round(queueDelayMs * 10) / 10,
      projection_ms: Math.round(projectionMs * 10) / 10,
      end_to_end_ms: queueDelayMs === null ? null : Math.round((queueDelayMs + projectionMs) * 10) / 10,
    })}`);
  }
}
