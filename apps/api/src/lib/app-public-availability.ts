import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PublicAvailabilityPolicySchema, PUBLIC_AVAILABILITY_SCALAR_TYPES } from '@deft/app-kit';
import { parseSupportedDeftModuleManifest } from '@deft/shared/modules';
import type { AppRunKeyProvider } from './app-run-keyrings.js';

export const StoredPublicAvailabilityPolicySchema = PublicAvailabilityPolicySchema.extend({
  module_version_id: z.string().min(1).max(128),
});
export type PublicAvailabilityPolicy = z.infer<typeof StoredPublicAvailabilityPolicySchema>;
const scalarTypes = new Set(PUBLIC_AVAILABILITY_SCALAR_TYPES);
const instant = z.string().datetime({ offset: true });

/** Exact reviewed field selectors, never a generic public Module query. */
export function validatePublicAvailabilityPolicy(value: unknown, manifestValue: unknown,
  collectionKey: string, moduleVersionId: string): PublicAvailabilityPolicy {
  const policy = StoredPublicAvailabilityPolicySchema.parse(value);
  if (policy.module_version_id !== moduleVersionId) throw new Error('Public Module version changed');
  const manifest = parseSupportedDeftModuleManifest(manifestValue);
  const collection = manifest.collections.find(item => item.key === collectionKey);
  if (!collection) throw new Error('Public collection unavailable');
  for (const selector of policy.fields) {
    const field = collection.fields.find(item => item.key === selector);
    if (!field || !scalarTypes.has(field.type)) throw new Error('Invalid public scalar field');
  }
  if (collection.fields.find(item => item.key === policy.claim_deadline_field)?.type !== 'datetime') {
    throw new Error('Public claim deadline must be a datetime field');
  }
  return policy;
}

export function publicClaimDeadline(policy: PublicAvailabilityPolicy, value: unknown): Date | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = instant.safeParse((value as Record<string, unknown>)[policy.claim_deadline_field]);
  if (!parsed.success) return null;
  const deadline = new Date(parsed.data);
  return Number.isFinite(deadline.getTime()) ? deadline : null;
}

export function canClaimPublicAvailability(policy: PublicAvailabilityPolicy, data: unknown, now: Date): boolean {
  const deadline = publicClaimDeadline(policy, data);
  return !!deadline && Number.isFinite(now.getTime()) && deadline > now;
}

export function projectPublicAvailability(policy: PublicAvailabilityPolicy, value: unknown): Record<string, string | number | boolean> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const fields: Record<string, string | number | boolean> = {};
  for (const key of policy.fields) {
    const scalar = data[key];
    if ((typeof scalar === 'string' && scalar.length <= 256)
      || (typeof scalar === 'number' && Number.isFinite(scalar)) || typeof scalar === 'boolean') {
      fields[key] = scalar;
    } else return null;
  }
  return fields;
}

const CursorSchema = z.strictObject({
  schema_version: z.literal('deft.app_public_availability_cursor.v1'),
  endpoint_id: z.string().min(1).max(128), endpoint_epoch: z.number().int().positive(),
  review_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), module_version_id: z.string().min(1).max(128),
  after: z.string().min(1).max(256), expires_at: z.number().int().positive(),
});
export type AvailabilityCursor = z.infer<typeof CursorSchema>;
const cursorPurpose = Buffer.from('deft.app_public_availability_cursor.v1');
export function sealPublicAvailabilityCursor(keys: AppRunKeyProvider, value: AvailabilityCursor): string {
  const key = keys.current('run_encryption');
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.key, iv);
    cipher.setAAD(Buffer.concat([cursorPurpose, Buffer.from(`\0${key.key_id}`)]));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(CursorSchema.parse(value)), 'utf8'), cipher.final()]);
    return `${Buffer.from(key.key_id).toString('base64url')}.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
  } finally { key.key.fill(0); }
}
export function openPublicAvailabilityCursor(keys: AppRunKeyProvider, token: string): AvailabilityCursor {
  if (token.length > 2048) throw new Error('Invalid public cursor');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid public cursor');
  const version = Buffer.from(parts[0]!, 'base64url');
  if (version.toString('base64url') !== parts[0]) throw new Error('Invalid public cursor');
  const key = keys.read('run_encryption', version.toString('utf8'));
  if (!key) throw new Error('Invalid public cursor');
  try {
    const bytes = Buffer.from(parts[1]!, 'base64url');
    if (bytes.length < 29 || bytes.toString('base64url') !== parts[1]) throw new Error('Invalid public cursor');
    const decipher = createDecipheriv('aes-256-gcm', key.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.concat([cursorPurpose, Buffer.from(`\0${key.key_id}`)])); decipher.setAuthTag(bytes.subarray(12, 28));
    return CursorSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')));
  } finally { key.key.fill(0); }
}
