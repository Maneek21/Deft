import { createMiddleware } from 'hono/factory';
import { verifyWebAccess } from '../lib/web-sessions.js';
import { OrgMembershipError, type OrgRole } from '../lib/org-membership.js';

export type AuthUser = {
  id: string;
  email: string;
  org_id: string;
  role?: OrgRole;
};

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

export const authMiddleware = createMiddleware(async (c, next) => {
  // Skip auth for auth routes (they're mounted before this middleware)
  const path = c.req.path;
  if (path.startsWith('/api/auth/')) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyWebAccess(token);
    c.set('user', payload);
    return next();
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return c.json({ error: err.message, code: err.code }, err.status as 403);
    }
    return c.json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' }, 401);
  }
});
