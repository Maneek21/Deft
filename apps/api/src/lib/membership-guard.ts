import { and, eq } from 'drizzle-orm';
import { orgMembers, users } from '@deft/db/schema';
import type { db } from './db.js';

/**
 * The one rule for every write to `org_members.role` or `org_members.is_active`
 * made by the app (routes, workers, tools). Each writer calls
 * guardMembershipChange inside its transaction, immediately before its write:
 *
 * - Only the owner, or an operator on the server, may change the role of an
 *   owner or admin (active or removed: re-inviting a removed admin as a
 *   member is a role change) or deactivate an active one. An admin who could demote or
 *   remove a peer could then make a recovery link for them as a member, set
 *   their password and promote them back.
 * - Any change to a person's role or active state ends every recovery link
 *   and every pending invite link made for them so far (both carry
 *   `users.password_version`, which this moves on), so no link outlives a
 *   change of who that person is in the workspace.
 *
 * It locks the account row, then the membership row: the order sign-in and
 * password changes use.
 *
 * Not guarded, by design: inserts of new membership rows (nothing is taken
 * away), and operator scripts run on the server with database access
 * (`src/scripts/seed-pilot-workspace.ts`, which deactivates stale pilot agent
 * memberships, and `scripts/pilot-workspace-hygiene.ts`, which deactivates
 * pilot test-fixture memberships). An operator can already make a recovery
 * link for anyone (`src/scripts/make-recovery-url.ts`).
 *
 * A pending invite for an owner or admin is a way into that role, so it
 * follows the same rule: it is reissued or revoked only by the owner or by
 * whoever made it (`inviteMadeBy`).
 *
 * Writers, each with a test (two-step-db.test.ts):
 *   PATCH  /api/members/:id              role change
 *   DELETE /api/members/:id              deactivation
 *   POST   /api/members/invite           re-activation of a former member
 *   POST   /api/members/invites/:id/reissue  new link for a pending invitee
 *   DELETE /api/members/invites/:id      deactivation of a pending invitee
 *   DELETE /api/agent-employees/:id      deactivation of the agent's membership
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<Tx, 'select'>;

export type MembershipActor = { userId: string } | 'operator';
export type MembershipChange = { role?: string; isActive?: boolean };
type GuardInput = { orgId: string; targetUserId: string; actor: MembershipActor; change: MembershipChange; inviteMadeBy?: string };
export type GuardedMembership = { id: string; role: string; is_active: boolean };
export type MembershipGuardResult =
  | { ok: true; membership: GuardedMembership | null }
  | { ok: false; code: 'FORBIDDEN'; error: string };

export class MembershipGuardError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(message: string) {
    super(message);
    this.name = 'MembershipGuardError';
  }
}

function takesPrivilegeAway(membership: GuardedMembership, change: MembershipChange): boolean {
  if (membership.role !== 'owner' && membership.role !== 'admin') return false;
  if (change.role !== undefined && change.role !== membership.role) return true;
  return membership.is_active && change.isActive === false;
}

async function decide(reader: Reader, input: GuardInput, membership: GuardedMembership, privileged: boolean) {
  const { orgId, actor } = input;
  if (!privileged || actor === 'operator') return null;
  if (input.inviteMadeBy !== undefined && input.inviteMadeBy === actor.userId) return null;
  const [acting] = await reader.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, actor.userId), eq(orgMembers.is_active, true)))
    .limit(1);
  if (acting?.role === 'owner') return null;
  return membership.role === 'owner' ? 'The owner cannot be changed or removed' : "Only the owner can change or remove an admin";
}

/** The same decision without locks or writes, for a refusal before other work. */
export async function checkMembershipChange(reader: Reader, input: GuardInput): Promise<MembershipGuardResult> {
  const [membership] = await reader.select({ id: orgMembers.id, role: orgMembers.role, is_active: orgMembers.is_active }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, input.orgId), eq(orgMembers.user_id, input.targetUserId))).limit(1);
  if (!membership) return { ok: true, membership: null };
  const refusal = await decide(reader, input, membership, takesPrivilegeAway(membership, input.change));
  return refusal ? { ok: false, code: 'FORBIDDEN', error: refusal } : { ok: true, membership };
}

/**
 * A new link for a pending invite hands out the invited role. For an owner
 * or admin, only the owner or whoever made the invite may reissue it.
 * Nothing is written, so nothing is ended.
 */
export async function checkInviteReissue(
  reader: Reader,
  input: { orgId: string; targetUserId: string; actor: MembershipActor; inviteMadeBy: string },
): Promise<MembershipGuardResult> {
  const [membership] = await reader.select({ id: orgMembers.id, role: orgMembers.role, is_active: orgMembers.is_active }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, input.orgId), eq(orgMembers.user_id, input.targetUserId))).limit(1);
  if (!membership) return { ok: true, membership: null };
  const privileged = membership.role === 'owner' || membership.role === 'admin';
  const refusal = await decide(reader, { ...input, change: {} }, membership, privileged);
  return refusal ? { ok: false, code: 'FORBIDDEN', error: refusal } : { ok: true, membership };
}

export async function guardMembershipChange(tx: Tx, input: GuardInput): Promise<MembershipGuardResult> {
  const [account] = await tx.select({ password_version: users.password_version }).from(users)
    .where(eq(users.id, input.targetUserId)).for('update');
  const [membership] = await tx.select({ id: orgMembers.id, role: orgMembers.role, is_active: orgMembers.is_active }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, input.orgId), eq(orgMembers.user_id, input.targetUserId))).for('update');
  if (!account || !membership) return { ok: true, membership: membership ?? null };
  const refusal = await decide(tx, input, membership, takesPrivilegeAway(membership, input.change));
  if (refusal) return { ok: false, code: 'FORBIDDEN', error: refusal };
  const changes = (input.change.role !== undefined && input.change.role !== membership.role)
    || (input.change.isActive !== undefined && input.change.isActive !== membership.is_active);
  if (changes) {
    await tx.update(users).set({ password_version: account.password_version + 1 }).where(eq(users.id, input.targetUserId));
  }
  return { ok: true, membership };
}
