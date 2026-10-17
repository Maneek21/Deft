import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';

type Bucket = { window_start: number; generation: number; count: number; in_flight: number };
const authenticatedHeartbeats = new WeakSet<Context>();
const isHeartbeat = (c: Context) => c.req.method === 'POST'
  && c.req.path === '/api/app-resource-sync-channel/v3/heartbeat';

/** Only the channel handler may mark a renewal after current authority succeeds.
 * Headers and request payloads cannot nominate this internal admission fact. */
export function markAuthenticatedResourceSyncHeartbeat(c: Context): void {
  if (isHeartbeat(c)) authenticatedHeartbeats.add(c);
}
export type AppResourceSyncLimitsOptions = Readonly<{
  /** Only the socket peer or an explicitly trusted host-proxy result. */
  peerAddress?: (c: Context) => string | null | undefined;
  now?: () => number;
  globalPerMinute?: number;
  peerPerMinute?: number;
  globalConcurrent?: number;
  peerConcurrent?: number;
  maxPeerBuckets?: number;
}>;

function positive(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function socketPeer(c: Context): string | null {
  try { return getConnInfo(c).remote.address ?? null; }
  catch { return null; }
}
function peerKey(value: string | null | undefined) {
  const candidate = value?.trim();
  return candidate && candidate.length <= 45 && isIP(candidate) !== 0 ? candidate : 'unknown';
}
function tick(bucket: Bucket, now: number) {
  if (now < bucket.window_start || now - bucket.window_start >= 60_000) {
    bucket.window_start = now;
    bucket.generation += 1;
    bucket.count = 0;
  }
}
function unavailable(c: Context, status: 429 | 503, retryAfter: string) {
  c.header('Retry-After', retryAfter);
  return c.json({ error: 'Resource sync request failed', code: 'APP_RESOURCE_SYNC_FAILURE' }, status);
}

/** Process-local bound ahead of the v2 JSON reader and session DB lookup.
 * Forwarding headers are never consulted. Invalid/unknown peers share a
 * bucket and every request is charged to the global bucket. */
export function createAppResourceSyncLimits(
  options: AppResourceSyncLimitsOptions = {},
): MiddlewareHandler {
  const clock = options.now ?? Date.now;
  const resolvePeer = options.peerAddress ?? socketPeer;
  const globalPerMinute = positive(options.globalPerMinute, 600);
  const peerPerMinute = positive(options.peerPerMinute, 60);
  const globalConcurrent = positive(options.globalConcurrent, 32);
  const peerConcurrent = positive(options.peerConcurrent, 2);
  const maxPeerBuckets = positive(options.maxPeerBuckets, 1024);
  const global: Bucket = { window_start: clock(), generation: 0, count: 0, in_flight: 0 };
  const unknown: Bucket = { window_start: clock(), generation: 0, count: 0, in_flight: 0 };
  const overflow: Bucket = { window_start: clock(), generation: 0, count: 0, in_flight: 0 };
  const peers = new Map<string, Bucket>();
  let admissions = 0;
  return async (c, next) => {
    const now = clock();
    tick(global, now);
    global.count += 1;
    if (global.count > globalPerMinute) return unavailable(c, 429, '60');
    const key = peerKey(resolvePeer(c));
    let peer = key === 'unknown' ? unknown : peers.get(key);
    if (!peer) {
      admissions += 1;
      if (admissions % 64 === 0 && peers.size >= maxPeerBuckets) {
        for (const [id, bucket] of peers) {
          if (bucket.in_flight === 0 && now - bucket.window_start >= 60_000) peers.delete(id);
        }
      }
      peer = peers.size < maxPeerBuckets
        ? { window_start: now, generation: 0, count: 0, in_flight: 0 } : overflow;
      if (peer !== overflow) peers.set(key, peer);
    }
    tick(peer, now);
    peer.count += 1;
    if (peer.count > peerPerMinute) return unavailable(c, 429, '60');
    if (c.req.raw.signal.aborted) return unavailable(c, 503, '1');
    if (global.in_flight >= globalConcurrent || peer.in_flight >= peerConcurrent) {
      return unavailable(c, 503, '1');
    }
    global.in_flight += 1;
    peer.in_flight += 1;
    const generation = peer.generation;
    let completed = false;
    try { await next(); completed = true; }
    finally {
      // All requests retain their global charge. Only an authenticated successful
      // renewal refunds its generic peer charge; it never bypasses admission or
      // occupies a different concurrency budget. Late work cannot refund a new
      // minute, including a clock rollback to an earlier window.
      if (completed && c.res.status === 200 && isHeartbeat(c)
        && authenticatedHeartbeats.has(c) && peer.generation === generation) peer.count -= 1;
      authenticatedHeartbeats.delete(c);
      global.in_flight -= 1; peer.in_flight -= 1;
    }
  };
}

export const appResourceSyncLimits = createAppResourceSyncLimits();
