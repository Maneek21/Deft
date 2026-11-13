import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { eq, and, isNotNull, isNull, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { users, icsSubscriptions, tasks, events, projects, orgMembers } from '@deft/db/schema';
import { icsPublishTokens } from '@deft/db/ics-publish-tokens';
import { generateICS, humanizeIcsError, newPublishToken, parseICS, extractICSCalendarName } from '../lib/ics.js';
import { syncOne } from '../workers/handlers/ics-sync.js';
import { env } from '../lib/env.js';
import { visibleTaskCondition } from '../lib/task-visibility.js';
import { PublicFetchError, fetchCalendarFeedText } from '../lib/public-http-fetch.js';

// Two routers: one public (the feed) mounted before authMiddleware, one
// authenticated for management. Both export from the same module so the
// surface is easy to find.

export const icsPublicRoutes = new Hono();
export const icsRoutes = new Hono();

// Any failure in these handlers is answered and logged without the error
// object or request input: database errors can carry statement parameters
// (the feed URL or publish token). Only the route and server-issued ids (the
// user, and a subscription row already loaded or created) are logged; request
// path input is never logged.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
function logRouteFailure(c: Context, route: string, err: unknown, subscriptionId?: string): void {
  const user = c.get('user') as { id?: string } | undefined;
  const parts = [`[ics] ${route} failed`];
  if (user?.id && SAFE_ID.test(user.id)) parts.push(`user=${user.id}`);
  if (subscriptionId && SAFE_ID.test(subscriptionId)) parts.push(`subscription=${subscriptionId}`);
  console.error(`${parts.join(' ')}: ${humanizeIcsError(err)}`);
}

function guarded(route: string, handler: (c: Context) => Promise<Response>) {
  return async (c: Context): Promise<Response> => {
    try {
      return await handler(c);
    } catch (err) {
      logRouteFailure(c, route, err);
      return c.json({ error: 'Calendar feed request failed', code: 'ICS_ROUTE_FAILED' }, 500);
    }
  };
}

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
icsPublicRoutes.get('/feed/:token', guarded('GET /feed', async (c) => {
  const token = c.req.param('token');
  if (!token || token.length < 16) {
    return c.text('Not found', 404);
  }

  // A token serves exactly the workspace it was issued in, and only while its
  // owner is an active member there.
  const [feed] = await db
    .select({ id: users.id, name: users.name, org_id: icsPublishTokens.org_id })
    .from(icsPublishTokens)
    .innerJoin(users, eq(users.id, icsPublishTokens.user_id))
    .innerJoin(orgMembers, and(
      eq(orgMembers.org_id, icsPublishTokens.org_id),
      eq(orgMembers.user_id, icsPublishTokens.user_id),
      eq(orgMembers.is_active, true),
    ))
    .where(and(eq(icsPublishTokens.token, token), isNull(icsPublishTokens.revoked_at)))
    .limit(1);
  if (!feed) return c.text('Not found', 404);
  const user = { id: feed.id, name: feed.name };
  const orgId = feed.org_id;

  const horizonStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days back
  const horizonEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year forward

  // 1. Live tasks with due dates, where the user is the assignee: no deleted or
  // template tasks, nothing from an archived or deleted project.
  const taskRows = await db
    .select({
      id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      description: tasks.description,
      due_date: tasks.due_date,
      project_prefix: projects.prefix,
    })
    .from(tasks)
    .innerJoin(projects, and(eq(tasks.project_id, projects.id), eq(projects.org_id, orgId)))
    .where(
      and(
        eq(tasks.org_id, orgId),
        eq(tasks.assignee_id, user.id),
        eq(tasks.is_deleted, false),
        eq(tasks.is_template, false),
        eq(projects.is_archived, false),
        eq(projects.is_deleted, false),
        visibleTaskCondition(user.id),
        isNotNull(tasks.due_date),
        gte(tasks.due_date, horizonStart),
        lte(tasks.due_date, horizonEnd),
      ),
    )
    .limit(500);

  // 2. Deft-native and ICS-ingested events for this user.
  const eventRows = await db
    .select({
      id: events.id,
      title: events.title,
      body: events.body,
      source: events.source,
      timestamp: events.timestamp,
      metadata: events.metadata,
    })
    .from(events)
    .where(
      and(
        eq(events.org_id, orgId),
        eq(events.user_id, user.id),
        inArray(events.source, ['native', 'ics']),
        eq(events.event_type, 'calendar_event'),
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
        url: `${appUrl}/tasks?task=${t.project_prefix}-${t.number}`,
      })),
      ...eventRows.map((e) => {
        const meta = (e.metadata ?? {}) as { end?: string | null; all_day?: boolean };
        return {
          uid: `${e.source}-event-${e.id}@deft`,
          summary: e.title ?? '(untitled)',
          description: e.body ?? null,
          start: e.timestamp as Date,
          end: meta.end ? new Date(meta.end) : null,
          all_day: Boolean(meta.all_day),
          url: e.source === 'native' ? `${appUrl}/calendar` : null,
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
}));

// ─── Authenticated management ────────────────────────────────────────────────

// GET /api/ics/subscriptions
icsRoutes.get('/subscriptions', guarded('GET /subscriptions', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const subs = await db
    .select()
    .from(icsSubscriptions)
    .where(and(eq(icsSubscriptions.user_id, user.id), eq(icsSubscriptions.org_id, user.org_id)));
  return c.json(subs);
}));

const icsUrlSchema = z.string().trim().min(1).max(2048).refine((value) => {
  try {
    const normalized = value.replace(/^webcal:\/\//i, 'https://');
    const url = new URL(normalized);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'Must be an http, https, or webcal ICS URL');

// POST /api/ics/subscriptions
const createSchema = z.object({
  ics_url: icsUrlSchema,
  label: z.string().max(120).optional(),
  sync_interval_min: z.number().int().min(5).max(720).optional(),
});

const previewSchema = z.object({
  ics_url: icsUrlSchema,
});

const updateSchema = z.object({
  label: z.string().max(120).nullable().optional(),
  sync_interval_min: z.number().int().min(5).max(720).optional(),
  is_active: z.boolean().optional(),
});

// POST /api/ics/preview
icsRoutes.post('/preview', guarded('POST /preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', detail: parsed.error.message }, 400);
  }

  try {
    const text = await fetchICSWithLimits(parsed.data.ics_url);
    const parsedEvents = parseICS(text).sort((a, b) => a.start.getTime() - b.start.getTime());
    const now = Date.now();
    const upcoming = parsedEvents
      .filter((event) => event.start.getTime() >= now - 24 * 60 * 60 * 1000)
      .slice(0, 5)
      .map((event) => ({
        uid: event.uid,
        title: event.summary || '(untitled event)',
        starts_at: event.start.toISOString(),
        ends_at: event.end?.toISOString() ?? null,
        all_day: event.all_day,
        location: event.location,
      }));

    return c.json({
      ok: true,
      calendar_name: extractICSCalendarName(text),
      event_count: parsedEvents.length,
      upcoming,
    });
  } catch (err) {
    logRouteFailure(c, 'POST /preview', err);
    return c.json({
      error: 'Preview failed',
      code: 'PREVIEW_FAILED',
      detail: humanizeIcsError(err),
    }, 502);
  }
}));

icsRoutes.post('/subscriptions', guarded('POST /subscriptions', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', detail: parsed.error.message }, 400);
  }

  const url = parsed.data.ics_url.trim().replace(/^webcal:\/\//i, 'https://');

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
  if (!created) {
    return c.json({ error: 'Failed to create subscription', code: 'CREATE_FAILED' }, 500);
  }

  try {
    await syncOne({
      id: created.id,
      org_id: created.org_id,
      user_id: created.user_id,
      ics_url: created.ics_url,
      label: created.label,
    });
  } catch (err) {
    logRouteFailure(c, 'POST /subscriptions (initial sync)', err, created.id);
    await db
      .update(icsSubscriptions)
      .set({ last_error: humanizeIcsError(err), last_synced_at: new Date() })
      .where(eq(icsSubscriptions.id, created.id));
  }

  const [refreshed] = await db
    .select()
    .from(icsSubscriptions)
    .where(eq(icsSubscriptions.id, created.id))
    .limit(1);

  return c.json(refreshed ?? created, 201);
}));

