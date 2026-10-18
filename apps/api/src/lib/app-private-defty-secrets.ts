import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonicalCapabilityJson } from '@deft/shared';
import { type AppRunKeyProvider, AppRunKeyVersionUnavailableError } from './app-run-keyrings.js';
import { AppRunSecretEnvelopeSchema, type AppRunSecretEnvelope } from './app-run-secrets.js';
import { PrivateDeftyPlaintext, PrivateDeftySecretContext } from './app-private-defty-contract.js';

function aad(context: PrivateDeftySecretContext): Buffer {
  return Buffer.from(canonicalCapabilityJson(['deft.private_defty.message_aad.v1', context]));
}

/** Only the locked owner viewer/private turn service may open these envelopes.
 * Generic Message/MCP surfaces use fixed content placeholders and never decrypt. */
export class PrivateDeftySecretService {
  constructor(private readonly keys: AppRunKeyProvider) {}

  seal(raw: PrivateDeftyPlaintext, rawContext: PrivateDeftySecretContext): AppRunSecretEnvelope {
    const context = PrivateDeftySecretContext.parse(rawContext);
    const value = PrivateDeftyPlaintext.parse(raw);
    if (value.role !== context.role) throw new TypeError('Private message role mismatch');
    const plaintext = Buffer.from(canonicalCapabilityJson(value));
    // Stored history is bounded by serialized plaintext bytes, including escapes.
    if (plaintext.length > 65_536) {
      plaintext.fill(0);
      throw new RangeError('Private message whole plaintext exceeds its bound');
    }
    const key = this.keys.current('run_encryption');
    const nonce = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      try {
        return AppRunSecretEnvelopeSchema.parse({
          schema_version: 'deft.secret.v1', algorithm: 'aes-256-gcm', key_version: key.key_id,
          nonce_b64: nonce.toString('base64'), ciphertext_b64: ciphertext.toString('base64'),
          auth_tag_b64: cipher.getAuthTag().toString('base64'),
        });
      } finally { ciphertext.fill(0); }
    } finally { plaintext.fill(0); nonce.fill(0); key.key.fill(0); }
  }

  open(raw: unknown, rawContext: PrivateDeftySecretContext): PrivateDeftyPlaintext {
    const context = PrivateDeftySecretContext.parse(rawContext);
    const envelope = AppRunSecretEnvelopeSchema.parse(raw);
    const key = this.keys.read('run_encryption', envelope.key_version);
    if (!key) throw new AppRunKeyVersionUnavailableError();
    const ciphertext = Buffer.from(envelope.ciphertext_b64, 'base64');
    let partial: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(envelope.nonce_b64, 'base64'));
      decipher.setAAD(aad(context));
      decipher.setAuthTag(Buffer.from(envelope.auth_tag_b64, 'base64'));
      partial = decipher.update(ciphertext);
      plaintext = Buffer.concat([partial, decipher.final()]);
      const value = PrivateDeftyPlaintext.parse(JSON.parse(plaintext.toString('utf8')));
      if (value.role !== context.role) throw new TypeError('Private message role mismatch');
      return value;
    } finally { ciphertext.fill(0); partial?.fill(0); plaintext?.fill(0); key.key.fill(0); }
  }
}
