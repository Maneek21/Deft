import { and, eq, isNull } from 'drizzle-orm';
import { invites, orgMembers, users } from '@deft/db/schema';
import { orgMemberPrivilegeHistory } from '@deft/db/two-step';
import type { db } from './db.js';

/**
 * Who may manage whom in a workspace, and the one locked path every such
 * operation takes.
 *
 * THE RULE (owner's decision, 17 Nov), for HUMAN memberships (users.kind =
 * 'human'). Granting admin is open to admins: an admin may invite a
 * brand-new person as admin, promote a member or guest, or (re-)invite as
 * admin someone whose membership has never been owner or admin. Everything
 * else about a human membership that is or ever was owner or admin, a
 * pending admin invite included, is the owner's alone (or a server
 * operator's, `src/scripts/make-recovery-url.ts`), with no exceptions:
 * demote, remove, deactivate, reactivate, re-invite, reissue or revoke its
 * invite, recovery link. The grant is a one-way door: once a person is
 * admin, even pending, only the owner touches their membership.
 *
 * NOT COVERED: agent and system memberships (users.kind 'agent' or
 * 'system'). Admins manage an agent that holds admin rights exactly as before
 * this rule (only a current owner membership is protected, as it always
 * was). Owner-only management of admin agents, across the agent-employee
 * routes, API keys, webhooks, MCP tools and budgets, is a separate follow-up.
 *
 * "Was" comes from `org_member_privilege_history`, written at the first
 * grant (or the first time a role leaves owner or admin) in the same locked
 * transaction, plus the current role (active or not). Memberships demoted
 * before upgrade 0.3.0-preview.149 are not known.
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

/**
 * Is or was this membership owner or admin, for the rule above? A membership
 * that is not a person's (an agent or the system user) counts only while it
 * is the owner.
 */
async function readProtection(reader: Reader, orgId: string, userId: string, role: string | null | undefined, kind?: string | null): Promise<boolean> {
  if (role === 'owner') return true;
  let accountKind = kind;
  if (accountKind === undefined) {
    const [account] = await reader.select({ kind: users.kind }).from(users).where(eq(users.id, userId)).limit(1);
    accountKind = account?.kind ?? null;
  }
  if (accountKind !== 'human') return false;
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
    protected: membership ? await readProtection(tx, input.orgId, input.targetUserId, membership.role, account?.kind ?? null) : false,
  };
}

/** Is or was this human membership owner or admin? (Also used where a link is redeemed.) */
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
  // An admin may grant admin to someone never privileged (resultingRole), but
  // never act on a human membership that is or was owner or admin.
  if (input.locked.protected) return 'Only the owner can manage a person who is or was an owner or admin';
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
 * The first time a membership is granted owner or admin (or first leaves it),
 * record it with the account's generation at that moment. Later grants keep
 * the first row. Call it inside the locked transaction of the grant.
 */
export async function recordPrivilege(tx: Tx, input: { orgId: string; userId: string; generation: number }) {
  await tx.insert(orgMemberPrivilegeHistory)
    .values({ org_id: input.orgId, user_id: input.userId, first_generation: input.generation })
    .onConflictDoNothing();
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
    await recordPrivilege(tx, { orgId: input.orgId, userId: input.targetUserId, generation: next });
  }
  if (input.change.isActive === false && membership.is_active && account.email) {
    // Removal kills the person's pending invites (by the address they were sent to).
    await tx.delete(invites).where(and(eq(invites.org_id, input.orgId), eq(invites.email, account.email), isNull(invites.accepted_at)));
  }
  return next;
}

/**
 * At redemption: does whoever made this invite or recovery link still count?
 * For someone who is or was an owner or admin, only a link the current owner
 * made works; for anyone else, the maker must still be an active owner or
 * admin (a removed admin's links die with their role). A link with no
 * recorded maker counts for no one. (A recovery link from the server
 * operator script is accepted by the caller before this is asked.)
 */
export async function linkMakerStillCounts(
  reader: Reader,
  input: {
    orgId: string; targetUserId: string; makerUserId: string | null | undefined; targetProtected: boolean;
    /** For an invite link: the role and generation it was made for, to recognise the first-grant link. */
    firstGrant?: { role: string | null | undefined; generation: number | undefined; currentGeneration: number };
  },
): Promise<boolean> {
  if (!input.makerUserId) return false;
  const [maker] = await reader.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, input.orgId), eq(orgMembers.user_id, input.makerUserId), eq(orgMembers.is_active, true)))
    .limit(1);
  const makerIsOwner = maker?.role === 'owner';
  const makerIsAdmin = makerIsOwner || maker?.role === 'admin';
  if (!input.targetProtected) return makerIsAdmin;
  if (makerIsOwner) return true;
  // The first-grant link: an admin invited someone never privileged as admin.
  // Recognised only from stored data: the link was made for the admin role at
  // exactly the generation recorded at the first grant, and the generation has
  // not moved since. A link without a generation (made before this release)
  // is never one.
  const grant = input.firstGrant;
  if (!makerIsAdmin || !grant || grant.role !== 'admin' || grant.generation === undefined) return false;
  if (grant.generation !== grant.currentGeneration) return false;
  const [history] = await reader.select({ first_generation: orgMemberPrivilegeHistory.first_generation }).from(orgMemberPrivilegeHistory)
    .where(and(eq(orgMemberPrivilegeHistory.org_id, input.orgId), eq(orgMemberPrivilegeHistory.user_id, input.targetUserId))).limit(1);
  return history?.first_generation === grant.generation;
}
