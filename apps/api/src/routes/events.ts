import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { events } from '@deft/db/schema';

export const eventRoutes = new Hono();

// Schema for creating a native calendar event
const createEventSchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  start: z.string(),
  end: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
});

// POST / — create a native calendar event
eventRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();

  const parsed = createEventSchema.safeParse(body);
  if (!parsed.success) {
    const firstError = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return c.json({ error: firstError || 'Validation error', code: 'VALIDATION_ERROR' }, 400);
  }

  const { title, start, end, description, location } = parsed.data;

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return c.json({ error: 'Invalid date format', code: 'INVALID_DATE' }, 400);
  }

  if (endDate <= startDate) {
    return c.json({ error: 'end must be after start', code: 'INVALID_RANGE' }, 400);
  }

  const [created] = await db.insert(events).values({
    org_id: user.org_id,
    source: 'native' as const,
    event_type: 'calendar_event',
    external_id: null,
    title,
    body: description || null,
    url: null,
    actor: user.email,
    timestamp: startDate,
    metadata: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      location: location || null,
      attendees: [],
      hangoutLink: null,
      status: 'confirmed',
      allDay: false,
    },
    user_id: user.id,
    connected_account_id: null,
  }).returning();

  return c.json(created, 201);
});

// PATCH /:id — update a native event
eventRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();

  const [existing] = await db.select().from(events)
    .where(and(eq(events.id, id), eq(events.user_id, user.id), eq(events.source, 'native')))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Event not found or not editable', code: 'NOT_FOUND' }, 404);
  }

  const updates: Record<string, any> = {};
  const metaUpdates = { ...(existing.metadata as any) };

  if (body.title) updates.title = body.title;
  if (body.description !== undefined) updates.body = body.description;
  if (body.start) {
    const startDate = new Date(body.start);
    updates.timestamp = startDate;
    metaUpdates.start = startDate.toISOString();
  }
  if (body.end) {
    metaUpdates.end = new Date(body.end).toISOString();
  }
  if (body.location !== undefined) {
    metaUpdates.location = body.location || null;
  }

  updates.metadata = metaUpdates;

  const [updated] = await db.update(events).set(updates)
    .where(eq(events.id, id)).returning();

  return c.json(updated);
});

// DELETE /:id — delete a native event
eventRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const [existing] = await db.select({ id: events.id }).from(events)
    .where(and(eq(events.id, id), eq(events.user_id, user.id), eq(events.source, 'native')))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Event not found or not deletable', code: 'NOT_FOUND' }, 404);
  }

  await db.delete(events).where(eq(events.id, id));

  return c.json({ deleted: true });
});
