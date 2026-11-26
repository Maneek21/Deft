// Documents (spec 5.1; plan Task F5). The roles, the sub-page rules, the lock
// order, the access-loss path and the events are in lib/documents.ts, which
// every write here goes through. Reads go through the access check
// (lib/document-access.ts): a document the caller can't see, in this
// workspace or another, is a 404.
//
// GET /:id answers in one read-only snapshot (the role, the document, its
// drive and its breadcrumb). Create and PATCH answer with the document as
// read in their own write transaction, never by a query after the commit.
// What a caller is shown follows rule C4: every document answer uses
// lib/documents.ts's viewerDocumentColumns, so a folder or parent page the
// caller can't see is null; the drive's name and kind show only to someone
// who can view the drive; the breadcrumb shows hidden ancestors as "Shared
// with you"; a delete answers with only the ids the caller could view.
// Content comes through live editing (F7); `content_json` is included only
// when live editing is off (DEFT_DOCUMENTS_LIVE=off, liveEditingEnabled) or
// `?content=1` asks for it. A document over the size cap is refused with 413
// TOO_LARGE.
//
// Routes that take no body (delete, restore, star and unstar) accept none,
// one of only JSON whitespace, or well-formed JSON, and answer anything else
// with 400 before changing anything. Removing a share takes an optional body
// on the same terms: none, or `{ include_subpages }`; any other JSON value
// (null aside) is 400 too.
//
// Cards (F13; lib/chat-documents.ts): POST /cards { ids } answers, for at most
// 50 ids, a card for each document the caller can open and null for every
// other id, one that doesn't exist or belongs to another workspace included,
// so it can't be used to find out whether a document exists. A drive the
// caller can't see is named null.
//
// Sharing (F9; the rules, the lock order and who is told are in
// lib/document-shares.ts): GET /:id/shares needs edit; POST /:id/shares,
// PATCH and DELETE /:id/shares/:shareId need edit, and a share gives at most
// edit (400 ROLE_TOO_HIGH); GET /:id/audience?space_id= needs view and a seat
// in the chat. POST, DELETE and a lowering PATCH reach the sub-pages too
// unless `include_subpages` is false (DELETE takes it as an optional body).
//
// Versions (F8; the rules are in lib/document-versions.ts): every route needs
// edit. A document the caller can't open is 404, checked first; then a role
// below edit is 403 FORBIDDEN_ROLE; then a version that isn't the document's
// is 404 VERSION_NOT_FOUND. GET /:id/versions[?limit=&before=] lists newest
// first, at most 200 a page (default 100), `next_before` continuing;
// GET /:id/versions/:vid adds `content_json`; POST /:id/versions { name }
// names the current content; POST /:id/versions/:vid/restore takes no body.
// A restore goes through the one writer, whose refusals answer: FORBIDDEN
// 403, TOO_LARGE 413, BUSY 503 with Retry-After (live editing can't take
// the write now; nothing changed, so the client tries again), and
// INVALID_CONTENT or REVISION_CHANGED 409.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { docFavorites, documents, drives } from '@deft/db/documents';
import { liveEditingEnabled } from '../collab/limits.js';
import { db } from '../lib/db.js';
import { documentRoleFor, driveRoleFor } from '../lib/document-access.js';
import {
  createDocumentInTx, documentBreadcrumb, DocumentRefusal, favoriteDocumentsQuery, moveDocument, recentDocumentsQuery, restoreDocument,
  softDeleteDocument, updateDocument, viewerDocumentColumns, viewerDocumentInTx,
} from '../lib/documents.js';
import {
  changeShareRole, documentAudience, listDocumentShares, removeShare, shareDocument, shareShape,
} from '../lib/document-shares.js';
import { jsonBody, noBodyOrJson } from '../lib/request-body.js';
import { documentCards, MAX_DOCUMENT_CARDS } from '../lib/chat-documents.js';
import { DocumentWriteRefused, type DocumentWriteRefusalCode } from '../lib/document-writer.js';
import {
  getVersion, listVersions, nameVersion, restoreVersion, VERSION_PAGE_DEFAULT, VERSION_PAGE_MAX,
} from '../lib/document-versions.js';

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
/** `full` parses so it can be refused as ROLE_TOO_HIGH rather than as invalid input. */
const shareRoleSchema = z.enum(['full', 'edit', 'comment', 'view']);
const shareSchema = z.object({
  principal_type: z.enum(['user', 'space']),
  principal_id: idSchema,
  role: shareRoleSchema,
  include_subpages: z.boolean().optional(),
});
const shareRoleChangeSchema = z.object({ role: shareRoleSchema, include_subpages: z.boolean().optional() });
/** DELETE's optional body. */
const shareRemoveSchema = z.object({ include_subpages: z.boolean().optional() });
const cardsSchema = z.object({ ids: z.array(idSchema).max(MAX_DOCUMENT_CARDS) });
const versionNameSchema = z.object({ name: z.string().trim().min(1).max(200) });
const versionPageSchema = z.object({
  limit: z.string().regex(/^\d{1,4}$/).transform(Number).pipe(z.number().int().min(1).max(VERSION_PAGE_MAX)).optional(),
  before: idSchema.optional(),
});

