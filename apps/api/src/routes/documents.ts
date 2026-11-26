// Documents (spec 5.1; plan Task F5). The roles, the sub-page rules, the lock
// order, the access-loss path and the events are in lib/documents.ts, which
// every write here goes through. Reads go through the access check
// (lib/document-access.ts): a document the caller can't see, in this
// workspace or another, is a 404.
//
// GET /:id answers in one read-only snapshot (the role, the document, its
// drive and its breadcrumb). The drive's name and kind show only to someone
// who can view the drive, and the breadcrumb names only the ancestors the
// caller can see (consult rule C4). Content comes through live editing (F7);
// `content_json` is included only when live editing is off or `?content=1`
// asks for it.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { docFavorites, documents, drives, type DocumentRow } from '@deft/db/documents';
import { db } from '../lib/db.js';
import { documentRoleFor, driveRoleFor } from '../lib/document-access.js';
import {
  createDocument, documentBreadcrumb, DocumentRefusal, favoriteDocumentsQuery, moveDocument, recentDocumentsQuery, restoreDocument,
  softDeleteDocument, updateDocument,
} from '../lib/documents.js';
import { jsonBody } from '../lib/request-body.js';

export const documentRoutes = new Hono();

const idSchema = z.string().trim().min(1).max(200);
const titleSchema = z.string().trim().max(500);
const createSchema = z.object({
  drive_id: idSchema.optional(),
  folder_id: idSchema.nullable().optional(),
  parent_document_id: idSchema.nullable().optional(),
  title: titleSchema.optional(),
  json: z.looseObject({ type: z.literal('doc') }).optional(),
});
/** Content never changes here (rule C2): an unknown key, `json` included, is refused. */
const updateSchema = z.object({
  title: titleSchema.optional(),
  icon: z.string().trim().min(1).max(64).nullable().optional(),
  is_template: z.boolean().optional(),
}).strict();
const moveSchema = z.object({
  drive_id: idSchema,
  folder_id: idSchema.nullable().optional(),
  parent_document_id: idSchema.nullable().optional(),
  position: z.number().finite().optional(),
});

/** One snapshot for GET /:id's role, document, drive and breadcrumb. */
const READ_SNAPSHOT: PgTransactionConfig = { isolationLevel: 'repeatable read', accessMode: 'read only' };

const NOT_FOUND = { error: 'Document not found', code: 'NOT_FOUND' } as const;

/** Whether live editing serves document content (F7). */
function liveEditing(): boolean {
  return true;
}

function invalid(c: Context) {
  return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
}

/** A refusal from lib/documents.ts, or a 500 whose log line is fixed text, never a request value. */
function failed(c: Context, error: unknown, what: string) {
  if (error instanceof DocumentRefusal) return c.json({ error: error.message, code: error.code }, error.status);
  console.error('[documents] a document request failed');
  return c.json({ error: `Failed to ${what}`, code: 'INTERNAL_ERROR' }, 500);
}

function documentShape(row: DocumentRow) {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    drive_id: row.drive_id,
    folder_id: row.folder_id,
    parent_document_id: row.parent_document_id,
    position: row.position,
    is_template: row.is_template,
    created_by: row.created_by,
    last_edited_by: row.last_edited_by,
    last_edited_at: row.last_edited_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// POST /api/documents { drive_id?, folder_id?, parent_document_id?, title?, json? }:
// needs edit on the drive; no drive and no parent page means My drive.
documentRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const parsed = createSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c);
    const body = parsed.data;
    const document = await createDocument({
      orgId: user.org_id, userId: user.id, driveId: body.drive_id, folderId: body.folder_id, parentDocumentId: body.parent_document_id,
      title: body.title, json: body.json,
    });
    return c.json({ document: documentShape(document) }, 201);
  } catch (error) {
    return failed(c, error, 'create the document');
  }
});

// GET /api/documents/favorites and /recent. Registered before /:id.
documentRoutes.get('/favorites', async (c) => {
  try {
    const user = c.get('user');
    return c.json({ documents: await favoriteDocumentsQuery(user.id, user.org_id) });
  } catch (error) {
    return failed(c, error, 'list favourites');
  }
});

documentRoutes.get('/recent', async (c) => {
  try {
    const user = c.get('user');
    return c.json({ documents: await recentDocumentsQuery(user.id, user.org_id) });
  } catch (error) {
    return failed(c, error, 'list recent documents');
  }
});

