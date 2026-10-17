import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assertCapabilityJsonWithinBudget, canonicalCapabilityJson, type CapabilityJsonValue } from '@deft/shared';
import { z } from 'zod';
import { type AppRunKeyProvider, AppRunKeyVersionUnavailableError } from './app-run-keyrings.js';
import { AppRunSecretEnvelopeSchema, type AppRunSecretEnvelope } from './app-run-secrets.js';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const JSON_BUDGET_BYTES = 512 * 1024;
const ContextIdSchema = z.string().min(1).max(256)
  .refine((value) => value === value.trim(), 'Identifier must be trimmed')
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), 'Identifier contains control characters');

export const EmailMailboxCryptoContextSchema = z.strictObject({
  org_id: ContextIdSchema,
  owner_user_id: ContextIdSchema,
  account_id: ContextIdSchema,
    kind: z.enum(['summary', 'provider_source', 'checkpoint', 'draft', 'template', 'signature', 'timer', 'rule', 'presentation_cache', 'provider_draft', 'operation', 'attachment']),
  record_id: ContextIdSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type EmailMailboxCryptoContext = z.infer<typeof EmailMailboxCryptoContextSchema>;

function associatedData(context: EmailMailboxCryptoContext): Buffer {
  return Buffer.from(canonicalCapabilityJson(['deft.email.mailbox.v1', context]), 'utf8');
}

function validateJson(value: unknown): asserts value is CapabilityJsonValue {
  assertCapabilityJsonWithinBudget(value, JSON_BUDGET_BYTES);
  if (Buffer.byteLength(canonicalCapabilityJson(value), 'utf8') > JSON_BUDGET_BYTES) {
    throw new TypeError('Email mailbox JSON exceeds the 512 KiB limit');
  }
}

/** Encrypts mailbox metadata under retained App Run encryption keys. Context must
 * be derived from the current server-side row binding by the caller. */
export class EmailMailboxCrypto {
  constructor(private readonly keys: AppRunKeyProvider) {}

  seal(value: unknown, rawContext: EmailMailboxCryptoContext): AppRunSecretEnvelope {
    const context = EmailMailboxCryptoContextSchema.parse(rawContext);
    validateJson(value);
    const plaintext = Buffer.from(canonicalCapabilityJson(value), 'utf8');
    const key = this.keys.current('run_encryption');
    const nonce = randomBytes(NONCE_BYTES);
    const aad = associatedData(context);
    let ciphertext: Buffer | undefined;
    let tag: Buffer | undefined;
    try {
      const cipher = createCipheriv(ALGORITHM, key.key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad);
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      tag = cipher.getAuthTag();
      return Object.freeze(AppRunSecretEnvelopeSchema.parse({
        schema_version: 'deft.secret.v1',
        algorithm: ALGORITHM,
        key_version: key.key_id,
        nonce_b64: nonce.toString('base64'),
        ciphertext_b64: ciphertext.toString('base64'),
        auth_tag_b64: tag.toString('base64'),
      }));
    } finally {
      plaintext.fill(0);
      key.key.fill(0);
      nonce.fill(0);
      aad.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
    }
  }

  open(envelopeValue: unknown, rawContext: EmailMailboxCryptoContext): CapabilityJsonValue {
    const context = EmailMailboxCryptoContextSchema.parse(rawContext);
    const envelope = AppRunSecretEnvelopeSchema.parse(envelopeValue);
    const key = this.keys.read('run_encryption', envelope.key_version);
    if (!key) throw new AppRunKeyVersionUnavailableError();
    const nonce = Buffer.from(envelope.nonce_b64, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext_b64, 'base64');
    const tag = Buffer.from(envelope.auth_tag_b64, 'base64');
    const aad = associatedData(context);
    let partial: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv(ALGORITHM, key.key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      partial = decipher.update(ciphertext);
      plaintext = Buffer.concat([partial, decipher.final()]);
      if (plaintext.byteLength > JSON_BUDGET_BYTES) throw new TypeError('Email mailbox JSON exceeds the 512 KiB limit');
      const value: unknown = JSON.parse(plaintext.toString('utf8'));
      validateJson(value);
      return value;
    } finally {
      key.key.fill(0);
      nonce.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
      aad.fill(0);
      partial?.fill(0);
      plaintext?.fill(0);
    }
  }
}
