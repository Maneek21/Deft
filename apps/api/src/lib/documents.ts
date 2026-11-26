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
// earlier stays in the trash.
//
// Content (rule C2): this file writes content only when it creates a
// document (initialContent), and leaves ydoc_state for the first live load.
// Every later content write goes through writeDocument (F7).
//
// Lock order (lib/drive-locks.ts, and routes/drives.ts's header): the
// actor's room-access lock, then their org_members row FOR SHARE
// (lockActorInTx), then the drive FOR UPDATE (both drives of a move, in id
// order), then the folders and documents changed. A document's drive is read
// before the locks, to know which drive to lock, and checked again under
// them. My drive is ensured between the actor and the drive
// (ensurePersonalDrive: the actor's rows FOR SHARE, then the drive FOR
// SHARE, which this transaction then raises to FOR UPDATE; the room-access
// lock keeps the person's own other writes out meanwhile).
//
// Access loss (rule C3): a move to another drive and a delete call
// applyAccessLossInTx in their transaction and finishAccessLoss after the
// commit. A move also tells listeners the target drive's people gained
// access, and a restore that access came back (emitDocumentAccessChanged).
//
// Events (rule C4): `document:updated`, ids only, to each person who can view
// the document (lib/document-access-events.ts). A delete tells the people who
// could view it before; a move tells the people who can view it after, with
// its new drive, and the people who could view it only before, with the
// drive they knew. Lifecycle events (lib/document-events.ts) follow every
// create, move, delete and restore. After a commit each step runs on its own,
// so one that fails never skips the next.
import { and, asc, desc, eq, gte, inArray, isNull, ne, notExists, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { docFavorites, docFolders, documentShares, documents, type DocFolderRow, type DocRole, type DocumentRow } from '@deft/db/documents';
import { EMPTY_DOCUMENT, ensureBlockIds, getDocumentSchema, jsonToText } from '@deft/doc-schema';
import { db } from './db.js';
import { documentRoleFor, roleAtLeast, visibleDocumentCondition, visibleDocumentIdSql, visibleDriveIdSql, type Executor } from './document-access.js';
import { accessLossInTx, finishAccessLoss, type PendingAccessLoss } from './document-access-change.js';
import {
  documentEventAudience, emitDocumentAccessChanged, emitDocumentUpdated, sendDocumentEvent, type DocumentEventAudience,
} from './document-access-events.js';
import { emitDocumentEvent } from './document-events.js';
import { driveAccess, lockActorInTx, type DriveAccess, type DriveActor } from './drive-locks.js';
import { ensurePersonalDrive, PrincipalCannotHoldAccessError } from './drives.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, 'select'>;
type JSONContent = Parameters<typeof jsonToText>[0];

/** How long a deleted document stays in its drive's trash. */
export const TRASH_DAYS = 30;

/** The deepest page or folder chain the breadcrumb follows. */
const MAX_DEPTH = 64;

/** A refusal for the caller: the routes answer `{ error: message, code }` with `status`. */
export class DocumentRefusal extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) { super(message); }
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
 * then the document.
 */
async function lockDocumentForEditInTx(tx: Tx, actor: DriveActor, documentId: string): Promise<DocumentRow> {
  const driveId = await liveDriveOf(tx, actor.org_id, documentId);
  if (!driveId) throw notFound();
  await lockActorInTx(tx, actor);
  await driveAccess(tx, actor, driveId, true);
  const document = await lockedDocument(tx, actor.org_id, documentId, driveId);
  await requireDocumentRole(tx, actor, document.id, 'edit');
  return document;
}

/** The document and its sub-pages at every depth (with `liveOnly`, only live ones), sorted by id. */
async function subtreeIds(tx: Tx, orgId: string, rootId: string, liveOnly: boolean): Promise<string[]> {
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
 * `json`, or an empty document, with block ids, its text and its size.
 * ydoc_state stays null until the first live load (F7). Content outside the
 * document schema is refused.
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
  return {
    content_json: contentJson,
    content_text: jsonToText(contentJson),
    size_bytes: Buffer.byteLength(JSON.stringify(contentJson)),
    ydoc_state: null,
  };
}