// GET /api/documents/:id[?content=1] (needs view).
documentRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const documentId = c.req.param('id');
    const live = liveEditing();
    const withContent = !live || c.req.query('content') === '1';
    const body = await db.transaction(async (tx) => {
      const role = await documentRoleFor(user.id, user.org_id, documentId, tx);
      if (!role) return null;
      const [row] = await tx.select({ document: documents, drive: { id: drives.id, name: drives.name, kind: drives.kind } })
        .from(documents)
        .innerJoin(drives, and(eq(drives.id, documents.drive_id), eq(drives.org_id, documents.org_id)))
        .where(and(eq(documents.id, documentId), eq(documents.org_id, user.org_id), eq(documents.is_deleted, false)))
        .limit(1);
      if (!row) return null;
      const driveVisible = (await driveRoleFor(user.id, user.org_id, row.drive.id, tx)) !== null;
      const breadcrumb = await documentBreadcrumb(documentId, { orgId: user.org_id, userId: user.id }, tx);
      const document = row.document;
      return {
        id: document.id,
        title: document.title,
        icon: document.icon,
        drive: { id: row.drive.id, name: driveVisible ? row.drive.name : null, kind: driveVisible ? row.drive.kind : null },
        folder_id: document.folder_id,
        parent_document_id: document.parent_document_id,
        breadcrumb,
        role,
        last_edited_by: document.last_edited_by,
        last_edited_at: document.last_edited_at,
        is_template: document.is_template,
        live,
        ...(withContent ? { content_json: document.content_json } : {}),
      };
    }, READ_SNAPSHOT);
    if (!body) return c.json(NOT_FOUND, 404);
    return c.json({ document: body });
  } catch (error) {
    return failed(c, error, 'load the document');
  }
});

// PATCH /api/documents/:id { title?, icon?, is_template? } (needs edit).
documentRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const parsed = updateSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c);
    const document = await updateDocument({
      orgId: user.org_id, userId: user.id, documentId: c.req.param('id'),
      patch: { title: parsed.data.title, icon: parsed.data.icon, isTemplate: parsed.data.is_template },
    });
    return c.json({ document: documentShape(document) });
  } catch (error) {
    return failed(c, error, 'update the document');
  }
});

// POST /api/documents/:id/move { drive_id, folder_id?, parent_document_id?, position? }
// (needs edit on the document and on both drives).
documentRoutes.post('/:id/move', async (c) => {
  try {
    const user = c.get('user');
    const parsed = moveSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c);
    const { movedIds } = await moveDocument({
      orgId: user.org_id, userId: user.id, documentId: c.req.param('id'), driveId: parsed.data.drive_id,
      folderId: parsed.data.folder_id, parentDocumentId: parsed.data.parent_document_id, position: parsed.data.position,
    });
    return c.json({ moved_ids: movedIds });
  } catch (error) {
    return failed(c, error, 'move the document');
  }
});

// DELETE /api/documents/:id (needs edit): the document and its sub-pages go to the trash.
documentRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const { deletedIds } = await softDeleteDocument({ orgId: user.org_id, userId: user.id, documentId: c.req.param('id') });
    return c.json({ deleted_ids: deletedIds });
  } catch (error) {
    return failed(c, error, 'delete the document');
  }
});

// POST /api/documents/:id/restore (needs edit on the drive).
documentRoutes.post('/:id/restore', async (c) => {
  try {
    const user = c.get('user');
    const { restoredIds } = await restoreDocument({ orgId: user.org_id, userId: user.id, documentId: c.req.param('id') });
    return c.json({ restored_ids: restoredIds });
  } catch (error) {
    return failed(c, error, 'restore the document');
  }
});

// POST /api/documents/:id/favorite (needs view): a per-person star.
documentRoutes.post('/:id/favorite', async (c) => {
  try {
    const user = c.get('user');
    const documentId = c.req.param('id');
    if (!(await documentRoleFor(user.id, user.org_id, documentId))) return c.json(NOT_FOUND, 404);
    await db.insert(docFavorites)
      .values({ org_id: user.org_id, user_id: user.id, target_type: 'document', target_id: documentId })
      .onConflictDoNothing({ target: [docFavorites.user_id, docFavorites.target_type, docFavorites.target_id] });
    return c.json({ favorite: true });
  } catch (error) {
    return failed(c, error, 'star the document');
  }
});

// DELETE /api/documents/:id/favorite: removes only the caller's own star.
documentRoutes.delete('/:id/favorite', async (c) => {
  try {
    const user = c.get('user');
    await db.delete(docFavorites).where(and(
      eq(docFavorites.org_id, user.org_id), eq(docFavorites.user_id, user.id), eq(docFavorites.target_type, 'document'),
      eq(docFavorites.target_id, c.req.param('id')),
    ));
    return c.json({ favorite: false });
  } catch (error) {
    return failed(c, error, 'unstar the document');
  }
});
