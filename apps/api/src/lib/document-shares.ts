// Sharing a document with people and chats (spec 5.2 and 5.10; plan Task F9).
//
// Roles (the access check, lib/document-access.ts):
// - listing a document's shares needs edit (consult rule C4). People's names
//   follow the people rule (lib/people-visibility-sql.ts: a guest sees only
//   the people they share a chat with), and a chat's name shows only to
//   someone who can read the chat, as in the drive members panel. The role
//   and the list are read in one read-only, repeatable-read snapshot;
// - sharing, changing a share's role and removing a share need edit on the
//   document. A share gives at most edit: `full` is 400 ROLE_TOO_HIGH;
// - the audience (the posting prompt, F13) needs view on the document and a
//   seat in the chat, in one snapshot too.
// What the caller can't see is a 404; a role too low is 403 FORBIDDEN_ROLE.
//
// Recipients. A share made or raised can't name someone who could never hold
// access (canHoldDocumentAccess: an inactive member, Defty's own user, a
// system user, anyone outside the workspace), nor a chat of this workspace
// the sharer can't read (canReadSpace), nor, for a guest sharer, a person
// they can't see (the people rule): 400 PRINCIPAL_CANNOT_HOLD_ACCESS, the
// same answer as for someone who doesn't exist. Lowering or removing a share
// is always allowed, so stale shares can be cleaned up.
//
// Sub-pages. Sharing a page also shares its live sub-pages, at every depth,
// unless `includeSubpages` is off ("Include sub-pages", on by default). Each
// sub-page the sharer can edit gets the same share, or has a lower share
// raised to it; one that already gives at least that role keeps it. A share
// never lowers anything, so it never takes access away. Sub-pages the sharer
// can't edit are skipped and counted. A sub-page made later starts with its
// parent's shares (lib/documents.ts createDocumentInTx). Changing or removing
// a share touches only its own page.
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
// Access (consult rule C3): lowering or removing a share calls
// applyAccessLossInTx in its transaction and finishAccessLoss after the
// commit. A new or raised share tells listeners after the commit
// (emitDocumentAccessChanged).
//
// Who is told (spec 5.10, as F4 tells people added to a drive): a new share
// sends one `document_shared` notification for the page shared (subtype
// `document_share`, with `document_id`) to the person, human or agent, while
// they can hold access, or to each human in the chat; never to the sharer.
// It is listed and counted only while its reader can open the document
// (lib/native-mention-visibility.ts), and its attention item is a `document`
// item (lib/attention.ts). `document:shared { document_id }` goes, for each
// page the share wrote, to the people the share reaches who can view it now,
// apart from the sharer (rule C4: emitToUser, never a room). After the commit
// each step runs on its own, so one that fails never skips the next.
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { documentShares, documents, drives, type DocShareRole, type DocumentShareRow } from '@deft/db/documents';
import { orgMembers, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from './db.js';
import {
  canHoldDocumentAccess, documentRoleFor, documentViewers, DOC_ROLE_RANK, roleAtLeast, spaceMembersWhoCannotOpen, visibleDocumentCondition,
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
const cannotHold = () => new DocumentRefusal(400, 'PRINCIPAL_CANNOT_HOLD_ACCESS', 'That person or chat can’t be given access to this document');
const alreadyShared = () => new DocumentRefusal(409, 'ALREADY_SHARED', 'Already shared with them; change their role instead');
const changedMeanwhile = () => new DocumentRefusal(409, 'CONFLICT', 'The document moved while this ran; try again');
const notInChat = () => new DocumentRefusal(403, 'SPACE_MEMBERSHIP_REQUIRED', 'You can only check a chat you are in');

/** 400 ROLE_TOO_HIGH: a share gives at most edit. */
export const roleTooHigh = () => new DocumentRefusal(400, 'ROLE_TOO_HIGH', 'A share gives at most edit access');

const actorOf = (orgId: string, userId: string): DriveActor => ({ id: userId, org_id: orgId });

/** `column` is one of `ids`, bound as one array parameter, however deep the sub-page tree. */
const idIn = (column: SQL, ids: readonly string[]) => sql`${column} = ANY(${sql.param([...ids])}::text[])`;

/** A PostgreSQL error code, through drizzle's wrapper. */
function pgCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown } | null)?.code;
  if (typeof own === 'string') return own;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

