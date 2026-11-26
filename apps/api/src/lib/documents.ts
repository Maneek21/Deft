// Folders and documents (spec 5.1; plan Task F5): creating documents and
// sub-pages, changing them, moving them between drives, the trash, folders,
// the breadcrumb, and the tree, recent and favourite lists.
//
// Roles (the access check, lib/document-access.ts):
// - creating a document needs edit on its drive: the drive named, the
//   parent's drive for a sub-page, or else the caller's My drive
//   (ensurePersonalDrive). A folder or parent page must be in that drive;
// - changing a document's title, icon or template flag, and deleting it,
//   need edit on the document;
// - a move needs edit on the document and on both drives;
// - restoring, and listing the trash, need edit on the drive: the access
//   check doesn't see deleted documents;
// - creating, changing and deleting a folder need edit on its drive.
// A frozen drive gives nobody edit (its own grants give nothing), so nothing
// is created in it, moved into or out of it, or restored there. What the
// caller can't see is a 404; a role too low is 403 FORBIDDEN_ROLE.
//
// Sub-pages: a sub-page lives in its parent's drive and starts with a copy of
// every one of the parent's shares, as it is (F9's sub-page share rule). The
// sub-page tree moves, is deleted and is restored with its document, each in
// one statement. A live document never sits under a deleted page or in a
// deleted folder, because the access check would still reach it: deleting a
// folder moves its contents up, and a document restored while its parent
// page or its folder is deleted goes to the drive root. A delete stamps the
// tree it trashes with one deleted_at, and a restore brings back the pages
// under the document that carry its stamp, so a sub-page deleted on its own
// earlier stays in the trash. The stamp is made in SQL, to the microsecond,
// and is always later than every stamp already in the tree (deleteStampSql),
// so two deletes never share one; restore and the trash compare stamps in
// SQL only.
//
// Content (rule C2): this file writes content only when it creates a
// document (initialContent), and leaves ydoc_state for the first live load.
// Every later content write goes through writeDocument
// (lib/document-writer.ts) or live editing (collab/server.ts). Those lock
// only the document row, never a drive: one may wait for a move or a delete
// here, or make one wait, but never in a cycle.
//
// Lock order (lib/drive-locks.ts, and routes/drives.ts's header): the
// actor's room-access lock, then their org_members row FOR SHARE
// (lockActorInTx), then the drive FOR UPDATE (both drives of a move, in id
// order), then the folders and documents changed. A document's drive is read
// before the locks, to know which drive to lock, and checked again under
// them. My drive is ensured between the actor and the drive
// (ensurePersonalDrive with lockForUpdate: the actor's rows FOR SHARE, then
// the drive FOR UPDATE before its owner row is written, so this transaction
// never raises a share lock while a concurrent ensure waits on that row).
//
// Access loss (rule C3): a move to another drive and a delete call
// applyAccessLossInTx in their transaction and finishAccessLoss after the
// commit. A move also tells listeners the target drive's people gained
// access, and a restore that access came back (emitDocumentAccessChanged).
//
// Events (rule C4): after a commit, `document:updated`, ids only, goes to each
// person who can view the document now (emitDocumentUpdated,
// lib/document-access-events.ts). Someone who lost access through a move or
// a delete hears only through the access-loss path (finishAccessLoss's
// access change), never the document event; after a delete nobody can view
// the documents, so none is sent, as after a drive delete. Lifecycle events
// (lib/document-events.ts) follow every create, move, delete and restore.
// After a commit each step runs on its own, so one that fails never skips the
// next.
//
// What a viewer is shown (rule C4): every document a route returns comes from
// one projection (viewerDocumentColumns), in which `folder_id` is null
// unless the viewer can view the drive (folders carry no access of their
// own) and `parent_document_id` is null unless they can view the parent page.
// The breadcrumb shows each run of ancestors they can't see as one "Shared
// with you". A delete answers with only the ids the caller could view.
import { and, asc, desc, eq, gte, inArray, isNull, ne, notExists, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { docFavorites, docFolders, documentShares, documents, type DocFolderRow, type DocRole, type DocumentRow } from '@deft/db/documents';
import { EMPTY_DOCUMENT, ensureBlockIds, getDocumentSchema, jsonToText, jsonToYDoc } from '@deft/doc-schema';
import { encodedStateBytes, withinSizeCap } from '../collab/limits.js';
import { db } from './db.js';
import { documentRoleFor, roleAtLeast, visibleDocumentCondition, visibleDocumentIdSql, visibleDriveIdSql, type Executor } from './document-access.js';
import { accessLossInTx, finishAccessLoss, type PendingAccessLoss } from './document-access-change.js';
import { emitDocumentAccessChanged, emitDocumentUpdated } from './document-access-events.js';
import { emitDocumentEvent } from './document-events.js';
import { driveAccess, lockActorInTx, type DriveAccess, type DriveActor } from './drive-locks.js';
import { ensurePersonalDrive, PrincipalCannotHoldAccessError } from './drives.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, 'select'>;
type JSONContent = Parameters<typeof jsonToText>[0];

/** How long a deleted document stays in its drive's trash. */
export const TRASH_DAYS = 30;

/** A refusal for the caller: the routes answer `{ error: message, code }` with `status`. */
export class DocumentRefusal extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413, readonly code: string, message: string) { super(message); }
}

