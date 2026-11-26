// The first locks of every drive, folder and document write, and the
// caller's access to a drive (consult batch B). Shared by routes/drives.ts
// and lib/documents.ts; routes/drives.ts's header holds the full lock order
// and why it can't cycle against a departure.
//
// The order: the actor's room-access lock (lib/room-access-lock.ts), then
// their org_members row FOR SHARE (lockActorInTx), then the drive row FOR
// UPDATE (driveAccess with `lock`; two drives in id order), then anything
// under the drive.
import { and, eq } from 'drizzle-orm';
import { drives, type DocRole, type DriveRow } from '@deft/db/documents';
import { orgMembers } from '@deft/db/schema';
import { db } from './db.js';
import { adminListedDriveCondition, driveRoleFor } from './document-access.js';
import { lockRoomAccessChange } from './room-access-lock.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, 'select' | 'execute'>;

/** Who acts: a person in their workspace (an AuthUser is one). */
export type DriveActor = { id: string; org_id: string };

/** What the caller holds on a live drive of their workspace. */
export type DriveAccess = { drive: DriveRow; role: DocRole | null; adminPath: boolean };

/**
 * The drive and the caller's role on it, or null when it doesn't exist, is
 * deleted or belongs to another workspace. `adminPath` is set for an owner
 * or admin, without full access, on a private drive they see listed. With
 * `lock`, the drive row is locked first (FOR UPDATE), so the role is read
 * after any change to the drive committed before.
 */
export async function driveAccess(reader: Reader, user: DriveActor, driveId: string, lock = false): Promise<DriveAccess | null> {
  const query = reader.select().from(drives)
    .where(and(eq(drives.id, driveId), eq(drives.org_id, user.org_id), eq(drives.is_deleted, false)));
  const [drive] = lock ? await query.for('update') : await query;
  if (!drive) return null;
  const role = await driveRoleFor(user.id, user.org_id, drive.id, reader);
  let adminPath = false;
  if (role !== 'full' && drive.kind === 'private') {
    const [listed] = await reader.select({ id: drives.id }).from(drives)
      .where(and(eq(drives.id, drive.id), adminListedDriveCondition(user.id, user.org_id))).limit(1);
    adminPath = Boolean(listed);
  }
  return { drive, role, adminPath };
}

/**
 * A drive write's first locks, in the order above: the actor's room-access
 * lock, then their active org_members row FOR SHARE. Returns their
 * workspace role, or null when they have no active membership.
 */
export async function lockActorInTx(tx: Tx, user: DriveActor): Promise<string | null> {
  await lockRoomAccessChange(tx, user.org_id, user.id);
  const [membership] = await tx.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id), eq(orgMembers.is_active, true)))
    .limit(1)
    .for('share');
  return membership?.role ?? null;
}