/** One snapshot for GET /:id's role, document, drive and breadcrumb. */
const READ_SNAPSHOT: PgTransactionConfig = { isolationLevel: 'repeatable read', accessMode: 'read only' };

const NOT_FOUND = { error: 'Document not found', code: 'NOT_FOUND' } as const;

function invalid(c: Context) {
  return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
}

/** How a refusal from the one writer (lib/document-writer.ts) answers (the header). */
const WRITE_REFUSAL_STATUS: Record<DocumentWriteRefusalCode, 403 | 409 | 413 | 503> = {
  FORBIDDEN: 403, TOO_LARGE: 413, BUSY: 503, REVISION_CHANGED: 409, INVALID_CONTENT: 409,
};

/** A refusal from lib/documents.ts or the writer, or a 500 whose log line is fixed text, never a request value. */
function failed(c: Context, error: unknown, what: string) {
  if (error instanceof DocumentRefusal) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof DocumentWriteRefused) {
    if (error.code === 'BUSY') c.header('Retry-After', '5');
    return c.json({ error: error.message, code: error.code }, WRITE_REFUSAL_STATUS[error.code]);
  }
  console.error('[documents] a document request failed');
  return c.json({ error: `Failed to ${what}`, code: 'INTERNAL_ERROR' }, 500);
}

// POST /api/documents { drive_id?, folder_id?, parent_document_id?, title?, json? }:
// needs edit on the drive; no drive and no parent page means My drive.
documentRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const parsed = createSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c);
    const body = parsed.data;
    // The answer is read in the create's own transaction; events follow the commit.
    const { view, finish } = await db.transaction(async (tx) => {
      const { document, finish: afterCommit } = await createDocumentInTx(tx, {
        orgId: user.org_id, userId: user.id, driveId: body.drive_id, folderId: body.folder_id, parentDocumentId: body.parent_document_id,
        title: body.title, json: body.json,
      });
      return { view: await viewerDocumentInTx(tx, user.id, user.org_id, document.id), finish: afterCommit };
    });
    await finish();
    return c.json({ document: view }, 201);
  } catch (error) {
    return failed(c, error, 'create the document');
  }
});

