import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { EmailActor, EmailScope } from '../lib/email-mailbox-service.js';
import type { EmailUnreadService } from '../lib/email-unread.js';

type VerifiedSession = { id: string; org_id: string; sid: string; exp: number };
type Dependencies = { verify: (token: string) => Promise<VerifiedSession>;
  service: (actor: EmailActor) => Promise<Pick<EmailUnreadService, 'read'|'readUnified'>>; now?: () => number };
const Identifier = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Folder = z.string().min(1).max(128).refine(value => !/[\r\n\0]/u.test(value));

/** Account-scoped native unread projection. It returns counts only; no message
 * metadata or provider locator is included. */
export function createEmailUnreadRoutes(dependencies: Dependencies) {
  const routes = new Hono();
  const verified = async (c: Context): Promise<VerifiedSession | null> => {
    const bearer = /^Bearer ([^\s]+)$/.exec(c.req.header('authorization') ?? '');
    if (!bearer) return null;
    try {
      const session = await dependencies.verify(bearer[1]!);
      if (!session.id || !session.org_id || !session.sid || !Number.isFinite(session.exp)
        || session.exp * 1000 <= (dependencies.now ?? Date.now)()) return null;
      return session;
    } catch { return null; }
  };
  const fail = (c: Context, error: unknown) => {
    if (c.req.raw.signal.aborted) throw error;
    if (error instanceof z.ZodError) return c.json({ code: 'EMAIL_UNREAD_INVALID' }, 400);
    if (error instanceof Error && error.message === 'EMAIL_UNREAD_INVALID') return c.json({ code: error.message }, 400);
    if (error instanceof Error && error.message === 'EMAIL_ACCESS_DENIED') return c.json({ code: error.message }, 403);
    return c.json({ code: 'EMAIL_UNREAD_UNAVAILABLE' }, 503);
  };
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache'); await next(); });
  routes.get('/accounts/:accountId/unread', async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    try {
      const params = new URL(c.req.url).searchParams;
      if ([...params.keys()].some(key => key !== 'folder') || params.getAll('folder').length > 1) throw new Error('EMAIL_UNREAD_INVALID');
      const scope: EmailScope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const service = await dependencies.service({ user_id: session.id, web_session_id: session.sid, access_expires_at: session.exp * 1000 });
      const result = await service.read({ user_id: session.id, web_session_id: session.sid, access_expires_at: session.exp * 1000 }, scope,
        Folder.parse(params.get('folder') ?? 'INBOX'), c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });
  routes.get('/unread', async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    try {
      const params = new URL(c.req.url).searchParams;
      if ([...params.keys()].some(key => !['folder', 'account_id'].includes(key)) || params.getAll('folder').length > 1
        || params.getAll('account_id').length < 1 || params.getAll('account_id').length > 50) throw new Error('EMAIL_UNREAD_INVALID');
      const accountIds = params.getAll('account_id').map(value => Identifier.parse(value));
      if (new Set(accountIds).size !== accountIds.length) throw new Error('EMAIL_UNREAD_INVALID');
      const scopes = accountIds.map(account_id => ({ org_id: session.org_id, owner_user_id: session.id, account_id }));
      const actor = { user_id: session.id, web_session_id: session.sid, access_expires_at: session.exp * 1000 };
      const result = await (await dependencies.service(actor)).readUnified(actor, scopes, Folder.parse(params.get('folder') ?? 'INBOX'), c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });
  return routes;
}
