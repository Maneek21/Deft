import type { Hono } from 'hono';

/**
 * Request gate that runs before routing. It holds two invariants that do not
 * depend on how the router matches a path:
 *
 * 1. A request whose path contains a control character, DEL or a backslash
 *    (literal or percent-encoded, any case) is refused with 400.
 * 2. A request under `/api` that is not on the public list below is refused
 *    unless it carries a valid web session. The route-level auth middleware
 *    still runs and reuses the same (memoised) result.
 */

export type GateAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string; code: string };

export type GateAuthenticate = (request: Request) => Promise<GateAuthResult>;
export type GateIsPublic = (method: string, path: string) => boolean;

const DECODED_FORBIDDEN = /[\u0000-\u001f\u007f\\]/;
const ENCODED_FORBIDDEN = /%(?:[01][0-9a-f]|7f|5c)/i;

// Routers mounted ahead of the session middleware in index.ts. Each one
// authenticates its callers with its own credential (or is deliberately open).
const PUBLIC_API_PREFIXES = [
  '/api/auth',
  '/api/mcp/v1',
  '/api/mcp/hermes/v1',
  '/api/agent-channel/v1',
  '/api/metrics',
  '/api/webhooks',
  '/api/invites',
  '/api/app-developer',
  '/api/app-runtime/channel',
  '/api/app-resource-sync/channel',
  '/api/app-resource-sync-channel/v3',
  '/api/app-resource-sync-management',
  '/api/private-resources',
  '/api/app-resource-private',
  '/api/app-resource-access',
  '/api/app-private-mcp',
  '/api/apps/private-defty',
  '/api/public/apps',
  '/api/app-connection-sessions',
  '/api/app-connection-forms',
  '/api/app-local-jobs',
  '/api/app-data',
  '/api/app-integration-tools',
  '/api/app-resource-observations',
] as const;

const PUBLIC_AGENT_WEBHOOK = /^\/api\/agent-webhooks\/[^/]+$/;
const PUBLIC_ICS_FEED = /^\/api\/ics\/feed\/[^/]+$/;

export function isGatedApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function isPublicApiRequest(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (PUBLIC_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return true;
  if (verb === 'POST' && PUBLIC_AGENT_WEBHOOK.test(path)) return true;
  if ((verb === 'GET' || verb === 'HEAD') && PUBLIC_ICS_FEED.test(path)) return true;
  return false;
}

export function hasForbiddenPathCharacters(rawPathname: string, routedPath: string): boolean {
  return DECODED_FORBIDDEN.test(routedPath) || ENCODED_FORBIDDEN.test(rawPathname);
}

function rawPathname(url: string): string {
  const start = url.indexOf('/', url.indexOf(':') + 3);
  if (start === -1) return '/';
  const end = url.search(/[?#]/);
  return end === -1 || end < start ? url.slice(start) : url.slice(start, end);
}

function json(body: { error: string; code: string }, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' },
  });
}

export function installRequestGate(
  app: Hono,
  options: { isPublic: GateIsPublic; authenticate: GateAuthenticate },
): void {
  const routedFetch = app.fetch;
  const gatedFetch: typeof app.fetch = async (request, ...rest) => {
    const path = app.getPath(request, { env: rest[0] });
    if (hasForbiddenPathCharacters(rawPathname(request.url), path)) {
      return json({ error: 'Invalid request path', code: 'INVALID_PATH' }, 400);
    }
    if (request.method !== 'OPTIONS' && isGatedApiPath(path) && !options.isPublic(request.method, path)) {
      const result = await options.authenticate(request);
      if (!result.ok) return json({ error: result.error, code: result.code }, result.status);
    }
    return routedFetch(request, ...rest);
  };
  app.fetch = gatedFetch;
}
