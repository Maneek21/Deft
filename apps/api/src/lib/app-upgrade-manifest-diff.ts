/** Automatic continuity deliberately accepts a smaller set than manual review.
 * Compare original JSON, including fields the current parser does not know.
 * Only explicitly listed presentation/version fields may change. Never use a
 * schema parser's stripped/defaulted output as the comparison input. */
export type UpgradeAuthorityDiff = Readonly<{ requires_review: boolean; changed_paths: readonly string[] }>;
const presentation = new Set(['version', 'name', 'description']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function json(value: unknown, depth = 0, budget = { remaining: 50000 }): boolean {
  if (--budget.remaining < 0 || depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return Object.keys(value).length === value.length
    && value.every(item => json(item, depth + 1, budget));
  return object(value) && Object.values(value).every(item => json(item, depth + 1, budget));
}
function changes(before: unknown, after: unknown, path: string, output: string[]) {
  if (Object.is(before, after)) return;
  if (object(before) && object(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const at = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) output.push(at);
      else changes(before[key], after[key], at, output);
    }
  } else if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    before.forEach((value, index) => changes(value, after[index], `${path}/${index}`, output));
  } else output.push(path);
}
/** Connection includes the reviewed provider profile AND transport digest.
 * No normalization of origins, scopes, arrays, purposes, effects or schemas:
 * even a removal/reorder is conservatively reviewed. Unknown changes cannot
 * disappear through an allowlist projection. Values never enter diagnostics. */
export function diffUpgradeAuthority(before: unknown, after: unknown,
  connection?: Readonly<{ before: unknown; after: unknown }>): UpgradeAuthorityDiff {
  const paths: string[] = [];
  if (!object(before) || !object(after) || !json(before) || !json(after)
    || !['3', '4', '5', '6', '7'].includes(before.schema_version as string)
    || before.schema_version !== after.schema_version || typeof before.id !== 'string'
    || typeof after.id !== 'string' || !object(before.compatibility) || !object(after.compatibility)) {
    return { requires_review: true, changed_paths: ['/manifest'] };
  }
  const project = (manifest: Record<string, unknown>) => Object.fromEntries(Object.entries(manifest).filter(([key, value]) =>
    !presentation.has(key) || typeof value !== 'string'));
  changes(project(before), project(after), '/manifest', paths);
  if (connection) {
    if (!json(connection.before) || !json(connection.after)) paths.push('/connection');
    else changes(connection.before, connection.after, '/connection', paths);
  }
  return { requires_review: paths.length !== 0, changed_paths: paths };
}
