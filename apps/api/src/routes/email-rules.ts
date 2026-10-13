import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { EmailActor } from '../lib/email-mailbox-service.js';
import { EmailRuleArchiveSchema, EmailRuleCreateSchema, EmailRuleError, EmailRuleIdSchema,
  EmailRuleListQuerySchema, EmailRuleOrderSchema, EmailRulePreviewRequestSchema, EmailRuleUpdateSchema } from '../lib/email-rule-types.js';
import type { EmailRuleService } from '../lib/email-rule-service.js';
import { EmailRuleExecutionService, EmailRuleReviewRequestSchema } from '../lib/email-rule-execution.js';

type VerifiedSession = { id: string; org_id: string; sid: string; exp: number };
type Dependencies = { verify: (token: string) => Promise<VerifiedSession>;
  rules: (actor: EmailActor) => Promise<Pick<EmailRuleService, 'create' | 'read' | 'list' | 'update' | 'archive' | 'reorder' | 'preview'>>;
  execution?: (actor: EmailActor) => Promise<EmailRuleExecutionService>;
  now?: () => number };
const Identifier = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));

/** Owner/account-scoped local rules. Preview evaluates bounded cached pages only. */
export function createEmailRuleRoutes(dependencies: Dependencies) {
  const routes = new Hono();
  const verified = async (c: Context): Promise<VerifiedSession | null> => {
    const match = /^Bearer ([^\s]+)$/.exec(c.req.header('authorization') ?? ''); if (!match) return null;
    try { const session = await dependencies.verify(match[1]!);
      if (!session.id || !session.org_id || !session.sid || !Number.isFinite(session.exp) || session.exp * 1000 <= (dependencies.now ?? Date.now)()) return null;
      return session; } catch { return null; }
  };
  const actor = (session: VerifiedSession): EmailActor => ({ user_id: session.id, web_session_id: session.sid, access_expires_at: session.exp * 1000 });
  const fail = (c: Context, error: unknown) => {
    if (c.req.raw.signal.aborted) throw error;
    if (error instanceof z.ZodError) return c.json({ code: 'EMAIL_RULE_INVALID' }, 400);
    if (error instanceof EmailRuleError) {
      const status = error.code === 'EMAIL_RULE_ACCESS_DENIED' ? 403 : error.code === 'EMAIL_RULE_NOT_FOUND' ? 404
        : error.code === 'EMAIL_RULE_INVALID' ? 400 : error.code === 'EMAIL_RULE_CONFLICT' ? 409 : 503;
      return c.json({ code: error.code }, status);
    }
    return c.json({ code: 'EMAIL_RULE_UNAVAILABLE' }, 503);
  };
  const contentType = (c: Context) => /^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type') ?? '');
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache'); await next(); });

  routes.get('/accounts/:accountId/rules', async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    try {
      const params = new URL(c.req.url).searchParams;
      if ([...params.keys()].some(key => !['cursor', 'limit'].includes(key)) || ['cursor', 'limit'].some(key => params.getAll(key).length > 1)) return c.json({ code: 'EMAIL_RULE_INVALID' }, 400);
      const query = EmailRuleListQuerySchema.parse({ cursor: params.get('cursor'), limit: params.get('limit') === null ? 50 : Number(params.get('limit')) });
      const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.rules(actor(session))).list(actor(session), scope, query.cursor, query.limit, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });

  routes.post('/accounts/:accountId/rules', bodyLimit({ maxSize: 40 * 1024, onError: c => c.json({ code: 'EMAIL_RULE_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search || !contentType(c)) return c.json({ code: 'EMAIL_RULE_INVALID' }, 400);
    try {
      let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_RULE_INVALID' }, 400); }
      const input = EmailRuleCreateSchema.parse(body), scope = { org_id: session.org_id, owner_user_id: session.id,
        account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.rules(actor(session))).create(actor(session), scope, input.rule_id, input.content, c.req.raw.signal, input.state);
      c.req.raw.signal.throwIfAborted(); return c.json(result, 201);
    } catch (error) { return fail(c, error); }
  });

  routes.get('/accounts/:accountId/rules/:ruleId', async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search) return c.json({ code: 'EMAIL_RULE_INVALID' }, 400);
    try { const scope = { org_id: session.org_id, owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.rules(actor(session))).read(actor(session), scope, EmailRuleIdSchema.parse(c.req.param('ruleId')), c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });

  routes.put('/accounts/:accountId/rules/:ruleId', bodyLimit({ maxSize: 40 * 1024,
    onError: c => c.json({ code: 'EMAIL_RULE_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search || !contentType(c)) return c.json({ code: 'EMAIL_RULE_INVALID' }, 400);
    try { let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_RULE_INVALID' }, 400); }
      const input = EmailRuleUpdateSchema.parse(body), scope = { org_id: session.org_id, owner_user_id: session.id,
        account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.rules(actor(session))).update(actor(session), scope, EmailRuleIdSchema.parse(c.req.param('ruleId')),
        input.expected_revision, input.content, input.state, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });

  routes.post('/accounts/:accountId/rules/:ruleId/archive', bodyLimit({ maxSize: 2 * 1024,
    onError: c => c.json({ code: 'EMAIL_RULE_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search || !contentType(c)) return c.json({ code: 'EMAIL_RULE_INVALID' }, 400);
    try { let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_RULE_INVALID' }, 400); }
      const input = EmailRuleArchiveSchema.parse(body), scope = { org_id: session.org_id, owner_user_id: session.id,
        account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.rules(actor(session))).archive(actor(session), scope, EmailRuleIdSchema.parse(c.req.param('ruleId')),
        input.expected_revision, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });

  routes.put('/accounts/:accountId/rules/order', bodyLimit({ maxSize: 16 * 1024,
    onError: c => c.json({ code: 'EMAIL_RULE_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search || !contentType(c)) return c.json({ code: 'EMAIL_RULE_INVALID' }, 400);
    try { let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_RULE_INVALID' }, 400); }
      const input = EmailRuleOrderSchema.parse(body), scope = { org_id: session.org_id, owner_user_id: session.id,
        account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.rules(actor(session))).reorder(actor(session), scope, input.rules, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json({ items: result });
    } catch (error) { return fail(c, error); }
  });

  routes.post('/accounts/:accountId/rules/preview', bodyLimit({ maxSize: 4 * 1024,
    onError: c => c.json({ code: 'EMAIL_RULE_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (new URL(c.req.url).search || !contentType(c)) return c.json({ code: 'EMAIL_RULE_INVALID' }, 400);
    try { let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_RULE_INVALID' }, 400); }
      const input = EmailRulePreviewRequestSchema.parse(body), scope = { org_id: session.org_id, owner_user_id: session.id,
        account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.rules(actor(session))).preview(actor(session), scope, input, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });

  routes.post('/accounts/:accountId/rules/:ruleId/review', bodyLimit({ maxSize: 8 * 1024,
    onError: c => c.json({ code: 'EMAIL_RULE_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (!dependencies.execution || new URL(c.req.url).search || !contentType(c)) return c.json({ code: 'EMAIL_RULE_INVALID' }, 400);
    try { let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_RULE_INVALID' }, 400); }
      const input = EmailRuleReviewRequestSchema.parse(body), scope = { org_id: session.org_id, owner_user_id: session.id,
        account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.execution(actor(session))).review(actor(session), scope, EmailRuleIdSchema.parse(c.req.param('ruleId')), input, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });

  routes.post('/accounts/:accountId/rules/execute', bodyLimit({ maxSize: 84 * 1024,
    onError: c => c.json({ code: 'EMAIL_RULE_TOO_LARGE' }, 413) }), async c => {
    const session = await verified(c); if (!session) return c.json({ code: 'EMAIL_AUTH_REQUIRED' }, 401);
    if (!dependencies.execution || new URL(c.req.url).search || !contentType(c)) return c.json({ code: 'EMAIL_RULE_INVALID' }, 400);
    try { let body: unknown; try { body = await c.req.json(); } catch { return c.json({ code: 'EMAIL_RULE_INVALID' }, 400); }
      const input = z.strictObject({ review_token: z.string().min(1).max(80_000) }).parse(body), scope = { org_id: session.org_id,
        owner_user_id: session.id, account_id: Identifier.parse(c.req.param('accountId')) };
      const result = await (await dependencies.execution(actor(session))).execute(actor(session), scope, input.review_token, c.req.raw.signal);
      c.req.raw.signal.throwIfAborted(); return c.json(result);
    } catch (error) { return fail(c, error); }
  });

  return routes;
}
