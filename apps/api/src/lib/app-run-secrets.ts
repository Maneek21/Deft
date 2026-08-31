import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';

import {
  APP_RUN_CONTRACT_VERSIONS,
  APP_RUN_LIMITS,
  CapabilityJsonValueSchema,
  assertCapabilityJsonWithinBudget,
  canonicalCapabilityJson,
  type CapabilityJsonValue,
} from '@deft/shared';

import {
  type AppRunKeyProvider,
  type AppRunKeyRef,
} from './app-run-keyrings.js';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const ExactContextIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim())
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

export const AppRunSecretContextSchema = z.object({
  org_id: ExactContextIdSchema,
  run_id: ExactContextIdSchema,
  payload_kind: z.enum(['input', 'output']),
  attempt_id: ExactContextIdSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.payload_kind === 'input' && value.attempt_id !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['attempt_id'], message: 'Input payload cannot be attempt-scoped' });
  }
  if (value.payload_kind === 'output' && value.attempt_id === undefined) {
    ctx.addIssue({ code: 'custom', path: ['attempt_id'], message: 'Output payload must be attempt-scoped' });
  }
});
export type AppRunSecretContext = z.infer<typeof AppRunSecretContextSchema>;

function canonicalBase64Schema(maxChars: number) {
  return z.string().max(maxChars).refine((value) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
    return Buffer.from(value, 'base64').toString('base64') === value;
  }, 'Value must be canonical base64');
}

const MAX_CIPHERTEXT_BASE64_CHARS = 4 * Math.ceil(APP_RUN_LIMITS.output_bytes / 3);

export const AppRunSecretEnvelopeSchema = z.object({
  schema_version: z.literal(APP_RUN_CONTRACT_VERSIONS.secret_envelope),
  algorithm: z.literal(ALGORITHM),
  key_version: z.string()
    .min(1)
    .max(APP_RUN_LIMITS.key_id_chars)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  nonce_b64: canonicalBase64Schema(16),
  ciphertext_b64: canonicalBase64Schema(MAX_CIPHERTEXT_BASE64_CHARS),
  auth_tag_b64: canonicalBase64Schema(24),
}).strict().superRefine((value, ctx) => {
  if (Buffer.from(value.nonce_b64, 'base64').length !== NONCE_BYTES) {
    ctx.addIssue({ code: 'custom', path: ['nonce_b64'], message: 'Nonce must be 96 bits' });
  }
  if (Buffer.from(value.auth_tag_b64, 'base64').length !== AUTH_TAG_BYTES) {
    ctx.addIssue({ code: 'custom', path: ['auth_tag_b64'], message: 'Authentication tag must be 128 bits' });
  }
});
export type AppRunSecretEnvelope = z.infer<typeof AppRunSecretEnvelopeSchema>;

export const AppRunSecretSafeProjectionSchema = z.object({
  schema_version: z.literal(APP_RUN_CONTRACT_VERSIONS.secret_envelope),
  algorithm: z.literal(ALGORITHM),
  key_version: z.string()
    .min(1)
    .max(APP_RUN_LIMITS.key_id_chars)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  ciphertext_bytes: z.number().int().nonnegative().max(APP_RUN_LIMITS.output_bytes),
}).strict();
export type AppRunSecretSafeProjection = z.infer<typeof AppRunSecretSafeProjectionSchema>;

export type AppRunFingerprintPurpose = 'input' | 'idempotency';

function aad(context: AppRunSecretContext): Buffer {
  return Buffer.from(canonicalCapabilityJson([
    APP_RUN_CONTRACT_VERSIONS.secret_aad,
    context.org_id,
    context.run_id,
    context.payload_kind,
    context.attempt_id ?? null,
  ]), 'utf8');
}

function fingerprintDomain(purpose: AppRunFingerprintPurpose): Buffer {
  return Buffer.from(`deft.app_run.fingerprint.v1\u0000${purpose}\u0000`, 'utf8');
}

function receiptDomain(): Buffer {
  return Buffer.from(`${APP_RUN_CONTRACT_VERSIONS.receipt}\u0000`, 'utf8');
}

function hmac(key: Buffer, domain: Buffer, value: Buffer): string {
  try {
    return `hmac-sha256:${createHmac('sha256', key).update(domain).update(value).digest('hex')}`;
  } finally {
    key.fill(0);
  }
}

