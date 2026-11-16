/**
 * Paused start: the install comes up so an operator can look, but runs no
 * operational work and calls nothing outside. Authentication and private
 * onboarding bookkeeping are the documented local-write exceptions.
 * Used for a restored or upgraded install
 * before it is released. It applies to every install, hosted or not.
 *
 * DEFT_PAUSED_START is read once when this module loads (process start):
 * - absent or exactly "false": not paused;
 * - exactly "true": paused;
 * - anything else ("TRUE", "1", "true\r", ...): the server refuses to start
 *   (`assertPausedStartSettingValid`, called first thing in server.ts). Until
 *   then this module treats such a value as paused, so it fails closed.
 *
 * While paused:
 * - the job scheduler is not started, background jobs are not claimed, and
 *   startup work that writes or re-queues (stale-job recovery, reminder and
 *   scheduled-message rehydration, retention, App Run maintenance, legacy
 *   credential migration) is skipped;
 * - every request other than GET, HEAD and OPTIONS is refused with 503
 *   `{ code: 'PAUSED' }`, except login, token refresh and logout; the agent
 *   channel (except its static contract), the public calendar feed and the
 *   feed-address route are refused for every method;
 * - reachable outbound calls are refused before transport (LLM
 *   and embedding providers, transcription, outside tool servers, the App
 *   Runtime, public URL fetches, web push), so a read cannot call out either;
 *   legacy GitHub sync is unreachable behind the request and worker gates;
 * - realtime connections are refused before presence is broadcast.
 */
export type PausedStartSetting = { paused: boolean; invalid: string | null };

export function parsePausedStartSetting(raw: string | undefined): PausedStartSetting {
  if (raw === undefined || raw === 'false') return { paused: false, invalid: null };
  if (raw === 'true') return { paused: true, invalid: null };
  return { paused: true, invalid: raw };
}

let setting = parsePausedStartSetting(process.env.DEFT_PAUSED_START);

export function isPausedStart(): boolean {
  return setting.paused;
}

/** Throws when DEFT_PAUSED_START holds anything but exactly "true" or "false". */
export function assertPausedStartSettingValid(current: PausedStartSetting = setting): void {
  if (current.invalid === null) return;
  throw new Error(
    `DEFT_PAUSED_START must be exactly "true" or "false" (or unset); got ${JSON.stringify(current.invalid)}. ` +
      'Refusing to start, because a restored copy must not start live by mistake.',
  );
}

/** Test seam only. Production reads the setting once at process start. */
export function _setPausedStartForTest(value: boolean): void {
  setting = { paused: value, invalid: null };
}

export const PAUSED_ERROR = {
  error: 'This Deft install started paused: it is read-only until it is restarted without DEFT_PAUSED_START',
  code: 'PAUSED',
} as const;

/** Thrown by every outbound call site while paused. */
export class PausedStartError extends Error {
  readonly code = 'PAUSED';
  constructor(what: string) {
    super(`Paused start: ${what} is not called while this install is paused`);
    this.name = 'PausedStartError';
  }
}

export function assertNotPaused(what: string): void {
  if (setting.paused) throw new PausedStartError(what);
}

/** `fetch` that refuses while paused; for outbound clients that take a fetcher. */
export const pausedGuardedFetch: typeof fetch = (input, init) =>
  setting.paused ? Promise.reject(new PausedStartError('an outbound request')) : fetch(input, init);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Writes allowed while paused: an operator must be able to sign in and out. */
// C7: add each login verification/enrolment route here with one refusal-rule
// test. Keep exact paths: a wildcard would also admit account/security changes.
export const PAUSED_ALLOWED_WRITES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/refresh' },
  { method: 'POST', path: '/api/auth/logout' },
];

/**
 * Routes refused for every method, reads included:
 * - the agent channel: `GET /events` hands out work (marks events delivered,
 *   writes a claim and lease) and `GET /connect` writes connection state; an
 *   outside agent would be given the same work again on every poll. Only the
 *   static `GET /contract` stays open.
 * - `GET /api/ics/my-feed-url` mints a public feed token on a page view, which
 *   would undo a reset that revoked them.
 * - the public calendar feed serves data to anyone holding a restored link.
 *
 * Shared-state writes are refused too: attention backfill assigns other
 * reviewers, conversations creates Defty's membership, canvas creates shared
 * content, and members clears other people's statuses. Only the caller's
 * private onboarding bookkeeping (`GET /api/auth/onboarding`) stays open.
 */
function refusedForEveryMethod(path: string): boolean {
  if (path.startsWith('/api/agent-channel/v1/') || path === '/api/agent-channel/v1') {
    return path !== '/api/agent-channel/v1/contract';
  }
  if (path === '/api/ics/my-feed-url') return true;
  if (['/api/attention', '/api/agent/conversations', '/api/members'].includes(path)) return true;
  if (/^\/api\/spaces\/[^/]+\/canvas$/.test(path)) return true;
  // These reads journal live source checks or execute adapter factories.
  // Context and wiki page reads instead skip identity/source I/O while paused.
  if (/^\/api\/app-owner-connections\/[^/]+\/connections$/.test(path)) return true;
  if (/^\/api\/(?:app-integrations\/knowledge|email-adoption)\/source\/[^/]+$/.test(path)) return true;
  if (/^\/api\/app-integrations\/destinations\/(?:(?:status|source)\/[^/]+|attention\/source\/[^/]+|calendar\/status\/[^/]+)$/.test(path)) return true;
  return path.startsWith('/api/ics/feed/');
}

function normalizedPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** True when the paused start must refuse this request. */
export function isRefusedWhilePaused(method: string, path: string): boolean {
  if (!setting.paused) return false;
  const verb = method.toUpperCase();
  const routed = normalizedPath(path);
  // A CORS preflight runs nothing; it is never refused.
  if (refusedForEveryMethod(routed)) return verb !== 'OPTIONS';
  if (READ_METHODS.has(verb)) return false;
  return !PAUSED_ALLOWED_WRITES.some((allowed) => allowed.method === verb && allowed.path === routed);
}

export function logPausedStart(log: (line: string) => void = console.warn): void {
  if (!setting.paused) return;
  log(
    '[startup] PAUSED START (DEFT_PAUSED_START=true): this install is read-only. ' +
      'The job scheduler and background jobs are off and startup recovery work is skipped. ' +
      'This process makes no outbound call (AI and embedding providers, transcription, outside ' +
      'tool servers, the App Runtime, URL and calendar fetches, web push). The agent channel and ' +
      'calendar feeds are closed, and every other change request except login, token refresh and ' +
      'logout is refused with 503 PAUSED. /health reports paused: true; do not route users here. ' +
      'Restart without DEFT_PAUSED_START to release it.',
  );
}

/** What server.ts runs at startup; a paused start skips every step that writes. */
export function serverStartupPlan(paused: boolean = setting.paused): {
  migrateLegacyMcpCredentials: boolean;
  initScheduler: boolean;
} {
  return { migrateLegacyMcpCredentials: !paused, initScheduler: !paused };
}
