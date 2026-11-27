// Sharing a document with people and chats (spec 5.2 and 5.10; plan Task F9).
//
// Roles (the access check, lib/document-access.ts):
// - listing a document's shares needs edit (consult rule C4). Someone the
//   caller may not see is hidden whole: a person outside the people rule
//   (lib/people-visibility-sql.ts: a guest sees only the people they share a
//   chat with), a chat the caller can't read. Their name and their id are
//   null, and so is `shared_by` when it names someone hidden; the share's own
//   id stays, so the share can still be managed. The role and the list are
//   read in one read-only, repeatable-read snapshot;
// - sharing, changing a share's role and removing a share need edit on the
//   document. A share gives at most edit: `full` is 400 ROLE_TOO_HIGH;
// - the audience (the posting prompt, F13) needs view on the document and a
//   seat in the chat, in one snapshot too.
// The role is checked first without any lock, and again under the locks
// below: someone who can't see the document gets 404 and a reader 403 before
// anything is locked, and before anything is said about the role asked for or
// the recipient. Then come 400 (ROLE_TOO_HIGH, SELF_SHARE,
// PRINCIPAL_CANNOT_HOLD_ACCESS) and 409.
//
// Recipients. A share made or raised can't name the sharer (400 SELF_SHARE:
// a drive member about to be removed could otherwise keep the pages; a chat
// the sharer is in is fine), nor someone who could never hold access
// (canHoldDocumentAccess: an inactive member, Defty's own user, a system
// user, anyone outside the workspace), nor a chat of this workspace the
// sharer can't read (canReadSpace), nor, for a guest sharer, a person they
// can't see (the people rule): 400 PRINCIPAL_CANNOT_HOLD_ACCESS, the same
// answer as for someone who doesn't exist. Lowering or removing a share is
// always allowed, so stale shares can be cleaned up.
//
// Sub-pages ("Include sub-pages", on by default, `includeSubpages`):
// - sharing a page gives the same share to each live sub-page, at every
//   depth, that the sharer can edit, or raises a lower share there to it; one
//   that already gives at least that role keeps it, so a share never takes
//   access away;
// - removing a page's share removes the same principal's shares from those
//   sub-pages, and lowering it lowers any of them above the new role. Raising
//   a share changes its own page only: raising across the tree is a new share;
// - sub-pages the actor can view but not edit are skipped and counted.
//   Sub-pages they can't see are left alone and not counted, so the count
//   never tells them a hidden page exists.
// A sub-page made later starts with its parent's shares (lib/documents.ts
// createDocumentInTx).
//
// Lock order (lib/drive-locks.ts; routes/drives.ts's header holds the whole
// argument against departures):
// 1. the actor's room-access lock, then their org_members row FOR SHARE
//    (lockActorInTx);
// 2. for a share made or changed, the recipient: a person's org_members row
//    and an agent's employee row FOR SHARE (canHoldDocumentAccessLocked), or
//    a chat's spaces row FOR SHARE, with the sharer's right to share with it
//    (canReadSpace) checked under that lock;
// 3. the document's drive FOR SHARE;
// 4. the documents FOR UPDATE, in id order: the page and, with sub-pages,
//    each live sub-page.
// The drive is read before the locks, to know which to lock, and checked
// again under them: a document moved meanwhile answers 409 CONFLICT. Every
// create, move, delete and restore in a drive locks it FOR UPDATE
// (lib/documents.ts), so while a share holds it FOR SHARE the sub-page tree
// can't change; shares in one drive run side by side and meet only on their
// documents, which every share takes in id order. Live editing and
// writeDocument lock one document row and wait on nothing after it.
//
// Access (consult rule C3): removing or lowering a share calls
// applyAccessLossInTx once in its transaction, naming every page it changed,
// and finishAccessLoss after the commit. A new or raised share tells
// listeners after the commit (emitDocumentAccessChanged).
//
// Who is told (spec 5.10, as F4 tells people added to a drive). Before the
// share is written, one statement works out, for each page it will write
// (the page and the sub-pages the sharer can edit), the people it newly
// reaches there: the person, or the chat's active members other than the
// sharer, whose role on that page is below the share's role (consult S-F3).
// - One `document_shared` notification, for the page shared (subtype
//   `document_share`, with `document_id`), goes to those newly reached on it:
//   the person (human or agent), or the humans of the chat. Someone who could
//   already open it at that role isn't told. It is listed and counted only
//   while its reader can open the document (lib/native-mention-visibility.ts),
//   and its attention item is a `document` item (lib/attention.ts).
// - `document:shared { document_id }` goes, for each page the share wrote, to
//   the people newly reached on that page (an agent in the chat included) who
//   can view it now (rule C4: emitToUser, never a room).
// After the commit each step runs on its own, so one that fails never skips
// the next.
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { documentShares, documents, drives, type DocRole, type DocShareRole, type DocumentShareRow } from '@deft/db/documents';
import { spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from './db.js';
import {
  documentRoleFor, documentViewers, DOC_ROLE_RANK, roleAtLeast, spaceMembersWhoCannotOpen, visibleDocumentCondition, visibleDocumentIdSql,
} from './document-access.js';
import { accessLossInTx, finishAccessLoss, type PendingAccessLoss } from './document-access-change.js';
import { emitDocumentAccessChanged, sendDocumentEvent, type DocumentAccessChange } from './document-access-events.js';
import { DocumentRefusal, subtreeIds } from './documents.js';
import { lockActorInTx, type DriveActor } from './drive-locks.js';
import { canHoldDocumentAccessLocked } from './drives.js';
import { emitVisibleNotifications } from './notification-delivery.js';
import { createNotificationIfAllowed } from './notification-policy.js';
import { asStoredNotificationType } from './notification-types.js';
import { canSeePerson, peopleViewer, visiblePersonIds } from './people-visibility.js';
import { canReadSpace, requireSpaceMembership, unjoinedPublicSpaceReadableSql } from './space-membership.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SharePrincipalType = 'user' | 'space';

/** One snapshot for a read's authorization and its data (the F4/F6 S-F7 pattern). */
const READ_SNAPSHOT: PgTransactionConfig = { isolationLevel: 'repeatable read', accessMode: 'read only' };

const notFound = () => new DocumentRefusal(404, 'NOT_FOUND', 'Document not found');
const shareNotFound = () => new DocumentRefusal(404, 'NOT_FOUND', 'Share not found');
const needEdit = () => new DocumentRefusal(403, 'FORBIDDEN_ROLE', 'You need edit access to this document');
const selfShare = () => new DocumentRefusal(400, 'SELF_SHARE', 'You can’t share a document with yourself');
const cannotHold = () => new DocumentRefusal(400, 'PRINCIPAL_CANNOT_HOLD_ACCESS', 'That person or chat can’t be given access to this document');
const alreadyShared = () => new DocumentRefusal(409, 'ALREADY_SHARED', 'Already shared with them; change their role instead');
const changedMeanwhile = () => new DocumentRefusal(409, 'CONFLICT', 'The document moved while this ran; try again');
const notInChat = () => new DocumentRefusal(403, 'SPACE_MEMBERSHIP_REQUIRED', 'You can only check a chat you are in');

/** 400 ROLE_TOO_HIGH: a share gives at most edit. */
export const roleTooHigh = () => new DocumentRefusal(400, 'ROLE_TOO_HIGH', 'A share gives at most edit access');

const actorOf = (orgId: string, userId: string): DriveActor => ({ id: userId, org_id: orgId });

/** `column` is one of `ids`, bound as one array parameter, however deep the sub-page tree. */
const idIn = (column: SQL, ids: readonly string[]) => sql`${column} = ANY(${sql.param([...ids])}::text[])`;

/** A share's role as a rank, in SQL (DOC_ROLE_RANK). */
const rankSql = (role: SQL) => sql`CASE ${role} WHEN 'view' THEN 1 WHEN 'comment' THEN 2 WHEN 'edit' THEN 3 END`;

/** A PostgreSQL error code, through drizzle's wrapper. */
function pgCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown } | null)?.code;
  if (typeof own === 'string') return own;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