// PATCH /api/ics/subscriptions/:id
icsRoutes.patch('/subscriptions/:id', guarded('PATCH /subscriptions/:id', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const id = c.req.param('id') as string;
  const body = await c.req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', detail: parsed.error.message }, 400);
  }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.label !== undefined) updates.label = parsed.data.label?.trim() || null;
  if (parsed.data.sync_interval_min !== undefined) updates.sync_interval_min = parsed.data.sync_interval_min;
  if (parsed.data.is_active !== undefined) updates.is_active = parsed.data.is_active;

  const [updated] = await db
    .update(icsSubscriptions)
    .set(updates)
    .where(and(eq(icsSubscriptions.id, id), eq(icsSubscriptions.user_id, user.id), eq(icsSubscriptions.org_id, user.org_id)))
    .returning();
  if (!updated) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json(updated);
}));

// DELETE /api/ics/subscriptions/:id
icsRoutes.delete('/subscriptions/:id', guarded('DELETE /subscriptions/:id', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const id = c.req.param('id') as string;
  const [removed] = await db
    .delete(icsSubscriptions)
    .where(and(eq(icsSubscriptions.id, id), eq(icsSubscriptions.user_id, user.id), eq(icsSubscriptions.org_id, user.org_id)))
    .returning({ id: icsSubscriptions.id });
  if (!removed) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ ok: true });
}));

