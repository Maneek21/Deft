import { and, eq } from 'drizzle-orm';
import { agentEmployees } from '@deft/db/schema';

export const DEFTY_EMAIL = 'deft-agent@system.local';
export const DEFTY_NAME = 'Defty';
export const DEFTY_SYSTEM_EMPLOYEE_SLUG = 'defty-system';
export const DEFTY_SYSTEM_RUNTIME_KIND = 'defty_system';

type DeftyEmployeeIdentity = {
  slug?: string | null;
  runtime_kind?: string | null;
  is_byoa?: boolean | null;
};

/**
 * Defty is an internal principal, not a runtime-kind label. All three fields
 * are required so a forged or legacy external row cannot inherit Defty's
 * deleted-row and trust-policy exceptions by setting runtime_kind alone.
 */
export function isCanonicalDeftyEmployee(
  employee: DeftyEmployeeIdentity | null | undefined,
): boolean {
  return employee?.runtime_kind === DEFTY_SYSTEM_RUNTIME_KIND
    && employee.slug === DEFTY_SYSTEM_EMPLOYEE_SLUG
    && employee.is_byoa === false;
}

export function canonicalDeftyEmployeeCondition() {
  return and(
    eq(agentEmployees.runtime_kind, DEFTY_SYSTEM_RUNTIME_KIND),
    eq(agentEmployees.slug, DEFTY_SYSTEM_EMPLOYEE_SLUG),
    eq(agentEmployees.is_byoa, false),
  );
}

export function isReservedDeftyEmployeeSlug(slug: string): boolean {
  return slug === DEFTY_SYSTEM_EMPLOYEE_SLUG;
}

export function isReservedDeftyRuntimeKind(runtimeKind: string): boolean {
  return runtimeKind === DEFTY_SYSTEM_RUNTIME_KIND;
}
