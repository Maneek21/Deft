import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalCapabilityJson } from '@deft/shared';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const cursorSchema = z.strictObject({ version: z.literal(1), key_version: z.string().min(1).max(128),
  after: z.string().uuid(), expires_at: z.number().int().positive(), identity_scope: digest,
  checkpoint_scope: digest, query_fields_scope: digest });
export type PrivateSearchCursor = z.infer<typeof cursorSchema>;
const purpose = 'deft.owner_private_search.cursor.v1\0';
export function privateSearchDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex')}`;
}
export function sealPrivateSearchCursor(keys: AppRunKeyProvider,
  value: Omit<PrivateSearchCursor, 'version' | 'key_version'>): string {
  const key = keys.current('fingerprint');
  try {
    const payload = Buffer.from(canonicalCapabilityJson(cursorSchema.parse({ ...value,
      version: 1, key_version: key.key_id }))).toString('base64url');
    return `${payload}.${createHmac('sha256', key.key).update(purpose).update(payload).digest('base64url')}`;
  } finally { key.key.fill(0); }
}
export function openPrivateSearchCursor(keys: AppRunKeyProvider, token: string): PrivateSearchCursor {
  const parts = token.split('.');
  if (token.length > 2048 || parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/u.test(p))) throw Error('Invalid search cursor');
  const payload = parts[0]!;
  const raw = Buffer.from(payload, 'base64url');
  if (raw.toString('base64url') !== payload) throw Error('Invalid search cursor');
  const value = cursorSchema.parse(JSON.parse(raw.toString('utf8')));
  const key = keys.read('fingerprint', value.key_version);
  if (!key) throw Error('Invalid search cursor');
  try {
    const mac = Buffer.from(parts[1]!, 'base64url');
    const expected = createHmac('sha256', key.key).update(purpose).update(payload).digest();
    if (mac.toString('base64url') !== parts[1] || mac.length !== expected.length || !timingSafeEqual(mac, expected)) throw Error('Invalid search cursor');
  } finally { key.key.fill(0); }
  return value;
}
