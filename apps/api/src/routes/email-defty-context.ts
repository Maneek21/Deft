import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { EmailActor, EmailScope } from '../lib/email-mailbox-service.js';

type Session = { id: string; org_id: string; sid: string; exp: number };
const accountId = z.string().min(1).max(256).refine(v => v.trim() === v && !/[\u0000-\u001f\u007f-\u009f]/u.test(v));
export function createEmailDeftyContextRoutes(deps: {
  verify(token: string): Promise<Session>;
  open(actor: EmailActor, scope: EmailScope, messageId: string): Promise<unknown>;
}) {
  const routes = new Hono();
  routes.post('/accounts/:accountId/messages/:messageId/defty-context', bodyLimit({ maxSize: 1024 }), async c => {
    c.header('Cache-Control', 'no-store');
    const bearer = /^Bearer ([^\s]+)$/.exec(c.req.header('authorization') ?? '');
    if (!bearer) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    let session: Session;
    try {
      session = await deps.verify(bearer[1]!);
      if (!session.id || !session.org_id || !session.sid || !Number.isFinite(session.exp) || session.exp * 1000 <= Date.now()) throw Error();
    } catch { return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401); }
    try {
      if (!c.req.header('content-type')?.startsWith('application/json') || Object.keys(c.req.query()).length) return c.json({ code: 'EMAIL_CONTEXT_INVALID' }, 400);
      z.strictObject({}).parse(await c.req.json());
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: accountId.parse(c.req.param('accountId')) };
      const messageId = z.string().regex(/^mail_[a-f0-9]{64}$/).parse(c.req.param('messageId'));
      return c.json(await deps.open({ user_id: session.id, web_session_id: session.sid, access_expires_at: session.exp * 1000 }, scope, messageId));
    } catch (error) {
      const code = error instanceof z.ZodError || error instanceof SyntaxError ? 'EMAIL_CONTEXT_INVALID'
        : error instanceof Error && ['EMAIL_DEFTY_ACCESS_REQUIRED', 'EMAIL_ACCESS_DENIED', 'EMAIL_MESSAGE_UNAVAILABLE'].includes(error.message) ? error.message : 'EMAIL_CONTEXT_UNAVAILABLE';
      return c.json({ code }, code === 'EMAIL_CONTEXT_INVALID' ? 400 : code === 'EMAIL_MESSAGE_UNAVAILABLE' ? 404 : code === 'EMAIL_CONTEXT_UNAVAILABLE' ? 503 : 403);
    }
  });
  return routes;
}
