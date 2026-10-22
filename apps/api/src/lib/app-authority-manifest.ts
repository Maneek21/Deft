import { parseAttachmentAppManifest } from '@deft/app-kit/core';
import { createAppAuthorityContentCache, type AppAuthorityContentScope } from './app-authority-content-cache.js';

export const APP_AUTHORITY_MANIFEST_CACHE_ENTRIES = 8;
export const APP_AUTHORITY_MANIFEST_CACHE_KEY_BYTES = 2 * 1024 * 1024;

/** Pure Host-owned parse reuse by organization, version and exact content.
 * No advertised digest can stand in for content, and no authority is cached.
 * A caller without a known org/version parses normally without retaining it. */
export function createAppAuthorityManifestParser(parser = parseAttachmentAppManifest) {
  const cache = createAppAuthorityContentCache<ReturnType<typeof parseAttachmentAppManifest>>({
    maxEntries: APP_AUTHORITY_MANIFEST_CACHE_ENTRIES, maxContentBytes: APP_AUTHORITY_MANIFEST_CACHE_KEY_BYTES,
  });
  return (raw: unknown, scope?: AppAuthorityContentScope): ReturnType<typeof parseAttachmentAppManifest> => {
    return scope ? cache(scope, raw, () => parser(raw)) : parser(raw);
  };
}

export const parseAppAuthorityManifest = createAppAuthorityManifestParser();
