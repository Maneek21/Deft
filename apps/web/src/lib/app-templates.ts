import {
  MODULE_LIMITS,
  parseSupportedDeftModuleManifest,
  type DeftModuleManifest,
} from '@deft/shared/modules';
import { formatManifestError } from '@deft/shared/module-issues';
import hiringPipeline from './app-templates/hiring-pipeline.json';
import hiringPipelineSamples from './app-templates/hiring-pipeline.samples.json';
import vendorTracker from './app-templates/vendor-tracker.json';
import vendorTrackerSamples from './app-templates/vendor-tracker.samples.json';
import lightCrm from './app-templates/light-crm.json';
import lightCrmSamples from './app-templates/light-crm.samples.json';
import contentCalendar from './app-templates/content-calendar.json';
import contentCalendarSamples from './app-templates/content-calendar.samples.json';
import { moduleApiError, type ModuleInstallation } from './modules';

/**
 * Starter apps. Each is an ordinary module manifest that installs as a
 * sideloaded module under the name the person gives it, so it stays editable
 * and upgradable like any uploaded app. The same JSON files are the
 * downloadable starters on the website.
 */

export type AppTemplateSample = {
  /** A name later samples use in `links` to point at this record. */
  ref?: string;
  collection: string;
  data: Record<string, unknown>;
  /** Relation field key → the `ref` (or refs) of earlier samples. */
  links?: Record<string, string | string[]>;
};

export type AppTemplate = {
  key: string;
  name: string;
  description: string;
  icon: string;
  manifest: DeftModuleManifest;
  /** Sample records in creation order: parents before the records that link to them. */
  samples: AppTemplateSample[];
};

function template(source: unknown, samples: unknown): AppTemplate {
  const manifest = parseSupportedDeftModuleManifest(source);
  return {
    key: manifest.slug,
    name: manifest.name,
    description: manifest.description ?? '',
    icon: manifest.icon ?? 'database',
    manifest,
    samples: samples as AppTemplateSample[],
  };
}

export const APP_TEMPLATES: readonly AppTemplate[] = Object.freeze([
  template(hiringPipeline, hiringPipelineSamples),
  template(vendorTracker, vendorTrackerSamples),
  template(lightCrm, lightCrmSamples),
  template(contentCalendar, contentCalendarSamples),
]);

export function getAppTemplate(key: string): AppTemplate | null {
  return APP_TEMPLATES.find((item) => item.key === key) ?? null;
}

const MAX_SLUG_ATTEMPTS = 20;

/** "Hiring – EU team" → "hiring-eu-team". Never empty, never over the slug limit. */
export function appTemplateSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // A slug starts with a letter: "3D printing" becomes "app-3d-printing".
  const lettered = /^[0-9]/.test(base) ? `app-${base}` : base;
  const trimmed = lettered.slice(0, MODULE_LIMITS.module_slug_chars - 4).replace(/-+$/g, '');
  return trimmed || 'my-app';
}

function withSuffix(slug: string, attempt: number): string {
  return attempt <= 1 ? slug : `${slug}-${attempt}`;
}

/** "Hiring" and then "Hiring 2", so two installs of one starter are told apart. */
function nameWithSuffix(name: string, attempt: number): string {
  const trimmed = name.trim();
  if (attempt <= 1) return trimmed;
  const suffix = ` ${attempt}`;
  return `${Array.from(trimmed).slice(0, MODULE_LIMITS.display_name_chars - suffix.length).join('').trimEnd()}${suffix}`;
}

/** The server refuses these names for this workspace; the next suffix may be free. */
const RETRY_WITH_SUFFIX = new Set(['MODULE_ALREADY_INSTALLED', 'MODULE_IDENTITY_RESERVED']);

/**
 * The template's manifest renamed for this workspace: the person's name, a
 * slug made from it, and the id `workspace.<slug>`. Throws a readable error
 * when the name is not usable.
 */
export function buildAppTemplateManifest(template: AppTemplate, name: string, slug = appTemplateSlug(name)): DeftModuleManifest {
  const candidate = { ...template.manifest, name: name.trim(), slug, id: `workspace.${slug}` };
  try {
    return parseSupportedDeftModuleManifest(candidate);
  } catch (error) {
    throw new Error(formatManifestError(error, { input: candidate, subject: 'App' }).message);
  }
}

export type AppTemplateInstallResult = {
  slug: string;
  moduleId: string;
  name: string;
  /** Sample records created. */
  seeded: number;
  /** Set when some samples could not be created. The app itself is installed. */
  seedError?: string;
};

type Fetcher = (path: string, init: RequestInit) => Promise<Response>;

async function defaultFetch(path: string, init: RequestInit): Promise<Response> {
  const { api } = await import('./api');
  return api.fetch(path, init);
}

