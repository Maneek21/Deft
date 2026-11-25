// Who may change an existing project's lead. A project's lead reads every
// task in it, restricted ones included (lib/task-visibility.ts), so naming a
// lead grants that access: only an owner, an admin or the current lead may
// change it. A guest never may (they see only the tasks of their projects).
// Setting a lead when creating a project is not covered: a new project has
// no tasks yet. The role is read from org_members for the project's
// workspace, never from a session or token claim.
import { and, eq } from 'drizzle-orm';
import { orgMembers } from '@deft/db/schema';
import { db } from './db.js';
import { isGuestRole } from './people-visibility-sql.js';

export type ProjectLeadChangeRefusal = { error: string; code: 'FORBIDDEN' };

/**
 * Null when `userId` may change the lead of a project of `orgId` whose
 * current lead is `currentLeadId`; otherwise the refusal to answer with 403.
 */
export async function projectLeadChangeRefusal(
  orgId: string,
  userId: string,
  currentLeadId: string | null,
): Promise<ProjectLeadChangeRefusal | null> {
  const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId), eq(orgMembers.is_active, true)))
    .limit(1);
  const role = membership?.role ?? null;
  if (role !== null && isGuestRole(role)) return { error: 'A guest cannot change a project lead', code: 'FORBIDDEN' };
  if (role === 'owner' || role === 'admin') return null;
  if (currentLeadId !== null && currentLeadId === userId) return null;
  return { error: 'Only an owner, an admin or the project lead can change the project lead', code: 'FORBIDDEN' };
}
