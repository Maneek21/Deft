import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { webPushSubscriptions } from '@deft/db/schema';
import { db } from '../lib/db.js';
import { env } from '../lib/env.js';
import { protectPushSubscription } from '../lib/push-subscription.js';
import { sendPushTest, webPushConfigured } from '../lib/web-push.js';

export const pushRoutes = new Hono();

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(4096),
  keys: z.object({
    p256dh: z.string().min(16).max(1024),
    auth: z.string().min(8).max(512),
  }),
  device_name: z.string().trim().min(1).max(120).optional(),
});

pushRoutes.get('/status', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const devices = await db
    .select({
      id: webPushSubscriptions.id,
      device_name: webPushSubscriptions.device_name,
      user_agent: webPushSubscriptions.user_agent,
      last_used_at: webPushSubscriptions.last_used_at,
      created_at: webPushSubscriptions.created_at,
    })
    .from(webPushSubscriptions)
    .where(and(
      eq(webPushSubscriptions.org_id, user.org_id),
      eq(webPushSubscriptions.user_id, user.id),
      eq(webPushSubscriptions.is_active, true),
    ));
  return c.json({
    configured: webPushConfigured(),
    public_key: webPushConfigured() ? env.VAPID_PUBLIC_KEY : null,
    devices,
  });
});

pushRoutes.post('/subscribe', async (c) => {
  if (!webPushConfigured()) {
    return c.json({ error: 'Browser notifications are not configured on this server', code: 'PUSH_NOT_CONFIGURED' }, 503);
  }
  const user = c.get('user') as { id: string; org_id: string };
  const parsed = subscriptionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid push subscription', code: 'VALIDATION_ERROR' }, 400);
  }
  const protectedSubscription = protectPushSubscription({
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
  });
  const [existing] = await db
    .select({ id: webPushSubscriptions.id, org_id: webPushSubscriptions.org_id, user_id: webPushSubscriptions.user_id })
    .from(webPushSubscriptions)
    .where(eq(webPushSubscriptions.endpoint_hash, protectedSubscription.endpoint_hash))
    .limit(1);
  if (existing && (existing.org_id !== user.org_id || existing.user_id !== user.id)) {
    return c.json({ error: 'This browser subscription belongs to another account', code: 'SUBSCRIPTION_CONFLICT' }, 409);
  }

  const values = {
    org_id: user.org_id,
    user_id: user.id,
    ...protectedSubscription,
    device_name: parsed.data.device_name ?? null,
    user_agent: c.req.header('user-agent')?.slice(0, 500) ?? null,
    is_active: true,
    failure_count: 0,
    updated_at: new Date(),
  };
  const [device] = existing
    ? await db.update(webPushSubscriptions).set(values).where(eq(webPushSubscriptions.id, existing.id)).returning()
    : await db.insert(webPushSubscriptions).values(values).returning();
  return c.json({ device }, existing ? 200 : 201);
});

pushRoutes.delete('/:id', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const [removed] = await db
    .delete(webPushSubscriptions)
    .where(and(
      eq(webPushSubscriptions.id, c.req.param('id')),
      eq(webPushSubscriptions.org_id, user.org_id),
      eq(webPushSubscriptions.user_id, user.id),
    ))
    .returning({ id: webPushSubscriptions.id });
  if (!removed) return c.json({ error: 'Device not found', code: 'NOT_FOUND' }, 404);
  return c.json({ success: true });
});

pushRoutes.post('/test', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const result = await sendPushTest({ orgId: user.org_id, userId: user.id });
  if (!result.configured) {
    return c.json({ error: 'Browser notifications are not configured on this server', code: 'PUSH_NOT_CONFIGURED' }, 503);
  }
  return c.json(result);
});
