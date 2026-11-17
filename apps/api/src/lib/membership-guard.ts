import { and, eq, isNull } from 'drizzle-orm';
import { invites, orgMembers, users } from '@deft/db/schema';
import { orgMemberPrivilegeHistory } from '@deft/db/two-step';
import type { db } from './db.js';

/**
 * Who may manage whom in a workspace, and the one locked path every such
 * operation takes.
 *
 * THE RULE (owner-only, no exceptions). An operation whose target membership
 * is, was at any time, or would become owner or admin is the owner's alone
 * (or a server operator's, `src/scripts/make-recovery-url.ts`). That covers:
 * invite as admin, re-invite, reactivate, reissue an invite, revoke an
 * invite, remove, deactivate, change role to or from admin, and make a
 * recovery link. An admin may do these only for people who are and have
 * always been member or guest and are staying that way.
 *
 * "Was at any time" comes from `org_member_privilege_history`, written here
 * whenever a role moves into or out of owner or admin, plus the current role
 * (active or not). Memberships demoted before upgrade 0.3.0-preview.149 are
 * not known.
 *
 * ONE LOCKED PATH. Every such operation, inside one transaction:
 *   1. lockMembership: the target's account row, then their membership row
 *      (FOR UPDATE), and whether the membership is protected;
 *   2. authorizeMembershipOperation: the rule above, under that lock;
 *   3. its own reads and writes, using the generation read under the lock;
 *   4. recordMembershipChange for a role or active-state write: moves
 *      `users.password_version` on (the one stamp), records privilege
 *      history, and on removal deletes the person's pending invites.
 * Lock order everywhere: account, membership, invites.
 *
 * LINKS. An invite link or a recovery link carries the generation it was made
 * at and is refused if the generation has moved at all since, whoever made it
 * (routes/invites.ts, lib/web-sessions.ts changeWebPassword). An invite link
 * without a generation (made before this) is refused once the generation has
 * left its starting value 0.
 *
 * Operations, each with a test (apps/api/test/two-step-db.test.ts, including a
 * table over actor role x the target's past and present role x operation):
 *   PATCH  /api/members/:id                  change role
 *   DELETE /api/members/:id                  remove
 *   POST   /api/members/invite               invite, or re-invite / reactivate
 *   POST   /api/members/invites/:id/reissue  reissue an invite
 *   DELETE /api/members/invites/:id          revoke an invite
 *   POST   /api/members/:id/recovery-url     make a recovery link
 *   DELETE /api/agent-employees/:id          remove an agent's membership
 *
 * Not on this path, by design: inserts of brand-new membership rows for a
 * member, guest or agent (signup's owner row is the workspace's first), and
 * operator scripts with database access (`src/scripts/seed-pilot-workspace.ts`,
 * `scripts/pilot-workspace-hygiene.ts`).
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<Tx, 'select'>;

export type MembershipActor = { userId: string } | 'operator';
export type LockedMembership = {
  account: { id: string; password_version: number; email: string | null; password_hash: string | null; kind: string } | null;
  membership: { id: string; role: string; is_active: boolean } | null;
  /** Is or was owner or admin. */
  protected: boolean;
};

export class MembershipGuardError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(message: string) {
    super(message);
    this.name = 'MembershipGuardError';
  }
}

const privilegedRole = (role: string | null | undefined) => role === 'owner' || role === 'admin';

async function readProtection(reader: Reader, orgId: string, userId: string, role: string | null | undefined): Promise<boolean> {
  if (privilegedRole(role)) return true;
  const [history] = await reader.select({ org_id: orgMemberPrivilegeHistory.org_id }).from(orgMemberPrivilegeHistory)
    .where(and(eq(orgMemberPrivilegeHistory.org_id, orgId), eq(orgMemberPrivilegeHistory.user_id, userId))).limit(1);
  return Boolean(history);
}

