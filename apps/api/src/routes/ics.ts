import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, isNotNull, gte, lte } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { users, icsSubscriptions, tasks, events } from '@deft/db/schema';
import { generateICS, newPublishToken } from '../lib/ics.js';
import { syncOne } from '../workers/handlers/ics-sync.js';
import { env } from '../lib/env.js';

// Two routers: one public (the feed) mounted before authMiddleware, one
// authenticated for management. Both export from the same module so the
// surface is easy to find.

export const icsPublicRoutes = new Hono();
export const icsRoutes = new Hono();

function publicApiBase(c: { req: { url: string } }): string {
  const configured = process.env.NEXT_PUBLIC_API_URL || process.env.DEFT_API_URL;
  if (configured) return configured.replace(/\/$/, '');
  return new URL(c.req.url).origin.replace(/\/$/, '');
}

// ─── Public feed ─────────────────────────────────────────────────────────────
// GET /api/ics/feed/:token — token IS the auth. No JWT, no session.
// Returns a text/calendar VCALENDAR with the user's tasks-with-due-dates and
// ICS-ingested events. Subscribed clients (Apple/Google/Outlook) re-fetch on
// their own schedule; we never push.
icsPublicRoutes.get('/feed/:token', async (c) => {
  const token = c.req.param('token');
  if (!token || token.length < 16) {
    return c.text('Not found', 404);
  }

  const [user] = await db
    .select({ id: users.id, name: users.name, org_id: users.id /* unused */ })
    .from(users)
    .where(eq(users.ics_publish_token, token))
    .limit(1);

  if (!user) {
    return c.text('Not found', 404);
  }

  // Resolve the user's org (single-org self-host: pick any active membership).
  const orgRows = await db.execute(
    // Drizzle doesn't expose the whole orgMembers selector here without an
    // import cycle; raw SQL is fine.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // @ts-ignore
    (await import('drizzle-orm')).sql`
      SELECT org_id FROM org_members WHERE user_id = ${user.id} AND is_active = true LIMIT 1
    `,
  );
  const orgRow = ((orgRows as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (orgRows as unknown as Array<Record<string, unknown>>))[0] as { org_id?: string } | undefined;
  const orgId = orgRow?.org_id;
  if (!orgId) return c.text('Not found', 404);

  const horizonStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days back
  const horizonEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year forward

  // 1. Tasks with due dates, where the user is the assignee.
  const taskRows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      due_date: tasks.due_date,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.assignee_id, user.id),
        isNotNull(tasks.due_date),
        gte(tasks.due_date, horizonStart),
        lte(tasks.due_date, horizonEnd),
      ),
    )
    .limit(500);

  // 2. ICS-ingested events for this user.
  const eventRows = await db
    .select({
      id: events.id,
      title: events.title,
      body: events.body,
      timestamp: events.timestamp,
      metadata: events.metadata,
    })
    .from(events)
    .where(
      and(
        eq(events.org_id, orgId),
        eq(events.user_id, user.id),
        eq(events.source, 'ics'),
        gte(events.timestamp, horizonStart),
        lte(events.timestamp, horizonEnd),
      ),
    )
    .limit(1000);

  const appUrl = env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const ics = generateICS(
    [
      ...taskRows.map((t) => ({
        uid: `task-${t.id}@deft`,
        summary: `[task] ${t.title}`,
        description: t.description ?? null,
        start: t.due_date as Date,
        end: null,
        all_day: true,
        url: `${appUrl}/tasks/${t.id}`,
      })),
      ...eventRows.map((e) => {
        const meta = (e.metadata ?? {}) as { end?: string | null; all_day?: boolean };
        return {
          uid: `event-${e.id}@deft`,
          summary: e.title ?? '(untitled)',
          description: e.body ?? null,
          start: e.timestamp as Date,
          end: meta.end ? new Date(meta.end) : null,
          all_day: Boolean(meta.all_day),
        };
      }),
    ],
    { name: `Deft — ${user.name}`, description: 'Your tasks and synced events from Deft' },
  );

  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="deft.ics"',
      'Cache-Control': 'private, max-age=300',
    },
  });
});

