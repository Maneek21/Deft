/** Automatic continuity deliberately accepts a smaller set than manual review.
 * Compare original JSON, including fields the current parser does not know.
 * Only the exact code/compatibility leaves below may change. Never use a
 * schema parser's stripped/defaulted output as the comparison input. */
export type UpgradeAuthorityDiff = Readonly<{ requires_review: boolean; changed_paths: readonly string[] }>;
/** JSON pointers relative to the raw manifest. '*' matches one array index only.
 * Protocols, artifact paths, capabilities, schemas, provider profiles and transport
 * pins are deliberately absent. Container additions/removals are never exempt.
 * Unrecognised changes anywhere (including inside compatibility) require review.
 * Keep the database's forward guard and its parity test aligned with this list. */
export const UPGRADE_NON_AUTHORITY_STRING_PATHS = [
  '/version', '/name', '/description',
  '/compatibility/host/version', '/compatibility/host/minimum_version', '/compatibility/host/release_manifest',
  '/compatibility/kit/version', '/compatibility/kit/minimum_version', '/compatibility/kit/release_manifest',
  '/compatibility/runtime/version', '/compatibility/runtime/minimum_version', '/compatibility/runtime/release_manifest',
  '/compatibility/app_kit_version', '/compatibility/runtime_kit_version', '/compatibility/runtime_version',
] as const;
export const UPGRADE_NON_AUTHORITY_DIGEST_PATHS = [
  '/experiences/*/artifact_digest', '/experiences/*/worker_digest',
  '/runtime_requirements/*/package_digest', '/runtime_requirements/*/worker_digest',
] as const;
const nonAuthorityStringPaths = new Set<string>(UPGRADE_NON_AUTHORITY_STRING_PATHS);
// Compile only these module-owned declarations. Match the absolute end rather
// than '$', which also accepts a final newline in a lookalike field name.
const nonAuthorityDigestPaths = UPGRADE_NON_AUTHORITY_DIGEST_PATHS.map(pattern => new RegExp('^' + pattern.split('/')
  .map(part => part === '*' ? '(?:0|[1-9][0-9]*)' : part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('/') + '(?![\\s\\S])', 'u'));
function nonAuthorityChange(before: unknown, after: unknown, path: string): boolean {
  // Container changes are never exempt; avoid allocating path segments for
  // every object in a large unchanged declaration/schema tree.
  const string = (value: unknown) => value === undefined || typeof value === 'string';
  if (!string(before) || !string(after)) return false;
  if (!path.startsWith('/manifest/')) return false;
  const at = path.slice('/manifest'.length);
  const digest = (value: unknown) => value === undefined || typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
  return nonAuthorityStringPaths.has(at)
    || digest(before) && digest(after) && nonAuthorityDigestPaths.some(pattern => pattern.test(at));
}
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
  if (Object.is(before, after) || nonAuthorityChange(before, after, path)) return;
  if (object(before) && object(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const at = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) {
        if (!nonAuthorityChange(before[key], after[key], at)) output.push(at);
      }
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
    || typeof after.id !== 'string' || !object(before.compatibility) || !object(after.compatibility)
    || [before, after].some(manifest => ['experiences', 'runtime_requirements'].some(key =>
      Object.hasOwn(manifest, key) && !Array.isArray(manifest[key])))) {
    return { requires_review: true, changed_paths: ['/manifest'] };
  }
  changes(before, after, '/manifest', paths);
  if (connection) {
    if (!json(connection.before) || !json(connection.after)) paths.push('/connection');
    else changes(connection.before, connection.after, '/connection', paths);
  }
  return { requires_review: paths.length !== 0, changed_paths: paths };
}
