// The drives a workspace makes for itself and for each person (spec 5.1),
// and the drive list the sidebar reads (GET /api/drives).
//
// - Workspace: every workspace's first open drive, default role "can edit"
//   (system_key 'workspace'). Made the first time anyone lists drives.
// - My drive: one personal drive per person, made when they first need it.
//   Its owner holds full access only through a `full` drive_members row
//   (lib/document-access.ts has no rule of its own for personal drives), so
//   ensurePersonalDrive writes that row every time, and restores it if it was
//   lost or lowered, for someone who can hold access.
// - Shared notes: the open drive, default "can view", that the notes move
//   (F14) creates for notes visible to the whole workspace (system_key
//   'shared_notes').
//
// Each is idempotent and safe under concurrency: a partial unique index
// (one live personal drive per person, one live drive per system key and
// workspace) makes a concurrent second insert do nothing, and the row is
// then read back.
//
// When a person leaves, their personal drive is frozen, or, on a removal
// with a replacement, handed to the replacement as a private drive
// (endDriveAccessOnDepartureInTx, handOverPersonalDriveInTx; spec 5.2, F6).
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { documents, driveMembers, drives, type DocRole, type DocShareRole, type DriveRow, type DriveSystemKey } from '@deft/db/documents';
import { auditLog, users } from '@deft/db/schema';
import { db } from './db.js';
import { adminListedDriveCondition, canHoldDocumentAccess, driveWithoutManagerCondition, visibleDriveCondition } from './document-access.js';
import { accessLossInTx, finishAccessLoss, type PendingAccessLoss } from './document-access-change.js';
import { emitDocumentUpdated } from './document-access-events.js';

/** The pool by default, or a caller's transaction. */
type Executor = Pick<typeof db, 'select' | 'insert' | 'execute'>;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The live documents of `driveId`, read through the caller's transaction. */
async function liveDocumentIds(tx: Tx, orgId: string, driveId: string): Promise<string[]> {
  const rows = await tx.select({ id: documents.id }).from(documents)
    .where(and(eq(documents.org_id, orgId), eq(documents.drive_id, driveId), eq(documents.is_deleted, false)))
    .orderBy(documents.id);
  return rows.map((row) => row.id);
}

/**
 * A person leaves the workspace (consult rules C3 and C5): every way out ends
 * their drive and document access here, inside the transaction that ended
 * their membership, after everything else it ends. Called by
 * routes/members.ts endWorkspaceAccess (removal, the deactivation an invite
 * revocation makes) and by deleting an agent employee
 * (routes/agent-employees.ts).
 *
 * Their live personal drive is frozen first (spec 5.2, F6): its own grants
 * end for everyone, owners and admins included, and shares out of it give
 * view at most, until an owner hands it on (handOverPersonalDriveInTx). That
 * is a loss of its own, naming the drive and its documents; the person's own
 * loss follows. A removal with a replacement has already handed the drive on
 * (routes/members.ts reassignMemberOwnership), so there is nothing to freeze.
 * The caller finishes the returned losses after commit (finishDriveLosses).
 */
export async function endDriveAccessOnDepartureInTx(tx: Tx, orgId: string, userId: string): Promise<PendingAccessLoss[]> {
  const now = new Date();
  const frozen = await tx.update(drives).set({ frozen_at: now, updated_at: now })
    .where(and(
      eq(drives.org_id, orgId), eq(drives.owner_user_id, userId), eq(drives.kind, 'personal'), eq(drives.is_deleted, false),
      isNull(drives.frozen_at),
    ))
    .returning({ id: drives.id });
  const losses: PendingAccessLoss[] = [];
  for (const drive of frozen) {
    losses.push(await accessLossInTx(tx, { orgId, driveId: drive.id, documentIds: await liveDocumentIds(tx, orgId, drive.id) }));
  }
  losses.push(await accessLossInTx(tx, { orgId, userIds: [userId] }));
  return losses;
}

/**
 * After commit: finishes each loss (finishAccessLoss), then sends
 * `document:updated` for the documents a loss names to the people who can
 * view them now (rule C4): after a freeze, the holders of shares out of the
 * drive; after a handover, the new holder too. Never throws.
 */
