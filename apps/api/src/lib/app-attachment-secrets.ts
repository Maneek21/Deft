import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canonicalAttachmentJson, RESOURCE_ATTACHMENT_LIMITS } from '@deft/app-kit';
import { AppRunKeyVersionUnavailableError, type AppRunKeyProvider } from './app-run-keyrings.js';

const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const contextSchema = z.strictObject({
  org_id: uuid, staging_id: uuid, resource_binding_id: uuid, checkpoint_id: uuid,
  generation: z.number().int().positive(), run_id: uuid, attempt_id: uuid,
  claim_token: uuid, reservation_sequence: z.number().int().positive(),
  fingerprint_key_version: z.string().min(1).max(64),
  parent_locator_hmac: digest, parent_revision_hmac: digest, attachment_key_hmac: digest,
});
const fingerprintScopeSchema = z.strictObject({ org_id: uuid, resource_binding_id: uuid, checkpoint_id: uuid });
export type AppAttachmentFingerprintScope = z.infer<typeof fingerprintScopeSchema>;
export type AppAttachmentSecretContext = z.infer<typeof contextSchema>;
export type AppAttachmentCiphertext = Readonly<{
  key_version: string; nonce_b64: string; auth_tag_b64: string; ciphertext: Buffer;
}>;
export type AppAttachmentFingerprint = Readonly<{ key_version: string; fingerprint: string }>;

/** Binary and metadata use distinct authenticated domains. Every identity is
 * supplied by locked host rows; a projection identity is introduced at link. */
export class AppAttachmentSecretService {
  constructor(private readonly keys: AppRunKeyProvider) {}

  sealBinary(bytes: Uint8Array, rawContext: AppAttachmentSecretContext): AppAttachmentCiphertext {
    if (bytes.byteLength > RESOURCE_ATTACHMENT_LIMITS.attachment_bytes) throw new TypeError('Attachment exceeds host limit');
    return this.#seal(bytes, rawContext, 'binary');
  }
  openBinary(value: AppAttachmentCiphertext, rawContext: AppAttachmentSecretContext): Buffer {
    if (value.ciphertext.length > RESOURCE_ATTACHMENT_LIMITS.attachment_bytes) throw new TypeError('Attachment exceeds host limit');
    return this.#open(value, rawContext, 'binary');
  }
  sealMetadata(value: unknown, rawContext: AppAttachmentSecretContext): AppAttachmentCiphertext {
    const bytes = Buffer.from(canonicalAttachmentJson(value));
    try {
      if (bytes.length > 8192) throw new TypeError('Attachment metadata exceeds host limit');
      return this.#seal(bytes, rawContext, 'metadata');
    } finally { bytes.fill(0); }
  }
  openMetadata(value: AppAttachmentCiphertext, rawContext: AppAttachmentSecretContext): unknown {
    if (value.ciphertext.length > 8192) throw new TypeError('Attachment metadata exceeds host limit');
    const bytes = this.#open(value, rawContext, 'metadata');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    finally { bytes.fill(0); }
  }
  sealMetadataJson(value: unknown, context: AppAttachmentSecretContext): Record<string, unknown> {
    const encrypted = this.sealMetadata(value, context);
    try { return { schema_version: 'deft.app_attachment_metadata.v1', key_version: encrypted.key_version,
      nonce_b64: encrypted.nonce_b64, auth_tag_b64: encrypted.auth_tag_b64,
      ciphertext_b64: encrypted.ciphertext.toString('base64') }; }
    finally { encrypted.ciphertext.fill(0); }
  }
  openMetadataJson(value: unknown, context: AppAttachmentSecretContext): unknown {
    const envelope = z.strictObject({ schema_version: z.literal('deft.app_attachment_metadata.v1'),
      key_version: z.string().min(1).max(64), nonce_b64: z.string().max(32), auth_tag_b64: z.string().max(32),
      ciphertext_b64: z.string().max(10924).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u) }).parse(value);
    const ciphertext = Buffer.from(envelope.ciphertext_b64, 'base64');
    try { return this.openMetadata({ ...envelope, ciphertext }, context); }
    finally { ciphertext.fill(0); }
  }
  fingerprint(domain: 'parent_locator' | 'parent_revision' | 'attachment_key' | 'content' | 'parent_body',
    value: Uint8Array, rawScope: AppAttachmentFingerprintScope, keyVersion?: string): AppAttachmentFingerprint {
    const scope = fingerprintScopeSchema.parse(rawScope);
    const key = keyVersion === undefined ? this.keys.current('fingerprint') : this.keys.read('fingerprint', keyVersion);
    if (!key) throw new AppRunKeyVersionUnavailableError();
    try {
      return Object.freeze({ key_version: key.key_id, fingerprint: createHmac('sha256', key.key)
        .update(canonicalAttachmentJson([`deft.app_attachment.${domain}.v1`, scope]))
        .update('\0').update(value).digest('hex') });
    } finally { key.key.fill(0); }
  }
  #seal(bytes: Uint8Array, rawContext: AppAttachmentSecretContext, domain: 'binary' | 'metadata'): AppAttachmentCiphertext {
    const context = contextSchema.parse(rawContext);
    const key = this.keys.current('run_encryption'); const nonce = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
      cipher.setAAD(Buffer.from(canonicalAttachmentJson([`deft.app_attachment.${domain}_aad.v1`, context])));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Object.freeze({ key_version: key.key_id, nonce_b64: nonce.toString('base64'),
        auth_tag_b64: cipher.getAuthTag().toString('base64'), ciphertext });
    } finally { key.key.fill(0); nonce.fill(0); }
  }
  #open(value: AppAttachmentCiphertext, rawContext: AppAttachmentSecretContext, domain: 'binary' | 'metadata'): Buffer {
    const context = contextSchema.parse(rawContext);
    const key = this.keys.read('run_encryption', value.key_version);
    if (!key) throw new AppRunKeyVersionUnavailableError();
    let partial: Buffer | undefined;
    try {
      const nonce = Buffer.from(value.nonce_b64, 'base64'); const tag = Buffer.from(value.auth_tag_b64, 'base64');
      if (nonce.length !== 12 || tag.length !== 16 || nonce.toString('base64') !== value.nonce_b64
        || tag.toString('base64') !== value.auth_tag_b64) throw new TypeError('Invalid attachment envelope');
      const decipher = createDecipheriv('aes-256-gcm', key.key, nonce);
      decipher.setAAD(Buffer.from(canonicalAttachmentJson([`deft.app_attachment.${domain}_aad.v1`, context])));
      decipher.setAuthTag(tag); partial = decipher.update(value.ciphertext);
      return Buffer.concat([partial, decipher.final()]);
    } finally { key.key.fill(0); partial?.fill(0); }
  }
}
