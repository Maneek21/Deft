import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { canonicalCapabilityJson } from '@deft/shared';
import { PrivateStateContextSchema, PrivateStateSourceReferenceSchema, type PrivateStateContext } from './app-private-state-contract.js';
import { AppRunKeyVersionUnavailableError } from './app-run-keyrings.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
const scalars = z.record(z.string().max(48), z.union([z.string().max(4096), z.number().finite(), z.boolean()]));
export const StoredPrivateSourceSchema = PrivateStateSourceReferenceSchema.extend({ resource_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  scope: z.string().regex(/^sha256:[a-f0-9]{64}$/), record: z.strictObject({ revision: z.string().min(1).max(1024), label: z.string().max(200),
    data: scalars.refine(value => Object.keys(value).length <= 32 && !Object.keys(value).some(key => ['__proto__','constructor','prototype'].includes(key))),
    provider_source: z.record(z.string().max(128),z.json()).refine(value => Object.keys(value).length <= 16
      && !Object.keys(value).some(key => ['__proto__','constructor','prototype'].includes(key)) && Buffer.byteLength(JSON.stringify(value)) <= 8192) }) });
export type StoredPrivateSource = z.infer<typeof StoredPrivateSourceSchema>;
const Stored = z.strictObject({ value: scalars, sources: z.array(StoredPrivateSourceSchema).min(1).max(4)
  .refine(sources => new Set(sources.map(source => source.field)).size === sources.length) });
const Envelope = z.strictObject({ schema_version: z.enum(['deft.private_state.secret.v1','deft.private_state.secret.v2']),
  key_version: z.string().min(1).max(128), nonce: z.string().max(32), ciphertext: z.string().max(22000), tag: z.string().max(32) });
const aad = (context: PrivateStateContext, version: string) => Buffer.from(canonicalCapabilityJson([
  version === 'deft.private_state.secret.v1' ? 'deft.private_state.aad.v1' : 'deft.private_state.aad.v2', PrivateStateContextSchema.parse(context)]));
const storedValue = (value: Record<string,string|number|boolean>, sources: readonly StoredPrivateSource[]) => sources.length ? Stored.parse({value,sources}) : value;
export function privateStateStoredBytes(value: Record<string,string|number|boolean>, sources: readonly StoredPrivateSource[]) {
  return Buffer.byteLength(JSON.stringify(storedValue(value,sources)));
}
export class AppPrivateStateSecrets {
  constructor(private readonly keys: AppRunKeyProvider) {}
  seal(context: PrivateStateContext, value: Record<string, string | number | boolean>, sources: readonly StoredPrivateSource[] = []) {
    const version = sources.length ? 'deft.private_state.secret.v2' : 'deft.private_state.secret.v1';
    const plain = Buffer.from(JSON.stringify(storedValue(value,sources)));
    const key = this.keys.current('run_encryption'); const nonce = randomBytes(12);
    try {
      if (plain.length > 16384) throw new Error('Private state exceeds its limit');
      const cipher = createCipheriv('aes-256-gcm', key.key, nonce); cipher.setAAD(aad(context,version));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      try { return Envelope.parse({ schema_version: version, key_version: key.key_id,
        nonce: nonce.toString('base64'), ciphertext: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') }); }
      finally { encrypted.fill(0); }
    } finally { plain.fill(0); key.key.fill(0); }
  }
  open(context: PrivateStateContext, value: unknown): unknown { return this.openState(context,value).value; }
  openState(context: PrivateStateContext, value: unknown): {value: unknown; sources: StoredPrivateSource[]} {
    const envelope = Envelope.parse(value); const key = this.keys.read('run_encryption', envelope.key_version);
    if (!key) throw new AppRunKeyVersionUnavailableError();
    const encrypted = Buffer.from(envelope.ciphertext, 'base64'); let plain: Buffer | undefined; let partial: Buffer | undefined;
    try {
      const nonce = Buffer.from(envelope.nonce, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16 || encrypted.length > 16384) throw new Error('Invalid private state envelope');
      const cipher = createDecipheriv('aes-256-gcm', key.key, nonce); cipher.setAAD(aad(context,envelope.schema_version)); cipher.setAuthTag(tag);
      partial = cipher.update(encrypted); plain = Buffer.concat([partial, cipher.final()]);
      const decoded: unknown = JSON.parse(plain.toString('utf8'));
      // Only the authenticated ciphertext wrapper selects v2. A v1 Worker value
      // with version-shaped fields always remains a normal scalar draft.
      return envelope.schema_version === 'deft.private_state.secret.v2' ? Stored.parse(decoded) : {value: decoded,sources:[]};
    } finally { key.key.fill(0); encrypted.fill(0); partial?.fill(0); plain?.fill(0); }
  }
}
