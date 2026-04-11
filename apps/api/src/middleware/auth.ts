import { createMiddleware } from 'hono/factory';
import jwt from 'jsonwebtoken';
import { env } from '../lib/env.js';

export type AuthUser = {
  id: string;
  email: string;
  org_id: string;
};

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

export const authMiddleware = createMiddleware(async (c, next) => {
  // Skip auth for auth routes (they're mounted before this middleware)
  const path = c.req.path;
  if (path.startsWith('/api/auth') || path.includes('/callback')) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    c.set('user', payload);
    return next();
  } catch {
    return c.json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' }, 401);
  }
});
