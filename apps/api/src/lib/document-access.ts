// Who may open a document or a drive, and with what role: the one access
// check (spec 5.2, consult rule C7). Every read of a document, drive, folder
// or drive file, on every surface (REST, live editing, Defty, MCP, search,
// mentions, the inbox, export), goes through these functions. Don't write a
// copy.
//
// A person's role on a document is the highest of:
// - their drive role: a drive_members row naming them, or naming a chat
//   (space) of the drive's workspace they are a member of. An archived chat
//   keeps granting its members, as messages do (lib/attention.ts);
// - on an open drive: full for a human owner or admin of the workspace, the
//   drive's default role for a human member. Worked out here, never stored;
// - a share of the document, naming them or a chat they are in.
// A personal drive's owner holds a `full` drive_members row (F4's
// ensurePersonalDrive); there is no rule of its own for it.
//
// Nothing is granted:
// - for a deleted document, or a document in a deleted drive;
// - by a frozen drive's own grants (its members, its default role, owners and
//   admins). A share out of a frozen drive gives view at most;
// - to anyone who is not an active member of the document's workspace, nor,
//   for an agent user, whose own agent employee (users.agent_employee_id) in
//   that workspace is paused or deleted;
// - to a guest or an agent user through an open drive: they get only what
//   names them or their chats.
// Roles are read from org_members for the document's workspace, never from a
// session or token claim.
//
// The conditions are OR'd EXISTS branches, never a computed maximum:
// PostgreSQL plans every branch of a condition whatever the row, and the
// backend keeps that memory. An oversized condition ran a 512 MB database out
// of memory in releases 145 to 149. document-access-planning-db.test.ts holds
// every form to a budget. Besides drives and documents they read only:
// - drive_members and document_shares (the grants);
// - space_members (who is in a chat);
// - spaces, because space_members has no org_id and a chat can move to
//   another workspace after a grant was written (the principal triggers
//   check only when a grant is written), so a chat counts only while it is in
//   the document's workspace;
// - org_members (active, role), users (kind, agent_employee_id) and
//   agent_employees (active, not deleted).
// The role lookups ask the same conditions at each role from full down, in
// one CASE, so each EXISTS stops at its first match and one row comes back.
//
// The conditions read no database themselves, so the workspace export can
// use them on its own snapshot.
import { sql, type SQL } from 'drizzle-orm';
import { DOC_ROLES, documents, drives, type DocRole } from '@deft/db/documents';
import { db } from './db.js';

export type { DocRole };

/** A workspace id, or a column of the statement (the attention rule, export). */
export type OrgRef = string | SQL;

/** Runs the role lookups: the pool by default, or a caller's transaction. */
export type Executor = Pick<typeof db, 'execute'>;

type UserRef = string | SQL;

export const DOC_ROLE_RANK: Record<DocRole, 1 | 2 | 3 | 4> = { view: 1, comment: 2, edit: 3, full: 4 };

/** True when `role` is `min` or higher. No role is never enough. */
export function roleAtLeast(role: DocRole | null, min: DocRole): boolean {
  return role !== null && DOC_ROLE_RANK[role] >= DOC_ROLE_RANK[min];
}

function checkedRole(min: DocRole): DocRole {
  if (!Object.hasOwn(DOC_ROLE_RANK, min)) throw new Error(`unknown document role: ${String(min)}`);
  return min;
}

/** A role read back from the database, or null. Anything that is not a role counts for nothing. */
function storedRole(role: unknown): DocRole | null {
  return typeof role === 'string' && Object.hasOwn(DOC_ROLE_RANK, role) ? role as DocRole : null;
}

/**
 * One row with the highest role at which `visibleAt` holds, or a null role:
 * the condition asked at full, edit, comment and view in turn. CASE stops at
 * the first that holds, and each EXISTS at its first matching grant.
 */
function highestRoleSql(visibleAt: (min: DocRole) => SQL): SQL {
  return sql`SELECT CASE ${sql.join(DOC_ROLES.map((role) => sql`WHEN ${visibleAt(role)} THEN ${sql.raw(`'${role}'`)}`), sql` `)} END AS role`;
}

/** The columns of the drive a grant is correlated with. */
type DriveRefs = { id: SQL; org: SQL; kind: SQL; defaultRole: SQL; frozenAt: SQL };

const drivesTable: DriveRefs = {
  id: sql`${drives.id}`, org: sql`${drives.org_id}`, kind: sql`${drives.kind}`,
  defaultRole: sql`${drives.default_role}`, frozenAt: sql`${drives.frozen_at}`,
};

