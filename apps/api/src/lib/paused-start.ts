/**
 * Paused start: the install comes up so an operator can look, but it changes
 * nothing and sends nothing. Used for a restored or upgraded install before it
 * is released. It is on only when DEFT_PAUSED_START is exactly "true", read
 * once when this module loads (process start). It applies to every install.
 *
 * While paused:
 * - the job scheduler is not started, background jobs are not claimed, and
 *   startup work that writes or re-queues (stale-job recovery, reminder and
 *   scheduled-message rehydration, retention, App Run maintenance, legacy
 *   credential migration) is skipped;
 * - every request other than GET, HEAD and OPTIONS is refused with 503
 *   `{ code: 'PAUSED' }`, except login, token refresh and logout;
 * - read paths that would call out (search embeddings, App Run inspection)
 *   stay local;
 * - live-connection events that write are refused.
 */
let pausedStart = process.env.DEFT_PAUSED_START === 'true';

export function isPausedStart(): boolean {
  return pausedStart;
}

/** Test seam only. Production reads the setting once at process start. */
export function _setPausedStartForTest(value: boolean): void {
  pausedStart = value;
}

export const PAUSED_ERROR = {
  error: 'This Deft install started paused: it is read-only until it is restarted without DEFT_PAUSED_START',
  code: 'PAUSED',
} as const;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Writes allowed while paused: an operator must be able to sign in and out. */
const PAUSED_ALLOWED_WRITES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/refresh' },
  { method: 'POST', path: '/api/auth/logout' },
];

function normalizedPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** True when the paused start must refuse this request. */
export function isRefusedWhilePaused(method: string, path: string): boolean {
  if (!pausedStart) return false;
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb)) return false;
  const routed = normalizedPath(path);
  if (routed === '/health' || routed.startsWith('/health/')) return false;
  return !PAUSED_ALLOWED_WRITES.some((allowed) => allowed.method === verb && allowed.path === routed);
}

/** Live-connection events that write to the database or notify people. */
const PAUSED_REFUSED_SOCKET_EVENTS = new Set(['huddle:create']);

export function isSocketEventRefusedWhilePaused(eventName: string): boolean {
  return pausedStart && PAUSED_REFUSED_SOCKET_EVENTS.has(eventName);
}

export function logPausedStart(log: (line: string) => void = console.warn): void {
  if (!pausedStart) return;
  log(
    '[startup] PAUSED START (DEFT_PAUSED_START=true): this install is read-only. ' +
      'The job scheduler and background jobs are off, startup recovery work is skipped, ' +
      'nothing is sent outward, and every change request except login, token refresh and ' +
      'logout is refused with 503 PAUSED. Restart without DEFT_PAUSED_START to release it.',
  );
}