// ─── Authenticated management ────────────────────────────────────────────────

// GET /api/ics/subscriptions
icsRoutes.get('/subscriptions', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const subs = await db
    .select()
    .from(icsSubscriptions)
    .where(and(eq(icsSubscriptions.user_id, user.id), eq(icsSubscriptions.org_id, user.org_id)));
  return c.json(subs);
});

// POST /api/ics/subscriptions
const createSchema = z.object({
  ics_url: z.string().url().max(2048),
  label: z.string().max(120).optional(),
  sync_interval_min: z.number().int().min(5).max(720).optional(),
});

icsRoutes.post('/subscriptions', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', detail: parsed.error.message }, 400);
  }

  const url = parsed.data.ics_url.replace(/^webcal:\/\//i, 'https://');

  const [created] = await db
    .insert(icsSubscriptions)
    .values({
      org_id: user.org_id,
      user_id: user.id,
      ics_url: url,
      label: parsed.data.label ?? null,
      sync_interval_min: parsed.data.sync_interval_min ?? 15,
    })
    .returning();

  return c.json(created, 201);
});

// DELETE /api/ics/subscriptions/:id
icsRoutes.delete('/subscriptions/:id', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const id = c.req.param('id');
  const [removed] = await db
    .delete(icsSubscriptions)
    .where(and(eq(icsSubscriptions.id, id), eq(icsSubscriptions.user_id, user.id)))
    .returning({ id: icsSubscriptions.id });
  if (!removed) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ ok: true });
});

// POST /api/ics/subscriptions/:id/sync — force-sync a single subscription
icsRoutes.post('/subscriptions/:id/sync', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const id = c.req.param('id');
  const [sub] = await db
    .select()
    .from(icsSubscriptions)
    .where(and(eq(icsSubscriptions.id, id), eq(icsSubscriptions.user_id, user.id)))
    .limit(1);
  if (!sub) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

  try {
    const { count } = await syncOne({
      id: sub.id,
      org_id: sub.org_id,
      user_id: sub.user_id,
      ics_url: sub.ics_url,
      label: sub.label,
    });
    const [refreshed] = await db
      .select()
      .from(icsSubscriptions)
      .where(eq(icsSubscriptions.id, sub.id))
      .limit(1);
    return c.json({ ok: true, count, subscription: refreshed });
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 500) ?? 'unknown error';
    await db
      .update(icsSubscriptions)
      .set({ last_error: msg, last_synced_at: new Date() })
      .where(eq(icsSubscriptions.id, sub.id));
    return c.json({ error: 'Sync failed', code: 'SYNC_FAILED', detail: msg }, 502);
  }
});

// GET /api/ics/my-feed-url — returns the user's outbound feed URL.
// Lazily generates the publish token on first call.
icsRoutes.get('/my-feed-url', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const [row] = await db.select({ token: users.ics_publish_token }).from(users).where(eq(users.id, user.id)).limit(1);
  let token = row?.token ?? null;
  if (!token) {
    token = newPublishToken();
    await db.update(users).set({ ics_publish_token: token }).where(eq(users.id, user.id));
  }
  const apiBase = publicApiBase(c);
  // Public feed URL — clients paste this into their calendar app.
  const url = `${apiBase}/api/ics/feed/${token}`;
  return c.json({ feed_url: url });
});

// POST /api/ics/my-feed-url/regenerate — rotate the publish token.
// Existing calendar subscribers will go 404 until they update the URL.
icsRoutes.post('/my-feed-url/regenerate', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const token = newPublishToken();
  await db.update(users).set({ ics_publish_token: token }).where(eq(users.id, user.id));
  const apiBase = publicApiBase(c);
  return c.json({ feed_url: `${apiBase}/api/ics/feed/${token}` });
});
