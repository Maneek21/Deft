import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { APP_RUN_CONTRACT_VERSIONS, APP_RUN_LIMITS } from '@deft/shared';

export const APP_RUN_KEY_PURPOSES = [
  'run_encryption',
  'receipt_signing',
  'fingerprint',
] as const;

export type AppRunKeyPurpose = (typeof APP_RUN_KEY_PURPOSES)[number];

const KeyIdSchema = z
  .string()
  .min(1)
  .max(APP_RUN_LIMITS.key_id_chars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Key id must use portable identifier characters');

const KeyringSchema = z.object({
  current: KeyIdSchema,
  keys: z.record(KeyIdSchema, z.string()),
}).strict();

const KeyringDocumentSchema = z.object({
  schema_version: z.literal(APP_RUN_CONTRACT_VERSIONS.keyring),
  run_encryption: KeyringSchema,
  receipt_signing: KeyringSchema,
  fingerprint: KeyringSchema,
}).strict();

export class AppRunKeyringConfigError extends Error {
  readonly code = 'APP_RUN_KEYRING_INVALID';

  constructor() {
    super('App Run keyring configuration is invalid');
    this.name = 'AppRunKeyringConfigError';
  }
}

export type AppRunKeyRef = Readonly<{
  key_id: string;
  key: Buffer;
}>;

export interface AppRunKeyProvider {
  current(purpose: AppRunKeyPurpose): AppRunKeyRef;
  read(purpose: AppRunKeyPurpose, keyId: string): AppRunKeyRef | null;
  keyIds(purpose: AppRunKeyPurpose): readonly string[];
}

export type AppRunKeyReference = Readonly<{
  purpose: AppRunKeyPurpose;
  key_id: string;
}>;

export class AppRunKeyVersionUnavailableError extends Error {
  readonly code = 'APP_RUN_KEY_VERSION_UNAVAILABLE';

  constructor() {
    super('A referenced App Run key version is unavailable');
    this.name = 'AppRunKeyVersionUnavailableError';
  }
}

type ParsedRing = {
  current: string;
  keys: Map<string, Buffer>;
};

const MAX_KEYRING_DOCUMENT_BYTES = 32 * 1024;

function decodeCanonicalKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new AppRunKeyringConfigError();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    decoded.fill(0);
    throw new AppRunKeyringConfigError();
  }
  return decoded;
}

function parseRing(value: z.infer<typeof KeyringSchema>): ParsedRing {
  const entries = Object.entries(value.keys);
  if (
    entries.length === 0
    || entries.length > APP_RUN_LIMITS.keyring_entries
    || !Object.prototype.hasOwnProperty.call(value.keys, value.current)
  ) {
    throw new AppRunKeyringConfigError();
  }

  const keys = new Map<string, Buffer>();
  const seenMaterial: Buffer[] = [];
  try {
    for (const [keyId, encoded] of entries) {
      const key = decodeCanonicalKey(encoded);
      if (seenMaterial.some((candidate) => timingSafeEqual(candidate, key))) {
        key.fill(0);
        throw new AppRunKeyringConfigError();
      }
      keys.set(keyId, key);
      seenMaterial.push(key);
    }
    return { current: value.current, keys };
  } catch (error) {
    for (const key of keys.values()) key.fill(0);
    if (error instanceof AppRunKeyringConfigError) throw error;
    throw new AppRunKeyringConfigError();
  }
}

export class EnvironmentAppRunKeyProvider implements AppRunKeyProvider {
  readonly #rings: Record<AppRunKeyPurpose, ParsedRing>;
  #destroyed = false;

  constructor(rings: Record<AppRunKeyPurpose, ParsedRing>) {
    this.#rings = rings;
  }

  current(purpose: AppRunKeyPurpose): AppRunKeyRef {
    this.#assertActive();
    const ring = this.#rings[purpose];
    const key = ring.keys.get(ring.current);
    if (!key) throw new AppRunKeyringConfigError();
    return { key_id: ring.current, key: Buffer.from(key) };
  }

  read(purpose: AppRunKeyPurpose, keyId: string): AppRunKeyRef | null {
    this.#assertActive();
    const key = this.#rings[purpose].keys.get(keyId);
    return key ? { key_id: keyId, key: Buffer.from(key) } : null;
  }

  keyIds(purpose: AppRunKeyPurpose): readonly string[] {
    this.#assertActive();
    return Object.freeze([...this.#rings[purpose].keys.keys()]);
  }

  destroy(): void {
    if (this.#destroyed) return;
    for (const purpose of APP_RUN_KEY_PURPOSES) {
      for (const key of this.#rings[purpose].keys.values()) key.fill(0);
      this.#rings[purpose].keys.clear();
    }
    this.#destroyed = true;
  }

  #assertActive(): void {
    if (this.#destroyed) throw new AppRunKeyringConfigError();
  }
}

export function parseEnvironmentAppRunKeyrings(raw: string | undefined): EnvironmentAppRunKeyProvider {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_KEYRING_DOCUMENT_BYTES) {
    throw new AppRunKeyringConfigError();
  }

  let document: z.infer<typeof KeyringDocumentSchema>;
  try {
    document = KeyringDocumentSchema.parse(JSON.parse(raw));
  } catch {
    throw new AppRunKeyringConfigError();
  }

  const parsed = {} as Record<AppRunKeyPurpose, ParsedRing>;
  const allMaterial: Buffer[] = [];
  try {
    for (const purpose of APP_RUN_KEY_PURPOSES) {
      const ring = parseRing(document[purpose]);
      parsed[purpose] = ring;
      for (const key of ring.keys.values()) {
        if (allMaterial.some((candidate) => timingSafeEqual(candidate, key))) {
          throw new AppRunKeyringConfigError();
        }
        allMaterial.push(key);
      }
    }
    return new EnvironmentAppRunKeyProvider(parsed);
  } catch (error) {
    for (const ring of Object.values(parsed)) {
      for (const key of ring.keys.values()) key.fill(0);
    }
    if (error instanceof AppRunKeyringConfigError) throw error;
    throw new AppRunKeyringConfigError();
  }
}

export function validateAppRunKeyringEnvironment(
  enabled: boolean,
  raw: string | undefined,
): void {
  if (!enabled) return;
  const provider = parseEnvironmentAppRunKeyrings(raw);
  provider.destroy();
}

// Call this with the distinct key references inventoried from retained rows
// before enabling execution or accepting a keyring retirement.
export function assertAppRunReferencedKeysAvailable(
  provider: AppRunKeyProvider,
  references: readonly AppRunKeyReference[],
): void {
  for (const reference of references) {
    const key = provider.read(reference.purpose, reference.key_id);
    if (!key) throw new AppRunKeyVersionUnavailableError();
    key.key.fill(0);
  }
}