const notFound = (what: 'Document' | 'Drive' | 'Folder' = 'Document') => new DocumentRefusal(404, 'NOT_FOUND', `${what} not found`);
const forbidden = (message: string) => new DocumentRefusal(403, 'FORBIDDEN_ROLE', message);
const invalid = (message: string) => new DocumentRefusal(400, 'VALIDATION_ERROR', message);
const folderNotInDrive = () => new DocumentRefusal(400, 'FOLDER_NOT_IN_DRIVE', 'That folder isn’t in this drive');
const parentNotInDrive = () => new DocumentRefusal(400, 'PARENT_NOT_IN_DRIVE', 'A sub-page lives in its parent page’s drive');
const moveCycle = () => new DocumentRefusal(409, 'MOVE_CYCLE', 'A page or folder can’t move under itself');
const changedMeanwhile = () => new DocumentRefusal(409, 'CONFLICT', 'The document moved while this ran; try again');

const actorOf = (orgId: string, userId: string): DriveActor => ({ id: userId, org_id: orgId });

const trashCutoff = () => new Date(Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000);

/**
 * Locks the drive FOR UPDATE (after lockActorInTx) and requires edit on it:
 * `missing` when the caller can't view it (by default 404 "Drive not
 * found"), 403 when they can only view or comment.
 */
async function lockDriveForEditInTx(tx: Tx, actor: DriveActor, driveId: string, missing = notFound('Drive')): Promise<DriveAccess> {
  const access = await driveAccess(tx, actor, driveId, true);
  if (!access || access.role === null) throw missing;
  if (!roleAtLeast(access.role, 'edit')) throw forbidden('You need edit access to this drive');
  return access;
}

/** The drive of a live document of `orgId`, or null: read before the locks, checked again under them. */
async function liveDriveOf(reader: Reader, orgId: string, documentId: string): Promise<string | null> {
  const [row] = await reader.select({ drive_id: documents.drive_id }).from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.org_id, orgId), eq(documents.is_deleted, false))).limit(1);
  return row?.drive_id ?? null;
}

async function liveFolderInDrive(reader: Reader, orgId: string, driveId: string, folderId: string): Promise<boolean> {
  const [row] = await reader.select({ id: docFolders.id }).from(docFolders).where(and(
    eq(docFolders.id, folderId), eq(docFolders.org_id, orgId), eq(docFolders.drive_id, driveId), eq(docFolders.is_deleted, false),
  )).limit(1);
  return Boolean(row);
}

/** The document row, locked FOR UPDATE: live (or, with `deleted`, in the trash) and still in `driveId`. */
async function lockedDocument(tx: Tx, orgId: string, documentId: string, driveId: string, deleted = false): Promise<DocumentRow> {
  const [document] = await tx.select().from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.org_id, orgId), eq(documents.is_deleted, deleted)))
    .for('update');
  if (!document) throw notFound();
  if (document.drive_id !== driveId) throw changedMeanwhile();
  return document;
}

/** The caller's role on the document, at least `min`: 404 when they can't see it, 403 below `min`. */
async function requireDocumentRole(tx: Tx, actor: DriveActor, documentId: string, min: DocRole): Promise<DocRole> {
  const role = await documentRoleFor(actor.id, actor.org_id, documentId, tx);
  if (!role) throw notFound();
  if (!roleAtLeast(role, min)) throw forbidden(`You need ${min} access to this document`);
  return role;
}

/**
 * A live document locked for a change that needs edit on it, in the lock
 * order: the actor, its drive (the role that counts is the document's own),
 * then the document. Also the first locks of an upload into a document
 * (routes/upload.ts).
 */
export async function lockDocumentForEditInTx(tx: Tx, actor: DriveActor, documentId: string): Promise<DocumentRow> {
  const driveId = await liveDriveOf(tx, actor.org_id, documentId);
  if (!driveId) throw notFound();
  await lockActorInTx(tx, actor);
  await driveAccess(tx, actor, driveId, true);
  const document = await lockedDocument(tx, actor.org_id, documentId, driveId);
  await requireDocumentRole(tx, actor, document.id, 'edit');
  return document;
}

/**
 * The document and its sub-pages at every depth (with `liveOnly`, only live
 * ones), sorted by id. Stable while the caller holds the drive's row lock:
 * every create, move, delete and restore locks it FOR UPDATE.
 */
export async function subtreeIds(tx: Tx, orgId: string, rootId: string, liveOnly: boolean): Promise<string[]> {
  const live = liveOnly ? sql`AND subtree_child.is_deleted = false` : sql``;
  const result = await tx.execute(sql`WITH RECURSIVE subtree AS (
      SELECT ${rootId}::text AS id
      UNION
      SELECT subtree_child.id FROM documents subtree_child
        JOIN subtree ON subtree_child.parent_document_id = subtree.id
        WHERE subtree_child.org_id = ${orgId} ${live}
    )
    SELECT id FROM subtree ORDER BY id`);
  return (result.rows as Array<{ id: string }>).map((row) => row.id);
}

/** After the last live sibling: the same folder, or the same parent page, or the drive root. */
async function nextDocumentPosition(
  reader: Reader, orgId: string, driveId: string, folderId: string | null, parentId: string | null, excluding?: string,
): Promise<number> {
  const [row] = await reader.select({ last: sql<number | null>`MAX(${documents.position})` }).from(documents).where(and(
    eq(documents.org_id, orgId), eq(documents.drive_id, driveId), eq(documents.is_deleted, false),
    folderId ? eq(documents.folder_id, folderId) : isNull(documents.folder_id),
    parentId ? eq(documents.parent_document_id, parentId) : isNull(documents.parent_document_id),
    excluding ? ne(documents.id, excluding) : undefined,
  ));
  return Number(row?.last ?? 0) + 1;
}

