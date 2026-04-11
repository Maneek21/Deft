import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, ilike, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { tags, entityTags, tasks, messages, users, projects, notes } from '@deft/db/schema';

export const tagRoutes = new Hono();

const createTagSchema = z.object({
  name: z.string().min(1).max(50).transform(s => s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')),
  color: z.string().nullable().optional(),
});

const applyTagSchema = z.object({
  entity_type: z.enum(['message', 'task', 'clip', 'daily_note', 'note']),
  entity_id: z.string().min(1),
});

const removeTagSchema = z.object({
  entity_type: z.enum(['message', 'task', 'clip', 'daily_note', 'note']),
  entity_id: z.string().min(1),
});

// GET / — list all tags for org with counts
tagRoutes.get('/', async (c) => {
  const user = c.get('user');

  const result = await db.select({
    id: tags.id,
    name: tags.name,
    color: tags.color,
    created_at: tags.created_at,
  }).from(tags)
    .where(eq(tags.org_id, user.org_id))
    .orderBy(tags.name);

  // Get counts per tag
  const tagIds = result.map(t => t.id);
  const counts = new Map<string, number>();

  if (tagIds.length > 0) {
    const countRows = await db.select({
      tag_id: entityTags.tag_id,
      count: sql<number>`count(*)::int`,
    }).from(entityTags)
      .where(eq(entityTags.org_id, user.org_id))
      .groupBy(entityTags.tag_id);

    for (const row of countRows) {
      counts.set(row.tag_id, row.count);
    }
  }

  const tagsWithCounts = result.map(t => ({
    ...t,
    count: counts.get(t.id) || 0,
  }));

  return c.json(tagsWithCounts);
});

// POST / — create tag
tagRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createTagSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid tag name', code: 'VALIDATION_ERROR' }, 400);
  }

  // Check for existing
  const [existing] = await db.select().from(tags)
    .where(and(eq(tags.org_id, user.org_id), eq(tags.name, parsed.data.name)))
    .limit(1);

  if (existing) {
    return c.json(existing); // Return existing tag (idempotent)
  }

  const [tag] = await db.insert(tags).values({
    org_id: user.org_id,
    name: parsed.data.name,
    color: parsed.data.color || null,
  }).returning();

  return c.json(tag, 201);
});

// DELETE /:id — delete tag
tagRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const tagId = c.req.param('id');

  const [tag] = await db.select().from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.org_id, user.org_id)))
    .limit(1);

  if (!tag) {
    return c.json({ error: 'Tag not found', code: 'NOT_FOUND' }, 404);
  }

  // entity_tags cascade-delete via FK
  await db.delete(tags).where(eq(tags.id, tagId));
  return c.json({ success: true });
});

// POST /:id/apply — apply tag to entity
tagRoutes.post('/:id/apply', async (c) => {
  const user = c.get('user');
  const tagId = c.req.param('id');
  const body = await c.req.json();
  const parsed = applyTagSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request', code: 'VALIDATION_ERROR' }, 400);
  }

  // Verify tag exists in this org
  const [tag] = await db.select().from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.org_id, user.org_id)))
    .limit(1);

  if (!tag) {
    return c.json({ error: 'Tag not found', code: 'NOT_FOUND' }, 404);
  }

  // Upsert (ignore if already applied)
  try {
    const [et] = await db.insert(entityTags).values({
      org_id: user.org_id,
      tag_id: tagId,
      entity_type: parsed.data.entity_type,
      entity_id: parsed.data.entity_id,
    }).onConflictDoNothing().returning();

    return c.json(et || { tag_id: tagId, entity_type: parsed.data.entity_type, entity_id: parsed.data.entity_id });
  } catch {
    return c.json({ tag_id: tagId, applied: true });
  }
});

// DELETE /:id/apply — remove tag from entity
tagRoutes.delete('/:id/apply', async (c) => {
  const user = c.get('user');
  const tagId = c.req.param('id');
  const body = await c.req.json();
  const parsed = removeTagSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request', code: 'VALIDATION_ERROR' }, 400);
  }

  await db.delete(entityTags)
    .where(and(
      eq(entityTags.tag_id, tagId),
      eq(entityTags.entity_type, parsed.data.entity_type),
      eq(entityTags.entity_id, parsed.data.entity_id),
      eq(entityTags.org_id, user.org_id),
    ));

  return c.json({ success: true });
});

