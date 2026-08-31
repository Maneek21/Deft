import { z } from 'zod';

export const DEFT_APP_MANIFEST_FILENAME = 'deft.app.json';
export const DEFT_APP_MANIFEST_SCHEMA_VERSION = '0' as const;
export const DEFT_APP_PROTOCOL_VERSION = '0' as const;
export const DEFT_APP_PACKAGE_FORMAT = 'deft.app.package.v0' as const;
export const DEFT_MODULE_ARTIFACT_MEDIA_TYPE = 'application/vnd.deft.module+json' as const;

export const APP_LIMITS = Object.freeze({
  manifest_bytes: 128 * 1024,
  package_bytes: 1024 * 1024,
  artifacts_per_app: 16,
  artifact_bytes: 128 * 1024,
  artifact_path_chars: 240,
  app_id_chars: 128,
  display_name_chars: 80,
  description_chars: 500,
  navigation_items: 32,
} as const);

const APP_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff<>]/u;
const ARTIFACT_PATH_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;
const SPDX_EXPRESSION_PATTERN = /^[A-Za-z0-9.+()-]+(?: [A-Za-z0-9.+()-]+)*$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();

function boundedPlainText(max: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((value) => !UNSAFE_TEXT.test(value), `${label} must be safe single-line plain text`);
}

export const AppIdSchema = z
  .string()
  .min(3)
  .max(APP_LIMITS.app_id_chars)
  .regex(APP_ID_PATTERN, 'App id must be a lowercase reverse-DNS identifier');

export const AppSemverSchema = z
  .string()
  .max(64)
  .regex(SEMVER_PATTERN, 'Version must be strict semantic versioning');

export const AppDigestSchema = z
  .string()
  .regex(SHA256_PATTERN, 'Digest must be sha256:<lowercase hex>');

export const AppArtifactPathSchema = z
  .string()
  .min(1)
  .max(APP_LIMITS.artifact_path_chars)
  .regex(ARTIFACT_PATH_PATTERN, 'Artifact path must use lowercase portable ASCII characters')
  .superRefine((path, ctx) => {
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      ctx.addIssue({ code: 'custom', message: 'Artifact path contains an unsafe segment' });
    }
    if (path.startsWith('/') || path.includes('\\') || /^[a-z]:/i.test(path)) {
      ctx.addIssue({ code: 'custom', message: 'Artifact path must be relative and portable' });
    }
    const reserved = new Set(['.git', 'node_modules']);
    if (
      segments.some((segment) => reserved.has(segment)) ||
      path === DEFT_APP_MANIFEST_FILENAME ||
      path === 'package.json'
    ) {
      ctx.addIssue({ code: 'custom', message: 'Artifact path is reserved' });
    }
  });

export const DeftAppModuleReferenceV0Schema = z.strictObject({
  module_id: AppIdSchema,
  version: AppSemverSchema,
  manifest_path: AppArtifactPathSchema,
  manifest_digest: AppDigestSchema,
});

export const DeftAppNavigationItemV0Schema = z.strictObject({
  key: z.string().min(1).max(48).regex(KEY_PATTERN, 'Navigation key must be lowercase snake_case'),
  label: boundedPlainText(APP_LIMITS.display_name_chars, 'Navigation label'),
  module_id: AppIdSchema,
  collection_key: z
    .string()
    .min(1)
    .max(48)
    .regex(KEY_PATTERN, 'Collection key must be lowercase snake_case'),
  view_key: z.string().min(1).max(48).regex(KEY_PATTERN, 'View key must be lowercase snake_case').optional(),
});

