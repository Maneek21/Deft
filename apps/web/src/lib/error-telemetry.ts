/**
 * Browser error reports (telemetry contract, section 1).
 *
 * Uncaught errors, unhandled promise rejections and API calls that fail with
 * a 5xx answer are reported to this workspace's own server, at
 * `POST /api/telemetry/client-error` on the API address the app already
 * uses. The browser never talks to anyone else. The server scrubs what it
 * receives and, on the hosted service only, forwards it; any other server
 * answers `{ "enabled": false }` and this page stops reporting.
 *
 * The page goes as its route template, with each dynamic segment replaced by
 * its name ("/modules/:slug", never "/modules/billing"), and never its query
 * or fragment (which can hold a link token). Until the router has said which
 * route this is, no page is sent. At most 5 reports a minute and 30 a page
 * load, and the same error once per page load.
 *
 * The server's error references (X-Deft-Error-Reference) from recent failed
 * calls are kept here, so "Report a problem" can include them.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
export const CLIENT_ERROR_PATH = '/api/telemetry/client-error';

const PER_MINUTE = 5;
const PER_PAGE = 30;
const MESSAGE_MAX = 1_000;
const STACK_MAX = 8_000;
const REFERENCES_MAX = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Browser noise that says nothing about Deft.
const IGNORED_MESSAGES = [/ResizeObserver loop/i, /^Script error\.?$/i];

type Report = {
  type: 'error' | 'rejection' | 'api';
  error_class?: string;
  message?: string;
  stack?: string;
  method?: string;
  api_path?: string;
  status?: number;
  request_id?: string;
};

let installed = false;
let stopped = false;
let pausedUntil = 0;
let total = 0;
const recentSends: number[] = [];
const seen = new Set<string>();
const references: string[] = [];

let pageTemplate: string | null = null;

/**
 * The route template for a path and the router's params: each segment that
 * is a param's value becomes ":name". "/modules/billing" with { slug:
 * "billing" } is "/modules/:slug".
 */
export function pageTemplateFor(pathname: string, params: Record<string, string | string[] | undefined> | null | undefined): string {
  const names = new Map<string, string>();
  for (const [name, value] of Object.entries(params ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string' || !item) continue;
      names.set(item, name);
      try { names.set(encodeURIComponent(item), name); } catch { /* keep the plain form */ }
    }
  }
  return `/${pathname.split(/[?#]/, 1)[0]!.split('/').slice(1).map((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* keep as is */ }
    const name = names.get(segment) ?? names.get(decoded);
    return name ? `:${name.replace(/[^A-Za-z0-9_]/g, '')}` : segment;
  }).join('/')}`;
}

/** Called by the root layout on each navigation with the current route template. */
export function setCurrentPageTemplate(template: string | null): void {
  pageTemplate = template;
}

/** The current page as a route template, or null before the router has said. */
export function currentPageTemplate(): string | null {
  return pageTemplate;
}

/** The server's error references from this page's recent failed calls, newest last. */
export function recentErrorReferences(): string[] {
  return [...references];
}

function rememberReference(value: string | null): void {
  if (!value || !UUID.test(value)) return;
  const reference = value.toLowerCase();
  const at = references.indexOf(reference);
  if (at >= 0) references.splice(at, 1);
  references.push(reference);
  if (references.length > REFERENCES_MAX) references.shift();
}

function accessToken(): string | null {
  try { return window.localStorage.getItem('deft-access-token'); } catch { return null; }
}

function send(report: Report): void {
  if (typeof window === 'undefined' || stopped) return;
  const now = Date.now();
  if (now < pausedUntil) return;
  while (recentSends.length > 0 && now - recentSends[0]! > 60_000) recentSends.shift();
  if (recentSends.length >= PER_MINUTE || total >= PER_PAGE) return;
  const key = [report.type, report.error_class, report.message, report.method, report.api_path, report.status].join('\u0001');
  if (seen.has(key)) return;
  if (seen.size < 200) seen.add(key);
  recentSends.push(now);
  total += 1;
  const body = JSON.stringify({ ...report, ...(pageTemplate ? { page: pageTemplate } : {}) });
  const token = accessToken();
  try {
    void fetch(`${API_URL}${CLIENT_ERROR_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body,
      credentials: 'omit',
      cache: 'no-store',
      // Only this workspace's own server: never followed anywhere else.
      redirect: 'error',
      keepalive: body.length < 60_000,
    }).then(async (res) => {
      if (res.status === 429) {
        pausedUntil = Date.now() + 60_000;
        return;
      }
      // Any other refusal (a paused install, an older server without the route): stop.
      if (!res.ok) {
        stopped = true;
        return;
      }
      const answer = await res.json().catch(() => null) as { enabled?: unknown } | null;
      if (answer?.enabled === false) stopped = true;
    }).catch(() => undefined);
  } catch {
    // Reporting never gets in the way.
  }
}

function clip(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

function reportError(type: 'error' | 'rejection', error: unknown, fallbackMessage?: string): void {
  if (error instanceof Error) {
    const message = clip(error.message, MESSAGE_MAX);
    if (message && IGNORED_MESSAGES.some((pattern) => pattern.test(message))) return;
    send({ type, error_class: clip(error.name, 100) ?? 'Error', message, stack: clip(error.stack, STACK_MAX) });
    return;
  }
  const message = clip(fallbackMessage, MESSAGE_MAX);
  if (message && IGNORED_MESSAGES.some((pattern) => pattern.test(message))) return;
  // A thrown value that is not an Error says nothing safe to send but that it happened.
  send({ type, error_class: type === 'rejection' ? 'UnhandledRejection' : 'Error', message: type === 'error' ? message : undefined });
}

/** Listen for uncaught errors and unhandled rejections on this page. Idempotent. */
export function installErrorTelemetry(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    // A failed image or script load is an Event, not an ErrorEvent: not an error in the app.
    if (!(event instanceof ErrorEvent)) return;
    reportError('error', event.error, event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError('rejection', event.reason);
  });
}

/** Called by the API client with each answer: keeps error references, reports a 5xx. */
export function noteApiResponse(method: string, path: string, response: Response): void {
  try {
    const reference = response.headers.get('X-Deft-Error-Reference');
    rememberReference(reference);
    if (response.status < 500 || path.startsWith(CLIENT_ERROR_PATH)) return;
    send({
      type: 'api',
      method: method.toUpperCase(),
      api_path: path.split(/[?#]/, 1)[0],
      status: response.status,
      ...(reference && UUID.test(reference) ? { request_id: reference.toLowerCase() } : {}),
    });
  } catch {
    // Reporting never gets in the way.
  }
}

/** Test helper. */
export function resetErrorTelemetryForTest(): void {
  installed = false;
  stopped = false;
  pausedUntil = 0;
  total = 0;
  recentSends.length = 0;
  seen.clear();
  references.length = 0;
  pageTemplate = null;
}