// GET /:id/entities — list all entities with this tag (with resolved titles)
tagRoutes.get('/:id/entities', async (c) => {
  const user = c.get('user');
  const tagId = c.req.param('id');
  const entityType = c.req.query('type'); // optional filter

  const rows = await db.select().from(entityTags)
    .where(and(
      eq(entityTags.tag_id, tagId),
      eq(entityTags.org_id, user.org_id),
      ...(entityType ? [eq(entityTags.entity_type, entityType as any)] : []),
    ))
    .orderBy(desc(entityTags.created_at))
    .limit(100);

  // Batch-resolve entities by type
  const taskIds = rows.filter(r => r.entity_type === 'task').map(r => r.entity_id);
  const messageIds = rows.filter(r => r.entity_type === 'message').map(r => r.entity_id);
  const noteIds = rows.filter(r => r.entity_type === 'note' || r.entity_type === 'daily_note').map(r => r.entity_id);

  const taskMap = new Map<string, { title: string; number: number; prefix: string; status: string; project_id: string }>();
  const messageMap = new Map<string, { content: string; user_name: string; space_id: string }>();
  const noteMap = new Map<string, { title: string }>();

  if (taskIds.length > 0) {
    const taskRows = await db.select({
      id: tasks.id, title: tasks.title, number: tasks.number,
      status: tasks.status, prefix: projects.prefix,
    }).from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(inArray(tasks.id, taskIds));
    for (const t of taskRows) taskMap.set(t.id, { title: t.title, number: t.number, prefix: t.prefix, status: t.status, project_id: t.id });
  }

  if (messageIds.length > 0) {
    const msgRows = await db.select({
      id: messages.id, content: messages.content, user_name: users.name, space_id: messages.space_id,
    }).from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(inArray(messages.id, messageIds));
    for (const m of msgRows) messageMap.set(m.id, { content: m.content.slice(0, 120), user_name: m.user_name, space_id: m.space_id });
  }

  if (noteIds.length > 0) {
    const noteRows = await db.select({
      id: notes.id, title: notes.title,
    }).from(notes)
      .where(inArray(notes.id, noteIds));
    for (const n of noteRows) noteMap.set(n.id, { title: n.title });
  }

  const results = rows.map(row => {
    const base = { id: row.id, entity_type: row.entity_type, entity_id: row.entity_id, created_at: row.created_at };
    if (row.entity_type === 'task') {
      const t = taskMap.get(row.entity_id);
      return { ...base, title: t ? `${t.prefix}-${t.number}: ${t.title}` : 'Unknown task', status: t?.status, task_ref: t ? `${t.prefix}-${t.number}` : undefined };
    }
    if (row.entity_type === 'message') {
      const m = messageMap.get(row.entity_id);
      return { ...base, title: m ? m.content : 'Unknown message', author: m?.user_name, space_id: m?.space_id };
    }
    if (row.entity_type === 'note' || row.entity_type === 'daily_note') {
      const n = noteMap.get(row.entity_id);
      return { ...base, title: n?.title || 'Untitled note' };
    }
    return { ...base, title: `${row.entity_type}: ${row.entity_id.slice(0, 8)}` };
  });

  return c.json(results);
});

// GET /entity/:type/:entityId — get all tags for a specific entity
tagRoutes.get('/entity/:type/:entityId', async (c) => {
  const user = c.get('user');
  const entityType = c.req.param('type');
  const entityId = c.req.param('entityId');

  const results = await db.select({
    id: tags.id,
    name: tags.name,
    color: tags.color,
  }).from(entityTags)
    .innerJoin(tags, eq(entityTags.tag_id, tags.id))
    .where(and(
      eq(entityTags.entity_type, entityType as any),
      eq(entityTags.entity_id, entityId),
      eq(entityTags.org_id, user.org_id),
    ));

  return c.json(results);
});

// GET /search — autocomplete search
tagRoutes.get('/search', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q') || '';

  const results = await db.select({
    id: tags.id,
    name: tags.name,
    color: tags.color,
  }).from(tags)
    .where(and(
      eq(tags.org_id, user.org_id),
      ilike(tags.name, `%${q}%`),
    ))
    .orderBy(tags.name)
    .limit(10);

  return c.json(results);
});
