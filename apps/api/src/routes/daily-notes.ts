import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, ilike } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { notes } from '@deft/db/schema';

export const dailyNoteRoutes = new Hono();

const createNoteSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  icon: z.string().nullable().optional(),
});

const updateNoteSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  icon: z.string().nullable().optional(),
  is_pinned: z.boolean().optional(),
});

// GET / — list all notes for user
dailyNoteRoutes.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q'); // optional search

  const rows = await db.select({
    id: notes.id,
    title: notes.title,
    content: notes.content,
    icon: notes.icon,
    is_pinned: notes.is_pinned,
    created_at: notes.created_at,
    updated_at: notes.updated_at,
  }).from(notes)
    .where(and(
      eq(notes.user_id, user.id),
      eq(notes.org_id, user.org_id),
      eq(notes.is_deleted, false),
      ...(q ? [ilike(notes.title, `%${q}%`)] : []),
    ))
    .orderBy(desc(notes.is_pinned), desc(notes.updated_at))
    .limit(100);

  return c.json(rows);
});

// POST / — create a new note
dailyNoteRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = createNoteSchema.safeParse(body);

  const [note] = await db.insert(notes).values({
    org_id: user.org_id,
    user_id: user.id,
    title: parsed.success && parsed.data.title ? parsed.data.title : '',
    content: parsed.success && parsed.data.content ? parsed.data.content : '',
    icon: parsed.success && parsed.data.icon ? parsed.data.icon : null,
  }).returning();

  return c.json(note, 201);
});

// GET /:id — get a single note
dailyNoteRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');

  const [note] = await db.select().from(notes)
    .where(and(
      eq(notes.id, noteId),
      eq(notes.user_id, user.id),
      eq(notes.is_deleted, false),
    ))
    .limit(1);

  if (!note) {
    return c.json({ error: 'Note not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json(note);
});

// PATCH /:id — update a note
dailyNoteRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateNoteSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', code: 'VALIDATION_ERROR' }, 400);
  }

  // Verify ownership
  const [existing] = await db.select({ id: notes.id }).from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.user_id, user.id), eq(notes.is_deleted, false)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Note not found', code: 'NOT_FOUND' }, 404);
  }

  const updates: Record<string, any> = {};
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.content !== undefined) updates.content = parsed.data.content;
  if (parsed.data.icon !== undefined) updates.icon = parsed.data.icon;
  if (parsed.data.is_pinned !== undefined) updates.is_pinned = parsed.data.is_pinned;

  if (Object.keys(updates).length === 0) {
    return c.json(existing);
  }

  const [updated] = await db.update(notes)
    .set(updates)
    .where(eq(notes.id, noteId))
    .returning();

  return c.json(updated);
});

// DELETE /:id — soft delete a note
dailyNoteRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');

  const [existing] = await db.select({ id: notes.id }).from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.user_id, user.id)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Note not found', code: 'NOT_FOUND' }, 404);
  }

  await db.update(notes)
    .set({ is_deleted: true })
    .where(eq(notes.id, noteId));

  return c.json({ success: true });
});
