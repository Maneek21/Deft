import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalCapabilityJson } from '@deft/shared';
import type { AppRunKeyProvider } from './app-run-keyrings.js';

export const EXPOSURE_VERSION = 'deft.experience_resource_exposure.v1' as const;
export const STATE_EXPOSURE_VERSION = 'deft.experience_resource_exposure.v3' as const;
export const SEARCH_EXPOSURE_VERSION = 'deft.experience_resource_exposure.v2' as const;
export const PAYLOAD_VERSION = 'deft.experience_resource_payload.v1' as const;
export const EXPOSURE_LIMITS = Object.freeze({ review_ms: 300_000, exposure_ms: 900_000,
  items: 10, fields: 32, field_chars: 48, string_chars: 4096, label_chars: 200,
  envelope_bytes: 60 * 1024, token_chars: 24 * 1024 });
const uuid = z.string().uuid();
const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ResourceRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ schema_version: z.literal('deft.experience_resource_request.v1'), operation: z.literal('list_summary'),
    limit: z.number().int().min(1).max(10).optional(), cursor: z.string().min(1).max(2048).optional() }),
  z.strictObject({ schema_version: z.literal('deft.experience_resource_request.v1'), operation: z.literal('read_one'), record_id: uuid }),
  z.strictObject({ schema_version: z.literal('deft.experience_resource_request.v2'), operation: z.literal('search'),
    query: z.string().min(1).max(200).refine(value => value.trim().length > 0),
    field_keys: z.array(z.string().min(1).max(48)).min(1).max(32).refine(value => new Set(value).size === value.length),
    cursor: z.string().min(1).max(2048).optional() }),
]);
export const ExposureResourceSchema = z.strictObject({ resource_key: key, binding_id: uuid,
  registration_id: uuid, runtime_epoch: epoch.refine(v => v > 0), descriptor_digest: digest,
  resource_type: z.string().min(1).max(128), label: z.string().max(200),
  allowed_operations: z.union([z.tuple([z.literal('list_summary'), z.literal('read_one')]),
    z.tuple([z.literal('list_summary'), z.literal('read_one'), z.literal('search')])]),
  allowed_fields: z.array(z.string().min(1).max(48)).min(1).max(32)
    .refine(v => new Set(v).size === v.length && v.every((s, i) => !i || v[i - 1]! < s)),
  consent_expires_at: timestamp });
export const ExposureSnapshotSchema = z.strictObject({ schema_version: z.enum([EXPOSURE_VERSION, SEARCH_EXPOSURE_VERSION, STATE_EXPOSURE_VERSION]),
  payload_policy_version: z.literal(PAYLOAD_VERSION), visibility: z.literal('user_private'),
  destination: z.literal('verified_installed_experience_worker'),
  org_id: uuid, owner_user_id: uuid, owner_label: z.string().max(200), web_session_id: uuid,
  experience_session_id: uuid, installation_id: uuid, app_version_id: uuid,
  app_name: z.string().max(200), app_version: z.string().max(128),
  package_digest: digest, manifest_digest: digest, grant_snapshot_id: uuid, grant_snapshot_digest: digest,
  lifecycle_epoch: epoch, grant_epoch: epoch, experience_key: key, experience_label: z.string().max(200),
  artifact_digest: digest, bridge_version: z.literal('deft.experience_bridge.v1'), renderer_version: z.literal('deft.trusted_renderer.v1'),
  resources: z.array(ExposureResourceSchema).max(16)
    .refine(v => v.every((r, i) => !i || v[i - 1]!.resource_key < r.resource_key)),
  private_state: z.array(z.strictObject({ key, label: z.string().max(128), declaration_digest: digest,
    allowed_operations: z.tuple([z.literal('list'), z.literal('read'), z.literal('put'), z.literal('delete')]),
    max_record_bytes: z.number().int().min(1).max(16384), max_records: z.number().int().min(1).max(32),
    max_total_bytes: z.number().int().min(1).max(131072), retention_days: z.number().int().min(1).max(30) })).min(1).max(16).optional(),
  limits: z.strictObject({ items: z.literal(10), fields: z.literal(32), string_chars: z.literal(4096), envelope_bytes: z.literal(61440) }),
  prepared_at: timestamp, review_expires_at: timestamp, web_access_expires_at: timestamp, expires_at: timestamp }).refine(value => value.schema_version === STATE_EXPOSURE_VERSION
  ? !!value.private_state?.length
  : value.private_state === undefined && value.resources.length > 0 && (value.schema_version === EXPOSURE_VERSION
    ? value.resources.every(resource => resource.allowed_operations.length === 2)
    : value.resources.some(resource => resource.allowed_operations.length === 3)), 'Exposure operation/version mismatch');
