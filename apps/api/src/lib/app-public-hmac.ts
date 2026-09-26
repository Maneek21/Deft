import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { framePublicHmacClaim, publicHmacClaimPath, PublicHmacPolicySchema } from '@deft/app-kit';
import { appPublicHmacKeys, appPublicHmacNonces, appPublicEndpoints } from '@deft/db/schema';
import type { db } from './db.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Endpoint = typeof appPublicEndpoints.$inferSelect;
export type PublicSignedRequest = Readonly<{ method: string; pathname: string; search: string; headers: Record<string, string | undefined> }>;
export class PublicSignatureInvalid extends Error {}
export class PublicSignatureReplay extends Error {}
export class PublicSignatureCapacity extends Error {}
async function signedClock(tx: Tx, timestamp: number): Promise<Date> {
  const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const now = new Date((result.rows[0] as { now: Date | string }).now);
  if (!Number.isFinite(now.getTime()) || Math.abs(now.getTime() - timestamp * 1000) > 300_000) throw new PublicSignatureInvalid();
  return now;
}
export async function assertPublicSignatureFresh(tx: Tx, verified: Awaited<ReturnType<typeof verifyPublicSignature>>) {
  if (verified) await signedClock(tx, verified.timestamp);
}
const purpose = 'deft.app_public_hmac_secret.v1';
const aad = (org: string, endpoint: string, id: string, encryptionId: string) =>
  Buffer.from(JSON.stringify([purpose, org, endpoint, id, encryptionId]));

export function sealPublicHmacSecret(keys: AppRunKeyProvider, org: string, endpoint: string, id: string, secret: Buffer): string {
  const key = keys.current('run_encryption');
  try {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key.key, iv);
    cipher.setAAD(aad(org, endpoint, id, key.key_id));
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
    return `${Buffer.from(key.key_id).toString('base64url')}.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
  } finally { key.key.fill(0); }
}
export function openPublicHmacSecret(keys: AppRunKeyProvider, org: string, endpoint: string, id: string, sealed: string): Buffer {
  const parts = sealed.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Public signing key unavailable');
  const version = Buffer.from(parts[0]!, 'base64url'); const bytes = Buffer.from(parts[1]!, 'base64url');
  if (version.toString('base64url') !== parts[0] || bytes.toString('base64url') !== parts[1] || bytes.length !== 60) throw new Error('Public signing key unavailable');
  const key = keys.read('run_encryption', version.toString('utf8'));
  if (!key) throw new Error('Public signing key unavailable');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, bytes.subarray(0, 12));
    decipher.setAAD(aad(org, endpoint, id, key.key_id)); decipher.setAuthTag(bytes.subarray(12, 28));
    const result = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    if (result.length !== 32) { result.fill(0); throw new Error('Public signing key unavailable'); }
    return result;
  } finally { key.key.fill(0); }
}
export function publicAuthenticationPolicy(endpoint: Pick<Endpoint, 'authentication_policy' | 'hmac_key_id'>) {
  if (endpoint.authentication_policy == null) {
    if (endpoint.hmac_key_id != null) throw new PublicSignatureInvalid();
    return null;
  }
  if (!endpoint.hmac_key_id) throw new PublicSignatureInvalid();
  return PublicHmacPolicySchema.parse(endpoint.authentication_policy);
}
export async function verifyPublicSignature(tx: Tx, keys: AppRunKeyProvider, endpoint: Endpoint,
  slug: string, body: Uint8Array, request?: PublicSignedRequest) {
  if (!publicAuthenticationPolicy(endpoint)) return null;
  if (!request || request.method !== 'POST' || request.pathname !== publicHmacClaimPath(slug) || request.search) throw new PublicSignatureInvalid();
  const values = request.headers;
  const epoch = values['x-deft-public-epoch']; const keyId = values['x-deft-public-key-id'];
  const timestamp = values['x-deft-public-timestamp']; const nonce = values['x-deft-public-nonce'];
  const signature = values['x-deft-public-signature'];
  if (epoch !== String(endpoint.endpoint_epoch) || keyId !== endpoint.hmac_key_id
    || !timestamp || !/^(?:0|[1-9][0-9]{0,10})$/.test(timestamp) || !nonce || !/^[a-f0-9]{64}$/.test(nonce)
    || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw new PublicSignatureInvalid();
  const [stored] = await tx.select().from(appPublicHmacKeys).where(and(eq(appPublicHmacKeys.org_id, endpoint.org_id),
    eq(appPublicHmacKeys.endpoint_id, endpoint.id), eq(appPublicHmacKeys.id, keyId))).limit(1);
  if (!stored) throw new Error('Public signing key unavailable');
  const secret = openPublicHmacSecret(keys, endpoint.org_id, endpoint.id, keyId, stored.sealed_secret);
  try {
    const actual = createHmac('sha256', secret).update(framePublicHmacClaim({ slug, endpoint_epoch: endpoint.endpoint_epoch,
      key_id: keyId, timestamp, nonce, body })).digest();
    if (!timingSafeEqual(actual, Buffer.from(signature.slice(7), 'hex'))) throw new PublicSignatureInvalid();
  } finally { secret.fill(0); }
  await signedClock(tx, Number(timestamp));
  return { keyId, nonceDigest: `sha256:${createHash('sha256').update(nonce).digest('hex')}`, timestamp: Number(timestamp) };
}
/** Only successful canonical outcomes spend a nonce. Called after record and
 * uniqueness waits, under the same App admission mutex as claim/replay. */
export async function acceptPublicSignature(tx: Tx, endpoint: Endpoint, verified: Awaited<ReturnType<typeof verifyPublicSignature>>) {
  if (!verified) return;
  const now = await signedClock(tx, verified.timestamp);
  const clock = now.toISOString().slice(0, -1);
  await tx.execute(sql`DELETE FROM app_public_hmac_nonces WHERE id IN (
    SELECT id FROM app_public_hmac_nonces WHERE org_id=${endpoint.org_id} AND endpoint_id=${endpoint.id}
      AND expires_at < ${clock}::timestamp ORDER BY expires_at,id LIMIT 100)`);
  const duplicate = await tx.select({ id: appPublicHmacNonces.id }).from(appPublicHmacNonces).where(and(
    eq(appPublicHmacNonces.org_id, endpoint.org_id), eq(appPublicHmacNonces.endpoint_id, endpoint.id),
    eq(appPublicHmacNonces.key_id, verified.keyId), eq(appPublicHmacNonces.nonce_digest, verified.nonceDigest))).limit(1);
  if (duplicate.length) throw new PublicSignatureReplay();
  const live = await tx.execute(sql`SELECT id FROM app_public_hmac_nonces WHERE org_id=${endpoint.org_id}
    AND endpoint_id=${endpoint.id} AND expires_at >= ${clock}::timestamp LIMIT 1001`);
  if (live.rows.length >= 1000) throw new PublicSignatureCapacity();
  const [inserted] = await tx.insert(appPublicHmacNonces).values({ id: randomUUID(), org_id: endpoint.org_id,
    endpoint_id: endpoint.id, key_id: verified.keyId, nonce_digest: verified.nonceDigest,
    signed_at: new Date(verified.timestamp * 1000), accepted_at: now,
    expires_at: new Date((verified.timestamp + 300) * 1000) }).onConflictDoNothing().returning({ id: appPublicHmacNonces.id });
  if (!inserted) throw new PublicSignatureReplay();
}
