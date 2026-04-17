import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, ilike, or, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { notes, noteFolders, noteVersions, noteShares, users } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';

const TASK_ID_PATTERN = /([A-Z]+-\d+)/;

async function enqueueNoteCrossReference(
  noteId: string,
  content: string,
  orgId: string,
  userId: string,
): Promise<void> {
  if (!content) return;
  const plain = content.replace(/<[^>]+>/g, '');
  if (!TASK_ID_PATTERN.test(plain)) return;
  try {
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'cross-reference', {
      sourceType: 'note',
      sourceId: noteId,
      content,
      orgId,
      userId,
    });
  } catch (err) {
    console.error('Failed to enqueue note cross-reference job:', (err as Error).message);
  }
}

export const dailyNoteRoutes = new Hono();

const visibilityEnum = z.enum(['private', 'org', 'space']).optional().default('private');

const createNoteSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  icon: z.string().nullable().optional(),
  folder_id: z.string().nullable().optional(),
  is_template: z.boolean().optional(),
  visibility: visibilityEnum,
});

const updateNoteSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  icon: z.string().nullable().optional(),
  is_pinned: z.boolean().optional(),
  folder_id: z.string().nullable().optional(),
  visibility: z.enum(['private', 'org', 'space']).optional(),
});

// ── Folder endpoints ──

// GET /folders — list all folders
dailyNoteRoutes.get('/folders', async (c) => {
  const user = c.get('user');
  const rows = await db.select().from(noteFolders)
    .where(and(eq(noteFolders.user_id, user.id), eq(noteFolders.is_deleted, false)))
    .orderBy(noteFolders.sort_order, noteFolders.name);
  return c.json({ folders: rows });
});

// POST /folders — create folder
dailyNoteRoutes.post('/folders', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { name, icon, parent_folder_id } = body;
  if (!name) return c.json({ error: 'Name required', code: 'VALIDATION_ERROR' }, 400);

  const [folder] = await db.insert(noteFolders).values({
    org_id: user.org_id,
    user_id: user.id,
    name,
    icon: icon || null,
    parent_folder_id: parent_folder_id || null,
  }).returning();

  return c.json(folder, 201);
});

// PATCH /folders/:id — update folder
dailyNoteRoutes.patch('/folders/:id', async (c) => {
  const user = c.get('user');
  const folderId = c.req.param('id');
  const body = await c.req.json();

  const updates: Record<string, any> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.icon !== undefined) updates.icon = body.icon;
  if (body.parent_folder_id !== undefined) updates.parent_folder_id = body.parent_folder_id;
  if (body.sort_order !== undefined) updates.sort_order = body.sort_order;

  const [updated] = await db.update(noteFolders)
    .set(updates)
    .where(and(eq(noteFolders.id, folderId), eq(noteFolders.user_id, user.id)))
    .returning();

  if (!updated) return c.json({ error: 'Folder not found', code: 'NOT_FOUND' }, 404);
  return c.json(updated);
});

// DELETE /folders/:id — soft delete folder
dailyNoteRoutes.delete('/folders/:id', async (c) => {
  const user = c.get('user');
  const folderId = c.req.param('id');

  await db.update(noteFolders)
    .set({ is_deleted: true })
    .where(and(eq(noteFolders.id, folderId), eq(noteFolders.user_id, user.id)));

  // Unset folder_id on notes in this folder
  await db.update(notes)
    .set({ folder_id: null })
    .where(and(eq(notes.folder_id, folderId), eq(notes.user_id, user.id)));

  return c.json({ success: true });
});

// ── Templates ──

// GET /templates — list note templates
dailyNoteRoutes.get('/templates', async (c) => {
  const user = c.get('user');
  const rows = await db.select({
    id: notes.id,
    title: notes.title,
    content: notes.content,
    icon: notes.icon,
  }).from(notes)
    .where(and(
      eq(notes.org_id, user.org_id),
      eq(notes.is_template, true),
      eq(notes.is_deleted, false),
    ))
    .orderBy(notes.title);
  return c.json({ templates: rows });
});

// ── Note CRUD ──

// GET / — list all notes for user (own notes + org-visible notes)
dailyNoteRoutes.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q');
  const folderId = c.req.query('folder_id');

  // Base conditions that always apply
  const baseConditions: any[] = [
    eq(notes.org_id, user.org_id),
    eq(notes.is_deleted, false),
    eq(notes.is_template, false),
  ];

  if (q) baseConditions.push(ilike(notes.title, `%${q}%`));
  if (folderId) baseConditions.push(eq(notes.folder_id, folderId));

  // Visibility: own notes OR org-visible notes
  const visibilityCondition = or(
    eq(notes.user_id, user.id),
    eq(notes.visibility, 'org'),
  );

  const rows = await db.select({
    id: notes.id,
    title: notes.title,
    content: notes.content,
    icon: notes.icon,
    is_pinned: notes.is_pinned,
    folder_id: notes.folder_id,
    visibility: notes.visibility,
    user_id: notes.user_id,
    created_at: notes.created_at,
    updated_at: notes.updated_at,
  }).from(notes)
    .where(and(...baseConditions, visibilityCondition))
    .orderBy(desc(notes.is_pinned), desc(notes.updated_at))
    .limit(100);

  return c.json(rows);
});