export async function finishDriveLosses(losses: readonly PendingAccessLoss[]): Promise<void> {
  for (const loss of losses) {
    await finishAccessLoss(loss.change, loss.result);
    const documentIds = loss.change.documentIds ?? [];
    if (documentIds.length > 0) await emitDocumentUpdated(loss.change.orgId, documentIds);
  }
}

/** Thrown by handOverPersonalDriveInTx for a drive that isn't a live personal drive of its workspace. */
export class NotAPersonalDriveError extends Error {
  readonly code = 'NOT_A_PERSONAL_DRIVE';
  constructor() { super('Only a personal drive can be handed on'); }
}

/**
 * Hands a departed person's personal drive to `holderId` (spec 5.2, F6),
 * inside the caller's transaction, which has locked the drive row:
 * - the drive becomes private and unfrozen, with no owner, named
 *   "<their name>'s drive";
 * - the departed person's member row goes and the holder holds `full`
 *   (raised if they were already a member); other members and links stay;
 * - the `drive_handed_over` audit row is written in the same transaction, so
 *   the handover never commits without it (logAuditEvent's columns);
 * - the change runs the access-loss path (rule C3), naming the drive and its
 *   documents; the caller finishes it after commit (finishDriveLosses).
 * The holder must be able to hold access (canHoldDocumentAccess), or this
 * throws PrincipalCannotHoldAccessError having changed nothing. Used by the
 * removal with a replacement (`via: 'removal'`) and by an owner's handover of
 * a frozen drive (`via: 'handover'`).
 */
export async function handOverPersonalDriveInTx(
  tx: Tx, drive: DriveRow, holderId: string, actorId: string, via: 'removal' | 'handover',
): Promise<{ drive: DriveRow; loss: PendingAccessLoss }> {
  if (drive.kind !== 'personal' || drive.is_deleted || !drive.owner_user_id) throw new NotAPersonalDriveError();
  if (!(await canHoldDocumentAccess(holderId, drive.org_id, tx))) throw new PrincipalCannotHoldAccessError();
  const departedId = drive.owner_user_id;
  const [departed] = await tx.select({ name: users.name }).from(users).where(eq(users.id, departedId)).limit(1);
  const name = `${departed?.name?.trim() || 'A former member'}'s drive`;
  const now = new Date();
  const [handed] = await tx.update(drives)
    .set({ kind: 'private', owner_user_id: null, frozen_at: null, name, updated_at: now })
    .where(eq(drives.id, drive.id))
    .returning();
  await tx.delete(driveMembers).where(and(
    eq(driveMembers.drive_id, drive.id), eq(driveMembers.principal_type, 'user'), eq(driveMembers.principal_id, departedId),
  ));
  await tx.insert(driveMembers)
    .values({ org_id: drive.org_id, drive_id: drive.id, principal_type: 'user', principal_id: holderId, role: 'full', added_by: actorId })
    .onConflictDoUpdate({
      target: [driveMembers.drive_id, driveMembers.principal_type, driveMembers.principal_id],
      set: { role: 'full', updated_at: now },
    });
  await tx.insert(auditLog).values({
    org_id: drive.org_id,
    actor_type: 'user',
    actor_id: actorId,
    action: 'drive_handed_over',
    entity_type: 'drive',
    entity_id: drive.id,
    before_state: { kind: drive.kind, name: drive.name, owner_user_id: departedId, frozen: drive.frozen_at !== null },
    after_state: { kind: 'private', name, owner_user_id: null, frozen: false, holder_user_id: holderId },
    metadata: { from_user_id: departedId, to_user_id: holderId, via },
  });
  const loss = await accessLossInTx(tx, { orgId: drive.org_id, driveId: drive.id, documentIds: await liveDocumentIds(tx, drive.org_id, drive.id) });
  return { drive: handed!, loss };
}

async function liveSystemDrive(executor: Executor, orgId: string, key: DriveSystemKey): Promise<DriveRow | undefined> {
  const [drive] = await executor.select().from(drives)
    .where(and(eq(drives.org_id, orgId), eq(drives.system_key, key), eq(drives.is_deleted, false))).limit(1);
  return drive;
}