/** After the last live folder beside it. */
async function nextFolderPosition(reader: Reader, orgId: string, driveId: string, parentFolderId: string | null): Promise<number> {
  const [row] = await reader.select({ last: sql<number | null>`MAX(${docFolders.position})` }).from(docFolders).where(and(
    eq(docFolders.org_id, orgId), eq(docFolders.drive_id, driveId), eq(docFolders.is_deleted, false),
    parentFolderId ? eq(docFolders.parent_folder_id, parentFolderId) : isNull(docFolders.parent_folder_id),
  ));
  return Number(row?.last ?? 0) + 1;
}

/**
 * A delete's one stamp, to the microsecond, in UTC like every timestamp
 * here: the database clock, or, when a page of the tree (`treeIds`, trashed
 * pages included) already carries a stamp that late, one microsecond after
 * the latest. So a sub-page deleted on its own keeps a stamp of its own,
 * however close the two deletes, and restoring its parent leaves it in the
 * trash. Deletes in one drive run one after another under its FOR UPDATE.
 * Made once per statement (a MATERIALIZED CTE): clock_timestamp() changes
 * from row to row.
 */
function deleteStampSql(orgId: string, treeIds: string[]): SQL {
  return sql`greatest(clock_timestamp() AT TIME ZONE 'UTC',
    (SELECT max(stamp_doc.deleted_at) FROM documents stamp_doc
      WHERE stamp_doc.org_id = ${orgId} AND stamp_doc.id = ANY(${sql.param(treeIds)}::text[]) AND stamp_doc.is_deleted = true)
    + interval '1 microsecond')`;
}

/** finishAccessLoss after a commit, on its own. */
async function finishLoss(loss: PendingAccessLoss): Promise<void> {
  try {
    await finishAccessLoss(loss.change, loss.result);
  } catch {
    console.error('[documents] finishing an access loss failed');
  }
}

// ---------------------------------------------------------------------------
// Creating

export type CreateDocumentInput = { orgId: string; userId: string; driveId?: string; folderId?: string | null; parentDocumentId?: string | null;
  title?: string; json?: JSONContent; isTemplate?: boolean; useInKnowledge?: boolean | null };

/**
 * A new document's stored content (rule C2: the one content write here):
 * `json`, or an empty document, with block ids, its text and its size: the
 * byte length of its encoded Yjs state, as every store measures it (F7).
 * ydoc_state stays null until the first live load (F7). Content outside the
 * document schema is refused, and so is content larger than the live size
 * cap (413 TOO_LARGE), measured by the same helper writeDocument uses.
 */
function initialContent(json: JSONContent | undefined) {
  const source = json ?? EMPTY_DOCUMENT;
  try {
    if (source.type !== 'doc') throw new Error('not a document');
    getDocumentSchema().nodeFromJSON(source).check();
  } catch {
    throw invalid('The document content isn’t valid');
  }
  const contentJson = ensureBlockIds(source);
  const ydoc = jsonToYDoc(contentJson);
  const sizeBytes = encodedStateBytes(ydoc);
  ydoc.destroy();
  if (!withinSizeCap(0, sizeBytes)) throw new DocumentRefusal(413, 'TOO_LARGE', 'The document is too large');
  return {
    content_json: contentJson,
    content_text: jsonToText(contentJson),
    size_bytes: sizeBytes,
    ydoc_state: null,
  };
}

/**
 * Creates a document (see the header for the roles): in `driveId`, else in
 * the parent page's drive, else in the caller's My drive. Commits in its own
 * transaction, then raises `created` and sends `document:updated`.
 */
export async function createDocument(input: CreateDocumentInput): Promise<DocumentRow> {
  const { document, finish } = await db.transaction((tx) => createDocumentInTx(tx, input));
  await finish();
  return document;
}

/**
 * createDocument in the caller's transaction. `finish` is the post-commit
 * step (the `created` lifecycle event, then `document:updated` to the
 * viewers); the caller runs it after its commit, never before. It never
 * throws.
 */
export async function createDocumentInTx(tx: Tx, input: CreateDocumentInput): Promise<{ document: DocumentRow; finish: () => Promise<void> }> {
  if (input.folderId && input.parentDocumentId) throw invalid('A document is in a folder or under a page, not both');
  const content = initialContent(input.json);
  const { orgId, userId } = input;
  const actor = actorOf(orgId, userId);
  const folderId = input.folderId ?? null;
  const parentId = input.parentDocumentId ?? null;
  // A parent page the caller can't see is missing, whichever drive it is in.
  if (parentId && !(await documentRoleFor(userId, orgId, parentId, tx))) throw notFound();
  const parentDriveId = parentId ? await liveDriveOf(tx, orgId, parentId) : null;
  if (parentId && !parentDriveId) throw notFound();
  if (parentDriveId && input.driveId && input.driveId !== parentDriveId) throw parentNotInDrive();
  await lockActorInTx(tx, actor);
  const driveId = input.driveId ?? parentDriveId ?? (await myDriveInTx(tx, orgId, userId));
  await lockDriveForEditInTx(tx, actor, driveId, parentId ? notFound() : notFound('Drive'));
  if (parentId) {
    const underLock = await liveDriveOf(tx, orgId, parentId);
    if (!underLock) throw notFound();
    if (underLock !== driveId) throw parentNotInDrive();
  }
  if (folderId && !(await liveFolderInDrive(tx, orgId, driveId, folderId))) throw folderNotInDrive();
  const now = new Date();
  const [created] = await tx.insert(documents).values({
    org_id: orgId,
    drive_id: driveId,
    folder_id: folderId,
    parent_document_id: parentId,
    title: input.title ?? '',
    position: await nextDocumentPosition(tx, orgId, driveId, folderId, parentId),
    ...content,
    is_template: input.isTemplate ?? false,
    use_in_knowledge: input.useInKnowledge ?? null,
    created_by: userId,
    last_edited_by: userId,
    last_edited_at: now,
  }).returning();
  if (parentId) await copySharesInTx(tx, orgId, parentId, created!.id);
  const document = created!;
  return {
    document,
    finish: async () => {
      emitDocumentEvent({ type: 'created', orgId, documentIds: [document.id], toDriveId: document.drive_id, actorId: userId });
      await emitDocumentUpdated(orgId, [document.id]);
    },
  };
}

