import { z } from 'zod';

export const PUBLIC_HMAC_AUDIENCE = 'deft.app_public_hmac.v1';
export const PublicHmacPolicySchema = z.strictObject({
  schema_version: z.literal(PUBLIC_HMAC_AUDIENCE), mode: z.literal('hmac_sha256'),
  max_clock_skew_seconds: z.literal(300),
});
export type PublicHmacSigningInput = Readonly<{
  slug: string; endpoint_epoch: number; key_id: string; timestamp: string;
  nonce: string; body: Uint8Array;
}>;
export function publicHmacClaimPath(slug: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(slug)) throw new Error('Invalid public slug');
  return `/api/public/apps/${slug}/claims`;
}
/** Eight ordered fields, each uint32 big-endian byte length then exact bytes.
 * Body bytes are never decoded, normalized, or JSON serialized. */
export function framePublicHmacClaim(input: PublicHmacSigningInput): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(input.endpoint_epoch) || input.endpoint_epoch < 1
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.key_id)
    || !/^(?:0|[1-9][0-9]{0,10})$/.test(input.timestamp)
    || !/^[a-f0-9]{64}$/.test(input.nonce) || input.body.byteLength > 8192) {
    throw new Error('Invalid public HMAC input');
  }
  const encoder = new TextEncoder();
  const fields: Uint8Array[] = [PUBLIC_HMAC_AUDIENCE, 'POST', publicHmacClaimPath(input.slug),
    String(input.endpoint_epoch), input.key_id, input.timestamp, input.nonce]
    .map(value => encoder.encode(value));
  fields.push(input.body);
  const output = new Uint8Array(fields.reduce((size, field) => size + 4 + field.byteLength, 0));
  const view = new DataView(output.buffer); let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength, false); offset += 4;
    output.set(field, offset); offset += field.byteLength;
  }
  return output;
}
/** Portable external signer. The host provisioning secret is base64url32 bytes;
 * callers decode it to key bytes and choose a fresh cryptographic32-byte nonce. */
export async function signPublicHmacClaim(secret: Uint8Array, input: PublicHmacSigningInput): Promise<Record<string, string>> {
  if (secret.byteLength !== 32) throw new Error('Invalid public HMAC key');
  const key = await crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, framePublicHmacClaim(input)));
  return {
    'x-deft-public-epoch': String(input.endpoint_epoch), 'x-deft-public-key-id': input.key_id,
    'x-deft-public-timestamp': input.timestamp, 'x-deft-public-nonce': input.nonce,
    'x-deft-public-signature': `sha256=${Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')}`,
  };
}