async function ensureSystemDrive(
  executor: Executor, orgId: string, key: DriveSystemKey, name: string, defaultRole: DocShareRole, createdBy: string | null,
): Promise<DriveRow> {
  const existing = await liveSystemDrive(executor, orgId, key);
  if (existing) return existing;
  await executor.insert(drives)
    .values({ org_id: orgId, name, kind: 'open', system_key: key, default_role: defaultRole, created_by: createdBy })
    .onConflictDoNothing({ target: [drives.org_id, drives.system_key], where: sql`system_key IS NOT NULL AND NOT is_deleted` });
  const drive = await liveSystemDrive(executor, orgId, key);
  if (!drive) throw new Error(`the ${key} drive could not be created`);
  return drive;
}

/** The workspace's Workspace drive: open, default role "can edit". */
export async function ensureWorkspaceDrive(orgId: string, executor: Executor = db): Promise<DriveRow> {
  return ensureSystemDrive(executor, orgId, 'workspace', 'Workspace', 'edit', null);
}

/** The workspace's Shared notes drive (the notes move): open, default role "can view". */
export async function ensureSharedNotesDrive(orgId: string, createdBy: string, executor: Executor = db): Promise<DriveRow> {
  return ensureSystemDrive(executor, orgId, 'shared_notes', 'Shared notes', 'view', createdBy);
}

async function livePersonalDrive(executor: Executor, orgId: string, userId: string): Promise<DriveRow | undefined> {
  const [drive] = await executor.select().from(drives)
    .where(and(eq(drives.org_id, orgId), eq(drives.owner_user_id, userId), eq(drives.kind, 'personal'), eq(drives.is_deleted, false)))
    .limit(1);
  return drive;
}

/**
 * A removal with a replacement (routes/members.ts reassignMemberOwnership):
 * hands the person's live personal drive, frozen or not, to the replacement
 * (handOverPersonalDriveInTx), with the drive row locked. Null when they
 * have none. Throws PrincipalCannotHoldAccessError, so the removal rolls
 * back, when the replacement can't hold access.
 */
export async function handOverPersonalDriveOnRemovalInTx(
  tx: Tx, orgId: string, memberId: string, replacementUserId: string, actorId: string,
): Promise<PendingAccessLoss | null> {
  const [drive] = await tx.select().from(drives)
    .where(and(eq(drives.org_id, orgId), eq(drives.owner_user_id, memberId), eq(drives.kind, 'personal'), eq(drives.is_deleted, false)))
    .limit(1)
    .for('update');
  if (!drive) return null;
  return (await handOverPersonalDriveInTx(tx, drive, replacementUserId, actorId, 'removal')).loss;
}

/** Thrown by ensurePersonalDrive and the handover for someone who could never hold access (canHoldDocumentAccess). */
export class PrincipalCannotHoldAccessError extends Error {
  readonly code = 'PRINCIPAL_CANNOT_HOLD_ACCESS';
  constructor() { super('That person can’t hold access to drives in this workspace'); }
}

/**
 * `userId`'s My drive in `orgId`, with their `full` drive_members row. A
 * grant is made only to someone who can hold access (canHoldDocumentAccess:
 * an active human member, or an agent user with an active employee); for
 * anyone else this throws PrincipalCannotHoldAccessError and creates nothing.
 */
export async function ensurePersonalDrive(orgId: string, userId: string, executor: Executor = db): Promise<DriveRow> {
  if (!(await canHoldDocumentAccess(userId, orgId, executor))) throw new PrincipalCannotHoldAccessError();
  let drive = await livePersonalDrive(executor, orgId, userId);
  if (!drive) {
    await executor.insert(drives)
      .values({ org_id: orgId, name: 'My drive', kind: 'personal', owner_user_id: userId, created_by: userId })
      .onConflictDoNothing({ target: [drives.org_id, drives.owner_user_id], where: sql`kind = 'personal' AND NOT is_deleted` });
    drive = await livePersonalDrive(executor, orgId, userId);
    if (!drive) throw new Error('the personal drive could not be created');
  }
  await executor.insert(driveMembers)
    .values({ org_id: orgId, drive_id: drive.id, principal_type: 'user', principal_id: userId, role: 'full', added_by: userId })
    .onConflictDoUpdate({
      target: [driveMembers.drive_id, driveMembers.principal_type, driveMembers.principal_id],
      set: { role: 'full', updated_at: sql`now()` },
      setWhere: sql`${driveMembers.role} <> 'full'`,
    });
  return drive;
}

