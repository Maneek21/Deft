import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, ilike, sql, desc, inArray, getTableColumns } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { tags, entityTags, tasks, messages, users, projects, clips, orgMembers, spaces, spaceMembers } from '@deft/db/schema';
import { documents } from '@deft/db/documents';
import type { AuthUser } from '../middleware/auth.js';
import { readableSpaceSql } from '../lib/space-membership.js';
import { visibleTaskCondition } from '../lib/task-visibility.js';
import { visibleDocumentCondition } from '../lib/document-access.js';
import { mappedTargetId, mappedTargetIds } from '../lib/legacy-notes.js';
import { accessibleClipSql } from './clips.js';

export const tagRoutes = new Hono();

const createTagSchema = z.object({
  name: z.string().min(1).max(50).transform(s => s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')),
  color: z.string().nullable().optional(),
});

const applyTagSchema = z.object({
  entity_type: z.enum(['message', 'task', 'clip', 'daily_note', 'note', 'document']),
  entity_id: z.string().min(1),
});

const removeTagSchema = z.object({
  entity_type: z.enum(['message', 'task', 'clip', 'daily_note', 'note', 'document']),
  entity_id: z.string().min(1),
});

type TagEntityType = z.infer<typeof applyTagSchema>['entity_type'];
type StoredTagEntityType = (typeof entityTags.$inferSelect)['entity_type'];

/** `entity_tag_type` gained `document` in upgrade SQL only (0.3.0-preview.155): schema.ts's enum is part of the fresh-install fingerprint, as with teams.ts's resource types. */
function asStoredEntityType(type: TagEntityType): StoredTagEntityType {
  return type as StoredTagEntityType;
}

const isNoteType = (type: string) => type === 'note' || type === 'daily_note';

/**
 * Notes are documents now (F15): a tag named by an old note id is the tag of
 * the document it moved to (the move rewrote every note tag the same way).
 * Null for a note that never moved.
 */
async function normalizeTagEntity(user: AuthUser, entityType: TagEntityType, entityId: string): Promise<{ type: TagEntityType; id: string } | null> {
  if (!isNoteType(entityType)) return { type: entityType, id: entityId };
  const documentId = await mappedTargetId(user.org_id, 'note', entityId);
  return documentId ? { type: 'document', id: documentId } : null;
}

const ENTITY_NOT_FOUND = { error: 'Entity not found', code: 'NOT_FOUND' } as const;

/**
 * Resolves tagged entities the caller may see: each must belong to the
 * caller's org and pass the same access rule its own routes use (space
 * access for messages, task and note visibility, clip access). Entities
 * that are missing or not visible are absent from every map.
 */
async function resolveVisibleTagEntities(
  refs: ReadonlyArray<{ entity_type: string; entity_id: string }>,
  user: AuthUser,
  access: 'member' | 'read' = 'member',
) {
  const idsOf = (...types: string[]) => [...new Set(refs.filter(r => types.includes(r.entity_type)).map(r => r.entity_id))];
  const taskIds = idsOf('task');
  const messageIds = idsOf('message');
  const noteIds = idsOf('note', 'daily_note');
  const clipIds = idsOf('clip');
  // An old note id stands for the document it moved to (normalizeTagEntity).
  const noteDocuments = await mappedTargetIds(user.org_id, 'note', noteIds);
  const documentIds = [...new Set([...idsOf('document'), ...noteDocuments.values()])];

  const taskMap = new Map<string, { title: string; number: number; prefix: string; status: string }>();
  const messageMap = new Map<string, { content: string; user_name: string; space_id: string }>();
  const documentMap = new Map<string, { title: string }>();
  const clipSet = new Set<string>();

  if (taskIds.length > 0) {
    const taskRows = await db.select({
      id: tasks.id, title: tasks.title, number: tasks.number,
      status: tasks.status, prefix: projects.prefix,
    }).from(tasks)
      .innerJoin(projects, and(eq(tasks.project_id, projects.id), eq(projects.org_id, user.org_id)))
      .where(and(
        inArray(tasks.id, taskIds),
        eq(tasks.org_id, user.org_id),
        eq(tasks.is_deleted, false),
        visibleTaskCondition(user.id),
      ));
    for (const t of taskRows) taskMap.set(t.id, { title: t.title, number: t.number, prefix: t.prefix, status: t.status });
  }

  if (messageIds.length > 0) {
    const msgRows = await db.select({
      id: messages.id, content: messages.content, user_name: users.name, space_id: messages.space_id,
    }).from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(and(inArray(messages.id, messageIds), eq(messages.org_id, user.org_id), eq(messages.is_deleted, false),
        access === 'read' ? readableSpaceSql(user.id, messages.space_id, messages.org_id)
          : sql`EXISTS (SELECT 1 FROM ${spaceMembers} WHERE ${spaceMembers.space_id} = ${messages.space_id} AND ${spaceMembers.user_id} = ${user.id})`));
    for (const m of msgRows) messageMap.set(m.id, { content: m.content.slice(0, 120), user_name: m.user_name, space_id: m.space_id });
  }

  if (documentIds.length > 0) {
    const documentRows = await db.select({
      id: documents.id, title: documents.title,
    }).from(documents)
      .where(and(inArray(documents.id, documentIds), visibleDocumentCondition(user.id, user.org_id)));
    for (const d of documentRows) documentMap.set(d.id, { title: d.title });
  }
  // Each old note id resolves to its document's entry.
  const noteMap = new Map<string, { title: string }>();
  for (const [noteId, documentId] of noteDocuments) {
    const document = documentMap.get(documentId);
    if (document) noteMap.set(noteId, document);
  }

  if (clipIds.length > 0) {
    const clipRows = await db.select({ id: clips.id }).from(clips)
      .where(and(inArray(clips.id, clipIds), accessibleClipSql(user.org_id, user.id, access)));
    for (const clip of clipRows) clipSet.add(clip.id);
  }

  const isVisible = (type: string, id: string) => {
    if (type === 'task') return taskMap.has(id);
    if (type === 'message') return messageMap.has(id);
    if (type === 'note' || type === 'daily_note') return noteMap.has(id);
    if (type === 'document') return documentMap.has(id);
    if (type === 'clip') return clipSet.has(id);
    return false;
  };

  return { taskMap, messageMap, noteMap, documentMap, isVisible };
}

/**
 * Per tag, the number of tagged items the caller may see. One grouped query
 * per kind of item, each with the same condition `resolveVisibleTagEntities`
 * applies to that kind, so the work is four queries however many items,
 * spaces or clips the workspace has, and no item is loaded into memory.
 * Documents are counted by their own tags: the notes move rewrote every
 * note tag to its document, and nothing tags a note any more (F15).
 */
async function visibleTagCounts(user: AuthUser): Promise<Array<{ tag_id: string; count: number }>> {
  const count = sql<number>`count(*)::int`;
  const tagged = (...types: TagEntityType[]) => and(eq(entityTags.org_id, user.org_id), inArray(entityTags.entity_type, types.map(asStoredEntityType)));
  const grouped = await Promise.all([
    db.select({ tag_id: entityTags.tag_id, count }).from(entityTags)
      .innerJoin(tasks, and(eq(tasks.id, entityTags.entity_id), eq(tasks.org_id, user.org_id)))
      .innerJoin(projects, and(eq(tasks.project_id, projects.id), eq(projects.org_id, user.org_id)))
      .where(and(tagged('task'), eq(tasks.is_deleted, false), visibleTaskCondition(user.id)))
      .groupBy(entityTags.tag_id),
    // Messages: not deleted, in a space of this org the caller may read.
    db.select({ tag_id: entityTags.tag_id, count }).from(entityTags)
      .innerJoin(messages, and(eq(messages.id, entityTags.entity_id), eq(messages.org_id, user.org_id)))
      .innerJoin(spaces, and(eq(spaces.id, messages.space_id), eq(spaces.org_id, user.org_id)))
      .innerJoin(users, eq(users.id, messages.user_id))
      .where(and(tagged('message'), eq(messages.is_deleted, false),
        readableSpaceSql(user.id, messages.space_id, messages.org_id)))
      .groupBy(entityTags.tag_id),
    db.select({ tag_id: entityTags.tag_id, count }).from(entityTags)
      .innerJoin(documents, and(eq(documents.id, entityTags.entity_id), eq(documents.org_id, user.org_id)))
      .where(and(tagged('document'), visibleDocumentCondition(user.id, user.org_id)))
      .groupBy(entityTags.tag_id),
    db.select({ tag_id: entityTags.tag_id, count }).from(entityTags)
      .innerJoin(clips, eq(clips.id, entityTags.entity_id))
      .where(and(tagged('clip'), accessibleClipSql(user.org_id, user.id, 'read')))
      .groupBy(entityTags.tag_id),
  ]);
  return grouped.flat();
}

async function canSeeTagEntity(entityType: TagEntityType, entityId: string, user: AuthUser, access: 'member' | 'read' = 'member') {
  const resolved = await resolveVisibleTagEntities([{ entity_type: entityType, entity_id: entityId }], user, access);
  return resolved.isVisible(entityType, entityId);
}

/** Deleting a tag removes it from every item, so it is for owners and admins. The role is read from the database. */
async function isOwnerOrAdmin(user: AuthUser) {
  const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id), eq(orgMembers.is_active, true)))
    .limit(1);
  return membership?.role === 'owner' || membership?.role === 'admin';
}