export const DeftAppManifestV0Schema = z
  .strictObject({
    schema_version: z.literal(DEFT_APP_MANIFEST_SCHEMA_VERSION),
    id: AppIdSchema,
    version: AppSemverSchema,
    name: boundedPlainText(APP_LIMITS.display_name_chars, 'App name'),
    description: boundedPlainText(APP_LIMITS.description_chars, 'App description').optional(),
    license: z
      .string()
      .min(1)
      .max(128)
      .regex(SPDX_EXPRESSION_PATTERN, 'License must be a bounded SPDX-style expression'),
    compatibility: z.strictObject({
      app_protocol: z.literal(DEFT_APP_PROTOCOL_VERSION),
    }),
    provenance: z
      .strictObject({
        source_repository: z.url().refine((value) => /^https?:\/\//.test(value), 'Repository must use HTTP(S)'),
        source_commit: z.string().regex(/^[a-f0-9]{7,64}$/, 'Commit must be lowercase hexadecimal'),
      })
      .optional(),
    modules: z.array(DeftAppModuleReferenceV0Schema).min(1).max(APP_LIMITS.artifacts_per_app),
    navigation: z
      .array(DeftAppNavigationItemV0Schema)
      .max(APP_LIMITS.navigation_items)
      .default([]),
  })
  .superRefine((manifest, ctx) => {
    const identities = new Set<string>();
    const moduleIds = new Set<string>();
    const paths = new Set<string>();
    for (const [index, module] of manifest.modules.entries()) {
      const identity = `${module.module_id}@${module.version}`;
      if (identities.has(identity)) {
        ctx.addIssue({ code: 'custom', path: ['modules', index], message: `Duplicate module identity ${identity}` });
      }
      if (moduleIds.has(module.module_id)) {
        ctx.addIssue({ code: 'custom', path: ['modules', index, 'module_id'], message: `Module id appears more than once: ${module.module_id}` });
      }
      if (paths.has(module.manifest_path)) {
        ctx.addIssue({ code: 'custom', path: ['modules', index, 'manifest_path'], message: 'Duplicate artifact path' });
      }
      identities.add(identity);
      moduleIds.add(module.module_id);
      paths.add(module.manifest_path);
    }
    const navigationKeys = new Set<string>();
    for (const [index, item] of manifest.navigation.entries()) {
      if (!moduleIds.has(item.module_id)) {
        ctx.addIssue({ code: 'custom', path: ['navigation', index, 'module_id'], message: 'Navigation references an undeclared module' });
      }
      if (navigationKeys.has(item.key)) {
        ctx.addIssue({ code: 'custom', path: ['navigation', index, 'key'], message: 'Navigation key must be unique' });
      }
      navigationKeys.add(item.key);
    }
  });

export const DeftAppPackageArtifactV0Schema = z.strictObject({
  path: AppArtifactPathSchema,
  media_type: z.literal(DEFT_MODULE_ARTIFACT_MEDIA_TYPE),
  content: z.string().max(APP_LIMITS.artifact_bytes),
  byte_length: z.number().int().nonnegative().max(APP_LIMITS.artifact_bytes),
  digest: AppDigestSchema,
});

export const DeftAppPackageV0Schema = z.strictObject({
  package_format: z.literal(DEFT_APP_PACKAGE_FORMAT),
  manifest: DeftAppManifestV0Schema,
  manifest_digest: AppDigestSchema,
  artifacts: z.array(DeftAppPackageArtifactV0Schema).min(1).max(APP_LIMITS.artifacts_per_app),
});

export type DeftAppManifestV0 = z.infer<typeof DeftAppManifestV0Schema>;
export type DeftAppManifestV0Input = z.input<typeof DeftAppManifestV0Schema>;
export type DeftAppPackageV0 = z.infer<typeof DeftAppPackageV0Schema>;
export type DeftAppPackageArtifactV0 = z.infer<typeof DeftAppPackageArtifactV0Schema>;
export type AppDigest = z.infer<typeof AppDigestSchema>;

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalizeJson(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value === 'object') {
    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) output[key.normalize('NFC')] = canonicalizeJson(item);
    }
    return output;
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

function assertByteLimit(value: string, limit: number, label: string): void {
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes > limit) throw new Error(`${label} exceeds ${limit} bytes`);
}

async function digestText(value: string): Promise<AppDigest> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable in this runtime');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return AppDigestSchema.parse(`sha256:${hex}`);
}

export function parseDeftAppManifest(value: unknown): DeftAppManifestV0 {
  const manifest = DeftAppManifestV0Schema.parse(value);
  assertByteLimit(JSON.stringify(manifest), APP_LIMITS.manifest_bytes, 'App manifest');
  return manifest;
}

export function parseDeftAppManifestJson(value: string): DeftAppManifestV0 {
  assertByteLimit(value, APP_LIMITS.manifest_bytes, 'App manifest');
  try {
    return parseDeftAppManifest(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('App manifest is not valid JSON', { cause: error });
    throw error;
  }
}

export function canonicalAppManifestJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(parseDeftAppManifest(value)));
}

export async function digestAppManifest(value: unknown): Promise<AppDigest> {
  return digestText(canonicalAppManifestJson(value));
}

export function getDeftAppManifestV0JsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Deft declarative app manifest v0',
    ...z.toJSONSchema(DeftAppManifestV0Schema, { target: 'draft-2020-12', unrepresentable: 'any' }),
  } as Record<string, unknown>;
}