/**
 * The caller's My drive, in this transaction, locked FOR UPDATE before its
 * owner row is written (the header's lock order). Someone who can never hold
 * access is refused.
 */
async function myDriveInTx(tx: Tx, orgId: string, userId: string): Promise<string> {
  try {
    return (await ensurePersonalDrive(orgId, userId, tx, { lockForUpdate: true })).id;
  } catch (error) {
    if (error instanceof PrincipalCannotHoldAccessError) {
      throw new DocumentRefusal(403, 'ORG_MEMBERSHIP_INACTIVE', 'Not an active member of this workspace');
    }
    throw error;
  }
}

/** F9's sub-page share rule (lib/document-shares.ts): the new sub-page starts with every share of its parent, as it is. */
async function copySharesInTx(tx: Tx, orgId: string, parentId: string, documentId: string): Promise<void> {
  const shares = await tx.select().from(documentShares)
    .where(and(eq(documentShares.org_id, orgId), eq(documentShares.document_id, parentId)));
  if (shares.length === 0) return;
  await tx.insert(documentShares).values(shares.map((share) => ({
    org_id: orgId, document_id: documentId, principal_type: share.principal_type, principal_id: share.principal_id,
    role: share.role, shared_by: share.shared_by,
  })));
}

// ---------------------------------------------------------------------------
// Changing, moving, deleting and restoring

export type DocumentPatch = { title?: string; icon?: string | null; isTemplate?: boolean };

/**
 * Changes a document's title, icon or template flag (edit on the document).
 * Never its content (rule C2). `view` is the caller's answer
 * (viewerDocumentColumns), read inside the same transaction, so what they
 * get back is what they wrote, whatever happens after the commit.
 */
export async function updateDocument(input: { orgId: string; userId: string; documentId: string; patch: DocumentPatch }): Promise<{
  document: DocumentRow; view: ViewerDocument;
}> {
  const { orgId, userId, patch } = input;
  const outcome = await db.transaction(async (tx) => {
    let document = await lockDocumentForEditInTx(tx, actorOf(orgId, userId), input.documentId);
    const set: Partial<typeof documents.$inferInsert> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.icon !== undefined) set.icon = patch.icon;
    if (patch.isTemplate !== undefined) set.is_template = patch.isTemplate;
    const changed = Object.keys(set).length > 0;
    if (changed) {
      const now = new Date();
      const [updated] = await tx.update(documents).set({ ...set, last_edited_by: userId, last_edited_at: now, updated_at: now })
        .where(eq(documents.id, document.id)).returning();
      document = updated!;
    }
    return { document, view: await viewerDocumentInTx(tx, userId, orgId, document.id), changed };
  });
  if (outcome.changed) await emitDocumentUpdated(orgId, [outcome.document.id]);
  return { document: outcome.document, view: outcome.view };
}

/**
 * Moves a document and its whole sub-page tree, in one statement, to
 * `driveId`: at its root, into `folderId`, or under `parentDocumentId`, at
 * `position` (by default after its new siblings). Needs edit on the
 * document and on both drives. Moving it under itself or one of its own
 * sub-pages is 409 MOVE_CYCLE. Moved ids are sorted and include sub-pages in
 * the trash, which move with their parent.
 */
export async function moveDocument(input: { orgId: string; userId: string; documentId: string; driveId: string; folderId?: string | null;
  parentDocumentId?: string | null; position?: number }): Promise<{ movedIds: string[] }> {
  const { orgId, userId, driveId: toDriveId } = input;
  const folderId = input.folderId ?? null;
  const parentId = input.parentDocumentId ?? null;
  if (folderId && parentId) throw invalid('A document is in a folder or under a page, not both');
  const actor = actorOf(orgId, userId);
  const outcome = await db.transaction(async (tx) => {
    const fromDriveId = await liveDriveOf(tx, orgId, input.documentId);
    if (!fromDriveId) throw notFound();
    await lockActorInTx(tx, actor);
    const access = new Map<string, DriveAccess | null>();
    for (const driveId of [...new Set([fromDriveId, toDriveId])].sort()) access.set(driveId, await driveAccess(tx, actor, driveId, true));
    const document = await lockedDocument(tx, orgId, input.documentId, fromDriveId);
    await requireDocumentRole(tx, actor, document.id, 'edit');
    if (!roleAtLeast(access.get(fromDriveId)?.role ?? null, 'edit')) throw forbidden('You need edit access to the drive the document is in');
    const target = access.get(toDriveId);
    if (!target || target.role === null) throw notFound('Drive');
    if (!roleAtLeast(target.role, 'edit')) throw forbidden('You need edit access to this drive');

    const ids = await subtreeIds(tx, orgId, document.id, false);
    if (parentId && ids.includes(parentId)) throw moveCycle();
    if (parentId && (await liveDriveOf(tx, orgId, parentId)) !== toDriveId) throw parentNotInDrive();
    if (folderId && !(await liveFolderInDrive(tx, orgId, toDriveId, folderId))) throw folderNotInDrive();
    const position = input.position ?? await nextDocumentPosition(tx, orgId, toDriveId, folderId, parentId, document.id);
    const isRoot = sql`${documents.id} = ${document.id}`;
    await tx.update(documents).set({
      drive_id: toDriveId,
      folder_id: sql`CASE WHEN ${isRoot} THEN ${folderId}::text ELSE ${documents.folder_id} END`,
      parent_document_id: sql`CASE WHEN ${isRoot} THEN ${parentId}::text ELSE ${documents.parent_document_id} END`,
      position: sql`CASE WHEN ${isRoot} THEN ${position}::double precision ELSE ${documents.position} END`,
      updated_at: new Date(),
    }).where(and(eq(documents.org_id, orgId), inArray(documents.id, ids)));
    const loss = fromDriveId !== toDriveId ? await accessLossInTx(tx, { orgId, driveId: fromDriveId, documentIds: ids }) : null;
    return { ids, fromDriveId, loss };
  });
  if (outcome.loss) await finishLoss(outcome.loss);
  if (outcome.fromDriveId !== toDriveId) emitDocumentAccessChanged({ orgId, driveId: toDriveId, documentIds: outcome.ids });
  emitDocumentEvent({ type: 'moved', orgId, documentIds: outcome.ids, fromDriveId: outcome.fromDriveId, toDriveId, actorId: userId });
  await emitDocumentUpdated(orgId, outcome.ids);
  return { movedIds: outcome.ids };
}