function exactSignatureBytes(value: string): Buffer | null {
  const match = /^hmac-sha256:([a-f0-9]{64})$/.exec(value);
  return match ? Buffer.from(match[1]!, 'hex') : null;
}

export class AppRunSecretService {
  constructor(private readonly keys: AppRunKeyProvider) {}

  sealJson(value: unknown, rawContext: AppRunSecretContext): AppRunSecretEnvelope {
    const context = AppRunSecretContextSchema.parse(rawContext);
    const limit = context.payload_kind === 'input'
      ? APP_RUN_LIMITS.input_bytes
      : APP_RUN_LIMITS.output_bytes;
    assertCapabilityJsonWithinBudget(value, limit);
    const plaintext = Buffer.from(canonicalCapabilityJson(value), 'utf8');
    const keyRef = this.keys.current('run_encryption');
    const nonce = randomBytes(NONCE_BYTES);
    let ciphertext: Buffer | null = null;
    let authTag: Buffer | null = null;
    try {
      const cipher = createCipheriv(ALGORITHM, keyRef.key, nonce, { authTagLength: AUTH_TAG_BYTES });
      cipher.setAAD(aad(context));
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      authTag = cipher.getAuthTag();
      const envelope = AppRunSecretEnvelopeSchema.parse({
        schema_version: APP_RUN_CONTRACT_VERSIONS.secret_envelope,
        algorithm: ALGORITHM,
        key_version: keyRef.key_id,
        nonce_b64: nonce.toString('base64'),
        ciphertext_b64: ciphertext.toString('base64'),
        auth_tag_b64: authTag.toString('base64'),
      });
      return Object.freeze(envelope);
    } finally {
      plaintext.fill(0);
      keyRef.key.fill(0);
      nonce.fill(0);
      ciphertext?.fill(0);
      authTag?.fill(0);
    }
  }

  openJson(rawEnvelope: unknown, rawContext: AppRunSecretContext): CapabilityJsonValue {
    const envelope = AppRunSecretEnvelopeSchema.parse(rawEnvelope);
    const context = AppRunSecretContextSchema.parse(rawContext);
    const keyRef = this.keys.read('run_encryption', envelope.key_version);
    if (!keyRef) throw new Error('APP_RUN_KEY_VERSION_UNAVAILABLE');

    const ciphertext = Buffer.from(envelope.ciphertext_b64, 'base64');
    const nonce = Buffer.from(envelope.nonce_b64, 'base64');
    const tag = Buffer.from(envelope.auth_tag_b64, 'base64');
    let plaintext: Buffer | null = null;
    try {
      const decipher = createDecipheriv(ALGORITHM, keyRef.key, nonce, { authTagLength: AUTH_TAG_BYTES });
      decipher.setAAD(aad(context));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const value = CapabilityJsonValueSchema.parse(JSON.parse(plaintext.toString('utf8')));
      const limit = context.payload_kind === 'input'
        ? APP_RUN_LIMITS.input_bytes
        : APP_RUN_LIMITS.output_bytes;
      assertCapabilityJsonWithinBudget(value, limit);
      return value;
    } finally {
      keyRef.key.fill(0);
      ciphertext.fill(0);
      nonce.fill(0);
      tag.fill(0);
      plaintext?.fill(0);
    }
  }

  safeProjection(rawEnvelope: unknown): AppRunSecretSafeProjection {
    const envelope = AppRunSecretEnvelopeSchema.parse(rawEnvelope);
    const ciphertext = Buffer.from(envelope.ciphertext_b64, 'base64');
    try {
      return Object.freeze(AppRunSecretSafeProjectionSchema.parse({
        schema_version: envelope.schema_version,
        algorithm: envelope.algorithm,
        key_version: envelope.key_version,
        ciphertext_bytes: ciphertext.length,
      }));
    } finally {
      ciphertext.fill(0);
    }
  }

  fingerprintJson(purpose: AppRunFingerprintPurpose, value: unknown): Readonly<{
    key_version: string;
    fingerprint: string;
  }> {
    assertCapabilityJsonWithinBudget(value, APP_RUN_LIMITS.input_bytes);
    const canonical = Buffer.from(canonicalCapabilityJson(value), 'utf8');
    return this.#fingerprintWith(this.keys.current('fingerprint'), purpose, canonical);
  }

