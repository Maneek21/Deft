// The live-editing client for documents (plan Task F12): one Hocuspocus
// provider, with its own WebSocket, per open document. F7's server takes only
// the exact address `doc:<id>` on a socket and refuses the multiplexed
// `name\0session` form, so a socket is never shared between documents.
//
// Address: NEXT_PUBLIC_WS_URL's origin with the scheme switched to ws/wss,
// plus /collab (that origin is already in the page's connect-src).
//
// Token: the signed-in session's access token, refreshed first when it is
// about to run out; a token sync sends a fresh one every 10 minutes, since the
// server closes the socket when the token it holds expires.
//
// What each close means (F7's COLLAB_CLOSE, mirrored below):
// - 4401 the token was refused or ran out: refresh it and reconnect quietly
//   (status `connecting`); after three refusals in a row, stop and say
//   `offline`, then try again on the read-only interval;
// - 4403 lost access, 4404 not this socket's document: `no_access`, stop;
// - 4409 the role changed: reconnect (`connecting`); the server sets the new
//   read-only flag on the new connection;
// - 4413, or 1009 (a frame over 4 MiB, refused by the socket itself): the
//   update would make the document too large. Stop; the page throws away this
//   Y.Doc and starts again from the server (`too_large`);
// - 4429 busy, 4430 crowded, 4503 live editing off: the page shows the stored
//   JSON read-only, and the client tries again every 15 s;
// - 4503 with reason `paused`: the workspace is paused (`read_only`); nothing
//   is tried again until the page is reloaded;
// - anything else (a dropped network): `offline`, while the socket reconnects
//   on its own with backoff.
// `live` follows each completed sync.

import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { api, refreshAccessToken } from './api';

/** F7's close codes (apps/api/src/collab/limits.ts), mirrored. */
export const COLLAB_CLOSE = {
  unauthenticated: 4401, forbidden: 4403, notFound: 4404, roleChanged: 4409,
  tooLarge: 4413, busy: 4429, crowded: 4430, liveOff: 4503,
} as const;

/** A frame over the server's 4 MiB limit is refused by the WebSocket itself with this code. */
export const FRAME_TOO_LARGE_CLOSE = 1009;

/** How often busy, crowded and live-off are tried again, and the read-only copy re-read. */
export const READ_ONLY_RETRY_MS = 15_000;

/** How often a fresh token is sent on an open connection. */
export const TOKEN_SYNC_MS = 10 * 60_000;

/** Refused tokens in a row (each after a refresh) before the client stops and says it is offline. */
const MAX_TOKEN_REFUSALS = 3;

/** A token with less than this left is refreshed before it is sent. */
const MIN_TOKEN_LIFE_MS = 60_000;

export type CollabStatus = 'connecting' | 'live' | 'read_only' | 'busy' | 'crowded' | 'too_large' | 'no_access' | 'live_off' | 'offline';

/** The statuses that show the stored JSON read-only. */
export const READ_ONLY_STATUSES: ReadonlySet<CollabStatus> = new Set(['busy', 'crowded', 'live_off', 'read_only']);

const RETRYING: ReadonlySet<CollabStatus> = new Set(['busy', 'crowded', 'live_off']);

/** What a /collab close code means for the page. */
export function collabStatusFromClose(code: number, reason?: string): CollabStatus {
  switch (code) {
    case COLLAB_CLOSE.unauthenticated:
    case COLLAB_CLOSE.roleChanged:
      return 'connecting';
    case COLLAB_CLOSE.forbidden:
    case COLLAB_CLOSE.notFound:
      return 'no_access';
    case COLLAB_CLOSE.tooLarge:
    case FRAME_TOO_LARGE_CLOSE:
      return 'too_large';
    case COLLAB_CLOSE.busy:
      return 'busy';
    case COLLAB_CLOSE.crowded:
      return 'crowded';
    case COLLAB_CLOSE.liveOff:
      return reason === 'paused' ? 'read_only' : 'live_off';
    default:
      return 'offline';
  }
}

/** The /collab address for a configured live-connection URL (http(s) or ws(s)). */
export function collabUrl(base: string): string {
  const url = new URL(base);
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  return `${secure ? 'wss' : 'ws'}://${url.host}/collab`;
}

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001';