/** A share as the routes return it. `name` is set only by the share list. */
export function shareShape(row: DocumentShareRow, name: string | null = null) {
  return {
    id: row.id,
    document_id: row.document_id,
    principal_type: row.principal_type,
    principal_id: row.principal_id,
    role: row.role,
    name,
    shared_by: row.shared_by,
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

/** Step 3 of the lock order: the document's drive FOR SHARE. */
async function lockDriveInTx(tx: Tx, orgId: string, driveId: string): Promise<void> {
  await tx.select({ id: drives.id }).from(drives).where(and(eq(drives.id, driveId), eq(drives.org_id, orgId))).for('share');
}

/**
 * Step 4 of the lock order: `documentIds` FOR UPDATE, in id order. The page
 * `rootId` must still be live (404) and in `driveId` (409 CONFLICT after a
 * move). Returns the locked rows.
 */
async function lockDocumentsInTx(tx: Tx, orgId: string, driveId: string, rootId: string, documentIds: string[]) {
  const rows = await tx.select({ id: documents.id, drive_id: documents.drive_id, is_deleted: documents.is_deleted, title: documents.title })
    .from(documents)
    .where(and(eq(documents.org_id, orgId), idIn(sql`${documents.id}`, documentIds)))
    .orderBy(asc(documents.id))
    .for('update');
  const root = rows.find((row) => row.id === rootId);
  if (!root || root.is_deleted) throw notFound();
  if (root.drive_id !== driveId) throw changedMeanwhile();
  return { root, rows };
}

/** The caller holds edit on the document: 404 when they can't see it, 403 below edit. */
async function requireEditInTx(tx: Tx, actor: DriveActor, documentId: string): Promise<void> {
  const role = await documentRoleFor(actor.id, actor.org_id, documentId, tx);
  if (!role) throw notFound();
  if (!roleAtLeast(role, 'edit')) throw needEdit();
}

/** finishAccessLoss after a commit, on its own. */
async function finishLoss(loss: PendingAccessLoss): Promise<void> {
  try {
    await finishAccessLoss(loss.change, loss.result);
  } catch {
    console.error('[document-shares] finishing an access loss failed');
  }
}

/** A share's role as a rank, in SQL (DOC_ROLE_RANK). */
const rankSql = (role: SQL) => sql`CASE ${role} WHEN 'view' THEN 1 WHEN 'comment' THEN 2 WHEN 'edit' THEN 3 END`;

export type ShareDocumentInput = {
  orgId: string; userId: string; documentId: string; principalType: SharePrincipalType; principalId: string; role: DocShareRole;
  includeSubpages: boolean;
};

/**
 * Shares the document with a person or a chat (edit on the document), and,
 * with `includeSubpages`, its live sub-pages the sharer can edit (header).
 * A second share of the page to the same principal is 409 ALREADY_SHARED:
 * change its role instead. `sharedSubpages` counts the sub-pages given the
 * share or raised to it, `skippedSubpages` those the sharer can't edit.
 */
export async function shareDocument(input: ShareDocumentInput): Promise<{ share: DocumentShareRow; sharedSubpages: number; skippedSubpages: number }> {
  const { orgId, userId, documentId, principalType, principalId, role } = input;
  const actor = actorOf(orgId, userId);
  let outcome: { share: DocumentShareRow; title: string; written: string[]; skipped: number };
  try {
    outcome = await db.transaction(async (tx) => {
      const driveId = await liveDriveOf(tx, orgId, documentId);
      if (!driveId) throw notFound();
      await lockActorInTx(tx, actor);
      const canHold = await recipientCanHoldInTx(tx, actor, principalType, principalId);
      await lockDriveInTx(tx, orgId, driveId);
      const tree = input.includeSubpages ? await subtreeIds(tx, orgId, documentId, true) : [documentId];
      const { root, rows } = await lockDocumentsInTx(tx, orgId, driveId, documentId, tree);
      await requireEditInTx(tx, actor, documentId);
      if (!canHold) throw cannotHold();
      const [existing] = await tx.select({ id: documentShares.id }).from(documentShares).where(and(
        eq(documentShares.document_id, documentId), eq(documentShares.principal_type, principalType), eq(documentShares.principal_id, principalId),
      )).limit(1);
      if (existing) throw alreadyShared();
      const [share] = await tx.insert(documentShares).values({
        org_id: orgId, document_id: documentId, principal_type: principalType, principal_id: principalId, role, shared_by: userId,
      }).returning();
      const subpages = rows.filter((row) => row.id !== documentId && !row.is_deleted && row.drive_id === driveId).map((row) => row.id);
      const editable = subpages.length === 0 ? [] : (await tx.select({ id: documents.id }).from(documents)
        .where(and(idIn(sql`${documents.id}`, subpages), visibleDocumentCondition(userId, orgId, 'edit')))).map((row) => row.id);
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
      return { share: share!, title: root.title, written: written.map((row) => row.document_id).sort(), skipped: subpages.length - editable.length };
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
  await tellShared(actor, { id: documentId, title: outcome.title }, principalType, principalId);
  await sendSharedEvents(actor, documentIds, principalType, principalId);
  return { share: outcome.share, sharedSubpages: outcome.written.length, skippedSubpages: outcome.skipped };
}

/**
 * Changes a share's role (edit on the document). Lowering is always allowed
 * and runs the access-loss path; raising follows the recipient rule (header).
 * The same role changes nothing.
 */
export async function changeShareRole(input: { orgId: string; userId: string; documentId: string; shareId: string; role: DocShareRole }): Promise<DocumentShareRow> {
  const { orgId, userId, documentId, shareId, role } = input;
  const actor = actorOf(orgId, userId);
  const outcome = await db.transaction(async (tx) => {
    const driveId = await liveDriveOf(tx, orgId, documentId);
    if (!driveId) throw notFound();
    // The principal is read first, to lock it in its slot; a share's principal
    // never changes, and the row is read again under the document's lock.
    const [target] = await tx.select({ principal_type: documentShares.principal_type, principal_id: documentShares.principal_id })
      .from(documentShares)
      .where(and(eq(documentShares.id, shareId), eq(documentShares.org_id, orgId), eq(documentShares.document_id, documentId))).limit(1);
    await lockActorInTx(tx, actor);
    const canHold = target ? await recipientCanHoldInTx(tx, actor, target.principal_type, target.principal_id) : false;
    await lockDriveInTx(tx, orgId, driveId);
    await lockDocumentsInTx(tx, orgId, driveId, documentId, [documentId]);
    await requireEditInTx(tx, actor, documentId);
    const [row] = await tx.select().from(documentShares)
      .where(and(eq(documentShares.id, shareId), eq(documentShares.org_id, orgId), eq(documentShares.document_id, documentId)))
      .for('update');
    if (!row) throw shareNotFound();
    if (row.role === role) return { share: row, loss: null, gained: null };
    const lowered = DOC_ROLE_RANK[role] < DOC_ROLE_RANK[row.role];
    // A stronger share is a new grant: the recipient rule.
    if (!lowered && !canHold) throw cannotHold();
    const [updated] = await tx.update(documentShares).set({ role, updated_at: new Date() }).where(eq(documentShares.id, row.id)).returning();
    const change = shareChange(orgId, [documentId], row.principal_type, row.principal_id);
    return { share: updated!, loss: lowered ? await accessLossInTx(tx, change) : null, gained: lowered ? null : change };
  });
  if (outcome.loss) await finishLoss(outcome.loss);
  else if (outcome.gained) emitDocumentAccessChanged(outcome.gained);
  return outcome.share;
}

/** Removes a share (edit on the document), through the access-loss path. */
export async function removeShare(input: { orgId: string; userId: string; documentId: string; shareId: string }): Promise<void> {
  const { orgId, userId, documentId, shareId } = input;
  const actor = actorOf(orgId, userId);
  const loss = await db.transaction(async (tx) => {
    const driveId = await liveDriveOf(tx, orgId, documentId);
    if (!driveId) throw notFound();
    await lockActorInTx(tx, actor);
    await lockDriveInTx(tx, orgId, driveId);
    await lockDocumentsInTx(tx, orgId, driveId, documentId, [documentId]);
    await requireEditInTx(tx, actor, documentId);
    const [removed] = await tx.delete(documentShares)
      .where(and(eq(documentShares.id, shareId), eq(documentShares.org_id, orgId), eq(documentShares.document_id, documentId)))
      .returning();
    if (!removed) throw shareNotFound();
    return accessLossInTx(tx, shareChange(orgId, [documentId], removed.principal_type, removed.principal_id));
  });
  await finishLoss(loss);
}

/**
 * A document's shares, oldest first, for someone with edit on it, with the
 * names they may see (header). The role and the rows come from one snapshot.
 */
export async function listDocumentShares(orgId: string, userId: string, documentId: string) {
  return db.transaction(async (tx) => {
    await requireEditInTx(tx, actorOf(orgId, userId), documentId);
    const rows = await tx.select().from(documentShares)
      .where(and(eq(documentShares.org_id, orgId), eq(documentShares.document_id, documentId)))
      .orderBy(asc(documentShares.created_at), asc(documentShares.id));
    const names = new Map<string, string>();
    const key = (type: string, id: string) => `${type}:${id}`;
    const userIds = rows.filter((row) => row.principal_type === 'user').map((row) => row.principal_id);
    if (userIds.length > 0) {
      const visible = await visiblePersonIds(await peopleViewer(orgId, userId, tx), tx);
      for (const person of await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))) {
        if (canSeePerson(visible, person.id)) names.set(key('user', person.id), person.name);
      }
    }
    const spaceIds = rows.filter((row) => row.principal_type === 'space').map((row) => row.principal_id);
    if (spaceIds.length > 0) {
      const readable = await tx.select({ id: spaces.id, name: spaces.name }).from(spaces).where(and(
        inArray(spaces.id, spaceIds), eq(spaces.org_id, orgId),
        or(
          sql`EXISTS (SELECT 1 FROM ${spaceMembers} WHERE ${spaceMembers.space_id} = ${spaces.id} AND ${spaceMembers.user_id} = ${userId})`,
          unjoinedPublicSpaceReadableSql(userId),
        ),
      ));
      for (const chat of readable) names.set(key('space', chat.id), chat.name);
    }
    return rows.map((row) => shareShape(row, names.get(key(row.principal_type, row.principal_id)) ?? null));
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

/** The active humans among `people` (a statement with a `user_id` column), apart from the actor (as routes/drives.ts). */
async function activeHumans(orgId: string, actorId: string, people: SQL): Promise<string[]> {
  const result = await db.execute(sql`SELECT DISTINCT told.user_id FROM (${people}) told
    JOIN ${orgMembers} told_membership ON told_membership.org_id = ${orgId} AND told_membership.user_id = told.user_id
      AND told_membership.is_active = true
    JOIN ${users} told_user ON told_user.id = told.user_id AND told_user.kind = 'human'
    WHERE told.user_id <> ${actorId}
    ORDER BY told.user_id`);
  return (result.rows as Array<{ user_id: string }>).map((row) => row.user_id);
}

/** The people in the chat `spaceId` of `orgId`. */
function chatPeopleSql(orgId: string, spaceId: string): SQL {
  return sql`SELECT told_seat.user_id FROM ${spaceMembers} told_seat
    JOIN ${spaces} told_space ON told_space.id = told_seat.space_id AND told_space.org_id = ${orgId}
    WHERE told_seat.space_id = ${spaceId}`;
}

/**
 * After commit: the `document_shared` notification for the page shared, to
 * the person (human or agent, while they can hold access) or to each human
 * in the chat, never the sharer. Each is created on its own, so a failure for
 * one person never stops the rest. Never throws.
 */
async function tellShared(actor: DriveActor, document: { id: string; title: string }, principalType: SharePrincipalType, principalId: string): Promise<void> {
  try {
    const recipients = principalType === 'user'
      ? (principalId !== actor.id && await canHoldDocumentAccess(principalId, actor.org_id) ? [principalId] : [])
      : await activeHumans(actor.org_id, actor.id, chatPeopleSql(actor.org_id, principalId));
    const title = `Document shared with you: ${document.title.trim() || 'Untitled'}`;
    const body = principalType === 'user' ? 'You can now open this document.' : 'This document was shared with a chat you are in.';
    const created: Array<{ id: string; org_id: string; user_id: string }> = [];
    for (const recipient of recipients) {
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
 * wrote, to the people it reaches (the person, or the people in the chat) who
 * can view that page now, apart from the sharer (rule C4). Never throws.
 */
async function sendSharedEvents(actor: DriveActor, documentIds: string[], principalType: SharePrincipalType, principalId: string): Promise<void> {
  try {
    const reached = new Set(principalType === 'user'
      ? [principalId]
      : ((await db.execute(chatPeopleSql(actor.org_id, principalId))).rows as Array<{ user_id: string }>).map((row) => row.user_id));
    reached.delete(actor.id);
    if (reached.size === 0) return;
    const viewers = await documentViewers(actor.org_id, documentIds);
    sendDocumentEvent({
      orgId: actor.org_id,
      documents: viewers.map((viewer) => ({ ...viewer, userIds: viewer.userIds.filter((id) => reached.has(id)) })),
    }, 'document:shared');
  } catch {
    console.error('[document-shares] document:shared could not be sent');
  }
}
