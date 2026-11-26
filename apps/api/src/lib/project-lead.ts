// Who may change an existing project's lead. A project's lead reads every
// task in it, restricted ones included (lib/task-visibility.ts), so naming a
// lead grants that access: only an owner, an admin or the current lead may
// change it. A guest never may (they see only the tasks of their projects).
// Setting a lead when creating a project is not covered: a new project has
// no tasks yet. The role is read from org_members for the project's
// workspace, never from a session or token claim.
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { orgMembers, projects } from '@deft/db/schema';
import { db } from './db.js';
import { isGuestRole } from './people-visibility-sql.js';

export type ProjectLeadChangeRefusal = { error: string; code: 'FORBIDDEN' };

/**
 * The condition a lead-changing UPDATE of `projects` carries, so the change is
 * atomic with what authorized it: the project's lead is still
 * `expectedLeadId`, and `userId` is, at that moment, an active owner or admin
 * of `orgId`, or an active member who is that lead. When the UPDATE matches no
 * row, the caller asks `projectLeadChangeRefusal` again: a refusal answers
 * 403, otherwise the lead changed meanwhile (409).
 */
export function leadChangeWriteCondition(orgId: string, userId: string, expectedLeadId: string | null): SQL {
  const leadIs = expectedLeadId === null ? isNull(projects.lead_id) : eq(projects.lead_id, expectedLeadId);
  return sql`(${leadIs} AND EXISTS (SELECT 1 FROM ${orgMembers} lead_actor
    WHERE lead_actor.org_id = ${orgId} AND lead_actor.user_id = ${userId} AND lead_actor.is_active = true
      AND (lead_actor.role IN ('owner', 'admin') OR (lead_actor.role = 'member' AND ${projects.lead_id} = ${userId}))))`;
}

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
  // The current lead may hand over only while an active member.
  if (role !== null && currentLeadId !== null && currentLeadId === userId) return null;
  return { error: 'Only an owner, an admin or the project lead can change the project lead', code: 'FORBIDDEN' };
}