// POST /api/documents/cards { ids }: the cards a chat message shows, as this caller may see them (F13).
documentRoutes.post('/cards', async (c) => {
  try {
    const user = c.get('user');
    const parsed = cardsSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c);
    return c.json({ cards: await documentCards(user.id, user.org_id, parsed.data.ids) });
  } catch (error) {
    return failed(c, error, 'load the document cards');
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
    const live = liveEditingEnabled();
    const withContent = !live || c.req.query('content') === '1';
    const body = await db.transaction(async (tx) => {
      const role = await documentRoleFor(user.id, user.org_id, documentId, tx);
      if (!role) return null;
      const [row] = await tx.select({
        document: { ...viewerDocumentColumns(user.id, user.org_id), content_json: documents.content_json },
        drive: { id: drives.id, name: drives.name, kind: drives.kind },
      })
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
    const { view } = await updateDocument({
      orgId: user.org_id, userId: user.id, documentId: c.req.param('id'),
      patch: { title: parsed.data.title, icon: parsed.data.icon, isTemplate: parsed.data.is_template },
    });
    return c.json({ document: view });
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

// DELETE /api/documents/:id (needs edit): the document and its sub-pages go
// to the trash. The answer lists only the pages the caller could view.
documentRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    if (!(await noBodyOrJson(c))) return invalid(c);
    const { visibleIds } = await softDeleteDocument({ orgId: user.org_id, userId: user.id, documentId: c.req.param('id') });
    return c.json({ deleted_ids: visibleIds });
  } catch (error) {
    return failed(c, error, 'delete the document');
  }
});

// POST /api/documents/:id/restore (needs edit on the drive).
documentRoutes.post('/:id/restore', async (c) => {
  try {
    const user = c.get('user');
    if (!(await noBodyOrJson(c))) return invalid(c);
    const { restoredIds } = await restoreDocument({ orgId: user.org_id, userId: user.id, documentId: c.req.param('id') });
    return c.json({ restored_ids: restoredIds });
  } catch (error) {
    return failed(c, error, 'restore the document');
  }
});

// GET /api/documents/:id/shares (needs edit).
documentRoutes.get('/:id/shares', async (c) => {
  try {
    const user = c.get('user');
    return c.json({ shares: await listDocumentShares(user.org_id, user.id, c.req.param('id')) });
  } catch (error) {
    return failed(c, error, 'list the document’s shares');
  }
});

// POST /api/documents/:id/shares { principal_type, principal_id, role, include_subpages? } (needs edit).
documentRoutes.post('/:id/shares', async (c) => {
  try {
    const user = c.get('user');
    const parsed = shareSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c);
    // `full` is refused in the library, after the access check (404, then 403, then ROLE_TOO_HIGH).
    const shared = await shareDocument({
      orgId: user.org_id, userId: user.id, documentId: c.req.param('id'), principalType: parsed.data.principal_type,
      principalId: parsed.data.principal_id, role: parsed.data.role, includeSubpages: parsed.data.include_subpages ?? true,
    });
    return c.json({ share: shareShape(shared.share), shared_subpages: shared.sharedSubpages, skipped_subpages: shared.skippedSubpages }, 201);
  } catch (error) {
    return failed(c, error, 'share the document');
  }
});

// PATCH /api/documents/:id/shares/:shareId { role, include_subpages? } (needs edit). Lowering also
// lowers the sub-pages' shares by default; raising changes this page only.
documentRoutes.patch('/:id/shares/:shareId', async (c) => {
  try {
    const user = c.get('user');
    const parsed = shareRoleChangeSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c);
    // `full` is refused in the library, after the access check.
    const changed = await changeShareRole({
      orgId: user.org_id, userId: user.id, documentId: c.req.param('id'), shareId: c.req.param('shareId'), role: parsed.data.role,
      includeSubpages: parsed.data.include_subpages ?? true,
    });
    return c.json({ share: changed.share, lowered_subpages: changed.loweredSubpages, skipped_subpages: changed.skippedSubpages });
  } catch (error) {
    return failed(c, error, 'change the share');
  }
});