function firstFreeAttempt(slug: string, installed: ModuleInstallation[] | undefined): number {
  if (!installed) return 1;
  const taken = new Set(installed.flatMap((module) => [module.slug, module.moduleId]));
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate = withSuffix(slug, attempt);
    if (!taken.has(candidate) && !taken.has(`workspace.${candidate}`)) return attempt;
  }
  return MAX_SLUG_ATTEMPTS;
}

function randomKey(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedSamples(
  fetcher: Fetcher,
  template: AppTemplate,
  slug: string,
  manifestDigest: string,
): Promise<{ seeded: number; seedError?: string }> {
  const ids = new Map<string, string>();
  const runKey = randomKey();
  let seeded = 0;
  for (const [index, sample] of template.samples.entries()) {
    const relations: Record<string, string[]> = {};
    for (const [field, refs] of Object.entries(sample.links ?? {})) {
      const recordIds = (Array.isArray(refs) ? refs : [refs])
        .map((ref) => ids.get(ref))
        .filter((id): id is string => Boolean(id));
      if (recordIds.length > 0) relations[field] = recordIds;
    }
    let response: Response;
    try {
      response = await fetcher(`/api/modules/${encodeURIComponent(slug)}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection_key: sample.collection,
          data: sample.data,
          relations,
          expected_manifest_digest: manifestDigest,
          idempotency_key: `template:${runKey}:${index}`,
        }),
      });
    } catch {
      // The app is already installed: a dropped connection only stops the samples.
      return { seeded, seedError: partialSeedError(seeded, template.samples.length, 'The connection dropped.') };
    }
    if (!response.ok) {
      const reason = await moduleApiError(response, 'A sample record could not be created.');
      return { seeded, seedError: partialSeedError(seeded, template.samples.length, reason) };
    }
    const parsed = await response.json().catch(() => null) as unknown;
    const body = (parsed && typeof parsed === 'object' ? parsed : {}) as {
      record?: { id?: unknown } | null;
      mutation?: { record_id?: unknown } | null;
      record_id?: unknown;
    };
    const recordId = [body.record?.id, body.mutation?.record_id, body.record_id]
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    seeded += 1;
    if (sample.ref) {
      // Later samples link to this one; without its id their links would be lost.
      if (!recordId) {
        return { seeded, seedError: partialSeedError(seeded, template.samples.length, 'The new record could not be read back.') };
      }
      ids.set(sample.ref, recordId);
    }
  }
  return { seeded };
}

function partialSeedError(seeded: number, total: number, reason: string): string {
  const added = seeded === 0 ? `none of the ${total} sample records were added` : `only ${seeded} of ${total} sample records were added`;
  const sentence = /[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`;
  return `The app is installed, but ${added}. ${sentence}`;
}

/**
 * Install a starter as a sideloaded app under the person's name. A slug that
 * is taken is retried as `<slug>-2`, `-3` and so on. With `withSamples`, the
 * sample records are created parents first, with their links. If seeding
 * fails part-way, the app stays installed and `seedError` says what happened.
 */
export async function installAppTemplate(options: {
  template: AppTemplate;
  name: string;
  withSamples: boolean;
  installed?: ModuleInstallation[];
  fetch?: Fetcher;
}): Promise<AppTemplateInstallResult> {
  const fetcher = options.fetch ?? defaultFetch;
  const baseSlug = appTemplateSlug(options.name);
  let attempt = firstFreeAttempt(baseSlug, options.installed);
  for (let tries = 0; tries < 3 && attempt <= MAX_SLUG_ATTEMPTS; tries += 1, attempt += 1) {
    const slug = withSuffix(baseSlug, attempt);
    const manifest = buildAppTemplateManifest(options.template, nameWithSuffix(options.name, attempt), slug);
    const response = await fetcher('/api/modules/sideload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    if (response.status === 409) {
      const body = await response.clone().json().catch(() => ({})) as { code?: unknown };
      if (typeof body.code === 'string' && RETRY_WITH_SUFFIX.has(body.code)) continue;
    }
    if (!response.ok) throw new Error(await moduleApiError(response, `Unable to install ${manifest.name}.`));
    const body = await response.json().catch(() => ({})) as { module?: { slug?: unknown; module_id?: unknown; manifest_digest?: unknown } };
    const installedSlug = typeof body.module?.slug === 'string' ? body.module.slug : manifest.slug;
    const digest = typeof body.module?.manifest_digest === 'string' ? body.module.manifest_digest : null;
    const result: AppTemplateInstallResult = {
      slug: installedSlug,
      moduleId: typeof body.module?.module_id === 'string' ? body.module.module_id : manifest.id,
      name: manifest.name,
      seeded: 0,
    };
    if (!options.withSamples || options.template.samples.length === 0) return result;
    if (!digest) {
      return { ...result, seedError: 'The app is installed, but its sample records were not added. Refresh and add records yourself.' };
    }
    return { ...result, ...await seedSamples(fetcher, options.template, installedSlug, digest) };
  }
  throw new Error('An app with this name is already installed. Choose another name.');
}