// GET / — list all tags for org, each with the number of tagged items the caller can see
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

  // Counts follow the tagged-items list (GET /:id/entities): an item the
  // caller cannot see is not counted, so a count says nothing about hidden items.
  const counts = new Map<string, number>();
  if (result.length > 0) {
    for (const row of await visibleTagCounts(user)) {
      counts.set(row.tag_id, (counts.get(row.tag_id) ?? 0) + row.count);
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

// DELETE /:id — delete tag (owners and admins only)
tagRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const tagId = c.req.param('id');

  if (!await isOwnerOrAdmin(user)) {
    return c.json({ error: 'Only owners and admins can delete tags', code: 'FORBIDDEN' }, 403);
  }

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

  const entity = await normalizeTagEntity(user, parsed.data.entity_type, parsed.data.entity_id);
  if (!entity || !await canSeeTagEntity(entity.type, entity.id, user)) {
    return c.json(ENTITY_NOT_FOUND, 404);
  }

  // Upsert (ignore if already applied)
  try {
    const [et] = await db.insert(entityTags).values({
      org_id: user.org_id,
      tag_id: tagId,
      entity_type: asStoredEntityType(entity.type),
      entity_id: entity.id,
    }).onConflictDoNothing().returning();

    return c.json(et || { tag_id: tagId, entity_type: entity.type, entity_id: entity.id });
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

  const entity = await normalizeTagEntity(user, parsed.data.entity_type, parsed.data.entity_id);
  if (!entity || !await canSeeTagEntity(entity.type, entity.id, user)) {
    return c.json(ENTITY_NOT_FOUND, 404);
  }

  await db.delete(entityTags)
    .where(and(
      eq(entityTags.tag_id, tagId),
      eq(entityTags.entity_type, asStoredEntityType(entity.type)),
      eq(entityTags.entity_id, entity.id),
      eq(entityTags.org_id, user.org_id),
    ));

  return c.json({ success: true });
});

// GET /:id/entities — list all entities with this tag (with resolved titles)
tagRoutes.get('/:id/entities', async (c) => {
  const user = c.get('user');
  const tagId = c.req.param('id');
  const entityType = c.req.query('type'); // optional filter

  // Only entities the caller can see are listed; the rest are omitted. Rows
  // are scanned newest first with a (created_at, id) cursor until 100 visible
  // entities are found or MAX_SCAN rows have been examined.
  const LIST_LIMIT = 100;
  const PAGE_SIZE = 200;
  const MAX_SCAN = 2000;
  const cursor: { current: { ts: string; id: string } | null } = { current: null };
  const visibleRows: Array<typeof entityTags.$inferSelect> = [];
  const taskMap = new Map<string, { title: string; number: number; prefix: string; status: string }>();
  const messageMap = new Map<string, { content: string; user_name: string; space_id: string }>();
  const noteMap = new Map<string, { title: string }>();
  const documentMap = new Map<string, { title: string }>();
  for (let scanned = 0; visibleRows.length < LIST_LIMIT && scanned < MAX_SCAN; scanned += PAGE_SIZE) {
    const after = cursor.current;
    const page = await db.select({ ...getTableColumns(entityTags), cursor_ts: sql<string>`${entityTags.created_at}::text` }).from(entityTags)
      .where(and(
        eq(entityTags.tag_id, tagId),
        eq(entityTags.org_id, user.org_id),
        ...(entityType ? [eq(entityTags.entity_type, entityType as any)] : []),
        // The cursor keeps the full-precision timestamp text of the last row seen.
        ...(after ? [sql`(${entityTags.created_at}, ${entityTags.id}) < (${after.ts}::timestamp, ${after.id})`] : []),
      ))
      .orderBy(desc(entityTags.created_at), desc(entityTags.id))
      .limit(PAGE_SIZE);
    if (page.length === 0) break;
    cursor.current = { ts: page[page.length - 1]!.cursor_ts, id: page[page.length - 1]!.id };
    const resolved = await resolveVisibleTagEntities(page, user, 'read');
    for (const [id, v] of resolved.taskMap) taskMap.set(id, v);
    for (const [id, v] of resolved.messageMap) messageMap.set(id, v);
    for (const [id, v] of resolved.noteMap) noteMap.set(id, v);
    for (const [id, v] of resolved.documentMap) documentMap.set(id, v);
    visibleRows.push(...page.filter(row => resolved.isVisible(row.entity_type, row.entity_id)));
    if (page.length < PAGE_SIZE) break;
  }
  visibleRows.splice(LIST_LIMIT);

  const results = visibleRows.map(row => {
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
    if ((row.entity_type as string) === 'document') {
      const d = documentMap.get(row.entity_id);
      return { ...base, title: d?.title || 'Untitled', url: `/d/${row.entity_id}` };
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

  const parsedType = applyTagSchema.shape.entity_type.safeParse(entityType);
  const entity = parsedType.success ? await normalizeTagEntity(user, parsedType.data, entityId) : null;
  if (!entity || !await canSeeTagEntity(entity.type, entity.id, user, 'read')) {
    return c.json([]);
  }

  const results = await db.select({
    id: tags.id,
    name: tags.name,
    color: tags.color,
  }).from(entityTags)
    .innerJoin(tags, eq(entityTags.tag_id, tags.id))
    .where(and(
      eq(entityTags.entity_type, asStoredEntityType(entity.type)),
      eq(entityTags.entity_id, entity.id),
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