/** What a caller may see of a share's principal and sharer (listedSharesInTx). */
export type ShareProjection = { name: string | null; principalId: string | null; sharedBy: string | null };

/**
 * A share as the routes return it. With `projection` (the list and PATCH),
 * the name, principal and sharer are as the caller may see them; without it
 * (POST, whose caller named the principal) they are as stored, with no name.
 */
export function shareShape(row: DocumentShareRow, projection?: ShareProjection) {
  return {
    id: row.id,
    document_id: row.document_id,
    principal_type: row.principal_type,
    principal_id: projection ? projection.principalId : row.principal_id,
    role: row.role,
    name: projection?.name ?? null,
    shared_by: projection ? projection.sharedBy : row.shared_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The access change a share's principal makes on `documentIds`. */
function shareChange(orgId: string, documentIds: string[], principalType: SharePrincipalType, principalId: string): DocumentAccessChange {
  return principalType === 'user' ? { orgId, documentIds, userIds: [principalId] } : { orgId, documentIds, spaceId: principalId };
}

/** The drive of a live document of `orgId`, or null: read before the locks, checked again under them. */
async function liveDriveOf(tx: Tx, orgId: string, documentId: string): Promise<string | null> {
  const [row] = await tx.select({ drive_id: documents.drive_id }).from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.org_id, orgId), eq(documents.is_deleted, false))).limit(1);
  return row?.drive_id ?? null;
}

