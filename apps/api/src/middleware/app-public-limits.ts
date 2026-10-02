import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';

const WINDOW_MS = 60_000;
const UNKNOWN_PEER = 'unknown';
const OVERFLOW_PEER = 'overflow';

type Bucket = { windowStart: number; count: number; inFlight: number };
export type AppPublicLimitsOptions = Readonly<{
  /** Supply only a socket peer or a value verified by a trusted host proxy. */
  peerAddress?: (c: Context) => string | null | undefined;
  now?: () => number;
  globalPerMinute?: number;
  peerPerMinute?: number;
  globalConcurrent?: number;
  peerConcurrent?: number;
  maxPeerBuckets?: number;
}>;

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function socketPeer(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // Hono's in-memory request adapter has no socket. Share the unknown bucket.
    return null;
  }
}

function peerKey(value: string | null | undefined): string {
  const candidate = value?.trim();
  return candidate && candidate.length <= 45 && isIP(candidate) !== 0
    ? candidate
    : UNKNOWN_PEER;
}

function tick(bucket: Bucket, now: number): void {
  if (now < bucket.windowStart || now - bucket.windowStart >= WINDOW_MS) {
    bucket.windowStart = now;
    bucket.count = 0;
  }
}

/**
 * Process-local admission before public body parsing, authentication lookups,
 * or DB work. Forwarding headers are deliberately never inspected here.
 * A deployment with a trusted reverse proxy may inject its verified peer.
 */
export function createAppPublicLimits(options: AppPublicLimitsOptions = {}): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const resolvePeer = options.peerAddress ?? socketPeer;
  const globalPerMinute = positiveInt(options.globalPerMinute, 600);
  const peerPerMinute = positiveInt(options.peerPerMinute, 30);
  const globalConcurrent = positiveInt(options.globalConcurrent, 32);
  const peerConcurrent = positiveInt(options.peerConcurrent, 2);
  const maxPeerBuckets = positiveInt(options.maxPeerBuckets, 1024);
  const peers = new Map<string, Bucket>();
  const unknown: Bucket = { windowStart: now(), count: 0, inFlight: 0 };
  const overflow: Bucket = { windowStart: now(), count: 0, inFlight: 0 };
  const global: Bucket = { windowStart: now(), count: 0, inFlight: 0 };
  let admissions = 0;

  return async (c, next) => {
    const current = now();
    tick(global, current);
    // Charge every request, including rejected identities, to the global
    // budget so rotating peers cannot bypass the process ceiling.
    global.count += 1;
    if (global.count > globalPerMinute) {
      c.header('Retry-After', '60');
      return c.json({ error: 'Public request rate limit reached', code: 'PUBLIC_RATE_LIMITED' }, 429);
    }

    const key = peerKey(resolvePeer(c));
    let peer: Bucket;
    if (key === UNKNOWN_PEER) {
      peer = unknown;
    } else {
      peer = peers.get(key)!;
      if (!peer) {
        admissions += 1;
        // Expired idle identities can be removed, but collection happens only
        // periodically and is capped by maxPeerBuckets.
        if (admissions % 64 === 0 && peers.size >= maxPeerBuckets) {
          for (const [id, bucket] of peers) {
            if (bucket.inFlight === 0 && current - bucket.windowStart >= WINDOW_MS) peers.delete(id);
          }
        }
        if (peers.size < maxPeerBuckets) {
          peer = { windowStart: current, count: 0, inFlight: 0 };
          peers.set(key, peer);
        } else {
          peer = overflow;
        }
      }
    }
    tick(peer, current);
    peer.count += 1;
    if (peer.count > peerPerMinute) {
      c.header('Retry-After', '60');
      return c.json({ error: 'Public request rate limit reached', code: 'PUBLIC_RATE_LIMITED' }, 429);
    }
    if (c.req.raw.signal.aborted) {
      return c.json({ error: 'Public request unavailable', code: 'PUBLIC_UNAVAILABLE' }, 503);
    }
    if (global.inFlight >= globalConcurrent || peer.inFlight >= peerConcurrent) {
      c.header('Retry-After', '1');
      return c.json({ error: 'Public request capacity reached', code: 'PUBLIC_UNAVAILABLE' }, 503);
    }

    global.inFlight += 1;
    peer.inFlight += 1;
    // Aborted requests keep their slot until downstream work actually settles.
    // Releasing early would allow more real DB work than the concurrency cap.
    try {
      await next();
    } finally {
      global.inFlight -= 1;
      peer.inFlight -= 1;
    }
  };
}

export const appPublicLimits = createAppPublicLimits();
