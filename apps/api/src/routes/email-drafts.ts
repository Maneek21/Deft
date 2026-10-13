import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { EmailActor } from '../lib/email-mailbox-service.js';
import { EmailDraftContentSchema, EmailDraftError, type EmailDraftService } from '../lib/email-draft-service.js';

type VerifiedSession = { id: string; org_id: string; sid: string; exp: number };
type Dependencies = {
  verify: (token: string) => Promise<VerifiedSession>;
  drafts: (actor: EmailActor) => Promise<Pick<EmailDraftService, 'list' | 'listSummaries' | 'read' | 'create' | 'update' | 'archive'>>;
  now?: () => number;
};
const Identifier = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const DraftId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const Save = z.strictObject({ expected_revision: z.number().int().min(0).max(2147483646), content: EmailDraftContentSchema });
const Archive = z.strictObject({ expected_revision: z.number().int().min(1).max(2147483646) });
const SummaryQuery = z.strictObject({ cursor: z.string().min(1).max(8192).nullable(), limit: z.number().int().min(1).max(50) });

/** Account-scoped owner draft API. Caller content can never choose provenance,
 * lifecycle state, actor, account owner or send status. */
export function createEmailDraftRoutes(dependencies: Dependencies) {
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
  const actor = (session: VerifiedSession): EmailActor => ({ user_id: session.id, web_session_id: session.sid, access_expires_at: session.exp * 1000 });
  const fail = (c: Context, error: unknown) => {
    if (c.req.raw.signal.aborted) throw error;
    if (error instanceof z.ZodError) return c.json({ code: 'EMAIL_DRAFT_REQUEST_INVALID' }, 400);
    if (error instanceof EmailDraftError) {
      const status = error.code === 'EMAIL_DRAFT_ACCESS_DENIED' ? 403 : error.code === 'EMAIL_DRAFT_NOT_FOUND' ? 404
        : error.code === 'EMAIL_DRAFT_INVALID' ? 400 : error.code === 'EMAIL_DRAFT_CONFLICT' ? 409 : 503;
      return c.json({ code: error.code }, status);
    }
    return c.json({ code: 'EMAIL_DRAFT_UNAVAILABLE' }, 503);
  };
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache'); await next(); });
  routes.get('/accounts/:accountId/drafts', async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search) return c.json({ code: 'EMAIL_DRAFT_REQUEST_INVALID' }, 400);
    try {
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.drafts(actor(session))).list(actor(session), scope, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json({ items: result });
    } catch (error) { return fail(c, error); }
  });
  routes.post('/accounts/:accountId/draft-summaries/query', bodyLimit({ maxSize: 12 * 1024,
    onError: c => c.json({ code: 'EMAIL_DRAFT_REQUEST_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search || !/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type') ?? ''))
      return c.json({ code: 'EMAIL_DRAFT_REQUEST_INVALID' }, 400);
    try {
      let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_DRAFT_REQUEST_INVALID' }, 400); }
      const input = SummaryQuery.parse(body);
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const service = await dependencies.drafts(actor(session));
      const result = await service.listSummaries(actor(session), scope, input.cursor, input.limit, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });
  routes.get('/accounts/:accountId/drafts/:draftId', async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search) return c.json({ code: 'EMAIL_DRAFT_REQUEST_INVALID' }, 400);
    try {
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.drafts(actor(session))).read(actor(session), scope, DraftId.parse(c.req.param('draftId')), c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });
  routes.put('/accounts/:accountId/drafts/:draftId', bodyLimit({ maxSize: 512 * 1024,
    onError: c => c.json({ code: 'EMAIL_DRAFT_REQUEST_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search || !/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type') ?? ''))
      return c.json({ code: 'EMAIL_DRAFT_REQUEST_INVALID' }, 400);
    try {
      let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_DRAFT_REQUEST_INVALID' }, 400); }
      const input = Save.parse(body), id = DraftId.parse(c.req.param('draftId'));
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const service = await dependencies.drafts(actor(session));
      const result = input.expected_revision === 0
        ? await service.create(actor(session), scope, id, input.content, c.req.raw.signal)
        : await service.update(actor(session), scope, id, input.expected_revision, input.content, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });
  routes.post('/accounts/:accountId/drafts/:draftId/archive', bodyLimit({ maxSize: 2 * 1024,
    onError: c => c.json({ code: 'EMAIL_DRAFT_REQUEST_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search || !/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type') ?? ''))
      return c.json({ code: 'EMAIL_DRAFT_REQUEST_INVALID' }, 400);
    try {
      let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_DRAFT_REQUEST_INVALID' }, 400); }
      const input = Archive.parse(body), id = DraftId.parse(c.req.param('draftId'));
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.drafts(actor(session))).archive(actor(session), scope, id, input.expected_revision, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });
  return routes;
}
