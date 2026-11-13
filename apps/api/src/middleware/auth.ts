import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import { verifyWebAccess } from '../lib/web-sessions.js';
import { OrgMembershipError, type OrgRole } from '../lib/org-membership.js';

export type AuthUser = {
  id: string;
  email: string;
  org_id: string;
  sid: string;
  role?: OrgRole;
};

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

export type WebAuthResult =
  | { ok: true; user: AuthUser }
  | { ok: false; status: 401 | 403; error: string; code: string };

const authResults = new WeakMap<Request, Promise<WebAuthResult>>();

async function verifyRequest(request: Request): Promise<WebAuthResult> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Unauthorized', code: 'NO_TOKEN' };
  }
  try {
    return { ok: true, user: await verifyWebAccess(authHeader.slice(7)) };
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return { ok: false, status: err.status as 403, error: err.message, code: err.code };
    }
    return { ok: false, status: 401, error: 'Invalid or expired token', code: 'INVALID_TOKEN' };
  }
}

/** Verifies the request's web session once; later callers get the same result. */
export function authenticateWebRequest(request: Request): Promise<WebAuthResult> {
  let result = authResults.get(request);
  if (!result) {
    result = verifyRequest(request);
    authResults.set(request, result);
  }
  return result;
}

export const authMiddleware: MiddlewareHandler = createMiddleware(async (c, next) => {
  // Skip auth for auth routes (they're mounted before this middleware)
  const path = c.req.path;
  if (path.startsWith('/api/auth/')) {
    return next();
  }

  const result = await authenticateWebRequest(c.req.raw);
  if (!result.ok) {
    return c.json({ error: result.error, code: result.code }, result.status);
  }
  c.set('user', result.user);
  return next();
});
