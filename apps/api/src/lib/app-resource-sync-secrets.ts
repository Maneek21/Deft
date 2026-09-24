import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { assertCapabilityJsonWithinBudget, canonicalCapabilityJson, type CapabilityJsonValue } from '@deft/shared';
import { type AppRunKeyProvider, AppRunKeyVersionUnavailableError } from './app-run-keyrings.js';
import { AppRunSecretEnvelopeSchema, type AppRunSecretEnvelope } from './app-run-secrets.js';

// Candidate owner primitive; no channel or store is activated by this module.
// Callers derive every context field from locked host rows, never provider data.
const identity = z.string().uuid();
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = { org_id: identity, resource_binding_id: identity, checkpoint_id: identity };
const locatorContext = z.strictObject(base);
const secretContext = z.discriminatedUnion('payload_kind', [
  z.strictObject({ ...base, payload_kind: z.literal('cursor'),
    generation: sequence.refine((value) => value > 0), cursor_sequence: sequence }),
  z.strictObject({ ...base, payload_kind: z.literal('projection'),
    generation: sequence.refine((value) => value > 0), projection_id: identity,
    slot: z.enum(['provider_id', 'record']) }),
]);
export type AppResourceSyncSecretContext = z.infer<typeof secretContext>;
export type AppResourceSyncLocatorContext = z.infer<typeof locatorContext>;
export type AppResourceSyncFingerprint = Readonly<{ key_version: string; fingerprint: string }>;
const providerId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const cursor = z.string().min(1).max(2_048).refine((value) =>
  !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.byteLength(value, 'utf8') <= 2_048
  && Buffer.from(value, 'utf8').toString('utf8') === value).nullable();

function aad(context: AppResourceSyncSecretContext): Buffer {
  return Buffer.from(canonicalCapabilityJson(['deft.resource_sync.secret_aad.v1', context]));
}
function validatePayload(value: unknown, context: AppResourceSyncSecretContext): asserts value is CapabilityJsonValue {
  if (context.payload_kind === 'cursor') cursor.parse(value);
  if (context.payload_kind === 'projection' && context.slot === 'provider_id') providerId.parse(value);
  // Cursor JSON escapes can exceed its raw UTF-8 length; both ceilings apply.
  assertCapabilityJsonWithinBudget(value, context.payload_kind === 'cursor' ? 16_384 : 524_288);
}

/** Reuses the retained keyring, with domains disjoint from Run secrets and
 * fingerprints. Database owners must include these references in key-retirement
 * checks and hold their checkpoint lock while locating, applying or rekeying. */
export class AppResourceSyncSecretService {
  constructor(private readonly keys: AppRunKeyProvider) {}

  sealJson(value: unknown, rawContext: AppResourceSyncSecretContext): AppRunSecretEnvelope {
    const context = secretContext.parse(rawContext);
    validatePayload(value, context);
    const plaintext = Buffer.from(canonicalCapabilityJson(value));
    const key = this.keys.current('run_encryption');
    const nonce = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      try {
        return Object.freeze(AppRunSecretEnvelopeSchema.parse({
          schema_version: 'deft.secret.v1', algorithm: 'aes-256-gcm', key_version: key.key_id,
          nonce_b64: nonce.toString('base64'), ciphertext_b64: ciphertext.toString('base64'),
          auth_tag_b64: cipher.getAuthTag().toString('base64'),
        }));
      } finally { ciphertext.fill(0); }
    } finally { plaintext.fill(0); key.key.fill(0); nonce.fill(0); }
  }

  openJson(value: unknown, rawContext: AppResourceSyncSecretContext): CapabilityJsonValue {
    const context = secretContext.parse(rawContext);
    const envelope = AppRunSecretEnvelopeSchema.parse(value);
    const key = this.keys.read('run_encryption', envelope.key_version);
    if (!key) throw new AppRunKeyVersionUnavailableError();
    const ciphertext = Buffer.from(envelope.ciphertext_b64, 'base64');
    let plaintext: Buffer | undefined;
    let partial: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key.key,
        Buffer.from(envelope.nonce_b64, 'base64'));
      decipher.setAAD(aad(context));
      decipher.setAuthTag(Buffer.from(envelope.auth_tag_b64, 'base64'));
      partial = decipher.update(ciphertext);
      plaintext = Buffer.concat([partial, decipher.final()]);
      const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
      validatePayload(parsed, context);
      return parsed;
    } finally { key.key.fill(0); ciphertext.fill(0); plaintext?.fill(0); partial?.fill(0); }
  }

  locator(providerResourceId: string, rawContext: AppResourceSyncLocatorContext): AppResourceSyncFingerprint {
    return this.fingerprint('locator', [locatorContext.parse(rawContext), providerId.parse(providerResourceId)]);
  }

  /** Pass all distinct locator key versions currently retained by this checkpoint.
   * Missing keys deny lookup even when no candidate matched, preventing a new
   * UUID from silently duplicating a row written under a lost key. */
  locatorCandidates(providerResourceId: string, rawContext: AppResourceSyncLocatorContext,
    requiredKeyVersions: readonly string[]): readonly AppResourceSyncFingerprint[] {
    const value = [locatorContext.parse(rawContext), providerId.parse(providerResourceId)];
    const keyIds = this.assertLocatorKeyVersionsAvailable(requiredKeyVersions);
    return Object.freeze(keyIds.map((id) => this.fingerprint('locator', value, id)));
  }

  /** A page with zero items still cannot advance a cursor when any retained
   * projection's locator key is absent. Call under the checkpoint lock. */
  assertLocatorKeyVersionsAvailable(requiredKeyVersions: readonly string[]): readonly string[] {
    const keyIds = this.keys.keyIds('fingerprint');
    if (requiredKeyVersions.some((id) => !keyIds.includes(id))) {
      throw new AppRunKeyVersionUnavailableError();
    }
    return keyIds;
  }

  cursorFingerprint(value: string | null,
    rawContext: Extract<AppResourceSyncSecretContext, { payload_kind: 'cursor' }>,
    keyVersion?: string): AppResourceSyncFingerprint {
    const context = secretContext.parse(rawContext);
    if (context.payload_kind !== 'cursor') throw new TypeError('Cursor context required');
    return this.fingerprint('cursor', [context, cursor.parse(value)], keyVersion);
  }

  private fingerprint(purpose: 'locator' | 'cursor', value: CapabilityJsonValue,
    keyVersion?: string): AppResourceSyncFingerprint {
    const key = keyVersion === undefined ? this.keys.current('fingerprint') : this.keys.read('fingerprint', keyVersion);
    if (!key) throw new AppRunKeyVersionUnavailableError();
    try {
      const fingerprint = createHmac('sha256', key.key)
        .update(`deft.resource_sync.${purpose}.v1\0`).update(canonicalCapabilityJson(value)).digest('hex');
      return Object.freeze({ key_version: key.key_id, fingerprint: `hmac-sha256:${fingerprint}` });
    } finally { key.key.fill(0); }
  }
}
