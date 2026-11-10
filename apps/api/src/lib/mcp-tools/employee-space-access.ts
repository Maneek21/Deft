import { and, eq, or } from 'drizzle-orm';
import { agentEmployees, spaceMembers, spaces } from '@deft/db/schema';
import { db } from '../db.js';
import { canonicalDeftyEmployeeCondition } from '../defty-identity.js';

/**
 * Public spaces are visible across the org. Private and DM spaces require the
 * employee's shadow user to be an explicit member.
 */
export async function employeeCanAccessSpace(
  employeeId: string,
  orgId: string,
  spaceId: string,
): Promise<boolean> {
  const [space] = await db
    .select({ type: spaces.type })
    .from(spaces)
    .where(
      and(
        eq(spaces.id, spaceId),
        eq(spaces.org_id, orgId),
        eq(spaces.is_archived, false),
      ),
    )
    .limit(1);

  if (!space) return false;
  if (space.type === 'public') return true;

  const [employee] = await db
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.id, employeeId),
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
        // The canonical Defty system employee is soft-hidden (is_deleted=true)
        // by design; it is admitted on the same membership rule below. Any
        // other deleted employee stays denied.
        or(eq(agentEmployees.is_deleted, false), canonicalDeftyEmployeeCondition()),
      ),
    )
    .limit(1);
  if (!employee) return false;

  const [membership] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.space_id, spaceId),
        eq(spaceMembers.user_id, employee.user_id),
      ),
    )
    .limit(1);

  return Boolean(membership);
}
