import type { Context } from 'hono';

/**
 * Handler-level owner/admin check. Returns a refusal response, or null when
 * the caller may proceed. `user.role` is the caller's live `org_members` role
 * (set by `verifyWebAccess` for every session-authenticated request).
 */
export function requireOrgAdmin(c: Context): Response | null {
  const user = c.get('user') as { id?: string; org_id?: string; role?: string } | undefined;
  if (!user?.id || !user.org_id) {
    return c.json({ error: 'Authentication required', code: 'NO_TOKEN' }, 401);
  }
  if (user.role !== 'owner' && user.role !== 'admin') {
    return c.json({ error: 'Owner or admin role required', code: 'FORBIDDEN' }, 403);
  }
  return null;
}
