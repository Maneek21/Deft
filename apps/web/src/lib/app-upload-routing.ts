// One "Upload an app" button for the Apps page. A person can pick any .json
// file: this module decides, from the file's content, which existing endpoint
// it belongs to. An app file (a Deft module manifest) goes to sideload, or to
// upgrade when that app is already installed. An App Kit package goes to
// inspect, then stage. Nothing here talks to the network.

import { APP_PACKAGE_MAX_BYTES, type AppInstallation } from './apps';
import {
  MODULE_MANIFEST_MAX_BYTES,
  resolveModuleManifestUpload,
  type BundledModule,
  type ModuleInstallation,
  type ModuleManifestPreview,
  type ModuleManifestUploadDecision,
} from './modules';

export type AppUploadKind = 'module' | 'app_package';

export type ClassifiedAppUpload = { kind: AppUploadKind; source: string };

/** The largest file the button reads at all: the App package limit (1 MB). */
export const APP_UPLOAD_MAX_BYTES = Math.max(APP_PACKAGE_MAX_BYTES, MODULE_MANIFEST_MAX_BYTES);

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Checks a chosen file before it is read. Throws readable text. */
export function checkAppUploadFile(file: { name: string; size: number }): void {
  if (!/\.json$/iu.test(file.name)) {
    throw new Error('Choose a .json file. An app is one JSON file, such as deft.module.json.');
  }
  if (file.size === 0) throw new Error('This file is empty. Choose the app file you saved.');
  if (file.size > APP_UPLOAD_MAX_BYTES) {
    throw new Error(`This file is ${formatBytes(file.size)}. App files must be ${formatBytes(APP_UPLOAD_MAX_BYTES)} or smaller.`);
  }
}

/** Line and column (1-based) for a character offset in `source`. */
function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

function jsonErrorText(error: unknown, source: string): string {
  const message = error instanceof Error ? error.message : '';
  const lineColumn = /line (\d+) column (\d+)/u.exec(message);
  if (lineColumn) return `This file isn't valid JSON (line ${lineColumn[1]}, column ${lineColumn[2]}). Look for a missing comma, quote or bracket there.`;
  const position = /position (\d+)/u.exec(message);
  if (position) {
    const at = lineAndColumn(source, Number(position[1]));
    return `This file isn't valid JSON (line ${at.line}, column ${at.column}). Look for a missing comma, quote or bracket there.`;
  }
  return "This file isn't valid JSON. Look for a missing comma, quote or bracket, or an extra comma at the end of a list.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Decides what a file is from its content. Throws readable text when it is
 * neither an app file nor an App Kit package.
 */
export function classifyAppUpload(source: string, options: { appPackagesEnabled: boolean }): ClassifiedAppUpload {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(jsonErrorText(error, source));
  }
  if (!isRecord(value)) {
    throw new Error('An app file is one JSON object that starts with {. This file holds something else.');
  }
  const byteLength = new TextEncoder().encode(source).byteLength;
  if (typeof value.package_format === 'string' && value.package_format.startsWith('deft.app.package')) {
    if (!options.appPackagesEnabled) {
      throw new Error('This is an App Kit package, and App Kit packages are not available on this workspace. Upload an app file (deft.module.json) instead.');
    }
    if (byteLength > APP_PACKAGE_MAX_BYTES) {
      throw new Error(`App Kit packages must be ${formatBytes(APP_PACKAGE_MAX_BYTES)} or smaller.`);
    }
    return { kind: 'app_package', source };
  }
  if (Array.isArray(value.collections) || ((value.schema_version === '1' || value.schema_version === '2') && typeof value.slug === 'string' && !('compatibility' in value))) {
    if (byteLength > MODULE_MANIFEST_MAX_BYTES) {
      throw new Error(`This app file is ${formatBytes(byteLength)}. App files must be ${formatBytes(MODULE_MANIFEST_MAX_BYTES)} or smaller.`);
    }
    return { kind: 'module', source };
  }
  if (isRecord(value.compatibility) && Array.isArray(value.modules)) {
    throw new Error('This is an App Kit source file (deft.app.json). Run `deft app build` and upload the package it writes to .deft/app.deftapp.json.');
  }
  throw new Error("Deft can't tell what this file is. Upload an app file: a JSON object with \"id\", \"slug\", \"name\", \"version\" and \"collections\".");
}

/**
 * Picks install or upgrade for an app file. `requestedTargetId` is set when the
 * person pressed "Upload new version" on a specific app.
 */
