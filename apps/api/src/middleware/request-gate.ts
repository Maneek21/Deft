import { Hono, type MiddlewareHandler } from 'hono';

/**
 * Request gate that runs before routing. It holds two invariants that do not
 * depend on how the router matches a path:
 *
 * 1. A request whose path contains a control character, DEL or a backslash
 *    (percent-encoded in any case, or literal after decoding) is refused with 400.
 * 2. A request under `/api` that does not match one of the session-exempt
 *    routes below is refused unless it carries a valid web session. The
 *    route-level auth middleware still runs and reuses the same result.
 *
 * Responses the gate produces pass through the same edge middleware as the
 * app (logging, CORS, security headers), so browsers can read them.
 */

export type GateAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string; code: string };

export type GateAuthenticate = (request: Request) => Promise<GateAuthResult>;
export type GateIsPublic = (method: string, path: string) => boolean;

const DECODED_FORBIDDEN = /[\u0000-\u001f\u007f\\]/;
const ENCODED_FORBIDDEN = /%(?:[01][0-9a-f]|7f|5c)/i;

/**
 * Routes mounted ahead of the session middleware in index.ts. Each one
 * authenticates its callers with its own credential or is deliberately open.
 * `:name` matches one segment; a trailing `*` matches zero or more segments.
 */
export const SESSION_EXEMPT_ROUTES: ReadonlyArray<{ methods?: readonly string[]; path: string }> = [
  { path: '/api/auth/*' },
  { path: '/api/mcp/v1/*' },
  { path: '/api/mcp/hermes/v1/*' },
  { path: '/api/agent-channel/v1/*' },
  { path: '/api/metrics/*' },
  { path: '/api/webhooks/*' },
  { path: '/api/invites/*' },
  { path: '/api/app-developer/*' },
  { path: '/api/app-runtime/channel/*' },
  { path: '/api/app-resource-sync/channel/*' },
  { path: '/api/app-resource-sync-channel/v3/*' },
  { path: '/api/app-resource-sync-management/*' },
  { path: '/api/private-resources/*' },
  { path: '/api/app-resource-private/*' },
  { path: '/api/app-resource-access/*' },
  { path: '/api/app-private-mcp/*' },
  { path: '/api/public/apps/*' },
  { path: '/api/app-connection-sessions/*' },
  { path: '/api/app-connection-forms/*' },
  { path: '/api/app-local-jobs/*' },
  { path: '/api/app-data/*' },
  { path: '/api/app-integration-tools/*' },
  { path: '/api/app-resource-observations/*' },
  // Exact routes that share a prefix with session-gated routers. (The private
  // Defty routes under /api/apps also require a web session, so they stay gated.)
  { methods: ['POST'], path: '/api/agent-webhooks/:slug' },
  { methods: ['GET', 'HEAD'], path: '/api/ics/feed/:token' },
];

function segments(path: string): string[] {
  return path.split('/').slice(1);
}

/** True when `path` (a concrete request path) matches the template. */
export function matchesTemplate(template: string, path: string): boolean {
  const t = segments(template);
  const p = segments(path);
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '*' && i === t.length - 1) return true;
    if (i >= p.length) return false;
    if (t[i]!.startsWith(':')) {
      if (p[i] === '') return false;
    } else if (t[i] !== p[i]) {
      return false;
    }
  }
  return t.length === p.length;
}

export function isGatedApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function isPublicApiRequest(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  return SESSION_EXEMPT_ROUTES.some((route) =>
    (!route.methods || route.methods.includes(verb)) && matchesTemplate(route.path, path));
}

export function hasForbiddenPathCharacters(rawPathname: string, routedPath: string): boolean {
  return DECODED_FORBIDDEN.test(routedPath) || ENCODED_FORBIDDEN.test(rawPathname);
}

function rawPathname(url: string): string {
  const start = url.indexOf('/', url.indexOf(':') + 3);
  if (start === -1) return '/';
  const end = url.slice(start).search(/[?#]/);
  return end === -1 ? url.slice(start) : url.slice(start, start + end);
}

type Denial = { error: string; code: string; status: 400 | 401 | 403 | 404 | 500 };

export function installRequestGate(
  app: Hono,
  options: {
    isPublic: GateIsPublic;
    authenticate: GateAuthenticate;
    /** Called once the request is answered; ends any per-request reuse of the auth result. */
    release?: (request: Request) => void;
    edgeMiddleware?: MiddlewareHandler[];
  },
): void {
  const routedFetch = app.fetch;
  const responses = new Hono<{ Bindings: { denial: Denial } }>();
  for (const middleware of options.edgeMiddleware ?? []) responses.use('*', middleware);
  responses.all('*', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: c.env.denial.error, code: c.env.denial.code }, c.env.denial.status);
  });
  const deny = (request: Request, denial: Denial) => responses.fetch(request, { denial });

  const gatedFetch: typeof app.fetch = async (request, ...rest) => {
    let gated = false;
    try {
      let path: string;
      try {
        path = app.getPath(request, { env: rest[0] });
      } catch {
        return await deny(request, { error: 'Invalid request path', code: 'INVALID_PATH', status: 400 });
      }
      if (hasForbiddenPathCharacters(rawPathname(request.url), path)) {
        return await deny(request, { error: 'Invalid request path', code: 'INVALID_PATH', status: 400 });
      }
      gated = isGatedApiPath(path) && !options.isPublic(request.method, path);
      if (gated && request.method === 'OPTIONS') {
        // Preflight is answered by the CORS policy alone; it never reaches a route.
        return await deny(request, { error: 'Not found', code: 'NOT_FOUND', status: 404 });
      }
      if (gated) {
        const result = await options.authenticate(request);
        if (!result.ok) return await deny(request, result);
      }
      return await routedFetch(request, ...rest);
    } finally {
      if (gated) options.release?.(request);
    }
  };
  app.fetch = gatedFetch;
}
