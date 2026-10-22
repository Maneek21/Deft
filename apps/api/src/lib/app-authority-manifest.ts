import { parseAttachmentAppManifest } from '@deft/app-kit/core';
import { boundedAppAuthorityJsonKey } from './app-authority-json-key.js';

export const APP_AUTHORITY_MANIFEST_CACHE_ENTRIES = 8;
export const APP_AUTHORITY_MANIFEST_CACHE_KEY_BYTES = 131072;

/** Pure Host-owned parse reuse only. No version ID, advertised digest, grant,
 * current state, expiry or authorization decision is a cache key or value. */
export function createAppAuthorityManifestParser(parser = parseAttachmentAppManifest) {
  const cache = new Map<string, ReturnType<typeof parseAttachmentAppManifest>>();
  return (raw: unknown): ReturnType<typeof parseAttachmentAppManifest> => {
    const key = boundedAppAuthorityJsonKey(raw, APP_AUTHORITY_MANIFEST_CACHE_KEY_BYTES), cached = key === undefined ? undefined : cache.get(key);
    if (cached) {
      cache.delete(key!); cache.set(key!, cached);
      return structuredClone(cached);
    }
    // Invalid manifests never enter the cache. Keep the parsed object private,
    // including on the first call, so callers cannot poison a later result.
    const owned = structuredClone(parser(raw));
    if (key !== undefined) {
      cache.set(key, owned);
      if (cache.size > APP_AUTHORITY_MANIFEST_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    }
    return structuredClone(owned);
  };
}

export const parseAppAuthorityManifest = createAppAuthorityManifestParser();