/**
 * Moves a document and its live sub-pages to the drive's trash (edit on the
 * document), with one deleted_at for them all. `deletedIds` is every page
 * trashed, sorted; `visibleIds` only those the caller could view before the
 * delete (a page shared on its own can have sub-pages they can't see), for
 * the caller's answer.
 */
export async function softDeleteDocument(input: { orgId: string; userId: string; documentId: string }): Promise<{ deletedIds: string[]; visibleIds: string[] }> {
  const { orgId, userId } = input;
  const outcome = await db.transaction(async (tx) => {
    const document = await lockDocumentForEditInTx(tx, actorOf(orgId, userId), input.documentId);
    const ids = await subtreeIds(tx, orgId, document.id, true);
    const visible = await tx.select({ id: documents.id }).from(documents)
      .where(and(inArray(documents.id, ids), visibleDocumentCondition(userId, orgId)));
    const deleted = await tx.execute(sql`WITH delete_stamp AS MATERIALIZED (
        SELECT ${deleteStampSql(orgId, await subtreeIds(tx, orgId, document.id, false))} AS at
      )
      UPDATE documents SET is_deleted = true, deleted_by = ${userId},
        deleted_at = (SELECT at FROM delete_stamp), updated_at = (SELECT at FROM delete_stamp)
      WHERE documents.org_id = ${orgId} AND documents.id = ANY(${sql.param(ids)}::text[]) AND documents.is_deleted = false
      RETURNING documents.id`);
    const deletedIds = (deleted.rows as Array<{ id: string }>).map((row) => row.id).sort();
    const loss = await accessLossInTx(tx, { orgId, driveId: document.drive_id, documentIds: deletedIds });
    const visibleIds = visible.map((row) => row.id).filter((id) => deletedIds.includes(id)).sort();
    return { driveId: document.drive_id, deletedIds, visibleIds, loss };
  });
  // No document:updated: nobody can view a deleted document (header).
  await finishLoss(outcome.loss);
  emitDocumentEvent({ type: 'deleted', orgId, documentIds: outcome.deletedIds, fromDriveId: outcome.driveId, actorId: userId });
  return { deletedIds: outcome.deletedIds, visibleIds: outcome.visibleIds };
}

/**
 * Brings a document back from its drive's trash (edit on the drive), with
 * the sub-pages deleted together with it. It goes to the drive root when its
 * parent page or its folder is still deleted. Older than TRASH_DAYS is
 * gone: 404. Restored ids are sorted.
 */
export async function restoreDocument(input: { orgId: string; userId: string; documentId: string }): Promise<{ restoredIds: string[] }> {
  const { orgId, userId } = input;
  const actor = actorOf(orgId, userId);
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx.select({ drive_id: documents.drive_id }).from(documents)
      .where(and(eq(documents.id, input.documentId), eq(documents.org_id, orgId))).limit(1);
    if (!current) throw notFound();
    await lockActorInTx(tx, actor);
    await lockDriveForEditInTx(tx, actor, current.drive_id, notFound());
    const [document] = await tx.select().from(documents)
      .where(and(eq(documents.id, input.documentId), eq(documents.org_id, orgId))).for('update');
    if (!document) throw notFound();
    if (document.drive_id !== current.drive_id) throw changedMeanwhile();
    if (!document.is_deleted) throw new DocumentRefusal(409, 'NOT_IN_TRASH', 'This document isn’t in the trash');
    if (!document.deleted_at || document.deleted_at < trashCutoff()) throw notFound();
    const result = await tx.execute(sql`WITH RECURSIVE restored AS (
        SELECT ${document.id}::text AS id, restore_root.deleted_at FROM documents restore_root WHERE restore_root.id = ${document.id}
        UNION
        SELECT restore_child.id, restore_child.deleted_at FROM documents restore_child
          JOIN restored ON restore_child.parent_document_id = restored.id
          WHERE restore_child.org_id = ${orgId} AND restore_child.is_deleted = true AND restore_child.deleted_at = restored.deleted_at
      )
      SELECT id FROM restored ORDER BY id`);
    const ids = (result.rows as Array<{ id: string }>).map((row) => row.id);
    const parentLive = document.parent_document_id !== null && (await liveDriveOf(tx, orgId, document.parent_document_id)) === document.drive_id;
    const folderLive = document.folder_id !== null && await liveFolderInDrive(tx, orgId, document.drive_id, document.folder_id);
    const now = new Date();
    await tx.update(documents).set({ is_deleted: false, deleted_at: null, deleted_by: null, updated_at: now })
      .where(and(eq(documents.org_id, orgId), inArray(documents.id, ids)));
    if ((document.parent_document_id !== null && !parentLive) || (document.folder_id !== null && !folderLive)) {
      await tx.update(documents)
        .set({ parent_document_id: parentLive ? document.parent_document_id : null, folder_id: folderLive ? document.folder_id : null })
        .where(eq(documents.id, document.id));
    }
    return { driveId: document.drive_id, ids };
  });
  emitDocumentAccessChanged({ orgId, driveId: outcome.driveId, documentIds: outcome.ids });
  emitDocumentEvent({ type: 'restored', orgId, documentIds: outcome.ids, toDriveId: outcome.driveId, actorId: userId });
  await emitDocumentUpdated(orgId, outcome.ids);
  return { restoredIds: outcome.ids };
}