export function planModuleUpload(
  preview: ModuleManifestPreview,
  installed: ModuleInstallation[],
  requestedTargetId?: string | null,
): ModuleManifestUploadDecision {
  const owned = installed.find((module) => module.owningAppInstallationId
    && (module.moduleId === preview.moduleId || module.slug === preview.slug));
  if (owned) {
    throw new Error(`${owned.manifest.name || owned.slug} is part of an App Kit package. Upload a new version of that package instead.`);
  }
  const requested = requestedTargetId ? installed.find((module) => module.id === requestedTargetId) : undefined;
  if (requested && (requested.moduleId !== preview.moduleId || requested.slug !== preview.slug)) {
    throw new Error(`This file is ${preview.name} (${preview.slug}), not ${requested.manifest.name || requested.slug}. Its "id" and "slug" must stay the same as the installed app's.`);
  }
  const clash = installed.find((module) => (module.moduleId === preview.moduleId) !== (module.slug === preview.slug));
  if (clash) {
    throw new Error(clash.slug === preview.slug
      ? `Another app already uses the slug "${preview.slug}". Choose a different "slug" and "id" for a new app.`
      : `Another app already uses the id "${preview.moduleId}". Choose a different "id" and "slug" for a new app.`);
  }
  const same = installed.find((module) => module.moduleId === preview.moduleId && module.slug === preview.slug);
  if (same && same.source !== 'sideloaded') {
    throw new Error(`${same.manifest.name || same.slug} comes with Deft and updates with Deft. To build your own version, give your file a new "id" and "slug".`);
  }
  return resolveModuleManifestUpload(preview, installed, requestedTargetId);
}

/** The existing endpoint and headers for an app file. */
export function moduleUploadRequest(decision: ModuleManifestUploadDecision): { path: string; headers: Record<string, string> } {
  if (decision.mode === 'upgrade') {
    return {
      path: `/api/modules/${encodeURIComponent(decision.target.slug)}/upgrade`,
      headers: { 'Content-Type': 'application/json', 'If-Match': decision.target.manifestDigest! },
    };
  }
  return { path: '/api/modules/sideload', headers: { 'Content-Type': 'application/json' } };
}

/** The inspect endpoint for an App Kit package. Staging stays in the page. */
export const APP_PACKAGE_INSPECT_REQUEST = {
  path: '/api/apps/inspect',
  headers: { 'Content-Type': 'application/vnd.deft.app.package+json' },
} as const;

export type AppsHomeItem =
  | { kind: 'module'; key: string; name: string; description: string | null; module: ModuleInstallation; bundled: BundledModule | null }
  | { kind: 'package'; key: string; name: string; description: string | null; app: AppInstallation };

export type AppsHome = { installed: AppsHomeItem[]; available: BundledModule[]; total: number };

/**
 * One list of everything installed, whatever its format, plus the bundled apps
 * not installed yet. Modules inside an App Kit package appear under that
 * package, not on their own.
 */
export function buildAppsHome(input: {
  modules: ModuleInstallation[];
  bundled: BundledModule[];
  apps: AppInstallation[];
  query?: string;
}): AppsHome {
  const bundledBySlug = new Map(input.bundled.map((module) => [module.slug, module]));
  const items: AppsHomeItem[] = [
    ...input.modules.filter((module) => !module.owningAppInstallationId).map((module): AppsHomeItem => ({
      kind: 'module',
      key: `module:${module.id}`,
      name: module.manifest.name || module.slug,
      description: module.manifest.description,
      module,
      bundled: module.source === 'bundled' ? bundledBySlug.get(module.slug) ?? null : null,
    })),
    ...input.apps.map((app): AppsHomeItem => ({
      kind: 'package',
      key: `package:${app.id}`,
      name: app.name,
      description: app.manifest.description ?? null,
      app,
    })),
  ].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  const installedSlugs = new Set(input.modules.map((module) => module.slug));
  const installedIds = new Set(input.modules.map((module) => module.moduleId));
  const available = input.bundled
    .filter((module) => !module.installed && !installedSlugs.has(module.slug) && !installedIds.has(module.moduleId))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  const query = input.query?.trim().toLowerCase() ?? '';
  const matches = (text: Array<string | null | undefined>) => !query || text.filter(Boolean).join(' ').toLowerCase().includes(query);
  return {
    installed: items.filter((item) => matches(item.kind === 'module'
      ? [item.name, item.module.slug, item.description]
      : [item.name, item.app.app_id, item.description])),
    available: available.filter((module) => matches([module.name, module.slug, module.description])),
    total: items.length + available.length,
  };
}

/** Whether `GET /api/apps` reports developer pairing as available. Missing means no. */
export function developerPairingAvailable(response: unknown): boolean {
  if (!isRecord(response)) return false;
  const pairing = response.developer_pairing;
  return isRecord(pairing) && pairing.available === true;
}
