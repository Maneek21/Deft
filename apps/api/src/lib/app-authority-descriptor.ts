import { digestResourceSyncDescriptorV2 } from '@deft/app-kit/core';
import { createAsyncAppAuthorityContentCache, type AppAuthorityContentScope } from './app-authority-content-cache.js';

export const APP_AUTHORITY_DESCRIPTOR_CACHE_ENTRIES = 32;
export const APP_AUTHORITY_DESCRIPTOR_CACHE_KEY_BYTES = 128 * 1024;

/** Pure Kit validation/digest reuse over complete freshly read descriptor JSON.
 * IDs or advertised digests never substitute for content. Current DB, owner,
 * admission, policy, epoch, configuration and deadline checks stay in callers.
 * The Kit digester parses/canonicalizes/encodes synchronously before its first
 * await, so it retains no caller JSON while WebCrypto completes. */
export function createAppAuthorityDescriptorDigester(digester = digestResourceSyncDescriptorV2) {
  const cache = createAsyncAppAuthorityContentCache<Awaited<ReturnType<typeof digester>>>({
    maxEntries: APP_AUTHORITY_DESCRIPTOR_CACHE_ENTRIES, maxBytes: 64 * 1024,
    maxContentBytes: APP_AUTHORITY_DESCRIPTOR_CACHE_KEY_BYTES,
  });
  return (raw: unknown, scope: AppAuthorityContentScope): ReturnType<typeof digester> =>
    cache(scope, raw, () => digester(raw));
}

export const digestAppAuthorityDescriptor = createAppAuthorityDescriptorDigester();
