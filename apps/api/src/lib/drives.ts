// The drives a workspace makes for itself and for each person (spec 5.1),
// and the drive list the sidebar reads (GET /api/drives).
//
// - Workspace: every workspace's first open drive, default role "can edit"
//   (system_key 'workspace'). Made the first time anyone lists drives.
// - My drive: one personal drive per person, made when they first need it.
//   Its owner holds full access only through a `full` drive_members row
//   (lib/document-access.ts has no rule of its own for personal drives), so
//   ensurePersonalDrive writes that row every time, and restores it if it was
//   lost or lowered.
// - Shared notes: the open drive, default "can view", that the notes move
//   (F14) creates for notes visible to the whole workspace (system_key
//   'shared_notes').
//
// Each is idempotent and safe under concurrency: a partial unique index
// (one live personal drive per person, one live drive per system key and
// workspace) makes a concurrent second insert do nothing, and the row is
// then read back.
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { driveMembers, drives, type DocRole, type DocShareRole, type DriveRow, type DriveSystemKey } from '@deft/db/documents';
import { db } from './db.js';
import { adminListedDriveCondition, visibleDriveCondition } from './document-access.js';

/** The pool by default, or a caller's transaction. */
type Executor = Pick<typeof db, 'select' | 'insert'>;

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
 * `userId`'s My drive in `orgId`, with their `full` drive_members row. The
 * person needs an org_members row there (the upgrade's triggers refuse
 * anyone else).
 */
export async function ensurePersonalDrive(orgId: string, userId: string, executor: Executor = db): Promise<DriveRow> {
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