/**
 * The caller holds edit on the document: 404 when they can't see it, 403
 * below edit. Asked first with no lock held (header), then again under the
 * locks.
 */
async function requireEditInTx(tx: Tx, actor: DriveActor, documentId: string): Promise<void> {
  const role = await documentRoleFor(actor.id, actor.org_id, documentId, tx);
  if (!role) throw notFound();
  if (!roleAtLeast(role, 'edit')) throw needEdit();
}

/**
 * Step 2 of the lock order: the recipient, locked, and whether `actor` may
 * give it access, checked under those locks (header). A deactivation, a pause
 * or an archive that commits first is seen; one that comes later waits.
 */
async function recipientCanHoldInTx(tx: Tx, actor: DriveActor, principalType: SharePrincipalType, principalId: string): Promise<boolean> {
  if (principalType === 'space') {
    await tx.select({ id: spaces.id }).from(spaces).where(and(eq(spaces.id, principalId), eq(spaces.org_id, actor.org_id))).for('share');
    return canReadSpace(principalId, actor.id, actor.org_id, tx);
  }
  if (!(await canHoldDocumentAccessLocked(tx, actor.org_id, principalId))) return false;
  // A guest shares only with the people they can see.
  return canSeePerson(await visiblePersonIds(await peopleViewer(actor.org_id, actor.id, tx), tx), principalId);
}

/**
 * Steps 3 and 4 of the lock order: the document's drive FOR SHARE, then the
 * page and (with `includeSubpages`) its live sub-pages FOR UPDATE, in id
 * order. The tree is read under the drive's lock, which every create, move,
 * delete and restore takes FOR UPDATE. The page must still be live (404) and
 * in `driveId` (409 CONFLICT after a move).
 *
 * The drive was read before the locks (liveDriveOf), so the page may have
 * moved before its lock was granted. That is checked first, with a fresh read
 * once the drive is locked, so no page is locked for a drive the share doesn't
 * hold (consult S-F2: locking a moved tree in id order could deadlock with a
 * second move, which locks the page and then its sub-pages). The read takes
 * no row lock of its own. While the drive is held, nothing can move or delete
 * the page, since both need the drive FOR UPDATE. A FOR SHARE on the page,
 * raised to FOR UPDATE below, would deadlock two shares of the same page.
 */
async function lockPageAndSubpagesInTx(tx: Tx, orgId: string, driveId: string, documentId: string, includeSubpages: boolean) {
  await tx.select({ id: drives.id }).from(drives).where(and(eq(drives.id, driveId), eq(drives.org_id, orgId))).for('share');
  const [current] = await tx.select({ drive_id: documents.drive_id, is_deleted: documents.is_deleted }).from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.org_id, orgId))).limit(1);
  if (!current || current.is_deleted) throw notFound();
  if (current.drive_id !== driveId) throw changedMeanwhile();
  const tree = includeSubpages ? await subtreeIds(tx, orgId, documentId, true) : [documentId];
  const rows = await tx.select({ id: documents.id, drive_id: documents.drive_id, is_deleted: documents.is_deleted, title: documents.title })
    .from(documents)
    .where(and(eq(documents.org_id, orgId), idIn(sql`${documents.id}`, tree)))
    .orderBy(asc(documents.id))
    .for('update');
  const root = rows.find((row) => row.id === documentId);
  if (!root || root.is_deleted) throw notFound();
  if (root.drive_id !== driveId) throw changedMeanwhile();
  const subpages = rows.filter((row) => row.id !== documentId && !row.is_deleted && row.drive_id === driveId).map((row) => row.id);
  return { root, subpages };
}