// ---------------------------------------------------------------------------
// Folders

/** A live folder locked for a change, in the lock order (actor, its drive with edit required, the folder). */
async function lockFolderForEditInTx(tx: Tx, actor: DriveActor, folderId: string): Promise<DocFolderRow> {
  const live = and(eq(docFolders.id, folderId), eq(docFolders.org_id, actor.org_id), eq(docFolders.is_deleted, false));
  const [current] = await tx.select({ drive_id: docFolders.drive_id }).from(docFolders).where(live).limit(1);
  if (!current) throw notFound('Folder');
  await lockActorInTx(tx, actor);
  await lockDriveForEditInTx(tx, actor, current.drive_id, notFound('Folder'));
  // A folder never changes drive.
  const [folder] = await tx.select().from(docFolders).where(live).for('update');
  if (!folder) throw notFound('Folder');
  return folder;
}

/** Creates a folder in `driveId`, at its root or in `parentFolderId` (edit on the drive). */
export async function createFolder(input: { orgId: string; userId: string; driveId: string; parentFolderId?: string | null; name: string }): Promise<DocFolderRow> {
  const { orgId, userId, driveId } = input;
  const parentFolderId = input.parentFolderId ?? null;
  const actor = actorOf(orgId, userId);
  return db.transaction(async (tx) => {
    await lockActorInTx(tx, actor);
    await lockDriveForEditInTx(tx, actor, driveId);
    if (parentFolderId && !(await liveFolderInDrive(tx, orgId, driveId, parentFolderId))) throw folderNotInDrive();
    const [folder] = await tx.insert(docFolders).values({
      org_id: orgId, drive_id: driveId, parent_folder_id: parentFolderId, name: input.name,
      position: await nextFolderPosition(tx, orgId, driveId, parentFolderId), created_by: userId,
    }).returning();
    return folder!;
  });
}

/** Renames, moves inside its drive, or reorders a folder (edit on the drive). Moving it under itself is 409 MOVE_CYCLE. */
export async function updateFolder(input: { orgId: string; userId: string; folderId: string; name?: string; parentFolderId?: string | null;
  position?: number }): Promise<DocFolderRow> {
  const { orgId } = input;
  return db.transaction(async (tx) => {
    const folder = await lockFolderForEditInTx(tx, actorOf(orgId, input.userId), input.folderId);
    const set: Partial<typeof docFolders.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.position !== undefined) set.position = input.position;
    if (input.parentFolderId !== undefined) {
      if (input.parentFolderId !== null) {
        const below = await tx.execute(sql`WITH RECURSIVE below AS (
            SELECT ${folder.id}::text AS id
            UNION
            SELECT below_folder.id FROM doc_folders below_folder JOIN below ON below_folder.parent_folder_id = below.id
              WHERE below_folder.org_id = ${orgId}
          )
          SELECT 1 FROM below WHERE id = ${input.parentFolderId}`);
        if (below.rows.length > 0) throw moveCycle();
        if (!(await liveFolderInDrive(tx, orgId, folder.drive_id, input.parentFolderId))) throw folderNotInDrive();
      }
      set.parent_folder_id = input.parentFolderId;
    }
    if (Object.keys(set).length === 0) return folder;
    const [updated] = await tx.update(docFolders).set({ ...set, updated_at: new Date() }).where(eq(docFolders.id, folder.id)).returning();
    return updated!;
  });
}

/**
 * Deletes a folder (edit on the drive): its documents, in the trash too, and
 * its folders move up to its parent folder, or to the drive root, and it is
 * soft-deleted. The live documents that moved get `document:updated`.
 */
export async function deleteFolder(input: { orgId: string; userId: string; folderId: string }): Promise<void> {
  const { orgId } = input;
  const movedIds = await db.transaction(async (tx) => {
    const folder = await lockFolderForEditInTx(tx, actorOf(orgId, input.userId), input.folderId);
    const now = new Date();
    const moved = await tx.update(documents).set({ folder_id: folder.parent_folder_id, updated_at: now })
      .where(and(eq(documents.org_id, orgId), eq(documents.folder_id, folder.id)))
      .returning({ id: documents.id, is_deleted: documents.is_deleted });
    await tx.update(docFolders).set({ parent_folder_id: folder.parent_folder_id, updated_at: now })
      .where(and(eq(docFolders.org_id, orgId), eq(docFolders.parent_folder_id, folder.id)));
    await tx.update(docFolders).set({ is_deleted: true, deleted_at: now, updated_at: now }).where(eq(docFolders.id, folder.id));
    return moved.filter((row) => !row.is_deleted).map((row) => row.id);
  });
  await emitDocumentUpdated(orgId, movedIds);
}