/** The inner alias for drives. Inner tables are always aliased, so a reference to an outer `documents` or `drives` column is never captured. */
const accessDrive: DriveRefs = {
  id: sql.raw('access_drive.id'), org: sql.raw('access_drive.org_id'), kind: sql.raw('access_drive.kind'),
  defaultRole: sql.raw('access_drive.default_role'), frozenAt: sql.raw('access_drive.frozen_at'),
};

/**
 * One way to hold a role: the rows that grant it (`from` and `where`,
 * correlated with the drive or the document) and the role they grant.
 * `highest` is the most it can grant, so a branch that can never reach the
 * asked role is left out of the statement.
 */
type Grant = { from: SQL; where: SQL; role: SQL; highest: DocRole };

/** Grants that all need `guard` (a frozen drive's own grants need it unfrozen). */
type GrantGroup = { guard: SQL | null; grants: Grant[] };

/** The drive's own grants: its members (people and chats), and on an open drive owners, admins and members. */
function driveGrants(userId: UserRef, drive: DriveRefs): GrantGroup {
  return {
    guard: sql`${drive.frozenAt} IS NULL`,
    grants: [
      {
        from: sql`drive_members access_member`,
        where: sql`access_member.drive_id = ${drive.id} AND access_member.principal_type = 'user'
          AND access_member.principal_id = ${userId}`,
        role: sql`access_member.role`,
        highest: 'full',
      },
      {
        from: sql`drive_members access_chat_member
          JOIN spaces access_chat ON access_chat.id = access_chat_member.principal_id
          JOIN space_members access_chat_seat ON access_chat_seat.space_id = access_chat.id`,
        where: sql`access_chat_member.drive_id = ${drive.id} AND access_chat_member.principal_type = 'space'
          AND access_chat.org_id = ${drive.org} AND access_chat_seat.user_id = ${userId}`,
        role: sql`access_chat_member.role`,
        highest: 'full',
      },
      {
        from: sql`org_members access_open JOIN users access_open_user ON access_open_user.id = access_open.user_id`,
        where: sql`${drive.kind} = 'open' AND access_open.org_id = ${drive.org} AND access_open.user_id = ${userId}
          AND access_open.is_active = true AND access_open.role IN ('owner', 'admin', 'member')
          AND access_open_user.kind = 'human'`,
        role: sql`CASE WHEN access_open.role IN ('owner', 'admin') THEN 'full' ELSE ${drive.defaultRole} END`,
        highest: 'full',
      },
    ],
  };
}

/** The document's shares, to the person or a chat they are in. Out of a frozen drive they give view at most. */
function shareGrants(userId: UserRef, documentId: SQL, drive: DriveRefs): GrantGroup {
  const capped = (role: SQL) => sql`CASE WHEN ${drive.frozenAt} IS NULL THEN ${role} ELSE 'view' END`;
  return {
    guard: null,
    grants: [
      {
        from: sql`document_shares access_share`,
        where: sql`access_share.document_id = ${documentId} AND access_share.principal_type = 'user'
          AND access_share.principal_id = ${userId}`,
        role: capped(sql`access_share.role`),
        highest: 'edit',
      },
      {
        from: sql`document_shares access_chat_share
          JOIN spaces access_share_chat ON access_share_chat.id = access_chat_share.principal_id
          JOIN space_members access_share_seat ON access_share_seat.space_id = access_share_chat.id`,
        where: sql`access_chat_share.document_id = ${documentId} AND access_chat_share.principal_type = 'space'
          AND access_share_chat.org_id = ${drive.org} AND access_share_seat.user_id = ${userId}`,
        role: capped(sql`access_chat_share.role`),
        highest: 'edit',
      },
    ],
  };
}