/**
 * Of the live sub-pages `ids`: those the actor can edit (sorted), and how
 * many more they can view but not edit (skipped). Sub-pages they can't see
 * aren't counted (header). Asked before the change, as the actor's authority
 * stood.
 */
async function subpageReachInTx(tx: Tx, actor: DriveActor, ids: string[]): Promise<{ editable: string[]; skipped: number }> {
  if (ids.length === 0) return { editable: [], skipped: 0 };
  const editable = (await tx.select({ id: documents.id }).from(documents)
    .where(and(idIn(sql`${documents.id}`, ids), visibleDocumentCondition(actor.id, actor.org_id, 'edit'))))
    .map((row) => row.id).sort();
  const [visible] = await tx.select({ count: sql<number>`count(*)::int` }).from(documents)
    .where(and(idIn(sql`${documents.id}`, ids), visibleDocumentCondition(actor.id, actor.org_id, 'view')));
  return { editable, skipped: Number(visible?.count ?? 0) - editable.length };
}

/**
 * The statement newlyReachedInTx runs: for each of `documentIds`, the people
 * a share to the principal reaches (the person; or the chat's members) who
 * are active in the workspace, apart from the sharer, and whose role on that
 * page is below `role` now, with whether each is a human. One statement for
 * every page, with one access check (pages × people rows). Exported for its
 * planning test.
 */
export function newlyReachedQuery(orgId: string, actorId: string, principalType: SharePrincipalType, principalId: string,
  documentIds: readonly string[], role: DocShareRole): SQL {
  const people = principalType === 'user'
    ? sql`SELECT ${principalId}::text AS user_id`
    : sql`SELECT reach_seat.user_id FROM space_members reach_seat
        JOIN spaces reach_chat ON reach_chat.id = reach_seat.space_id AND reach_chat.org_id = ${orgId}
        WHERE reach_seat.space_id = ${principalId}`;
  return sql`SELECT reach_page.id AS document_id, reach_person.user_id, reach_user.kind = 'human' AS human
    FROM documents reach_page
    CROSS JOIN (${people}) reach_person
    JOIN org_members reach_member ON reach_member.org_id = ${orgId} AND reach_member.user_id = reach_person.user_id
      AND reach_member.is_active = true
    JOIN users reach_user ON reach_user.id = reach_person.user_id
    WHERE reach_page.org_id = ${orgId} AND reach_page.id = ANY(${sql.param([...documentIds])}::text[])
      AND reach_person.user_id <> ${actorId}
      AND NOT ${visibleDocumentIdSql(sql.raw('reach_person.user_id'), orgId, sql.raw('reach_page.id'), role)}
    ORDER BY reach_page.id, reach_person.user_id`;
}

/** Whom a share newly reaches on one page: `told` get the notification, `reached` the socket event. */
type PageReach = { told: string[]; reached: string[] };

/**
 * Before the share is written, under its locks: whom it newly reaches on each
 * of `documentIds` (header; consult S-F3), by page. On each page `reached` is
 * everyone newly reached there (an agent in the chat too) and `told` the
 * person named, or the humans of the chat. A page nobody newly reaches has
 * no entry.
 */
async function newlyReachedInTx(tx: Tx, actor: DriveActor, documentIds: readonly string[], principalType: SharePrincipalType,
  principalId: string, role: DocShareRole): Promise<Map<string, PageReach>> {
  const byPage = new Map<string, PageReach>();
  if (documentIds.length === 0) return byPage;
  const rows = (await tx.execute(newlyReachedQuery(actor.org_id, actor.id, principalType, principalId, documentIds, role))).rows as Array<{
    document_id: string; user_id: string; human: boolean;
  }>;
  for (const row of rows) {
    let page = byPage.get(row.document_id);
    if (!page) byPage.set(row.document_id, page = { told: [], reached: [] });
    page.reached.push(row.user_id);
    if (principalType === 'user' || row.human) page.told.push(row.user_id);
  }
  return byPage;
}

