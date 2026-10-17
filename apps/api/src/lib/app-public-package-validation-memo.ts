import { createHash } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { verifyDeftAppPackageJson } from '@deft/app-kit';

// Only deterministic public package validation is retained. Current authority,
// manifest selection, digest comparisons and feature gates remain at the caller.
export function createPublicPackageValidationMemo<T>(
  validate: (raw: string) => Promise<T>,
  limits = { entries: 8, bytes: 2 * 1024 * 1024, entryBytes: 512 * 1024 },
) {
  const bounds = { ...limits };
  const retained = new Map<string, Buffer>();
  let bytes = 0;
  return async (raw: string): Promise<T> => {
    // Preserve the underlying verifier's runtime precondition even on a hit.
    if (!globalThis.crypto?.subtle) return validate(raw);
    const key = createHash('sha256').update(raw).digest('hex');
    const existing = retained.get(key);
    if (existing) return deserialize(existing) as T;
    const result = await validate(raw);
    const encoded = serialize(result);
    if (encoded.length <= bounds.entryBytes && encoded.length <= bounds.bytes && bounds.entries > 0) {
      // Concurrent misses may settle for the same public input; replace its bytes.
      const prior = retained.get(key);
      if (prior) { bytes -= prior.length; retained.delete(key); }
      while (retained.size >= bounds.entries || bytes + encoded.length > bounds.bytes) {
        const oldest = retained.keys().next().value;
        if (oldest === undefined) break;
        bytes -= retained.get(oldest)!.length;
        retained.delete(oldest);
      }
      retained.set(key, encoded);
      bytes += encoded.length;
    }
    return result;
  };
}

export const verifiedPublicPackageJson = createPublicPackageValidationMemo(verifyDeftAppPackageJson);