/**
 * Creates a document (see the header for the roles): in `driveId`, else in
 * the parent page's drive, else in the caller's My drive. With `executor`
 * it runs in the caller's transaction, and the caller calls
 * finishDocumentCreated after its commit; otherwise it commits and finishes
 * itself.
 */
export async function createDocument(input: CreateDocumentInput, executor?: Tx): Promise<DocumentRow> {
  if (input.folderId && input.parentDocumentId) throw invalid('A document is in a folder or under a page, not both');
  const content = initialContent(input.json);
  if (executor) return createDocumentInTx(executor, input, content);
  const document = await db.transaction((tx) => createDocumentInTx(tx, input, content));
  await finishDocumentCreated(document, input.userId);
  return document;
}

async function createDocumentInTx(tx: Tx, input: CreateDocumentInput, content: ReturnType<typeof initialContent>): Promise<DocumentRow> {
  const { orgId, userId } = input;
  const actor = actorOf(orgId, userId);
  const folderId = input.folderId ?? null;
  const parentId = input.parentDocumentId ?? null;
  const parentDriveId = parentId ? await liveDriveOf(tx, orgId, parentId) : null;
  if (parentId && !parentDriveId) throw notFound();
  if (parentDriveId && input.driveId && input.driveId !== parentDriveId) throw parentNotInDrive();
  await lockActorInTx(tx, actor);
  const driveId = input.driveId ?? parentDriveId ?? (await myDriveInTx(tx, orgId, userId));
  // A parent page the caller can't see reads as a missing page, not a drive.
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
  return created!;
}

/** The caller's My drive, in this transaction. Someone who can never hold access is refused. */
async function myDriveInTx(tx: Tx, orgId: string, userId: string): Promise<string> {
  try {
    return (await ensurePersonalDrive(orgId, userId, tx)).id;
  } catch (error) {
    if (error instanceof PrincipalCannotHoldAccessError) {
      throw new DocumentRefusal(403, 'ORG_MEMBERSHIP_INACTIVE', 'Not an active member of this workspace');
    }
    throw error;
  }
}

/** F9's sub-page share rule: the new sub-page starts with every share of its parent, as it is. */
async function copySharesInTx(tx: Tx, orgId: string, parentId: string, documentId: string): Promise<void> {
  const shares = await tx.select().from(documentShares)
    .where(and(eq(documentShares.org_id, orgId), eq(documentShares.document_id, parentId)));
  if (shares.length === 0) return;
  await tx.insert(documentShares).values(shares.map((share) => ({
    org_id: orgId, document_id: documentId, principal_type: share.principal_type, principal_id: share.principal_id,
    role: share.role, shared_by: share.shared_by,
  })));
}

/** After a create's commit: the `created` lifecycle event, then `document:updated` to the document's viewers. Never throws. */
export async function finishDocumentCreated(document: DocumentRow, actorId: string): Promise<void> {
  emitDocumentEvent({ type: 'created', orgId: document.org_id, documentIds: [document.id], toDriveId: document.drive_id, actorId });
  await emitDocumentUpdated(document.org_id, [document.id]);
}

// ---------------------------------------------------------------------------
// Changing, moving, deleting and restoring

export type DocumentPatch = { title?: string; icon?: string | null; isTemplate?: boolean };

/** Changes a document's title, icon or template flag (edit on the document). Never its content (rule C2). */
export async function updateDocument(input: { orgId: string; userId: string; documentId: string; patch: DocumentPatch }): Promise<DocumentRow> {
  const { orgId, userId, patch } = input;
  const outcome = await db.transaction(async (tx) => {
    const document = await lockDocumentForEditInTx(tx, actorOf(orgId, userId), input.documentId);
    const set: Partial<typeof documents.$inferInsert> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.icon !== undefined) set.icon = patch.icon;
    if (patch.isTemplate !== undefined) set.is_template = patch.isTemplate;
    if (Object.keys(set).length === 0) return { document, changed: false };
    const now = new Date();
    const [updated] = await tx.update(documents).set({ ...set, last_edited_by: userId, last_edited_at: now, updated_at: now })
      .where(eq(documents.id, document.id)).returning();
    return { document: updated!, changed: true };
  });
  if (outcome.changed) await emitDocumentUpdated(orgId, [outcome.document.id]);
  return outcome.document;
}

