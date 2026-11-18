import { createAppResourceSyncLimits, type AppResourceSyncLimitsOptions } from './app-resource-sync-limits.js';

/** Independent pre-authentication budgets for host owner reads and management.
 * The shared limiter keys on the trusted client address, never on forwarding
 * headers from a peer that is not a configured trusted proxy.
 * Admitted work retains its concurrency slot until downstream unwinds, including
 * after an abort, so cancelling a client cannot multiply ongoing database work.
 */
export function createAppResourcePrivateReadLimits(options: AppResourceSyncLimitsOptions = {}) {
  return createAppResourceSyncLimits({ globalPerMinute: 600, peerPerMinute: 60,
    globalConcurrent: 16, peerConcurrent: 4, maxPeerBuckets: 1024, ...options });
}

export function createAppResourceSyncManagementLimits(options: AppResourceSyncLimitsOptions = {}) {
  return createAppResourceSyncLimits({ globalPerMinute: 120, peerPerMinute: 20,
    globalConcurrent: 8, peerConcurrent: 2, maxPeerBuckets: 1024, ...options });
}

export const appResourcePrivateReadLimits = createAppResourcePrivateReadLimits();
export const appResourceSyncManagementLimits = createAppResourceSyncManagementLimits();
