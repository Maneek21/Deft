import {
  ModuleManifestError,
  formatModuleManifestError,
  moduleApiError,
  previewModuleManifestJson,
  type ModuleManifestPreview,
} from './modules';

/**
 * Editing an installed app in the browser: check the edited app file, bump
 * its version when the person did not, and save it as an update guarded by
 * the active digest (If-Match), so a stale editor never overwrites a newer
 * version.
 */

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** The next version after `active`: 1.2.3 → 1.2.4, and 1.2.3-beta.1 → 1.2.3. */
export function nextPatchVersion(active: string): string | null {
  const match = SEMVER.exec(active.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  if (prerelease) return `${major}.${minor}.${patch}`;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

/**
 * Semantic-version precedence: negative, zero or positive, or null when either
 * is not a version. Build metadata (+...) does not count, as on the server.
 */
export function compareVersions(left: string, right: string): number | null {
  const a = SEMVER.exec(left.trim());
  const b = SEMVER.exec(right.trim());
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  const aPre = a[4]?.split('.') ?? [];
  const bPre = b[4]?.split('.') ?? [];
  if (aPre.length === 0 || bPre.length === 0) return bPre.length - aPre.length;
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index += 1) {
    const x = aPre[index];
    const y = bPre[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function topLevelVersion(source: string): string | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const version = (value as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/**
 * The edited source with its version bumped to the next patch when it still
 * equals the active version. Anything else (a version the person already
 * changed, or text that is not JSON) is returned as it is, for the check to
 * explain. The rest of the text keeps its formatting.
 */
export function bumpPatchIfUnchanged(edited: string, activeVersion: string): string {
  if (topLevelVersion(edited) !== activeVersion) return edited;
  const next = nextPatchVersion(activeVersion);
  if (!next) return edited;
  const escaped = activeVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`("version"\\s*:\\s*)"${escaped}"`);
  const replaced = edited.replace(pattern, `$1"${next}"`);
  if (topLevelVersion(replaced) === next) return replaced;
  // The first "version" was not the top-level one: rewrite the whole file.
  const value = JSON.parse(edited) as Record<string, unknown>;
  return `${JSON.stringify({ ...value, version: next }, null, 2)}\n`;
}

export type ModuleManifestEditCheck =
  | { ok: true; preview: ModuleManifestPreview; source: string; bumped: boolean }
  | { ok: false; lines: string[] };

/**
 * Check an edited app file the way the server will: valid, the same id and
 * slug as the installed app, and a newer version (bumped for the person when
 * they left it unchanged).
 */
export async function checkModuleManifestEdit(
  source: string,
  active: { version: string; moduleId?: string; slug?: string },
): Promise<ModuleManifestEditCheck> {
  const bumpedSource = bumpPatchIfUnchanged(source, active.version);
  try {
    const preview = await previewModuleManifestJson(bumpedSource);
    const order = compareVersions(preview.version, active.version);
    if (order !== null && order <= 0) {
      const next = nextPatchVersion(active.version);
      return {
        ok: false,
        lines: [`version: must be higher than the installed ${active.version}${next ? `, such as ${next}` : ''}`],
      };
    }
    if ((active.moduleId && preview.moduleId !== active.moduleId) || (active.slug && preview.slug !== active.slug)) {
      return {
        ok: false,
        lines: [`The app file id and slug cannot change. Keep id "${active.moduleId ?? preview.moduleId}" and slug "${active.slug ?? preview.slug}".`],
      };
    }
    return { ok: true, preview, source: bumpedSource, bumped: bumpedSource !== source };
  } catch (error) {
    if (error instanceof ModuleManifestError) return { ok: false, lines: error.lines };
    return { ok: false, lines: formatModuleManifestError(error, bumpedSource).split('\n') };
  }
}

type Fetcher = (path: string, init: RequestInit) => Promise<Response>;

async function defaultFetch(path: string, init: RequestInit): Promise<Response> {
  const { api } = await import('./api');
  return api.fetch(path, init);
}

export type ModuleManifestSaveResult = {
  version: string;
  /** The text that was saved (bumped when needed), to keep in the editor. */
  source: string;
  module: unknown;
};

/**
 * Save an edited app file as an update. Checks it first, bumps the patch
 * version when needed, and sends the active digest as If-Match. Throws an
 * Error with readable text: the check's lines, or the server's (which name
 * the records that do not fit a new version).
 */
export async function saveModuleManifestEdit(options: {
  slug: string;
  source: string;
  activeDigest: string;
  activeVersion: string;
  moduleId?: string;
  fetch?: Fetcher;
}): Promise<ModuleManifestSaveResult> {
  const check = await checkModuleManifestEdit(options.source, {
    version: options.activeVersion,
    moduleId: options.moduleId,
    slug: options.slug,
  });
  if (!check.ok) throw new Error(check.lines.join('\n'));
  const fetcher = options.fetch ?? defaultFetch;
  const response = await fetcher(`/api/modules/${encodeURIComponent(options.slug)}/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'If-Match': options.activeDigest },
    body: check.source,
  });
  if (!response.ok) throw new Error(await moduleApiError(response, `Unable to save ${check.preview.name}.`));
  const body = await response.json().catch(() => ({})) as { module?: unknown };
  return { version: check.preview.version, source: check.source, module: body.module ?? null };
}
