import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { EmailContextTransferError, type EmailContextTransferService } from '../lib/email-context-transfer.js';
import { EmailMailboxError, type EmailActor } from '../lib/email-mailbox-service.js';
import { EmailMessageContentError } from '../lib/email-message-content.js';

export function createEmailContextTransferRoutes(ports: {
  verify(token: string): Promise<{ id: string; org_id: string; sid: string; exp: number }>;
  service(actor: EmailActor): Promise<Pick<EmailContextTransferService, 'review' | 'transfer'>>;
  now?: () => number;
}) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache'); await next(); });
  for (const operation of ['review', 'transfer'] as const) {
    const path = '/accounts/:accountId/messages/:logicalId/context-transfer' + (operation === 'review' ? '/review' : '');
    // Keep the bound on these two endpoints. Subrouter '*' middleware would
    // otherwise also limit unrelated native Email send/attachment routes.
    app.use(path, bodyLimit({ maxSize: 128 * 1024, onError: c => c.json({ error: 'Transfer is too large', code: 'EMAIL_TRANSFER_INVALID' }, 413) }));
    app.post(path, async c => {
      const token = /^Bearer ([^\s]+)$/u.exec(c.req.header('Authorization') ?? '')?.[1];
      if (!token) return c.json({ error: 'Sign in required', code: 'EMAIL_AUTH_REQUIRED' }, 401);
      let session;
      try {
        session = await ports.verify(token);
        if (!session.id || !session.org_id || !session.sid || !Number.isFinite(session.exp) || session.exp * 1000 <= (ports.now ?? Date.now)()) throw Error();
      } catch { return c.json({ error: 'Sign in required', code: 'EMAIL_AUTH_REQUIRED' }, 401); }
      if (new URL(c.req.url).search) return c.json({ error: 'Invalid transfer', code: 'EMAIL_TRANSFER_INVALID' }, 400);
      if (!/^application\/json(?:\s*;|$)/iu.test(c.req.header('Content-Type') ?? '')) return c.json({ error: 'JSON required', code: 'EMAIL_TRANSFER_INVALID' }, 400);
      try {
        const text = await c.req.text();
        if (Buffer.byteLength(text) > 128 * 1024) return c.json({ error: 'Transfer is too large', code: 'EMAIL_TRANSFER_INVALID' }, 400);
        let body: unknown;
        try { body = JSON.parse(text); } catch { return c.json({ error: 'Invalid transfer', code: 'EMAIL_TRANSFER_INVALID' }, 400); }
        const actor = { user_id: session.id, web_session_id: session.sid, access_expires_at: session.exp * 1000 };
        const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: c.req.param('accountId')! };
        const service = await ports.service(actor);
        const result = operation === 'review' ? await service.review(actor, scope, c.req.param('logicalId')!, body, c.req.raw.signal)
          : await service.transfer(actor, scope, c.req.param('logicalId')!, body, c.req.header('Idempotency-Key') ?? '', c.req.raw.signal);
        c.req.raw.signal.throwIfAborted();
        return c.json(result, operation === 'transfer' && 'replayed' in result && !result.replayed ? 201 : 200);
      } catch (error) {
        if (c.req.raw.signal.aborted) throw error;
        const code = error instanceof EmailContextTransferError ? error.code
          : (error instanceof EmailMailboxError || error instanceof EmailMessageContentError) && error.code === 'EMAIL_ACCESS_DENIED'
            ? 'EMAIL_ACCESS_DENIED' : error instanceof z.ZodError ? 'EMAIL_TRANSFER_INVALID' : 'EMAIL_TRANSFER_UNAVAILABLE';
        const status = code === 'EMAIL_TRANSFER_INVALID' ? 400 : ['EMAIL_ACCESS_DENIED', 'EMAIL_TRANSFER_FORBIDDEN'].includes(code) ? 403
          : ['EMAIL_TRANSFER_STALE', 'EMAIL_TRANSFER_CONFLICT'].includes(code) ? 409 : 503;
        return c.json({ error: code === 'EMAIL_TRANSFER_STALE' ? 'Source or audience changed. Review again.'
          : code === 'EMAIL_TRANSFER_CONFLICT' ? 'This request was already used for a different transfer.'
            : code === 'EMAIL_TRANSFER_INVALID' ? 'Invalid transfer or selected excerpt.'
              : status === 403 ? 'Source or destination access changed.' : 'Transfer is unavailable. Try again.', code }, status);
      }
    });
  }
  return app;
}