/**
 * `rows` (shares of one document) as `userId` may see them (header): a
 * person outside the people rule, and a chat they can't read, are hidden
 * whole, and so is a sharer they can't see. Read through the caller's
 * transaction.
 */
async function listedSharesInTx(tx: Tx, orgId: string, userId: string, rows: DocumentShareRow[]) {
  const visible = await visiblePersonIds(await peopleViewer(orgId, userId, tx), tx);
  const names = new Map<string, string>();
  const key = (type: string, id: string) => `${type}:${id}`;
  const userIds = rows.filter((row) => row.principal_type === 'user' && canSeePerson(visible, row.principal_id)).map((row) => row.principal_id);
  if (userIds.length > 0) {
    for (const person of await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))) {
      names.set(key('user', person.id), person.name);
    }
  }
  const readableChats = new Set<string>();
  const spaceIds = rows.filter((row) => row.principal_type === 'space').map((row) => row.principal_id);
  if (spaceIds.length > 0) {
    const readable = await tx.select({ id: spaces.id, name: spaces.name }).from(spaces).where(and(
      inArray(spaces.id, spaceIds), eq(spaces.org_id, orgId),
      or(
        sql`EXISTS (SELECT 1 FROM ${spaceMembers} WHERE ${spaceMembers.space_id} = ${spaces.id} AND ${spaceMembers.user_id} = ${userId})`,
        unjoinedPublicSpaceReadableSql(userId),
      ),
    ));
    for (const chat of readable) {
      readableChats.add(chat.id);
      names.set(key('space', chat.id), chat.name);
    }
  }
  return rows.map((row) => {
    const shown = row.principal_type === 'user' ? canSeePerson(visible, row.principal_id) : readableChats.has(row.principal_id);
    return shareShape(row, {
      name: shown ? names.get(key(row.principal_type, row.principal_id)) ?? null : null,
      principalId: shown ? row.principal_id : null,
      sharedBy: row.shared_by !== null && canSeePerson(visible, row.shared_by) ? row.shared_by : null,
    });
  });
}

/** finishAccessLoss after a commit, on its own. */
async function finishLoss(loss: PendingAccessLoss): Promise<void> {
  try {
    await finishAccessLoss(loss.change, loss.result);
  } catch {
    console.error('[document-shares] finishing an access loss failed');
  }
}

export type ShareDocumentInput = {
  orgId: string; userId: string; documentId: string; principalType: SharePrincipalType; principalId: string;
  /** `full` is refused with 400 ROLE_TOO_HIGH, after the access check (consult S-F1). */
  role: DocRole;
  includeSubpages: boolean;
};

/**
 * Shares the document with a person or a chat (edit on the document), and,
 * with `includeSubpages`, its live sub-pages the sharer can edit (header).
 * A second share of the page to the same principal is 409 ALREADY_SHARED:
 * change its role instead. `sharedSubpages` counts the sub-pages given the
 * share or raised to it, `skippedSubpages` those the sharer can view but not
 * edit.
 */