export type ExposureSnapshot = z.infer<typeof ExposureSnapshotSchema>;
export const ExposureAcceptSchema = z.strictObject({ review_token: z.string().min(1).max(EXPOSURE_LIMITS.token_chars),
  review_digest: digest, accept_exposure: z.literal(true) });
export const ExposureCursorSchema = z.strictObject({ schema_version: z.literal('deft.experience_resource_cursor.v1'),
  identity_scope_digest: digest, checkpoint_scope_digest: digest, after: uuid, expires_at: timestamp });

export const ExposureSearchCursorSchema = z.strictObject({ schema_version: z.literal('deft.experience_resource_search_cursor.v1'),
  identity_scope_digest: digest, checkpoint_scope_digest: digest, query_fields_scope_digest: digest,
  after: uuid, expires_at: timestamp });

export class ExperienceExposureError extends Error {
  constructor(readonly code: 'APP_EXPERIENCE_RESOURCE_UNAVAILABLE' | 'APP_EXPERIENCE_EXPOSURE_STALE' | 'APP_EXPERIENCE_EXPOSURE_DISABLED'
    | 'RESOURCE_PAYLOAD_TOO_LARGE' | 'RESOURCE_CURSOR_STALE', readonly status: 404 | 409 | 413 | 503) {
    super(code === 'RESOURCE_PAYLOAD_TOO_LARGE' ? 'Experience resource payload exceeds the reviewed limits'
      : code === 'RESOURCE_CURSOR_STALE' ? 'Saved records changed; restart the list'
        : code === 'APP_EXPERIENCE_EXPOSURE_STALE' ? 'Experience exposure review changed; review again' : 'Experience resource unavailable');
  }
}
export const exposureUnavailable = () => new ExperienceExposureError('APP_EXPERIENCE_RESOURCE_UNAVAILABLE', 404);
export const exposureStale = () => new ExperienceExposureError('APP_EXPERIENCE_EXPOSURE_STALE', 409);
export function exposureDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalCapabilityJson(JSON.parse(JSON.stringify(value)))).digest('hex')}`;
}

/** Purpose domains are disjoint from resource/Run cursors and credentials. */
export function sealExposureToken(keys: AppRunKeyProvider, purpose: 'review' | 'durable_review' | 'cursor' | 'search_cursor', snapshot: unknown): string {
  const ref = keys.current('fingerprint');
  try {
    const payload = Buffer.from(canonicalCapabilityJson({ key_version: ref.key_id, value: snapshot })).toString('base64url');
    const mac = createHmac('sha256', ref.key).update(`deft.experience_exposure.${purpose}.v1\0`).update(payload).digest('base64url');
    const token = `${payload}.${mac}`;
    if (token.length > (purpose.endsWith('review') ? EXPOSURE_LIMITS.token_chars : 2048)) throw exposureUnavailable();
    return token;
  } finally { ref.key.fill(0); }
}
export function openExposureToken(keys: AppRunKeyProvider, purpose: 'review' | 'durable_review' | 'cursor' | 'search_cursor', token: string): unknown {
  try {
    if (token.length > (purpose.endsWith('review') ? EXPOSURE_LIMITS.token_chars : 2048)) throw exposureUnavailable();
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every(s => /^[A-Za-z0-9_-]+$/.test(s))) throw exposureUnavailable();
    const bytes = Buffer.from(parts[0]!, 'base64url');
    if (bytes.toString('base64url') !== parts[0]) throw exposureUnavailable();
    const parsed = z.strictObject({ key_version: z.string().min(1).max(128), value: z.unknown() }).parse(JSON.parse(bytes.toString('utf8')));
    const ref = keys.read('fingerprint', parsed.key_version);
    if (!ref) throw exposureUnavailable();
    try {
      const mac = Buffer.from(parts[1]!, 'base64url');
      const expected = createHmac('sha256', ref.key).update(`deft.experience_exposure.${purpose}.v1\0`).update(parts[0]!).digest();
      if (mac.length !== expected.length || mac.toString('base64url') !== parts[1] || !timingSafeEqual(mac, expected)) throw exposureUnavailable();
      return parsed.value;
    } finally { ref.key.fill(0); }
  } catch { throw exposureUnavailable(); }
}

export function exposurePayloadData(data: Record<string, string | number | boolean>, fields: readonly string[]) {
  if (fields.length > 32 || Object.keys(data).some(field => !fields.includes(field))) throw exposureUnavailable();
  for (const [field, value] of Object.entries(data)) {
    if (field.length > 48 || (typeof value === 'string' && value.length > 4096)
      || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new ExperienceExposureError('RESOURCE_PAYLOAD_TOO_LARGE', 413);
    }
  }
  return data;
}
