import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { nativeCreate, nativeCreateKey, NativeCreateError } from '../lib/native-create.js';
import { events } from '@deft/db/schema';
import { createNativeCalendarEventInTransaction } from '../lib/native-calendar.js';
import { validateCalendarEventRange } from '../lib/calendar-event-range.js';

export const eventRoutes = new Hono();

const attendeeSchema = z.object({
  email: z.string().trim().email(),
  displayName: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

// Schema for creating a native calendar event
export const createEventSchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  start: z.string(),
  end: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  metadata: z.object({
    attendees: z.array(attendeeSchema).max(100).optional(),
  }).optional(),
});

// POST / — create a native calendar event
eventRoutes.post('/', async (c) => {
  try {
  const user = c.get('user');
  const body = await c.req.json();

  const parsed = createEventSchema.safeParse(body);
  if (!parsed.success) {
    const firstError = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return c.json({ error: firstError || 'Validation error', code: 'VALIDATION_ERROR' }, 400);
  }

  const { title, start, end, description, location, metadata } = parsed.data;

  const range = validateCalendarEventRange(start, end);
  if (!range.ok) return c.json({ error: range.error, code: range.code }, 400);

  const { value: created } = await nativeCreate({
    orgId: user.org_id, userId: user.id, operation: 'event',
    key: nativeCreateKey(c.req.header('Idempotency-Key')), payload: parsed.data,
    replay: async (tx, id) => (await tx.select().from(events).where(and(eq(events.id, id), eq(events.org_id, user.org_id), eq(events.user_id, user.id), eq(events.source, 'native'))).limit(1))[0],
    create: tx => createNativeCalendarEventInTransaction(tx, { orgId: user.org_id, userId: user.id, email: user.email,
      input: { title, start, end, description, location, attendees: metadata?.attendees } }),
  });
  return c.json(created, 201);
  } catch (err) {
    if (err instanceof NativeCreateError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
});

// PATCH /:id — update a native event
eventRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const parsed = createEventSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'Invalid event update', code: 'VALIDATION_ERROR' }, 400);
  }
  const body = parsed.data;

  const [existing] = await db.select().from(events)
    .where(and(eq(events.id, id), eq(events.org_id,user.org_id), eq(events.user_id, user.id), eq(events.source, 'native')))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Event not found or not editable', code: 'NOT_FOUND' }, 404);
  }

  const updates: Record<string, any> = {};
  const metaUpdates = { ...(existing.metadata as any) };

  if (body.start !== undefined || body.end !== undefined) {
    const range = validateCalendarEventRange(
      body.start ?? metaUpdates.start ?? existing.timestamp.toISOString(),
      body.end ?? metaUpdates.end,
    );
    if (!range.ok) return c.json({ error: range.error, code: range.code }, 400);
    updates.timestamp = range.start;
    metaUpdates.start = range.start.toISOString();
    metaUpdates.end = range.end.toISOString();
  }

  if (body.title) updates.title = body.title;
  if (body.description !== undefined) updates.body = body.description;
  if (body.location !== undefined) {
    metaUpdates.location = body.location || null;
  }
  if (body.metadata?.attendees !== undefined) {
    const parsedAttendees = z.array(attendeeSchema).max(100).safeParse(body.metadata.attendees);
    if (!parsedAttendees.success) {
      return c.json({ error: 'Invalid attendees', code: 'VALIDATION_ERROR' }, 400);
    }
    metaUpdates.attendees = parsedAttendees.data.map((attendee) => ({
      email: attendee.email,
      displayName: attendee.displayName ?? attendee.name ?? attendee.email.split('@')[0],
    }));
  }

  updates.metadata = metaUpdates;

  const [updated] = await db.update(events).set(updates)
    .where(and(eq(events.id,id),eq(events.org_id,user.org_id),eq(events.user_id,user.id),eq(events.source,'native'))).returning();

  return c.json(updated);
});

// DELETE /:id — delete a native event
eventRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const [existing] = await db.select({ id: events.id }).from(events)
    .where(and(eq(events.id, id), eq(events.org_id,user.org_id), eq(events.user_id, user.id), eq(events.source, 'native')))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Event not found or not deletable', code: 'NOT_FOUND' }, 404);
  }

  await db.delete(events).where(and(eq(events.id,id),eq(events.org_id,user.org_id),eq(events.user_id,user.id),eq(events.source,'native')));

  return c.json({ deleted: true });
});