// POST / — create a new note (optionally from template)
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
    folder_id: parsed.success && parsed.data.folder_id ? parsed.data.folder_id : null,
    is_template: parsed.success && parsed.data.is_template ? parsed.data.is_template : false,
    visibility: parsed.success && parsed.data.visibility ? parsed.data.visibility : 'private',
  }).returning();

  // Task 5.1 — scan note content for PREFIX-N task refs on create
  if (note && note.content) {
    await enqueueNoteCrossReference(note.id, note.content, user.org_id, user.id);
  }

  return c.json(note, 201);
});

// GET /:id — get a single note (own notes + org-visible notes)
dailyNoteRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');

  const [note] = await db.select().from(notes)
    .where(and(
      eq(notes.id, noteId),
      eq(notes.org_id, user.org_id),
      eq(notes.is_deleted, false),
      or(eq(notes.user_id, user.id), eq(notes.visibility, 'org')),
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

  // Fetch full existing note (owner or org-visible for this org)
  const [full] = await db.select().from(notes)
    .where(and(
      eq(notes.id, noteId),
      eq(notes.org_id, user.org_id),
      eq(notes.is_deleted, false),
      or(eq(notes.user_id, user.id), eq(notes.visibility, 'org')),
    ))
    .limit(1);

  if (!full) {
    return c.json({ error: 'Note not found', code: 'NOT_FOUND' }, 404);
  }

  // Only the note owner can modify a note
  if (full.user_id !== user.id) {
    return c.json({ error: 'Only the note owner can edit this note', code: 'FORBIDDEN' }, 403);
  }

  const updates: Record<string, any> = {};
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.content !== undefined) updates.content = parsed.data.content;
  if (parsed.data.icon !== undefined) updates.icon = parsed.data.icon;
  if (parsed.data.is_pinned !== undefined) updates.is_pinned = parsed.data.is_pinned;
  if (parsed.data.folder_id !== undefined) updates.folder_id = parsed.data.folder_id;
  if (parsed.data.visibility !== undefined) updates.visibility = parsed.data.visibility;

  if (Object.keys(updates).length === 0) {
    return c.json(full);
  }

  // Snapshot version before content changes (max 1 per minute to avoid spam)
  if (parsed.data.content !== undefined && parsed.data.content !== full.content) {
    await db.insert(noteVersions).values({
      note_id: noteId,
      version: full.version,
      title: full.title,
      content: full.content,
      edited_by: user.id,
    }).onConflictDoNothing();
    updates.version = full.version + 1;
  }

  const [updated] = await db.update(notes)
    .set(updates)
    .where(eq(notes.id, noteId))
    .returning();

  // Task 5.1 — enqueue cross-reference scan whenever content changes
  if (updated && parsed.data.content !== undefined) {
    await enqueueNoteCrossReference(noteId, updated.content || '', user.org_id, user.id);
  }

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

// ── Version History ──

// GET /:id/history — list versions
dailyNoteRoutes.get('/:id/history', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');

  const [note] = await db.select({ id: notes.id }).from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.user_id, user.id)))
    .limit(1);
  if (!note) return c.json({ error: 'Note not found', code: 'NOT_FOUND' }, 404);

  const versions = await db.select().from(noteVersions)
    .where(eq(noteVersions.note_id, noteId))
    .orderBy(desc(noteVersions.version));

  return c.json({ versions });
});

// ── Sharing ──

// GET /shared-with-me — notes shared with the current user (must be before /:id)
// Note: this is registered but route ordering means /:id/shares catches first for UUIDs

// GET /:id/shares — list who a note is shared with
dailyNoteRoutes.get('/:id/shares', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');

  const [note] = await db.select({ id: notes.id }).from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.user_id, user.id)))
    .limit(1);
  if (!note) return c.json({ error: 'Note not found', code: 'NOT_FOUND' }, 404);

  const shares = await db.select({
    id: noteShares.id,
    user_id: noteShares.shared_with_user_id,
    permission: noteShares.permission,
    user_name: users.name,
    user_email: users.email,
    created_at: noteShares.created_at,
  })
    .from(noteShares)
    .innerJoin(users, eq(noteShares.shared_with_user_id, users.id))
    .where(eq(noteShares.note_id, noteId));

  return c.json({ shares });
});

// POST /:id/shares — share note with a user
dailyNoteRoutes.post('/:id/shares', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');
  const { user_id: targetUserId, permission = 'view' } = await c.req.json();

  if (!targetUserId) return c.json({ error: 'user_id required', code: 'VALIDATION_ERROR' }, 400);

  const [note] = await db.select({ id: notes.id }).from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.user_id, user.id)))
    .limit(1);
  if (!note) return c.json({ error: 'Note not found', code: 'NOT_FOUND' }, 404);

  const [share] = await db.insert(noteShares).values({
    note_id: noteId,
    shared_with_user_id: targetUserId,
    permission,
  }).onConflictDoNothing().returning();

  return c.json(share || { already_shared: true }, 201);
});

// DELETE /:id/shares/:userId — unshare note
dailyNoteRoutes.delete('/:id/shares/:userId', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');
  const targetUserId = c.req.param('userId');

  const [note] = await db.select({ id: notes.id }).from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.user_id, user.id)))
    .limit(1);
  if (!note) return c.json({ error: 'Note not found', code: 'NOT_FOUND' }, 404);

  await db.delete(noteShares)
    .where(and(eq(noteShares.note_id, noteId), eq(noteShares.shared_with_user_id, targetUserId)));

  return c.json({ success: true });
});