// POST /api/ics/subscriptions/:id/sync — force-sync a single subscription
icsRoutes.post('/subscriptions/:id/sync', guarded('POST /subscriptions/:id/sync', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const id = c.req.param('id') as string;
  const [sub] = await db
    .select()
    .from(icsSubscriptions)
    .where(and(eq(icsSubscriptions.id, id), eq(icsSubscriptions.user_id, user.id), eq(icsSubscriptions.org_id, user.org_id)))
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
    logRouteFailure(c, 'POST /subscriptions/:id/sync', err, sub.id);
    const msg = humanizeIcsError(err);
    await db
      .update(icsSubscriptions)
      .set({ last_error: msg, last_synced_at: new Date() })
      .where(eq(icsSubscriptions.id, sub.id));
    return c.json({ error: 'Sync failed', code: 'SYNC_FAILED', detail: msg }, 502);
  }
}));

type FeedDb = Pick<typeof db, 'select' | 'insert'>;

// The caller's live feed token in their current workspace, created if missing.
// The partial unique index keeps one live row per person per workspace, so
// concurrent first loads converge on the same row.
async function liveFeedToken(tx: FeedDb, user: { id: string; org_id: string }): Promise<string> {
  const live = and(eq(icsPublishTokens.org_id, user.org_id), eq(icsPublishTokens.user_id, user.id), isNull(icsPublishTokens.revoked_at));
  const read = async () => (await tx.select({ token: icsPublishTokens.token }).from(icsPublishTokens).where(live).limit(1))[0]?.token;
  const existing = await read();
  if (existing) return existing;
  await tx.insert(icsPublishTokens).values({ org_id: user.org_id, user_id: user.id, token: newPublishToken() }).onConflictDoNothing();
  const created = await read();
  if (!created) throw new Error('Feed token could not be created');
  return created;
}

// GET /api/ics/my-feed-url — the caller's feed URL for their current workspace.
icsRoutes.get('/my-feed-url', guarded('GET /my-feed-url', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const token = await liveFeedToken(db, user);
  // Public feed URL — clients paste this into their calendar app.
  return c.json({ feed_url: `${publicApiBase(c)}/api/ics/feed/${token}` });
}));

// POST /api/ics/my-feed-url/regenerate — rotate the current workspace's feed
// token. Subscribers of the old URL get 404 until they update it; feeds in
// other workspaces are unchanged.
icsRoutes.post('/my-feed-url/regenerate', guarded('POST /my-feed-url/regenerate', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const token = await db.transaction(async (tx) => {
    await tx.update(icsPublishTokens).set({ revoked_at: new Date() }).where(and(
      eq(icsPublishTokens.org_id, user.org_id), eq(icsPublishTokens.user_id, user.id), isNull(icsPublishTokens.revoked_at)));
    return liveFeedToken(tx, user);
  });
  return c.json({ feed_url: `${publicApiBase(c)}/api/ics/feed/${token}` });
}));

async function fetchICSWithLimits(url: string): Promise<string> {
  const text = await fetchCalendarFeedText(url);
  if (/<!doctype html|<html[\s>]/i.test(text.slice(0, 500))) {
    throw new Error('The URL returned a web page, not an ICS feed');
  }
  return text;
}