// ---------------------------------------------------------------------------
// Reading: the breadcrumb, the tree, the trash, recent and favourites

export type BreadcrumbItem = { type: 'drive' | 'folder' | 'document'; id: string; title: string } | { type: 'shared'; title: string };

/**
 * The statement documentBreadcrumb runs for the page chain: the document and
 * every parent page above it, top first, each with whether the viewer can
 * see it. The whole chain is followed; `visited` stops a cycle. Exported for
 * its planning test.
 */
export function breadcrumbChainQuery(userId: string, orgId: string, documentId: string): SQL {
  return sql`WITH RECURSIVE crumb_chain AS (
      SELECT crumb_doc.id, crumb_doc.parent_document_id, crumb_doc.folder_id, crumb_doc.drive_id, crumb_doc.title,
        ARRAY[crumb_doc.id] AS visited
      FROM documents crumb_doc
      WHERE crumb_doc.id = ${documentId} AND crumb_doc.org_id = ${orgId} AND crumb_doc.is_deleted = false
      UNION ALL
      SELECT crumb_parent.id, crumb_parent.parent_document_id, crumb_parent.folder_id, crumb_parent.drive_id, crumb_parent.title,
        crumb_chain.visited || crumb_parent.id
      FROM documents crumb_parent
      JOIN crumb_chain ON crumb_parent.id = crumb_chain.parent_document_id
      WHERE crumb_parent.org_id = ${orgId} AND NOT crumb_parent.id = ANY(crumb_chain.visited)
    )
    SELECT crumb_chain.id, crumb_chain.folder_id, crumb_chain.drive_id, crumb_chain.title,
      ${visibleDocumentIdSql(userId, orgId, sql.raw('crumb_chain.id'))} AS visible
    FROM crumb_chain
    ORDER BY cardinality(crumb_chain.visited) DESC`;
}

/**
 * Where a document sits, for its viewer (consult rule C4): its drive, every
 * folder above it, every parent page, then itself. Folders carry no access
 * of their own, so they follow the drive; each page is checked on its own.
 * Each run of ancestors the viewer can't see (drive, folders, pages) shows
 * as one "Shared with you", with no id; what they can see after it still
 * shows. Both chains are followed in full, a cycle stopped by `visited`.
 */
export async function documentBreadcrumb(documentId: string, viewer: { orgId: string; userId: string }, executor: Executor = db): Promise<BreadcrumbItem[]> {
  const { orgId, userId } = viewer;
  const pages = (await executor.execute(breadcrumbChainQuery(userId, orgId, documentId))).rows as Array<{
    id: string; folder_id: string | null; drive_id: string; title: string; visible: boolean;
  }>;
  const top = pages[0];
  if (!top) return [];
  const driveRows = await executor.execute(sql`SELECT crumb_drive.name,
      ${visibleDriveIdSql(userId, orgId, sql.raw('crumb_drive.id'))} AS visible
    FROM drives crumb_drive WHERE crumb_drive.id = ${top.drive_id} AND crumb_drive.org_id = ${orgId}`);
  const drive = driveRows.rows[0] as { name: string; visible: boolean } | undefined;
  const driveVisible = drive?.visible === true;
  const folders = top.folder_id ? (await executor.execute(sql`WITH RECURSIVE crumb_folders AS (
      SELECT crumb_folder.id, crumb_folder.parent_folder_id, crumb_folder.name, ARRAY[crumb_folder.id] AS visited
      FROM doc_folders crumb_folder
      WHERE crumb_folder.id = ${top.folder_id} AND crumb_folder.org_id = ${orgId} AND crumb_folder.drive_id = ${top.drive_id}
      UNION ALL
      SELECT crumb_up.id, crumb_up.parent_folder_id, crumb_up.name, crumb_folders.visited || crumb_up.id
      FROM doc_folders crumb_up
      JOIN crumb_folders ON crumb_up.id = crumb_folders.parent_folder_id
      WHERE crumb_up.org_id = ${orgId} AND crumb_up.drive_id = ${top.drive_id} AND NOT crumb_up.id = ANY(crumb_folders.visited)
    )
    SELECT id, name FROM crumb_folders ORDER BY cardinality(visited) DESC`)).rows as Array<{ id: string; name: string }> : [];
  const path: Array<{ visible: boolean; item: BreadcrumbItem }> = [
    { visible: driveVisible, item: { type: 'drive', id: top.drive_id, title: drive?.name ?? '' } },
    ...folders.map((folder) => ({ visible: driveVisible, item: { type: 'folder' as const, id: folder.id, title: folder.name } })),
    ...pages.map((page) => ({ visible: page.visible, item: { type: 'document' as const, id: page.id, title: page.title } })),
  ];
  const crumbs: BreadcrumbItem[] = [];
  for (const step of path) {
    if (step.visible) crumbs.push(step.item);
    else if (crumbs[crumbs.length - 1]?.type !== 'shared') crumbs.push({ type: 'shared', title: 'Shared with you' });
  }
  return crumbs;
}

/**
 * The one projection of a document a route returns to `userId` (rule C4):
 * `folder_id` only when they can view the drive (folders carry no access of
 * their own), `parent_document_id` only when they can view the parent page,
 * else null. GET /api/documents/:id, the create and change answers, recent
 * and favourites all use it.
 */
