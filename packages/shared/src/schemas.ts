// Legacy dependency-free validation helpers. The declarative module contract
// uses Zod in ./modules; these primitives stay lightweight for older callers.

/**
 * Strict semver regex: MAJOR.MINOR.PATCH with optional pre-release/build metadata.
 * Matches 1.2.3, 1.2.3-alpha, 1.2.3-rc.1, 1.2.3+build.5.
 */
export const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSemver(v: unknown): v is string {
  return typeof v === 'string' && SEMVER_REGEX.test(v);
}

/**
 * Throwing variant — use at insert time to enforce semver for
 * agent_employee_templates.version before hitting the DB CHECK constraint.
 */
export function assertSemver(v: unknown, fieldName = 'version'): string {
  if (!isValidSemver(v)) {
    throw new Error(`Invalid semver for ${fieldName}: ${String(v)}`);
  }
  return v;
}
