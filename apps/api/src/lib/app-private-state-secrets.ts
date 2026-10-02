import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canonicalCapabilityJson } from '@deft/shared';
import { PrivateStateContextSchema, type PrivateStateContext } from './app-private-state-contract.js';
import { AppRunKeyVersionUnavailableError } from './app-run-keyrings.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
const Envelope = z.strictObject({ schema_version: z.literal('deft.private_state.secret.v1'),
  key_version: z.string().min(1).max(128), nonce: z.string().max(32), ciphertext: z.string().max(22000), tag: z.string().max(32) });
const aad = (context: PrivateStateContext) => Buffer.from(canonicalCapabilityJson(['deft.private_state.aad.v1', PrivateStateContextSchema.parse(context)]));
export class AppPrivateStateSecrets {
  constructor(private readonly keys: AppRunKeyProvider) {}
  seal(context: PrivateStateContext, value: Record<string, string | number | boolean>) {
    const plain = Buffer.from(JSON.stringify(value));
    const key = this.keys.current('run_encryption'); const nonce = randomBytes(12);
    try {
      if (plain.length > 16384) throw new Error('Private state exceeds its limit');
      const cipher = createCipheriv('aes-256-gcm', key.key, nonce); cipher.setAAD(aad(context));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      try { return Envelope.parse({ schema_version: 'deft.private_state.secret.v1', key_version: key.key_id,
        nonce: nonce.toString('base64'), ciphertext: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') }); }
      finally { encrypted.fill(0); }
    } finally { plain.fill(0); key.key.fill(0); }
  }
  open(context: PrivateStateContext, value: unknown): unknown {
    const envelope = Envelope.parse(value); const key = this.keys.read('run_encryption', envelope.key_version);
    if (!key) throw new AppRunKeyVersionUnavailableError();
    const encrypted = Buffer.from(envelope.ciphertext, 'base64'); let plain: Buffer | undefined; let partial: Buffer | undefined;
    try {
      const nonce = Buffer.from(envelope.nonce, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16 || encrypted.length > 16384) throw new Error('Invalid private state envelope');
      const cipher = createDecipheriv('aes-256-gcm', key.key, nonce); cipher.setAAD(aad(context)); cipher.setAuthTag(tag);
      partial = cipher.update(encrypted); plain = Buffer.concat([partial, cipher.final()]);
      return JSON.parse(plain.toString('utf8')) as unknown;
    } finally { key.key.fill(0); encrypted.fill(0); partial?.fill(0); plain?.fill(0); }
  }
}