// DELETE /api/documents/:id/shares/:shareId [{ include_subpages? }] (needs edit). The body is optional;
// by default the sub-pages' shares go too.
documentRoutes.delete('/:id/shares/:shareId', async (c) => {
  try {
    const user = c.get('user');
    if (!(await noBodyOrJson(c))) return invalid(c);
    const parsed = shareRemoveSchema.safeParse((await jsonBody(c)) ?? {});
    if (!parsed.success) return invalid(c);
    const removed = await removeShare({
      orgId: user.org_id, userId: user.id, documentId: c.req.param('id'), shareId: c.req.param('shareId'),
      includeSubpages: parsed.data.include_subpages ?? true,
    });
    return c.json({ success: true, removed_subpages: removed.removedSubpages, skipped_subpages: removed.skippedSubpages });
  } catch (error) {
    return failed(c, error, 'remove the share');
  }
});

// GET /api/documents/:id/audience?space_id= (needs view and a seat in the chat): for the posting prompt.
documentRoutes.get('/:id/audience', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = idSchema.safeParse(c.req.query('space_id'));
    if (!spaceId.success) return invalid(c);
    return c.json(await documentAudience(user.org_id, user.id, c.req.param('id'), spaceId.data));
  } catch (error) {
    return failed(c, error, 'count the chat’s audience');
  }
});

// GET /api/documents/:id/versions[?limit=&before=] (needs edit): newest first.
documentRoutes.get('/:id/versions', async (c) => {
  try {
    const user = c.get('user');
    const page = versionPageSchema.safeParse({ limit: c.req.query('limit'), before: c.req.query('before') });
    if (!page.success) return invalid(c);
    const listed = await listVersions({
      orgId: user.org_id, userId: user.id, documentId: c.req.param('id'), limit: page.data.limit ?? VERSION_PAGE_DEFAULT, before: page.data.before,
    });
    return c.json({ versions: listed.versions, next_before: listed.nextBefore });
  } catch (error) {
    return failed(c, error, 'list the versions');
  }
});

// GET /api/documents/:id/versions/:vid (needs edit): the version with its content.
documentRoutes.get('/:id/versions/:vid', async (c) => {
  try {
    const user = c.get('user');
    const version = await getVersion({ orgId: user.org_id, userId: user.id, documentId: c.req.param('id'), versionId: c.req.param('vid') });
    return c.json({ version });
  } catch (error) {
    return failed(c, error, 'load the version');
  }
});

// POST /api/documents/:id/versions { name } (needs edit): names the current content.
documentRoutes.post('/:id/versions', async (c) => {
  try {
    const user = c.get('user');
    const parsed = versionNameSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return invalid(c);
    const version = await nameVersion({ orgId: user.org_id, userId: user.id, documentId: c.req.param('id'), name: parsed.data.name });
    return c.json({ version }, 201);
  } catch (error) {
    return failed(c, error, 'save the version');
  }
});

// POST /api/documents/:id/versions/:vid/restore (needs edit): through the one writer; saves a restore version.
documentRoutes.post('/:id/versions/:vid/restore', async (c) => {
  try {
    const user = c.get('user');
    if (!(await noBodyOrJson(c))) return invalid(c);
    const { versionId } = await restoreVersion({
      orgId: user.org_id, userId: user.id, documentId: c.req.param('id'), versionId: c.req.param('vid'),
    });
    return c.json({ version_id: versionId });
  } catch (error) {
    return failed(c, error, 'restore the version');
  }
});

// POST /api/documents/:id/favorite (needs view): a per-person star.
documentRoutes.post('/:id/favorite', async (c) => {
  try {
    const user = c.get('user');
    if (!(await noBodyOrJson(c))) return invalid(c);
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
    if (!(await noBodyOrJson(c))) return invalid(c);
    await db.delete(docFavorites).where(and(
      eq(docFavorites.org_id, user.org_id), eq(docFavorites.user_id, user.id), eq(docFavorites.target_type, 'document'),
      eq(docFavorites.target_id, c.req.param('id')),
    ));
    return c.json({ favorite: false });
  } catch (error) {
    return failed(c, error, 'unstar the document');
  }
});