type ModuleIdentity = { schema_version: string; id: string; version: string };

function parseModuleArtifactIdentity(value: unknown): ModuleIdentity {
  return z
    .strictObject({
      schema_version: z.union([z.literal('1'), z.literal('2')]),
      id: AppIdSchema,
      version: AppSemverSchema,
    })
    .passthrough()
    .parse(value);
}

export async function prepareModuleArtifact(input: {
  path: string;
  manifest: unknown;
}): Promise<DeftAppPackageArtifactV0> {
  const path = AppArtifactPathSchema.parse(input.path);
  parseModuleArtifactIdentity(input.manifest);
  const content = JSON.stringify(canonicalizeJson(input.manifest));
  assertByteLimit(content, APP_LIMITS.artifact_bytes, 'Module artifact');
  return DeftAppPackageArtifactV0Schema.parse({
    path,
    media_type: DEFT_MODULE_ARTIFACT_MEDIA_TYPE,
    content,
    byte_length: textEncoder.encode(content).byteLength,
    digest: await digestText(content),
  });
}

async function verifyPackage(packageValue: DeftAppPackageV0): Promise<void> {
  const artifacts = new Map<string, DeftAppPackageArtifactV0>();
  for (const artifact of packageValue.artifacts) {
    if (artifacts.has(artifact.path)) throw new Error(`Duplicate package artifact path ${artifact.path}`);
    assertByteLimit(artifact.content, APP_LIMITS.artifact_bytes, 'Module artifact');
    if (textEncoder.encode(artifact.content).byteLength !== artifact.byte_length) {
      throw new Error(`Artifact byte length mismatch for ${artifact.path}`);
    }
    if ((await digestText(artifact.content)) !== artifact.digest) {
      throw new Error(`Artifact digest mismatch for ${artifact.path}`);
    }
    artifacts.set(artifact.path, artifact);
  }
  if ((await digestAppManifest(packageValue.manifest)) !== packageValue.manifest_digest) {
    throw new Error('App manifest digest mismatch');
  }
  if (artifacts.size !== packageValue.manifest.modules.length) {
    throw new Error('Package must contain exactly the artifacts declared by the app manifest');
  }
  for (const moduleReference of packageValue.manifest.modules) {
    const artifact = artifacts.get(moduleReference.manifest_path);
    if (!artifact) throw new Error(`Missing module artifact ${moduleReference.manifest_path}`);
    if (artifact.digest !== moduleReference.manifest_digest) {
      throw new Error(`Manifest digest does not match artifact ${artifact.path}`);
    }
    let moduleManifest: unknown;
    try {
      moduleManifest = JSON.parse(artifact.content) as unknown;
    } catch (error) {
      throw new Error(`Module artifact ${artifact.path} is not valid JSON`, { cause: error });
    }
    const identity = parseModuleArtifactIdentity(moduleManifest);
    if (identity.id !== moduleReference.module_id || identity.version !== moduleReference.version) {
      throw new Error(`Module identity does not match app manifest for ${artifact.path}`);
    }
  }
}

export async function buildDeftAppPackage(input: {
  manifest: DeftAppManifestV0Input;
  artifacts: DeftAppPackageArtifactV0[];
}): Promise<{ package: DeftAppPackageV0; json: string; digest: AppDigest }> {
  const manifest = parseDeftAppManifest(input.manifest);
  const packageValue = DeftAppPackageV0Schema.parse({
    package_format: DEFT_APP_PACKAGE_FORMAT,
    manifest,
    manifest_digest: await digestAppManifest(manifest),
    artifacts: [...input.artifacts].sort((left, right) => left.path.localeCompare(right.path)),
  });
  await verifyPackage(packageValue);
  const json = JSON.stringify(canonicalizeJson(packageValue));
  assertByteLimit(json, APP_LIMITS.package_bytes, 'App package');
  return { package: packageValue, json, digest: await digestText(json) };
}

export async function verifyDeftAppPackageJson(
  value: string,
): Promise<{ package: DeftAppPackageV0; json: string; digest: AppDigest }> {
  assertByteLimit(value, APP_LIMITS.package_bytes, 'App package');
  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error('App package is not valid JSON', { cause: error });
  }
  const packageValue = DeftAppPackageV0Schema.parse(raw);
  await verifyPackage(packageValue);
  const json = JSON.stringify(canonicalizeJson(packageValue));
  return { package: packageValue, json, digest: await digestText(json) };
}