export async function shareDocument(input: ShareDocumentInput): Promise<{ share: DocumentShareRow; sharedSubpages: number; skippedSubpages: number }> {
  const { orgId, userId, documentId, principalType, principalId } = input;
  const actor = actorOf(orgId, userId);
  let outcome: { share: DocumentShareRow; title: string; written: string[]; skipped: number; reach: Map<string, PageReach> };
  try {
    outcome = await db.transaction(async (tx) => {
      // 404 and 403 before any lock (header), then the 400s.
      await requireEditInTx(tx, actor, documentId);
      if (input.role === 'full') throw roleTooHigh();
      const role: DocShareRole = input.role;
      if (principalType === 'user' && principalId === userId) throw selfShare();
      const driveId = await liveDriveOf(tx, orgId, documentId);
      if (!driveId) throw notFound();
      await lockActorInTx(tx, actor);
      const canHold = await recipientCanHoldInTx(tx, actor, principalType, principalId);
      const { root, subpages } = await lockPageAndSubpagesInTx(tx, orgId, driveId, documentId, input.includeSubpages);
      await requireEditInTx(tx, actor, documentId);
      if (!canHold) throw cannotHold();
      const [existing] = await tx.select({ id: documentShares.id }).from(documentShares).where(and(
        eq(documentShares.document_id, documentId), eq(documentShares.principal_type, principalType), eq(documentShares.principal_id, principalId),
      )).limit(1);
      if (existing) throw alreadyShared();
      // Before the write: the sub-pages the sharer may extend it to, and whom it newly reaches on each page.
      const { editable, skipped } = await subpageReachInTx(tx, actor, subpages);
      const reach = await newlyReachedInTx(tx, actor, [documentId, ...editable], principalType, principalId, role);
      const [share] = await tx.insert(documentShares).values({
        org_id: orgId, document_id: documentId, principal_type: principalType, principal_id: principalId, role, shared_by: userId,
      }).returning();
      const written = editable.length === 0 ? [] : await tx.insert(documentShares)
        .values(editable.map((id) => ({
          org_id: orgId, document_id: id, principal_type: principalType, principal_id: principalId, role, shared_by: userId,
        })))
        .onConflictDoUpdate({
          target: [documentShares.document_id, documentShares.principal_type, documentShares.principal_id],
          set: { role, updated_at: new Date() },
          // Raised only: a sub-page that already gives at least this role keeps it.
          setWhere: sql`${rankSql(sql`${documentShares.role}`)} < ${DOC_ROLE_RANK[role]}`,
        })
        .returning({ document_id: documentShares.document_id });
      return { share: share!, title: root.title, written: written.map((row) => row.document_id).sort(), skipped, reach };
    });
  } catch (error) {
    // The principal triggers refuse anyone outside the workspace, and the
    // unique key a racing second share; the checks above normally answer first.
    if (pgCode(error) === '23503') throw cannotHold();
    if (pgCode(error) === '23505') throw alreadyShared();
    throw error;
  }
  const documentIds = [documentId, ...outcome.written];
  emitDocumentAccessChanged(shareChange(orgId, documentIds, principalType, principalId));
  // The notification is for the page shared; the event goes for every page written. Each to whom it newly reached there.
  await tellShared(actor, { id: documentId, title: outcome.title }, principalType, outcome.reach.get(documentId)?.told ?? []);
  await sendSharedEvents(actor, documentIds.map((id) => ({ documentId: id, userIds: outcome.reach.get(id)?.reached ?? [] })));
  return { share: outcome.share, sharedSubpages: outcome.written.length, skippedSubpages: outcome.skipped };
}

/**
 * Changes a share's role (edit on the document). Lowering is always allowed:
 * with `includeSubpages` it also lowers the same principal's shares above
 * the new role on the sub-pages the actor can edit, and it runs the
 * access-loss path once for every page changed. Raising follows the
 * recipient rule (never the actor themselves) and changes the page only. The
 * same role changes nothing. The answer is projected as the share list is.
 * `full` is refused with 400 ROLE_TOO_HIGH, after the access check (consult
 * S-F1).
 */
