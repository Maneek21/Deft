import { and, eq } from 'drizzle-orm';
import { agentEmployees } from '@deft/db/schema';
import { db } from '../db.js';
import { DEFTY_SYSTEM_EMPLOYEE_SLUG } from '../ensure-defty-membership.js';
import type { ToolContext } from './types.js';

export type EmployeeProjectAccess =
  | {
      resolved: false;
      userId: null;
      unrestricted: false;
      projectIds: [];
    }
  | {
      resolved: true;
      userId: string;
      unrestricted: boolean;
      projectIds: string[];
    };

/**
 * Resolve the current employee task boundary from the database.
 *
 * Historical rows use both NULL and [] for org-wide access, so only a
 * non-empty project_ids array is restrictive. Callers must treat an
 * unresolved employee as denied rather than falling back to org scope.
 */
export async function loadEmployeeProjectAccess(
  ctx: Pick<ToolContext, 'org_id' | 'employee_id'>,
): Promise<EmployeeProjectAccess> {
  const [employee] = await db
    .select({
      user_id: agentEmployees.user_id,
      slug: agentEmployees.slug,
      project_ids: agentEmployees.project_ids,
      runtime_kind: agentEmployees.runtime_kind,
      is_byoa: agentEmployees.is_byoa,
      is_active: agentEmployees.is_active,
      is_deleted: agentEmployees.is_deleted,
    })
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.id, ctx.employee_id),
        eq(agentEmployees.org_id, ctx.org_id),
      ),
    )
    .limit(1);

  // Defty is an internal system principal whose hidden employee row is kept
  // soft-deleted by design. It is not a user-created runtime and remains
  // organization-wide; every external employee still fails closed on pause
  // or deletion.
  const isDeftySystem = employee?.runtime_kind === 'defty_system'
    && employee.slug === DEFTY_SYSTEM_EMPLOYEE_SLUG
    && employee.is_byoa === false;
  if (!employee || !employee.is_active || (employee.is_deleted && !isDeftySystem)) {
    return {
      resolved: false,
      userId: null,
      unrestricted: false,
      projectIds: [],
    };
  }

  const projectIds = [...new Set(
    (isDeftySystem ? [] : employee.project_ids ?? []).filter(
      (projectId): projectId is string => typeof projectId === 'string' && projectId.length > 0,
    ),
  )];

  return {
    resolved: true,
    userId: employee.user_id,
    unrestricted: projectIds.length === 0,
    projectIds,
  };
}

export function employeeProjectAccessAllows(
  access: EmployeeProjectAccess,
  projectId: string,
): boolean {
  return access.resolved
    && (access.unrestricted || access.projectIds.includes(projectId));
}

export async function employeeCanAccessProject(
  ctx: Pick<ToolContext, 'org_id' | 'employee_id'>,
  projectId: string,
): Promise<boolean> {
  return employeeProjectAccessAllows(
    await loadEmployeeProjectAccess(ctx),
    projectId,
  );
}