/**
 * A move's `document:updated`: the people who can view the documents after
 * it, with the new drive; the people who could view them only before, with
 * the drive they knew.
 */
function sendMovedEvents(before: DocumentEventAudience | null, after: DocumentEventAudience): void {
  sendDocumentEvent(after, 'document:updated');
  if (!before) return;
  const viewingAfter = new Map(after.documents.map((doc) => [doc.documentId, new Set(doc.userIds)]));
  sendDocumentEvent({
    orgId: before.orgId,
    documents: before.documents.map((doc) => ({ ...doc, userIds: doc.userIds.filter((userId) => !viewingAfter.get(doc.documentId)?.has(userId)) })),
  }, 'document:updated');
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
    const crossDrive = fromDriveId !== toDriveId;
    const before = crossDrive ? await documentEventAudience(orgId, ids, tx) : null;
    const isRoot = sql`${documents.id} = ${document.id}`;
    await tx.update(documents).set({
      drive_id: toDriveId,
      folder_id: sql`CASE WHEN ${isRoot} THEN ${folderId}::text ELSE ${documents.folder_id} END`,
      parent_document_id: sql`CASE WHEN ${isRoot} THEN ${parentId}::text ELSE ${documents.parent_document_id} END`,
      position: sql`CASE WHEN ${isRoot} THEN ${position}::double precision ELSE ${documents.position} END`,
      updated_at: new Date(),
    }).where(and(eq(documents.org_id, orgId), inArray(documents.id, ids)));
    const after = await documentEventAudience(orgId, ids, tx);
    const loss = crossDrive ? await accessLossInTx(tx, { orgId, driveId: fromDriveId, documentIds: ids }) : null;
    return { ids, fromDriveId, before, after, loss };
  });
  if (outcome.loss) await finishLoss(outcome.loss);
  if (outcome.fromDriveId !== toDriveId) emitDocumentAccessChanged({ orgId, driveId: toDriveId, documentIds: outcome.ids });
  emitDocumentEvent({ type: 'moved', orgId, documentIds: outcome.ids, fromDriveId: outcome.fromDriveId, toDriveId, actorId: userId });
  sendMovedEvents(outcome.before, outcome.after);
  return { movedIds: outcome.ids };
}

/**
 * Moves a document and its live sub-pages to the drive's trash (edit on the
 * document), with one deleted_at for them all. Deleted ids are sorted.
 */