/** The groups as one boolean: OR'd EXISTS branches, each filtered to roles at least `min`. */
function anyGrant(groups: GrantGroup[], min: DocRole): SQL {
  const atLeast = DOC_ROLES.filter((role) => roleAtLeast(role, min));
  // Every role is at least view, so view needs no filter. The literals come from DOC_ROLES.
  const roleFilter = (role: SQL) => (min === 'view' ? sql`` : sql` AND ${role} IN (${sql.raw(atLeast.map((r) => `'${r}'`).join(', '))})`);
  const parts: SQL[] = [];
  for (const group of groups) {
    const branches = group.grants.filter((grant) => roleAtLeast(grant.highest, min))
      .map((grant) => sql`EXISTS (SELECT 1 FROM ${grant.from} WHERE ${grant.where}${roleFilter(grant.role)})`);
    if (branches.length === 0) continue;
    const any = sql.join(branches, sql` OR `);
    parts.push(group.guard ? sql`(${group.guard} AND (${any}))` : sql`(${any})`);
  }
  return parts.length === 0 ? sql`false` : sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * True when `userId` may act in the workspace `orgId` at all: an active
 * member there, and, unless human, an agent user whose own employee (the one
 * `users.agent_employee_id` names, as provisioning records it) belongs to
 * that workspace and user and is active and not deleted. Another employee
 * row naming the same user counts for nothing. Every branch needs it.
 */
function activeActorSql(userId: UserRef, orgId: OrgRef): SQL {
  return sql`EXISTS (SELECT 1 FROM org_members access_actor
    JOIN users access_actor_user ON access_actor_user.id = access_actor.user_id
    WHERE access_actor.org_id = ${orgId} AND access_actor.user_id = ${userId} AND access_actor.is_active = true
      AND (access_actor_user.kind = 'human' OR EXISTS (SELECT 1 FROM agent_employees access_actor_employee
        WHERE access_actor_employee.id = access_actor_user.agent_employee_id
          AND access_actor_employee.org_id = access_actor.org_id AND access_actor_employee.user_id = access_actor.user_id
          AND access_actor_employee.is_active = true AND access_actor_employee.is_deleted = false)))`;
}

/** The access rule for the document row `documentId` in the drive row `access_drive`, given the actor check is made. */
function documentGrants(userId: UserRef, documentId: SQL): GrantGroup[] {
  return [driveGrants(userId, accessDrive), shareGrants(userId, documentId, accessDrive)];
}

/** visibleDocumentIdSql, with the person as a value or a column (spaceMembersWhoCannotOpen). */
function documentIdVisibleSql(userId: UserRef, orgId: OrgRef, documentId: SQL, min: DocRole): SQL {
  return sql`EXISTS (SELECT 1 FROM documents access_doc
    JOIN drives access_drive ON access_drive.id = access_doc.drive_id AND access_drive.org_id = access_doc.org_id
    WHERE access_doc.id = ${documentId} AND access_doc.org_id = ${orgId}
      AND access_doc.is_deleted = false AND access_drive.is_deleted = false
      AND ${activeActorSql(userId, orgId)}
      AND ${anyGrant(documentGrants(userId, sql.raw('access_doc.id')), checkedRole(min))})`;
}

/**
 * For a query over the `documents` table (not aliased): true for a document
 * of `orgId` that `userId` can open with at least `min` (view by default).
 */
export function visibleDocumentCondition(userId: string, orgId: string, min: DocRole = 'view'): SQL {
  return sql`(${documents.org_id} = ${orgId} AND ${documents.is_deleted} = false
    AND ${activeActorSql(userId, orgId)}
    AND EXISTS (SELECT 1 FROM drives access_drive
      WHERE access_drive.id = ${documents.drive_id} AND access_drive.org_id = ${documents.org_id}
        AND access_drive.is_deleted = false
        AND ${anyGrant(documentGrants(userId, sql`${documents.id}`), checkedRole(min))}))`;
}

/**
 * The same rule for any statement: true when the document `documentId` of
 * `orgId` exists and `userId` can open it with at least `min`. `orgId` and
 * `documentId` may be columns of the statement (an attention item's
 * `org_id` and `source_id`, an exported row's document id).
 */
export function visibleDocumentIdSql(userId: string, orgId: OrgRef, documentId: SQL, min: DocRole = 'view'): SQL {
  return documentIdVisibleSql(userId, orgId, documentId, min);
}

/**
 * The statement documentRoleFor runs: one row, the highest role at which
 * visibleDocumentCondition holds for the document. Exported for its planning
 * test.
 */
export function documentRoleQuery(userId: string, orgId: string, documentId: string): SQL {
  return highestRoleSql((min) => sql`EXISTS (SELECT 1 FROM ${documents}
    WHERE ${documents.id} = ${documentId} AND ${visibleDocumentCondition(userId, orgId, min)})`);
}

/** `userId`'s role on the document `documentId` of `orgId`, or null when they can't open it. */
export async function documentRoleFor(userId: string, orgId: string, documentId: string, executor: Executor = db): Promise<DocRole | null> {
  const result = await executor.execute(documentRoleQuery(userId, orgId, documentId));
  return storedRole((result.rows[0] as { role?: unknown } | undefined)?.role);
}

/**
 * For a query over the `drives` table (not aliased): true for a drive of
 * `orgId` where `userId` holds at least `min` (view by default). A share of
 * a document gives no role on its drive.
 */
export function visibleDriveCondition(userId: string, orgId: string, min: DocRole = 'view'): SQL {
  return sql`(${drives.org_id} = ${orgId} AND ${drives.is_deleted} = false
    AND ${activeActorSql(userId, orgId)}
    AND ${anyGrant([driveGrants(userId, drivesTable)], checkedRole(min))})`;
}

/**
 * The statement driveRoleFor runs: one row, the highest role at which
 * visibleDriveCondition holds for the drive. Exported for its planning test.
 */
export function driveRoleQuery(userId: string, orgId: string, driveId: string): SQL {
  return highestRoleSql((min) => sql`EXISTS (SELECT 1 FROM ${drives}
    WHERE ${drives.id} = ${driveId} AND ${visibleDriveCondition(userId, orgId, min)})`);
}

/** `userId`'s role on the drive `driveId` of `orgId`, or null. */
export async function driveRoleFor(userId: string, orgId: string, driveId: string, executor: Executor = db): Promise<DocRole | null> {
  const result = await executor.execute(driveRoleQuery(userId, orgId, driveId));
  return storedRole((result.rows[0] as { role?: unknown } | undefined)?.role);
}

/**
 * For a query over the `drives` table (not aliased): the private drives of
 * `orgId` that `userId`, an active human owner or admin there, sees listed
 * and may manage the members of, whether or not they can open them (F4).
 * Never a personal or frozen drive. A drive that is also visible to them
 * (visibleDriveCondition) is listed as visible.
 */
export function adminListedDriveCondition(userId: string, orgId: string): SQL {
  return sql`(${drives.org_id} = ${orgId} AND ${drives.is_deleted} = false
    AND ${drives.kind} = 'private' AND ${drives.frozen_at} IS NULL
    AND EXISTS (SELECT 1 FROM org_members access_admin JOIN users access_admin_user ON access_admin_user.id = access_admin.user_id
      WHERE access_admin.org_id = ${orgId} AND access_admin.user_id = ${userId} AND access_admin.is_active = true
        AND access_admin.role IN ('owner', 'admin') AND access_admin_user.kind = 'human'))`;
}

/** The statement spaceMembersWhoCannotOpen runs. Exported for its planning test. */
export function spaceMembersWhoCannotOpenQuery(orgId: string, spaceId: string, documentId: string): SQL {
  const seat = sql.raw('cannot_open_seat.user_id');
  return sql`SELECT cannot_open_seat.user_id,
      (cannot_open_member.role = 'guest' AND cannot_open_user.kind = 'human') AS guest
    FROM space_members cannot_open_seat
    JOIN spaces cannot_open_chat ON cannot_open_chat.id = cannot_open_seat.space_id
    JOIN org_members cannot_open_member ON cannot_open_member.org_id = cannot_open_chat.org_id
      AND cannot_open_member.user_id = cannot_open_seat.user_id
    JOIN users cannot_open_user ON cannot_open_user.id = cannot_open_seat.user_id
    WHERE cannot_open_seat.space_id = ${spaceId} AND cannot_open_chat.org_id = ${orgId}
      AND ${activeActorSql(seat, orgId)}
      AND NOT ${documentIdVisibleSql(seat, orgId, sql`${documentId}`, 'view')}
    ORDER BY cannot_open_seat.user_id`;
}

/**
 * The members of the chat `spaceId` of `orgId` who can't open the document
 * `documentId` (the posting prompt, F13): people and agent users who are
 * active in the workspace, and how many of them are guests. Members who left
 * the workspace aren't counted. The caller has already checked that it may
 * see the document and the chat (F9's GET /audience).
 */
export async function spaceMembersWhoCannotOpen(orgId: string, spaceId: string, documentId: string): Promise<{ userIds: string[]; guests: number }> {
  const result = await db.execute(spaceMembersWhoCannotOpenQuery(orgId, spaceId, documentId));
  const rows = result.rows as Array<{ user_id: string; guest: boolean }>;
  return { userIds: rows.map((row) => row.user_id), guests: rows.filter((row) => row.guest).length };
}