export async function changeShareRole(input: { orgId: string; userId: string; documentId: string; shareId: string; role: DocRole;
  includeSubpages: boolean }): Promise<{ share: ReturnType<typeof shareShape>; loweredSubpages: number; skippedSubpages: number }> {
  const { orgId, userId, documentId, shareId } = input;
  const actor = actorOf(orgId, userId);
  const outcome = await db.transaction(async (tx) => {
    // 404 and 403 before any lock (header), then the 400s.
    await requireEditInTx(tx, actor, documentId);
    if (input.role === 'full') throw roleTooHigh();
    const role: DocShareRole = input.role;
    const driveId = await liveDriveOf(tx, orgId, documentId);
    if (!driveId) throw notFound();
    // The principal is read first, to lock it in its slot; a share's principal
    // never changes, and the row is read again under the document's lock.
    const [target] = await tx.select({ principal_type: documentShares.principal_type, principal_id: documentShares.principal_id })
      .from(documentShares)
      .where(and(eq(documentShares.id, shareId), eq(documentShares.org_id, orgId), eq(documentShares.document_id, documentId))).limit(1);
    await lockActorInTx(tx, actor);
    const canHold = target ? await recipientCanHoldInTx(tx, actor, target.principal_type, target.principal_id) : false;
    const { subpages } = await lockPageAndSubpagesInTx(tx, orgId, driveId, documentId, input.includeSubpages);
    await requireEditInTx(tx, actor, documentId);
    const [row] = await tx.select().from(documentShares)
      .where(and(eq(documentShares.id, shareId), eq(documentShares.org_id, orgId), eq(documentShares.document_id, documentId)))
      .for('update');
    if (!row) throw shareNotFound();
    const answer = async (share: DocumentShareRow) => (await listedSharesInTx(tx, orgId, userId, [share]))[0]!;
    if (row.role === role) return { share: await answer(row), loss: null, gained: null, lowered: [] as string[], skipped: 0 };
    const lowering = DOC_ROLE_RANK[role] < DOC_ROLE_RANK[row.role];
    if (!lowering) {
      // A stronger share is a new grant: never to oneself, and the recipient rule.
      if (row.principal_type === 'user' && row.principal_id === userId) throw selfShare();
      if (!canHold) throw cannotHold();
      const [raised] = await tx.update(documentShares).set({ role, updated_at: new Date() }).where(eq(documentShares.id, row.id)).returning();
      return {
        share: await answer(raised!), loss: null, gained: shareChange(orgId, [documentId], row.principal_type, row.principal_id),
        lowered: [] as string[], skipped: 0,
      };
    }
    const { editable, skipped } = await subpageReachInTx(tx, actor, subpages);
    const [updated] = await tx.update(documentShares).set({ role, updated_at: new Date() }).where(eq(documentShares.id, row.id)).returning();
    const lowered = editable.length === 0 ? [] : (await tx.update(documentShares).set({ role, updated_at: new Date() }).where(and(
      eq(documentShares.org_id, orgId), idIn(sql`${documentShares.document_id}`, editable),
      eq(documentShares.principal_type, row.principal_type), eq(documentShares.principal_id, row.principal_id),
      sql`${rankSql(sql`${documentShares.role}`)} > ${DOC_ROLE_RANK[role]}`,
    )).returning({ document_id: documentShares.document_id })).map((changed) => changed.document_id).sort();
    const loss = await accessLossInTx(tx, shareChange(orgId, [documentId, ...lowered], row.principal_type, row.principal_id));
    return { share: await answer(updated!), loss, gained: null, lowered, skipped };
  });
  if (outcome.loss) await finishLoss(outcome.loss);
  else if (outcome.gained) emitDocumentAccessChanged(outcome.gained);
  return { share: outcome.share, loweredSubpages: outcome.lowered.length, skippedSubpages: outcome.skipped };
}

/**
 * Removes a share (edit on the document) and, with `includeSubpages`, the
 * same principal's shares on the sub-pages the actor can edit, through the
 * access-loss path once for every page changed.
 */
export async function removeShare(input: { orgId: string; userId: string; documentId: string; shareId: string; includeSubpages: boolean }): Promise<{
  removedSubpages: number; skippedSubpages: number;
}> {
  const { orgId, userId, documentId, shareId } = input;
  const actor = actorOf(orgId, userId);
  const outcome = await db.transaction(async (tx) => {
    // 404 and 403 before any lock (header).
    await requireEditInTx(tx, actor, documentId);
    const driveId = await liveDriveOf(tx, orgId, documentId);
    if (!driveId) throw notFound();
    await lockActorInTx(tx, actor);
    const { subpages } = await lockPageAndSubpagesInTx(tx, orgId, driveId, documentId, input.includeSubpages);
    await requireEditInTx(tx, actor, documentId);
    const [row] = await tx.select().from(documentShares)
      .where(and(eq(documentShares.id, shareId), eq(documentShares.org_id, orgId), eq(documentShares.document_id, documentId)))
      .for('update');
    if (!row) throw shareNotFound();
    const { editable, skipped } = await subpageReachInTx(tx, actor, subpages);
    await tx.delete(documentShares).where(eq(documentShares.id, row.id));
    const removed = editable.length === 0 ? [] : (await tx.delete(documentShares).where(and(
      eq(documentShares.org_id, orgId), idIn(sql`${documentShares.document_id}`, editable),
      eq(documentShares.principal_type, row.principal_type), eq(documentShares.principal_id, row.principal_id),
    )).returning({ document_id: documentShares.document_id })).map((gone) => gone.document_id).sort();
    const loss = await accessLossInTx(tx, shareChange(orgId, [documentId, ...removed], row.principal_type, row.principal_id));
    return { loss, removed, skipped };
  });
  await finishLoss(outcome.loss);
  return { removedSubpages: outcome.removed.length, skippedSubpages: outcome.skipped };
}