export function viewerDocumentColumns(userId: string, orgId: string) {
  return {
    id: documents.id,
    title: documents.title,
    icon: documents.icon,
    drive_id: documents.drive_id,
    folder_id: sql<string | null>`CASE WHEN ${documents.folder_id} IS NOT NULL
      AND ${visibleDriveIdSql(userId, orgId, sql`${documents.drive_id}`)} THEN ${documents.folder_id} END`,
    parent_document_id: sql<string | null>`CASE WHEN ${documents.parent_document_id} IS NOT NULL
      AND ${visibleDocumentIdSql(userId, orgId, sql`${documents.parent_document_id}`)} THEN ${documents.parent_document_id} END`,
    position: documents.position,
    is_template: documents.is_template,
    created_by: documents.created_by,
    last_edited_by: documents.last_edited_by,
    last_edited_at: documents.last_edited_at,
    created_at: documents.created_at,
    updated_at: documents.updated_at,
  };
}

/** A document `userId` can view, in viewerDocumentColumns' projection, or null. */
export async function documentForViewer(reader: Reader, userId: string, orgId: string, documentId: string) {
  const [document] = await reader.select(viewerDocumentColumns(userId, orgId)).from(documents)
    .where(and(eq(documents.id, documentId), visibleDocumentCondition(userId, orgId))).limit(1);
  return document ?? null;
}

/** A document as a route returns it (viewerDocumentColumns). */
export type ViewerDocument = NonNullable<Awaited<ReturnType<typeof documentForViewer>>>;

/**
 * The answer to a write, read in the write's own transaction: the caller
 * holds edit on the document there, so it is always theirs to see; if not,
 * the write rolls back as a 404.
 */
export async function viewerDocumentInTx(tx: Tx, userId: string, orgId: string, documentId: string): Promise<ViewerDocument> {
  const view = await documentForViewer(tx, userId, orgId, documentId);
  if (!view) throw notFound();
  return view;
}

/**
 * GET /api/drives/:id/tree's documents: those of the drive the caller can
 * see, by position, then title. The caller has checked they can view the
 * drive, so its folders and pages are theirs to see. Exported for its
 * planning test (`.toSQL()`).
 */
export function driveTreeDocumentsQuery(userId: string, orgId: string, driveId: string, reader: Reader = db) {
  return reader.select({
    id: documents.id, title: documents.title, icon: documents.icon, folder_id: documents.folder_id,
    parent_document_id: documents.parent_document_id, position: documents.position, updated_at: documents.updated_at,
  }).from(documents)
    .where(and(eq(documents.drive_id, driveId), visibleDocumentCondition(userId, orgId)))
    .orderBy(asc(documents.position), asc(documents.title), asc(documents.id));
}

/**
 * A drive's folders and the documents the caller can see in it (they can
 * view the drive), read through `reader`: the route's snapshot.
 */
export async function driveTree(reader: Reader, userId: string, orgId: string, driveId: string) {
  const folders = await reader.select({ id: docFolders.id, parent_folder_id: docFolders.parent_folder_id, name: docFolders.name, position: docFolders.position })
    .from(docFolders)
    .where(and(eq(docFolders.org_id, orgId), eq(docFolders.drive_id, driveId), eq(docFolders.is_deleted, false)))
    .orderBy(asc(docFolders.position), asc(docFolders.name), asc(docFolders.id));
  return { folders, documents: await driveTreeDocumentsQuery(userId, orgId, driveId, reader) };
}

/**
 * A drive's trash, read through `reader` (the route's snapshot): its
 * documents deleted in the last TRASH_DAYS, newest first. A page deleted
 * together with its parent comes back with it, so it is folded into the
 * parent's row; a page deleted on its own earlier keeps its own row. The
 * caller has checked they can edit the drive.
 */
export async function driveTrash(reader: Reader, orgId: string, driveId: string) {
  const parent = alias(documents, 'trash_parent');
  return reader.select({
    id: documents.id, title: documents.title, icon: documents.icon, folder_id: documents.folder_id,
    parent_document_id: documents.parent_document_id, deleted_at: documents.deleted_at, deleted_by: documents.deleted_by,
  }).from(documents)
    .where(and(
      eq(documents.org_id, orgId), eq(documents.drive_id, driveId), eq(documents.is_deleted, true), gte(documents.deleted_at, trashCutoff()),
      notExists(reader.select({ id: parent.id }).from(parent).where(and(
        eq(parent.id, documents.parent_document_id), eq(parent.is_deleted, true), eq(parent.deleted_at, documents.deleted_at),
      ))),
    ))
    .orderBy(desc(documents.deleted_at), asc(documents.id));
}

/** GET /api/documents/recent: the 20 most recently edited documents the caller can see. Exported for its planning test. */
export function recentDocumentsQuery(userId: string, orgId: string) {
  return db.select(viewerDocumentColumns(userId, orgId)).from(documents)
    .where(visibleDocumentCondition(userId, orgId))
    .orderBy(desc(sql`COALESCE(${documents.last_edited_at}, ${documents.updated_at})`), asc(documents.id))
    .limit(20);
}

/** GET /api/documents/favorites: the caller's starred documents they can still see, newest star first. Exported for its planning test. */
export function favoriteDocumentsQuery(userId: string, orgId: string) {
  return db.select({ ...viewerDocumentColumns(userId, orgId), favorited_at: docFavorites.created_at }).from(documents)
    .innerJoin(docFavorites, and(
      eq(docFavorites.org_id, orgId), eq(docFavorites.user_id, userId), eq(docFavorites.target_type, 'document'),
      eq(docFavorites.target_id, documents.id),
    ))
    .where(visibleDocumentCondition(userId, orgId))
    .orderBy(desc(docFavorites.created_at), asc(documents.id))
    .limit(200);
}