export async function softDeleteDocument(input: { orgId: string; userId: string; documentId: string }): Promise<{ deletedIds: string[] }> {
  const { orgId, userId } = input;
  const outcome = await db.transaction(async (tx) => {
    const document = await lockDocumentForEditInTx(tx, actorOf(orgId, userId), input.documentId);
    const ids = await subtreeIds(tx, orgId, document.id, true);
    const before = await documentEventAudience(orgId, ids, tx);
    const now = new Date();
    const deleted = await tx.update(documents).set({ is_deleted: true, deleted_at: now, deleted_by: userId, updated_at: now })
      .where(and(eq(documents.org_id, orgId), inArray(documents.id, ids), eq(documents.is_deleted, false)))
      .returning({ id: documents.id });
    const deletedIds = deleted.map((row) => row.id).sort();
    const loss = await accessLossInTx(tx, { orgId, driveId: document.drive_id, documentIds: deletedIds });
    return { driveId: document.drive_id, deletedIds, before, loss };
  });
  await finishLoss(outcome.loss);
  emitDocumentEvent({ type: 'deleted', orgId, documentIds: outcome.deletedIds, fromDriveId: outcome.driveId, actorId: userId });
  sendDocumentEvent(outcome.before, 'document:updated');
  return { deletedIds: outcome.deletedIds };
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

const sharedCrumb = (): BreadcrumbItem => ({ type: 'shared', title: 'Shared with you' });

/**
 * The statement documentBreadcrumb runs for the page chain: the document and
 * its parent pages, top first, each with whether the viewer can see it.
 * Exported for its planning test.
 */
export function breadcrumbChainQuery(userId: string, orgId: string, documentId: string): SQL {
  return sql`WITH RECURSIVE crumb_chain AS (
      SELECT crumb_doc.id, crumb_doc.parent_document_id, crumb_doc.folder_id, crumb_doc.drive_id, crumb_doc.title, 0 AS depth
      FROM documents crumb_doc
      WHERE crumb_doc.id = ${documentId} AND crumb_doc.org_id = ${orgId} AND crumb_doc.is_deleted = false
      UNION ALL
      SELECT crumb_parent.id, crumb_parent.parent_document_id, crumb_parent.folder_id, crumb_parent.drive_id, crumb_parent.title,
        crumb_chain.depth + 1
      FROM documents crumb_parent
      JOIN crumb_chain ON crumb_parent.id = crumb_chain.parent_document_id
      WHERE crumb_parent.org_id = ${orgId} AND crumb_parent.is_deleted = false AND crumb_chain.depth < ${MAX_DEPTH}
    )
    SELECT crumb_chain.id, crumb_chain.folder_id, crumb_chain.drive_id, crumb_chain.title,
      ${visibleDocumentIdSql(userId, orgId, sql.raw('crumb_chain.id'))} AS visible
    FROM crumb_chain
    ORDER BY crumb_chain.depth DESC`;
}

/**
 * Where a document sits, for its viewer (consult rule C4): its drive, the
 * folders above it, its parent pages, then itself. Each ancestor the viewer
 * can't see shows as "Shared with you", one for a run of them, with no id.
 * Folders carry no access of their own, so they show only with the drive.
 */
export async function documentBreadcrumb(documentId: string, viewer: { orgId: string; userId: string }, executor: Executor = db): Promise<BreadcrumbItem[]> {
  const { orgId, userId } = viewer;
  const chain = (await executor.execute(breadcrumbChainQuery(userId, orgId, documentId))).rows as Array<{
    id: string; folder_id: string | null; drive_id: string; title: string; visible: boolean;
  }>;
  const top = chain[0];
  if (!top) return [];
  const crumbs: BreadcrumbItem[] = [];
  const driveRows = await executor.execute(sql`SELECT crumb_drive.name,
      ${visibleDriveIdSql(userId, orgId, sql.raw('crumb_drive.id'))} AS visible
    FROM drives crumb_drive WHERE crumb_drive.id = ${top.drive_id} AND crumb_drive.org_id = ${orgId}`);
  const drive = driveRows.rows[0] as { name: string; visible: boolean } | undefined;
  if (drive?.visible) {
    crumbs.push({ type: 'drive', id: top.drive_id, title: drive.name });
    if (top.folder_id) {
      const folders = await executor.execute(sql`WITH RECURSIVE crumb_folders AS (
          SELECT crumb_folder.id, crumb_folder.parent_folder_id, crumb_folder.name, 0 AS depth
          FROM doc_folders crumb_folder
          WHERE crumb_folder.id = ${top.folder_id} AND crumb_folder.org_id = ${orgId} AND crumb_folder.drive_id = ${top.drive_id}
          UNION ALL
          SELECT crumb_up.id, crumb_up.parent_folder_id, crumb_up.name, crumb_folders.depth + 1
          FROM doc_folders crumb_up
          JOIN crumb_folders ON crumb_up.id = crumb_folders.parent_folder_id
          WHERE crumb_up.org_id = ${orgId} AND crumb_up.drive_id = ${top.drive_id} AND crumb_folders.depth < ${MAX_DEPTH}
        )
        SELECT id, name FROM crumb_folders ORDER BY depth DESC`);
      for (const folder of folders.rows as Array<{ id: string; name: string }>) crumbs.push({ type: 'folder', id: folder.id, title: folder.name });
    }
  } else {
    crumbs.push(sharedCrumb());
  }
  for (const page of chain) crumbs.push(page.visible ? { type: 'document', id: page.id, title: page.title } : sharedCrumb());
  return crumbs.filter((crumb, at) => !(crumb.type === 'shared' && crumbs[at - 1]?.type === 'shared'));
}

/**
 * GET /api/drives/:id/tree's documents: those of the drive the caller can
 * see, by position, then title. The caller has checked they can view the
 * drive. Exported for its planning test (`.toSQL()`).
 */
export function driveTreeDocumentsQuery(userId: string, orgId: string, driveId: string) {
  return db.select({
    id: documents.id, title: documents.title, icon: documents.icon, folder_id: documents.folder_id,
    parent_document_id: documents.parent_document_id, position: documents.position, updated_at: documents.updated_at,
  }).from(documents)
    .where(and(eq(documents.drive_id, driveId), visibleDocumentCondition(userId, orgId)))
    .orderBy(asc(documents.position), asc(documents.title), asc(documents.id));
}

/** A drive's folders and the documents the caller can see in it (they can view the drive). */
export async function driveTree(userId: string, orgId: string, driveId: string) {
  const folders = await db.select({ id: docFolders.id, parent_folder_id: docFolders.parent_folder_id, name: docFolders.name, position: docFolders.position })
    .from(docFolders)
    .where(and(eq(docFolders.org_id, orgId), eq(docFolders.drive_id, driveId), eq(docFolders.is_deleted, false)))
    .orderBy(asc(docFolders.position), asc(docFolders.name), asc(docFolders.id));
  return { folders, documents: await driveTreeDocumentsQuery(userId, orgId, driveId) };
}

/**
 * A drive's trash: its documents deleted in the last TRASH_DAYS, newest
 * first. A page deleted together with its parent comes back with it, so only
 * the document each delete started from is listed. The caller has checked
 * they can edit the drive.
 */
export async function driveTrash(orgId: string, driveId: string) {
  const parent = alias(documents, 'trash_parent');
  return db.select({
    id: documents.id, title: documents.title, icon: documents.icon, folder_id: documents.folder_id,
    parent_document_id: documents.parent_document_id, deleted_at: documents.deleted_at, deleted_by: documents.deleted_by,
  }).from(documents)
    .where(and(
      eq(documents.org_id, orgId), eq(documents.drive_id, driveId), eq(documents.is_deleted, true), gte(documents.deleted_at, trashCutoff()),
      notExists(db.select({ id: parent.id }).from(parent).where(and(
        eq(parent.id, documents.parent_document_id), eq(parent.is_deleted, true), eq(parent.deleted_at, documents.deleted_at),
      ))),
    ))
    .orderBy(desc(documents.deleted_at), asc(documents.id));
}

const listColumns = {
  id: documents.id, title: documents.title, icon: documents.icon, drive_id: documents.drive_id, folder_id: documents.folder_id,
  parent_document_id: documents.parent_document_id, last_edited_by: documents.last_edited_by, last_edited_at: documents.last_edited_at,
  updated_at: documents.updated_at,
};

/** GET /api/documents/recent: the 20 most recently edited documents the caller can see. Exported for its planning test. */
export function recentDocumentsQuery(userId: string, orgId: string) {
  return db.select(listColumns).from(documents)
    .where(visibleDocumentCondition(userId, orgId))
    .orderBy(desc(sql`COALESCE(${documents.last_edited_at}, ${documents.updated_at})`), asc(documents.id))
    .limit(20);
}

/** GET /api/documents/favorites: the caller's starred documents they can still see, newest star first. Exported for its planning test. */
export function favoriteDocumentsQuery(userId: string, orgId: string) {
  return db.select({ ...listColumns, favorited_at: docFavorites.created_at }).from(documents)
    .innerJoin(docFavorites, and(
      eq(docFavorites.org_id, orgId), eq(docFavorites.user_id, userId), eq(docFavorites.target_type, 'document'),
      eq(docFavorites.target_id, documents.id),
    ))
    .where(visibleDocumentCondition(userId, orgId))
    .orderBy(desc(docFavorites.created_at), asc(documents.id))
    .limit(200);
}
