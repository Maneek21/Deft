import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { EmailActor } from '../lib/email-mailbox-service.js';
import { EmailTimerCancelSchema, EmailTimerError, EmailTimerListQuerySchema } from '../lib/email-timer-types.js';
import type { EmailTimerService } from '../lib/email-timer-service.js';

type VerifiedSession = { id: string; org_id: string; sid: string; exp: number };
type Dependencies = { verify: (token: string) => Promise<VerifiedSession>;
  timers: (actor: EmailActor) => Promise<Pick<EmailTimerService, 'get' | 'list' | 'save' | 'cancel'>>; now?: () => number };
const Identifier = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const TimerId = z.string().uuid();

/** Local owner timer API. It never accepts or returns provider identifiers. */
export function createEmailTimerRoutes(dependencies: Dependencies) {
  const routes = new Hono();
  const verified = async (c: Context): Promise<VerifiedSession | null> => {
    const bearer = /^Bearer ([^\s]+)$/.exec(c.req.header('authorization') ?? '');
    if (!bearer) return null;
    try {
      const value = await dependencies.verify(bearer[1]!);
      if (!value.id || !value.org_id || !value.sid || !Number.isFinite(value.exp)
        || value.exp * 1000 <= (dependencies.now ?? Date.now)()) return null;
      return value;
    } catch { return null; }
  };
  const actor = (session: VerifiedSession): EmailActor => ({ user_id: session.id,
    web_session_id: session.sid, access_expires_at: session.exp * 1000 });
  const fail = (c: Context, error: unknown) => {
    if (c.req.raw.signal.aborted) throw error;
    if (error instanceof z.ZodError) return c.json({ code: 'EMAIL_TIMER_INVALID' }, 400);
    if (error instanceof EmailTimerError) {
      const status = error.code === 'EMAIL_TIMER_ACCESS_DENIED' ? 403 : error.code === 'EMAIL_TIMER_NOT_FOUND' ? 404
        : error.code === 'EMAIL_TIMER_INVALID' ? 400 : error.code === 'EMAIL_TIMER_CONFLICT' ? 409 : 503;
      return c.json({ code: error.code }, status);
    }
    return c.json({ code: 'EMAIL_TIMER_UNAVAILABLE' }, 503);
  };
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache'); await next(); });
  routes.get('/accounts/:accountId/timers', async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    try {
      const url = new URL(c.req.url), params = url.searchParams;
      if ([...params.keys()].some(key => !['kind', 'state', 'cursor', 'limit'].includes(key))
        || ['kind', 'state', 'cursor', 'limit'].some(key => params.getAll(key).length > 1)) throw new Error('query');
      const limitValue = params.get('limit');
      const query = EmailTimerListQuerySchema.parse({
        kind: params.get('kind') ?? undefined, state: params.get('state') ?? undefined,
        cursor: params.get('cursor'), limit: limitValue === null ? 50 : Number(limitValue),
      });
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.timers(actor(session))).list(actor(session), scope, query, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });
  routes.get('/accounts/:accountId/timers/:timerId', async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search) return c.json({ code: 'EMAIL_TIMER_INVALID' }, 400);
    try {
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.timers(actor(session))).get(actor(session), scope, TimerId.parse(c.req.param('timerId')), c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });
  routes.put('/accounts/:accountId/timers/:timerId', bodyLimit({ maxSize: 8 * 1024,
    onError: c => c.json({ code: 'EMAIL_TIMER_REQUEST_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search || !/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type') ?? ''))
      return c.json({ code: 'EMAIL_TIMER_INVALID' }, 400);
    try {
      let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_TIMER_INVALID' }, 400); }
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.timers(actor(session))).save(actor(session), scope, TimerId.parse(c.req.param('timerId')), body, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });
  routes.post('/accounts/:accountId/timers/:timerId/cancel', bodyLimit({ maxSize: 2 * 1024,
    onError: c => c.json({ code: 'EMAIL_TIMER_REQUEST_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search || !/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type') ?? ''))
      return c.json({ code: 'EMAIL_TIMER_INVALID' }, 400);
    try {
      let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_TIMER_INVALID' }, 400); }
      const input = EmailTimerCancelSchema.parse(body);
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.timers(actor(session))).cancel(actor(session), scope, TimerId.parse(c.req.param('timerId')), input.expected_revision, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });
  return routes;
}