/**
 * A document's shares, oldest first, for someone with edit on it, as they
 * may see them (header). The role and the rows come from one snapshot.
 */
export async function listDocumentShares(orgId: string, userId: string, documentId: string) {
  return db.transaction(async (tx) => {
    await requireEditInTx(tx, actorOf(orgId, userId), documentId);
    const rows = await tx.select().from(documentShares)
      .where(and(eq(documentShares.org_id, orgId), eq(documentShares.document_id, documentId)))
      .orderBy(asc(documentShares.created_at), asc(documentShares.id));
    return listedSharesInTx(tx, orgId, userId, rows);
  }, READ_SNAPSHOT);
}

/**
 * For the posting prompt (F13): how many members of the chat `spaceId` can't
 * open the document, how many of them are guests, and whether the caller
 * may share it with them (edit). Needs view on the document and a seat in the
 * chat; read in one snapshot.
 */
export async function documentAudience(orgId: string, userId: string, documentId: string, spaceId: string) {
  return db.transaction(async (tx) => {
    const role = await documentRoleFor(userId, orgId, documentId, tx);
    if (!role) throw notFound();
    if (!(await requireSpaceMembership(spaceId, userId, orgId, tx))) throw notInChat();
    const { userIds, guests } = await spaceMembersWhoCannotOpen(orgId, spaceId, documentId, tx);
    return { cannot_open: userIds.length, guests, can_share: roleAtLeast(role, 'edit') };
  }, READ_SNAPSHOT);
}

/**
 * After commit: the `document_shared` notification for the page shared, to
 * each of `told` (newlyReachedInTx). Each is created on its own, so a failure
 * for one person never stops the rest. Never throws.
 */
async function tellShared(actor: DriveActor, document: { id: string; title: string }, principalType: SharePrincipalType, told: string[]): Promise<void> {
  try {
    const title = `Document shared with you: ${document.title.trim() || 'Untitled'}`;
    const body = principalType === 'user' ? 'You can now open this document.' : 'This document was shared with a chat you are in.';
    const created: Array<{ id: string; org_id: string; user_id: string }> = [];
    for (const recipient of told) {
      try {
        const notification = await createNotificationIfAllowed({
          org_id: actor.org_id,
          user_id: recipient,
          type: asStoredNotificationType('document_shared'),
          title,
          body,
          link: `/d/${document.id}`,
          metadata: { subtype: 'document_share', document_id: document.id },
        });
        if (notification) created.push(notification);
      } catch {
        console.error('[document-shares] a share notification could not be created');
      }
    }
    try {
      await emitVisibleNotifications(created);
    } catch {
      console.error('[document-shares] share notifications could not be sent');
    }
  } catch {
    console.error('[document-shares] telling the people a share reaches failed');
  }
}

/**
 * After commit: `document:shared { document_id }` for each page the share
 * wrote, to the people it newly reached on that page (newlyReachedInTx) who
 * can view it now (rule C4). Never throws.
 */
async function sendSharedEvents(actor: DriveActor, pages: Array<{ documentId: string; userIds: string[] }>): Promise<void> {
  try {
    const reachedOn = new Map(pages.map((page) => [page.documentId, new Set(page.userIds.filter((id) => id !== actor.id))]));
    const reachedPages = [...reachedOn].filter(([, people]) => people.size > 0).map(([id]) => id);
    if (reachedPages.length === 0) return;
    const viewers = await documentViewers(actor.org_id, reachedPages);
    sendDocumentEvent({
      orgId: actor.org_id,
      documents: viewers.map((viewer) => ({ ...viewer, userIds: viewer.userIds.filter((id) => reachedOn.get(viewer.documentId)?.has(id)) })),
    }, 'document:shared');
  } catch {
    console.error('[document-shares] document:shared could not be sent');
  }
}
