/**
 * POST /api/telemetry/client-error — the web app reports a browser error to
 * its own cell (telemetry contract, section 1). Signed in or not, so it is
 * mounted ahead of the session middleware; it changes nothing in the
 * workspace and reads no account.
 *
 * Hosted cells scrub the report and add it to the error events they send to
 * the control plane as kind `client`. Every other install answers
 * `{ "enabled": false }` without reading the body, keeps nothing, and the
 * page stops reporting.
 *
 * Limits, all checked before the body is read: per client address first,
 * then per session (a verified web session, or the address when there is
 * none), then a ceiling for the whole server that only requests admitted by
 * the first two count against, so one noisy address cannot use it up.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { rateLimiter } from 'hono-rate-limiter';
import { z } from 'zod';
import { createInviteClientKey } from '../lib/invite-client-ip.js';
import { captureClientError, isErrorTelemetryEnabled } from '../lib/telemetry/error-reporter.js';
import { apiRouteTemplateFor, webPageTemplate } from '../lib/telemetry/route-templates.js';

const clientErrorSchema = z.object({
  type: z.enum(['error', 'rejection', 'api']),
  error_class: z.string().max(200).optional(),
  message: z.string().max(4000).optional(),
  stack: z.string().max(16_000).optional(),
  page: z.string().max(2048).optional(),
  method: z.string().max(10).optional(),
  api_path: z.string().max(2048).optional(),
  status: z.number().int().min(100).max(599).optional(),
  request_id: z.string().max(64).optional(),
});

const limited = (c: Context) => c.json({ error: 'Too many requests.', code: 'RATE_LIMITED' }, 429);

/** The verified web session a request carries, or null. */
async function verifiedSession(request: Request): Promise<string | null> {
  if (!request.headers.get('authorization')?.startsWith('Bearer ')) return null;
  try {
    const { authenticateWebRequest } = await import('../middleware/auth.js');
    const result = await authenticateWebRequest(request, false);
    return result.ok ? result.user.sid : null;
  } catch {
    return null;
  }
}

export function createTelemetryRoutes(options: {
  perSession?: number;
  perAddress?: number;
  perServer?: number;
  /** Test seams: the session a request carries, and its client address. */
  sessionOf?: (request: Request) => Promise<string | null>;
  addressOf?: (c: Context) => Promise<string>;
} = {}) {
  const addressKey = options.addressOf ?? createInviteClientKey();
  const sessionOf = options.sessionOf ?? verifiedSession;
  const sessionKey = async (c: Context) => {
    const sid = await sessionOf(c.req.raw);
    return sid ? `session:${sid}` : `address:${await addressKey(c)}`;
  };
  const perAddress = rateLimiter({ windowMs: 60_000, limit: options.perAddress ?? 30, keyGenerator: addressKey, handler: limited });
  const perSession = rateLimiter({ windowMs: 60_000, limit: options.perSession ?? 10, keyGenerator: sessionKey, handler: limited });
  const perServer = rateLimiter({ windowMs: 60_000, limit: options.perServer ?? 600, keyGenerator: () => 'client-error', handler: limited });
  const onlyWhenEnabled: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!isErrorTelemetryEnabled()) return c.json({ enabled: false });
    return next();
  };

  const routes = new Hono();
  routes.post(
    '/client-error',
    onlyWhenEnabled,
    perAddress,
    perSession,
    perServer,
    bodyLimit({ maxSize: 24 * 1024, onError: (c) => c.json({ error: 'Request body is too large', code: 'VALIDATION_ERROR' }, 413) }),
    async (c) => {
      const parsed = clientErrorSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
      const report = parsed.data;
      const api = report.type === 'api';
      captureClientError({
        errorClass: api ? 'ApiRequestFailed' : report.error_class,
        message: api ? '' : report.message,
        stack: api ? undefined : report.stack,
        route: api ? apiRouteTemplateFor(report.method, report.api_path) : webPageTemplate(report.page),
        method: api ? report.method : null,
        status: api ? report.status : null,
        requestIds: report.request_id ? [report.request_id] : [],
      });
      return c.json({ enabled: true });
    },
  );
  return routes;
}

export const telemetryRoutes = createTelemetryRoutes();
