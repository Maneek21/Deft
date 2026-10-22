import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { boundedAppAuthorityJsonKey } from './app-authority-json-key.js';

export type AppAuthorityContentScope = Readonly<{ org_id: string; app_version_id: string }>;
type CacheLimits = Readonly<{ maxEntries?: number; maxBytes?: number; maxContentBytes?: number }>;
const contentKey = (scope: AppAuthorityContentScope, evidence: unknown, maxContentBytes: number) => {
  const content = boundedAppAuthorityJsonKey(evidence, maxContentBytes);
  return content !== undefined && typeof scope.org_id === 'string' && scope.org_id.length > 0
    && typeof scope.app_version_id === 'string' && scope.app_version_id.length > 0
    ? createHash('sha256').update(JSON.stringify([scope.org_id, scope.app_version_id])).update('\0').update(content).digest('hex')
    : undefined;
};

/** Reuse pure validation/reconstruction of exact, freshly read content only.
 * This is not authority: callers must read every current row/set and enforce
 * membership, revocation, expiry, epochs, configuration and boundary admission
 * on every invocation. Include all reconstruction inputs in evidence; an ID or
 * advertised digest alone is never evidence of immutable content. No mutable
 * decision, transaction, provider response or executable callback is retained.
 * Scope and content bytes are both hashed, so identical JSON in a different
 * organization/version cannot share a validated value. Results are private. */
export function createAppAuthorityContentCache<Value>(limits: CacheLimits = {}) {
  const maxEntries = limits.maxEntries ?? 32, maxBytes = limits.maxBytes ?? 16 * 1024 * 1024;
  const maxContentBytes = limits.maxContentBytes ?? 2 * 1024 * 1024;
  const cache = new Map<string, { value: Value; bytes: number }>();
  let bytes = 0;
  return (scope: AppAuthorityContentScope, evidence: unknown, reconstruct: () => Value): Value => {
    const key = contentKey(scope, evidence, maxContentBytes);
    const cached = key === undefined ? undefined : cache.get(key);
    if (cached) {
      cache.delete(key!); cache.set(key!, cached);
      return structuredClone(cached.value);
    }
    // A throw never enters the cache, and the first returned tree cannot mutate
    // the retained validated fact any more than a subsequent returned tree can.
    const value = reconstruct();
    if (key === undefined) return value;
    const owned = structuredClone(value), entryBytes = Buffer.byteLength(key) + serialize(owned).byteLength;
    if (entryBytes <= maxBytes && maxEntries > 0) {
      cache.set(key, { value: owned, bytes: entryBytes }); bytes += entryBytes;
      while (cache.size > maxEntries || bytes > maxBytes) {
        const oldest = cache.keys().next().value!, entry = cache.get(oldest)!;
        cache.delete(oldest); bytes -= entry.bytes;
      }
    }
    return value;
  };
}

/** Async pure reconstruction has the same bounds and isolation. It retains no
 * promise or in-flight admission, and failed/changed-in-flight evidence cannot
 * seed a validated fact. Concurrent misses may recompute independently. */
export function createAsyncAppAuthorityContentCache<Value>(limits: CacheLimits = {}) {
  const maxEntries = limits.maxEntries ?? 32, maxBytes = limits.maxBytes ?? 16 * 1024 * 1024;
  const maxContentBytes = limits.maxContentBytes ?? 2 * 1024 * 1024;
  const cache = new Map<string, { value: Value; bytes: number }>();
  let bytes = 0;
  return async (scope: AppAuthorityContentScope, evidence: unknown, reconstruct: () => Promise<Value>): Promise<Value> => {
    const key = contentKey(scope, evidence, maxContentBytes), cached = key === undefined ? undefined : cache.get(key);
    if (cached) { cache.delete(key!); cache.set(key!, cached); return structuredClone(cached.value); }
    const value = await reconstruct();
    if (key === undefined || contentKey(scope, evidence, maxContentBytes) !== key) return value;
    const owned = structuredClone(value), entryBytes = Buffer.byteLength(key) + serialize(owned).byteLength;
    if (entryBytes <= maxBytes && maxEntries > 0) {
      const concurrent = cache.get(key);
      if (concurrent) { cache.delete(key); bytes -= concurrent.bytes; }
      cache.set(key, { value: owned, bytes: entryBytes }); bytes += entryBytes;
      while (cache.size > maxEntries || bytes > maxBytes) {
        const oldest = cache.keys().next().value!, entry = cache.get(oldest)!;
        cache.delete(oldest); bytes -= entry.bytes;
      }
    }
    return value;
  };
}
