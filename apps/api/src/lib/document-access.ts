// Who may open a document or a drive, and with what role: the one access
// check (spec 5.2, consult rule C7). The rule and every condition it is made
// of are in document-access-sql.ts (its header states the rule), which reads
// no database module, so code that must never load the app's database client
// (the workspace export, lib/workspace-export/) can use them on its own
// snapshot. This module re-exports all of it and adds the lookups that run on
// the app's database, or a caller's transaction. Import the check from here;
// only such code imports document-access-sql.ts directly. Don't write a copy.
import { sql } from 'drizzle-orm';
import { db } from './db.js';
import {
  canHoldDocumentAccessSql, DOC_ROLE_RANK, documentRoleQuery, documentViewersQuery, driveRoleQuery,
  spaceMembersWhoCannotOpenQuery, type DocRole,
} from './document-access-sql.js';

export * from './document-access-sql.js';

/** Runs the role lookups: the pool by default, or a caller's transaction. */
export type Executor = Pick<typeof db, 'execute'>;

/** A role read back from the database, or null. Anything that is not a role counts for nothing. */
function storedRole(role: unknown): DocRole | null {
  return typeof role === 'string' && Object.hasOwn(DOC_ROLE_RANK, role) ? role as DocRole : null;
}

/** `userId`'s role on the document `documentId` of `orgId`, or null when they can't open it. */
export async function documentRoleFor(userId: string, orgId: string, documentId: string, executor: Executor = db): Promise<DocRole | null> {
  const result = await executor.execute(documentRoleQuery(userId, orgId, documentId));
  return storedRole((result.rows[0] as { role?: unknown } | undefined)?.role);
}

/** `userId`'s role on the drive `driveId` of `orgId`, or null. */
export async function driveRoleFor(userId: string, orgId: string, driveId: string, executor: Executor = db): Promise<DocRole | null> {
  const result = await executor.execute(driveRoleQuery(userId, orgId, driveId));
  return storedRole((result.rows[0] as { role?: unknown } | undefined)?.role);
}

/**
 * The members of the chat `spaceId` of `orgId` who can't open the document
 * `documentId` (the posting prompt, F13): people and agent users who are
 * active in the workspace, and how many of them are guests. Members who left
 * the workspace aren't counted. The caller has already checked that it may
 * see the document and the chat (F9's GET /audience).
 */
export async function spaceMembersWhoCannotOpen(
  orgId: string, spaceId: string, documentId: string, executor: Executor = db,
): Promise<{ userIds: string[]; guests: number }> {
  const result = await executor.execute(spaceMembersWhoCannotOpenQuery(orgId, spaceId, documentId));
  const rows = result.rows as Array<{ user_id: string; guest: boolean }>;
  return { userIds: rows.map((row) => row.user_id), guests: rows.filter((row) => row.guest).length };
}

/**
 * True when `userId` could ever hold access in `orgId` (F4's grant check): an
 * active human member of any role, guests included, or an agent user whose
 * own employee is active (activeActorSql). Defty's own user, a system user
 * and an inactive member can't. A grant naming anyone else is refused.
 */
export async function canHoldDocumentAccess(userId: string, orgId: string, executor: Executor = db): Promise<boolean> {
  const result = await executor.execute(sql`SELECT ${canHoldDocumentAccessSql(sql`${userId}`, orgId)} AS can_hold`);
  return (result.rows[0] as { can_hold?: unknown } | undefined)?.can_hold === true;
}

/**
 * Who may be sent a live event about the documents `documentIds` of `orgId`
 * (consult rule C4): for each one that exists and isn't deleted, its drive
 * and every person who can view it now. One statement for all the documents.
 */
export async function documentViewers(
  orgId: string, documentIds: readonly string[], executor: Executor = db,
): Promise<Array<{ documentId: string; driveId: string; userIds: string[] }>> {
  if (documentIds.length === 0) return [];
  const result = await executor.execute(documentViewersQuery(orgId, documentIds));
  const rows = result.rows as Array<{ document_id: string | null; drive_id: string | null; user_id: string | null }>;
  const driveOf = new Map<string, string>();
  const byDrive = new Map<string, Set<string>>();
  const byShare = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, userId: string) => {
    let set = map.get(key);
    if (!set) map.set(key, set = new Set());
    set.add(userId);
  };
  for (const row of rows) {
    if (row.user_id === null && row.document_id && row.drive_id) driveOf.set(row.document_id, row.drive_id);
    else if (row.user_id && row.drive_id) add(byDrive, row.drive_id, row.user_id);
    else if (row.user_id && row.document_id) add(byShare, row.document_id, row.user_id);
  }
  return [...driveOf].map(([documentId, driveId]) => ({
    documentId,
    driveId,
    userIds: [...new Set([...(byDrive.get(driveId) ?? []), ...(byShare.get(documentId) ?? [])])].sort(),
  }));
}