/** Step 1: the target's account row, then their membership row, locked. */
export async function lockMembership(tx: Tx, input: { orgId: string; targetUserId: string }): Promise<LockedMembership> {
  const [account] = await tx.select({
    id: users.id, password_version: users.password_version, email: users.email, password_hash: users.password_hash, kind: users.kind,
  }).from(users).where(eq(users.id, input.targetUserId)).for('update');
  const [membership] = await tx.select({ id: orgMembers.id, role: orgMembers.role, is_active: orgMembers.is_active }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, input.orgId), eq(orgMembers.user_id, input.targetUserId))).for('update');
  return {
    account: account ?? null,
    membership: membership ?? null,
    protected: membership ? await readProtection(tx, input.orgId, input.targetUserId, membership.role) : false,
  };
}

/** Is or was this membership owner or admin? (Also used where a link is redeemed.) */
export function isProtectedMembership(reader: Reader, orgId: string, userId: string, role: string | null | undefined) {
  return readProtection(reader, orgId, userId, role);
}

/**
 * Step 2: the rule, under the lock from step 1. `resultingRole` is the role
 * the target would hold after the operation (the invited role, the new role),
 * if any. Returns the refusal, or null.
 */
export async function authorizeMembershipOperation(
  reader: Reader,
  input: { orgId: string; actor: MembershipActor; locked: Pick<LockedMembership, 'protected'>; resultingRole?: string | null },
): Promise<string | null> {
  if (input.actor === 'operator') return null;
  const [acting] = await reader.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, input.orgId), eq(orgMembers.user_id, input.actor.userId), eq(orgMembers.is_active, true)))
    .limit(1);
  if (acting?.role === 'owner') return null;
  if (acting?.role !== 'admin') return 'Only the owner or an admin can manage members';
  if (input.locked.protected) return 'Only the owner can manage someone who is or was an owner or admin';
  if (privilegedRole(input.resultingRole)) return 'Only the owner can make someone an admin';
  return null;
}

/**
 * The same decision without locks, for a refusal before other work (the
 * locked check in the write's transaction is the one that counts).
 */
export async function checkMembershipOperation(
  reader: Reader,
  input: { orgId: string; targetUserId: string; actor: MembershipActor; resultingRole?: string | null },
): Promise<string | null> {
  const [membership] = await reader.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, input.orgId), eq(orgMembers.user_id, input.targetUserId))).limit(1);
  const locked = { protected: membership ? await readProtection(reader, input.orgId, input.targetUserId, membership.role) : false };
  return authorizeMembershipOperation(reader, { ...input, locked });
}

/**
 * Step 4: a role or active-state write is about to happen (call it in the
 * same transaction, after step 2). Returns the account's new generation.
 */
export async function recordMembershipChange(
  tx: Tx,
  input: { orgId: string; targetUserId: string; locked: LockedMembership; change: { role?: string; isActive?: boolean } },
): Promise<number> {
  const { account, membership } = input.locked;
  if (!account || !membership) return account?.password_version ?? 0;
  const roleChanges = input.change.role !== undefined && input.change.role !== membership.role;
  const activeChanges = input.change.isActive !== undefined && input.change.isActive !== membership.is_active;
  if (!roleChanges && !activeChanges) return account.password_version;
  const next = account.password_version + 1;
  await tx.update(users).set({ password_version: next }).where(eq(users.id, input.targetUserId));
  if (privilegedRole(membership.role) || privilegedRole(input.change.role)) {
    await tx.insert(orgMemberPrivilegeHistory).values({ org_id: input.orgId, user_id: input.targetUserId }).onConflictDoNothing();
  }
  if (input.change.isActive === false && membership.is_active && account.email) {
    // Removal kills the person's pending invites (by the address they were sent to).
    await tx.delete(invites).where(and(eq(invites.org_id, input.orgId), eq(invites.email, account.email), isNull(invites.accepted_at)));
  }
  return next;
}