/** Milliseconds a JWT has left, or null when it can't be read. */
function tokenLifeMs(token: string): number | null {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 - Date.now() : null;
  } catch {
    return null;
  }
}

/** Test seams; production passes none. */
export type DocumentProviderSeams = {
  url?: string;
  WebSocketPolyfill?: unknown;
  getAccessToken?: () => string | null;
  refreshAccessToken?: () => Promise<string | null>;
  reconnectDelayMs?: number;
  readOnlyRetryMs?: number;
  tokenSyncMs?: number;
};

export function createDocumentProvider(i: { documentId: string; onStatus: (s: CollabStatus) => void; seams?: DocumentProviderSeams }): {
  provider: HocuspocusProvider; ydoc: Y.Doc; destroy(): void;
} {
  const seams = i.seams ?? {};
  const currentToken = seams.getAccessToken ?? (() => api.getAccessToken());
  const refresh = seams.refreshAccessToken ?? refreshAccessToken;
  const readOnlyRetryMs = seams.readOnlyRetryMs ?? READ_ONLY_RETRY_MS;
  const tokenSyncMs = seams.tokenSyncMs ?? TOKEN_SYNC_MS;
  const reconnectDelayMs = seams.reconnectDelayMs ?? 1000;

  const ydoc = new Y.Doc();
  let destroyed = false;
  /** Set by a 4401: the next token is a refreshed one. */
  let mustRefresh = false;
  let tokenRefusals = 0;
  /** While a token sync runs, the token must outlive the next sync. */
  let syncing = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const report = (status: CollabStatus) => {
    if (!destroyed) i.onStatus(status);
  };

  const token = async (): Promise<string> => {
    const held = mustRefresh ? null : currentToken();
    const minLife = syncing ? tokenSyncMs + MIN_TOKEN_LIFE_MS : MIN_TOKEN_LIFE_MS;
    const life = held ? tokenLifeMs(held) : null;
    if (held && (life === null || life > minLife)) return held;
    mustRefresh = false;
    try {
      const fresh = await refresh();
      if (fresh) return fresh;
    } catch {
      // The refresh endpoint is out of reach: send what we hold; a refusal comes back as 4401.
    }
    return currentToken() ?? '';
  };

  const socket = new HocuspocusProviderWebsocket({
    url: seams.url ?? collabUrl(WS_URL),
    delay: reconnectDelayMs,
    minDelay: reconnectDelayMs,
    ...(seams.WebSocketPolyfill ? { WebSocketPolyfill: seams.WebSocketPolyfill } : {}),
  });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: `doc:${i.documentId}`, document: ydoc, token });
  provider.attach();

  /** Stops reconnecting; `connect()` starts again. */
  const stop = () => socket.disconnect();
  const retryLater = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!destroyed) void socket.connect();
    }, readOnlyRetryMs);
  };

  provider.on('authenticated', () => { tokenRefusals = 0; });
  provider.on('synced', () => report('live'));
  provider.on('close', ({ event }: { event: { code?: number; reason?: string } }) => {
    if (destroyed) return;
    const code = event?.code ?? 1006;
    const status = collabStatusFromClose(code, event?.reason);
    if (code === COLLAB_CLOSE.unauthenticated) {
      mustRefresh = true;
      tokenRefusals += 1;
      if (tokenRefusals > MAX_TOKEN_REFUSALS) {
        tokenRefusals = 0;
        stop();
        report('offline');
        retryLater();
        return;
      }
      report('connecting');
      return;
    }
    if (status === 'connecting' || status === 'offline') {
      // The socket reconnects on its own (4409 picks up the new read-only flag).
      report(status);
      return;
    }
    stop();
    report(status);
    if (RETRYING.has(status)) retryLater();
  });

  const syncTimer = setInterval(() => {
    if (destroyed || !provider.isAuthenticated) return;
    syncing = true;
    void provider.sendToken().finally(() => { syncing = false; });
  }, tokenSyncMs);

  return {
    provider,
    ydoc,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(syncTimer);
      if (retryTimer) clearTimeout(retryTimer);
      provider.destroy();
      socket.destroy();
      ydoc.destroy();
    },
  };
}
