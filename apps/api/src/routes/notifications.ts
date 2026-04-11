import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { notifications } from '@deft/db/schema';

export const notificationRoutes = new Hono();

// GET /api/notifications — list notifications for current user
notificationRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');

    const results = await db.select()
      .from(notifications)
      .where(
        and(
          eq(notifications.user_id, user.id),
          eq(notifications.org_id, user.org_id),
        )
      )
      .orderBy(desc(notifications.created_at))
      .limit(50);

    const [unreadResult] = await db.select({
      count: sql<number>`count(*)::int`,
    })
      .from(notifications)
      .where(
        and(
          eq(notifications.user_id, user.id),
          eq(notifications.org_id, user.org_id),
          eq(notifications.is_read, false),
        )
      );

    return c.json({
      notifications: results,
      unread_count: unreadResult?.count ?? 0,
    });
  } catch (err) {
    console.error('Failed to fetch notifications:', err);
    return c.json({ error: 'Failed to fetch notifications', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/notifications/:id/read — mark single notification as read
notificationRoutes.patch('/:id/read', async (c) => {
  try {
    const user = c.get('user');
    const notificationId = c.req.param('id');

    const [existing] = await db.select()
      .from(notifications)
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.user_id, user.id),
        )
      )
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Notification not found', code: 'NOT_FOUND' }, 404);
    }

    const [updated] = await db.update(notifications)
      .set({ is_read: true })
      .where(eq(notifications.id, notificationId))
      .returning();

    return c.json(updated);
  } catch (err) {
    console.error('Failed to mark notification as read:', err);
    return c.json({ error: 'Failed to update notification', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/notifications/read-all — mark all as read for current user
notificationRoutes.post('/read-all', async (c) => {
  try {
    const user = c.get('user');

    await db.update(notifications)
      .set({ is_read: true })
      .where(
        and(
          eq(notifications.user_id, user.id),
          eq(notifications.org_id, user.org_id),
          eq(notifications.is_read, false),
        )
      );

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to mark all notifications as read:', err);
    return c.json({ error: 'Failed to update notifications', code: 'INTERNAL_ERROR' }, 500);
  }
});
