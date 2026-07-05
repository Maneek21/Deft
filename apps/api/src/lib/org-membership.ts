import { and, eq } from 'drizzle-orm';
import { orgMembers } from '@deft/db/schema';
import { db } from './db.js';

export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';

export type ActiveOrgMembership = {
  id: string;
  role: OrgRole;
};

export async function getActiveOrgMembership(
  orgId: string,
  userId: string,
): Promise<ActiveOrgMembership | null> {
  const [membership] = await db
    .select({
      id: orgMembers.id,
      role: orgMembers.role,
    })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.org_id, orgId),
        eq(orgMembers.user_id, userId),
        eq(orgMembers.is_active, true),
      ),
    )
    .limit(1);

  return membership ? { id: membership.id, role: membership.role as OrgRole } : null;
}

export async function requireActiveOrgMembership(
  orgId: string,
  userId: string,
): Promise<ActiveOrgMembership> {
  const membership = await getActiveOrgMembership(orgId, userId);
  if (!membership) {
    throw new OrgMembershipError('User is not an active member of this organization');
  }
  return membership;
}

export async function requireOrgAdminOrOwner(
  orgId: string,
  userId: string,
): Promise<ActiveOrgMembership> {
  const membership = await requireActiveOrgMembership(orgId, userId);
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new OrgMembershipError('Owner or admin role required', 'FORBIDDEN', 403);
  }
  return membership;
}

export class OrgMembershipError extends Error {
  constructor(
    message: string,
    public readonly code = 'ORG_MEMBERSHIP_INACTIVE',
    public readonly status = 403,
  ) {
    super(message);
    this.name = 'OrgMembershipError';
  }
}