  fingerprintJsonCandidates(purpose: AppRunFingerprintPurpose, value: unknown): readonly Readonly<{
    key_version: string;
    fingerprint: string;
  }>[] {
    assertCapabilityJsonWithinBudget(value, APP_RUN_LIMITS.input_bytes);
    const canonical = canonicalCapabilityJson(value);
    return Object.freeze(this.keys.keyIds('fingerprint').map((keyId) => {
      const keyRef = this.keys.read('fingerprint', keyId);
      if (!keyRef) throw new Error('APP_RUN_KEY_VERSION_UNAVAILABLE');
      return this.#fingerprintWith(keyRef, purpose, Buffer.from(canonical, 'utf8'));
    }));
  }

  fingerprintText(purpose: AppRunFingerprintPurpose, value: string): Readonly<{
    key_version: string;
    fingerprint: string;
  }> {
    const limit = purpose === 'idempotency'
      ? APP_RUN_LIMITS.idempotency_key_bytes
      : APP_RUN_LIMITS.input_bytes;
    if (Buffer.byteLength(value, 'utf8') > limit) {
      throw new TypeError(`App Run ${purpose} value exceeds ${limit} bytes`);
    }
    return this.#fingerprintWith(
      this.keys.current('fingerprint'),
      purpose,
      Buffer.from(value, 'utf8'),
    );
  }

  fingerprintTextCandidates(purpose: AppRunFingerprintPurpose, value: string): readonly Readonly<{
    key_version: string;
    fingerprint: string;
  }>[] {
    const limit = purpose === 'idempotency'
      ? APP_RUN_LIMITS.idempotency_key_bytes
      : APP_RUN_LIMITS.input_bytes;
    if (Buffer.byteLength(value, 'utf8') > limit) {
      throw new TypeError(`App Run ${purpose} value exceeds ${limit} bytes`);
    }
    return Object.freeze(this.keys.keyIds('fingerprint').map((keyId) => {
      const keyRef = this.keys.read('fingerprint', keyId);
      if (!keyRef) throw new Error('APP_RUN_KEY_VERSION_UNAVAILABLE');
      return this.#fingerprintWith(keyRef, purpose, Buffer.from(value, 'utf8'));
    }));
  }

  signReceipt(value: unknown): Readonly<{ key_version: string; signature_hmac: string }> {
    assertCapabilityJsonWithinBudget(value, APP_RUN_LIMITS.safe_receipt_envelope_bytes);
    const canonical = Buffer.from(canonicalCapabilityJson(value), 'utf8');
    const keyRef = this.keys.current('receipt_signing');
    try {
      return Object.freeze({
        key_version: keyRef.key_id,
        signature_hmac: hmac(keyRef.key, receiptDomain(), canonical),
      });
    } finally {
      canonical.fill(0);
    }
  }

  verifyReceipt(value: unknown, keyVersion: string, signature: string): boolean {
    try {
      assertCapabilityJsonWithinBudget(value, APP_RUN_LIMITS.safe_receipt_envelope_bytes);
      const keyRef = this.keys.read('receipt_signing', keyVersion);
      if (!keyRef) return false;
      const canonical = Buffer.from(canonicalCapabilityJson(value), 'utf8');
      let expected: string;
      try {
        expected = hmac(keyRef.key, receiptDomain(), canonical);
      } finally {
        canonical.fill(0);
      }
      const expectedBytes = exactSignatureBytes(expected);
      const actualBytes = exactSignatureBytes(signature);
      try {
        return Boolean(
          expectedBytes
          && actualBytes
          && expectedBytes.length === actualBytes.length
          && timingSafeEqual(expectedBytes, actualBytes),
        );
      } finally {
        expectedBytes?.fill(0);
        actualBytes?.fill(0);
      }
    } catch {
      return false;
    }
  }

  #fingerprintWith(
    keyRef: AppRunKeyRef,
    purpose: AppRunFingerprintPurpose,
    value: Buffer,
  ): Readonly<{ key_version: string; fingerprint: string }> {
    try {
      return Object.freeze({
        key_version: keyRef.key_id,
        fingerprint: hmac(keyRef.key, fingerprintDomain(purpose), value),
      });
    } finally {
      value.fill(0);
    }
  }
}
