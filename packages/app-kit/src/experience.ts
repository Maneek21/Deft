import { z } from 'zod';

/** Closed, candidate App Protocol v3 Experience artifact. The Kit dispatcher
 * owns package integration; this leaf never executes author bytes on install. */
export const DEFT_EXPERIENCE_BUNDLE_VERSION = 'deft.experience_bundle.v1' as const;
export const DEFT_EXPERIENCE_BRIDGE_VERSION = 'deft.experience_bridge.v1' as const;
export const DEFT_EXPERIENCE_RENDERER_VERSION = 'deft.trusted_renderer.v1' as const;
export const DEFT_EXPERIENCE_MEDIA_TYPE = 'application/vnd.deft.experience+json' as const;

const MAX_BUNDLE_BYTES = 128 * 1024;
const MAX_WORKER_BYTES = 64 * 1024;
const MAX_REFERENCES = 16;
const encoder = new TextEncoder();
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const keySchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);

const experiencePathSchema = z.string().min(1).max(240)
  .regex(/^experiences\/[a-z0-9][a-z0-9._/-]*\.json$/)
  .refine((path) => !path.split('/').some((part) =>
    part === '' || part === '.' || part === '..' || part === '.git' || part === 'node_modules'));

const uniqueKeys = z.array(keySchema).max(MAX_REFERENCES)
  .refine((items) => new Set(items).size === items.length, 'Keys must be unique')
  .refine((items) => items.every((item, index) => index === 0 || items[index - 1]! < item),
    'Keys must be sorted');

export const DeftExperienceReferenceSchema = z.strictObject({
  artifact_path: experiencePathSchema,
  artifact_digest: digestSchema,
  bridge_version: z.literal(DEFT_EXPERIENCE_BRIDGE_VERSION),
  renderer_version: z.literal(DEFT_EXPERIENCE_RENDERER_VERSION),
});
export type DeftExperienceReference = z.infer<typeof DeftExperienceReferenceSchema>;

const bundleFields = {
  worker_source: z.string().min(1), entry_view: keySchema,
  resource_keys: uniqueKeys, action_keys: uniqueKeys,
};
const bundleV1 = z.strictObject({ schema_version: z.literal(DEFT_EXPERIENCE_BUNDLE_VERSION), ...bundleFields });
const bundleV2 = z.strictObject({ schema_version: z.literal('deft.experience_bundle.v2'), ...bundleFields,
  search_resource_keys: uniqueKeys.refine(keys => keys.length > 0),
}).refine(value => value.search_resource_keys.every(key => value.resource_keys.includes(key)),
  'Search keys must be declared resource keys');
export const DeftExperienceBundleSchema = z.union([bundleV1, bundleV2]).superRefine((value, ctx) => {
  if (encoder.encode(value.worker_source).byteLength > MAX_WORKER_BYTES) {
    ctx.addIssue({ code: 'custom', path: ['worker_source'], message: 'Worker source exceeds 64 KiB' });
  }
});
export type DeftExperienceBundle = z.infer<typeof DeftExperienceBundleSchema>;

export const DeftExperienceArtifactSchema = z.strictObject({
  path: experiencePathSchema,
  media_type: z.literal(DEFT_EXPERIENCE_MEDIA_TYPE),
  content: z.string(),
  byte_length: z.number().int().nonnegative().max(MAX_BUNDLE_BYTES),
  digest: digestSchema,
});
export type DeftExperienceArtifact = z.infer<typeof DeftExperienceArtifactSchema>;

function canonicalBundleJson(input: unknown): string {
  const bundle = DeftExperienceBundleSchema.parse(input);
  const content = JSON.stringify({
    schema_version: bundle.schema_version,
    worker_source: bundle.worker_source,
    entry_view: bundle.entry_view,
    resource_keys: bundle.resource_keys,
    action_keys: bundle.action_keys,
    ...(bundle.schema_version === 'deft.experience_bundle.v2' ? { search_resource_keys: bundle.search_resource_keys } : {}),
  });
  if (encoder.encode(content).byteLength > MAX_BUNDLE_BYTES) {
    throw new Error('Experience bundle exceeds 128 KiB');
  }
  return content;
}

async function sha256(content: string): Promise<string> {
  const bytes = encoder.encode(content);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareDeftExperienceArtifact(
  path: string, bundle: unknown,
): Promise<DeftExperienceArtifact> {
  const parsedPath = experiencePathSchema.parse(path);
  const content = canonicalBundleJson(bundle);
  return DeftExperienceArtifactSchema.parse({
    path: parsedPath, media_type: DEFT_EXPERIENCE_MEDIA_TYPE,
    content, byte_length: encoder.encode(content).byteLength, digest: await sha256(content),
  });
}

export async function verifyDeftExperienceArtifact(
  referenceInput: unknown, artifactInput: unknown,
): Promise<DeftExperienceBundle> {
  const reference = DeftExperienceReferenceSchema.parse(referenceInput);
  const artifact = DeftExperienceArtifactSchema.parse(artifactInput);
  if (reference.artifact_path !== artifact.path || reference.artifact_digest !== artifact.digest) {
    throw new Error('Experience artifact reference mismatch');
  }
  if (encoder.encode(artifact.content).byteLength !== artifact.byte_length) {
    throw new Error('Experience artifact byte length mismatch');
  }
  let raw: unknown;
  try { raw = JSON.parse(artifact.content) as unknown; }
  catch { throw new Error('Experience artifact is not JSON'); }
  const canonical = canonicalBundleJson(raw);
  if (canonical !== artifact.content || await sha256(canonical) !== artifact.digest) {
    throw new Error('Experience artifact digest or canonical bytes mismatch');
  }
  return DeftExperienceBundleSchema.parse(raw);
}