/**
 * The statement GET /api/drives runs: every live drive of `orgId` that
 * `userId` can open, with their role on it, plus the private drives an owner
 * or admin sees listed (`admin_listed`; a drive that is both is visible).
 * Each row: id, name, icon, kind, system_key, default_role, frozen, role
 * (null for a drive only admin-listed), admin_listed and pinned. Workspace
 * first, then the person's My drive, then by name. Exported for its planning
 * test.
 *
 * The role is the highest at which visibleDriveCondition holds, asked from
 * full down in one CASE. `OFFSET 0` keeps the inner query from being pulled
 * up into the outer one, which would copy each condition into the outer
 * filter and plan it twice.
 */
export function driveListQuery(userId: string, orgId: string): SQL {
  const at = (role: DocRole) => visibleDriveCondition(userId, orgId, role);
  return sql`SELECT listed.* FROM (
      SELECT ${drives.id} AS id, ${drives.name} AS name, ${drives.icon} AS icon, ${drives.kind} AS kind,
        ${drives.system_key} AS system_key, ${drives.default_role} AS default_role, ${drives.frozen_at} IS NOT NULL AS frozen,
        CASE WHEN ${at('full')} THEN 'full' WHEN ${at('edit')} THEN 'edit' WHEN ${at('comment')} THEN 'comment'
          WHEN ${at('view')} THEN 'view' END AS role,
        ${adminListedDriveCondition(userId, orgId)} AS admin_listed,
        EXISTS (SELECT 1 FROM doc_favorites drive_pin
          WHERE drive_pin.org_id = ${drives.org_id} AND drive_pin.user_id = ${userId}
            AND drive_pin.target_type = 'drive' AND drive_pin.target_id = ${drives.id}) AS pinned
      FROM ${drives}
      WHERE ${drives.org_id} = ${orgId} AND ${drives.is_deleted} = false
      OFFSET 0
    ) listed
    WHERE listed.role IS NOT NULL OR listed.admin_listed
    ORDER BY CASE WHEN listed.system_key = 'workspace' THEN 0 WHEN listed.kind = 'personal' THEN 1 ELSE 2 END,
      lower(listed.name), listed.id`;
}

/**
 * The statement GET /api/drives/without-manager runs: the private drives of
 * `orgId` nobody can manage (driveWithoutManagerCondition), each with how
 * many member rows it has, by name. Exported for its planning test.
 */
export function drivesWithoutManagerQuery(orgId: string): SQL {
  return sql`SELECT ${drives.id} AS id, ${drives.name} AS name, ${drives.icon} AS icon, ${drives.created_at} AS created_at,
      (SELECT count(*)::int FROM drive_members manager_count WHERE manager_count.drive_id = ${drives.id}) AS member_count
    FROM ${drives}
    WHERE ${driveWithoutManagerCondition(orgId)}
    ORDER BY lower(${drives.name}), ${drives.id}`;
}

/**
 * The frozen personal drives of `orgId`, newest first, with the person who
 * left each: what an owner can hand on (POST /api/drives/:id/handover).
 * Names only, nothing inside them.
 */
export function frozenDrivesQuery(orgId: string): SQL {
  return sql`SELECT frozen_drive.id, frozen_drive.frozen_at, frozen_drive.owner_user_id AS former_owner_id,
      frozen_owner.name AS former_owner_name
    FROM drives frozen_drive
    LEFT JOIN users frozen_owner ON frozen_owner.id = frozen_drive.owner_user_id
    WHERE frozen_drive.org_id = ${orgId} AND frozen_drive.is_deleted = false AND frozen_drive.kind = 'personal'
      AND frozen_drive.frozen_at IS NOT NULL
    ORDER BY frozen_drive.frozen_at DESC, frozen_drive.id`;
}
