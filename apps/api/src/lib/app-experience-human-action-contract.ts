import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canonicalCapabilityJson } from '@deft/shared';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import { AppRunError } from './app-run-errors.js';

const scalar = z.union([z.string().max(16_384), z.number().finite(), z.boolean()]);
export const HumanActionPrepareSchema = z.strictObject({
  input: z.record(z.string().min(1).max(64), scalar),
  idempotency_key: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/),
});
export const HumanActionConfirmSchema = z.strictObject({
  ticket: z.string().min(1).max(100_000),
  expected_input_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export const HumanActionTicketSchema = HumanActionPrepareSchema.extend({
  org_id: z.string().uuid(), user_id: z.string().uuid(), sid: z.string().uuid(),
  session_id: z.string().uuid(), action_key: z.string().min(1).max(64),
  runtime_binding_id: z.string().uuid(), authority_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  input_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/), expires_at: z.string().datetime(),
}).strict();
export type HumanActionTicket = z.infer<typeof HumanActionTicketSchema>;
export function humanActionDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalCapabilityJson(JSON.parse(JSON.stringify(value)))).digest('hex')}`;
}
const DOMAIN = Buffer.from('deft.experience_human_action.ticket.v1');
/** Uses the established Run keyring, with a distinct authenticated purpose. */
export function sealHumanActionTicket(keys: AppRunKeyProvider, raw: HumanActionTicket): string {
  const value = HumanActionTicketSchema.parse(raw);
  const bytes = Buffer.from(canonicalCapabilityJson(value));
  if (bytes.length > 65_536 || Object.keys(value.input).length > 32) throw new AppRunError('APP_RUN_INPUT_INVALID');
  const ref = keys.current('run_encryption');
  try {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', ref.key, nonce);
    cipher.setAAD(Buffer.concat([DOMAIN, Buffer.from(`\0${ref.key_id}`)]));
    return [Buffer.from(ref.key_id).toString('base64url'), nonce.toString('base64url'), Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  } finally { ref.key.fill(0); }
}
export function openHumanActionTicket(keys: AppRunKeyProvider, token: string): HumanActionTicket {
  try {
    if (token.length > 100_000) throw Error('bounded');
    const parts = token.split('.'); if (parts.length !== 4) throw Error('shape');
    const [encodedId, nonce, ciphertext, tag] = parts;
    const idBytes = Buffer.from(encodedId!, 'base64url');
    if (idBytes.toString('base64url') !== encodedId || idBytes.length > 64) throw Error('key id');
    const id = idBytes.toString('utf8');
    const ref = keys.read('run_encryption', id!); if (!ref) throw Error('key');
    try {
      const decoded = [nonce!, ciphertext!, tag!].map(v => { const b = Buffer.from(v, 'base64url'); if (b.toString('base64url') !== v) throw Error('encoding'); return b; });
      if (decoded[0]!.length !== 12 || decoded[2]!.length !== 16 || decoded[1]!.length > 65_536) throw Error('bounded');
      const cipher = createDecipheriv('aes-256-gcm', ref.key, decoded[0]!);
      cipher.setAAD(Buffer.concat([DOMAIN, Buffer.from(`\0${id}`)])); cipher.setAuthTag(decoded[2]!);
      return HumanActionTicketSchema.parse(JSON.parse(Buffer.concat([cipher.update(decoded[1]!), cipher.final()]).toString('utf8')));
    } finally { ref.key.fill(0); }
  } catch { throw new AppRunError('APP_RUN_AUTHORIZATION_STALE'); }
}

/** Conservative synchronous fence after the last authority I/O. */
export function assertHumanActionTicketDeadline(expiresAt: string, hostNow: number, databaseSample: number, elapsedMs: number) {
  if (Date.parse(expiresAt) <= Math.max(hostNow, databaseSample + elapsedMs)) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
}
