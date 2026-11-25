/**
 * POST /api/telemetry/client-error — the web app reports a browser error to
 * its own cell (telemetry contract, section 1). Signed in or not, so it is
 * mounted ahead of the session middleware; it changes nothing in the
 * workspace and reads no account.
 *
 * Hosted cells scrub the report and add it to the error events they send to
 * the control plane as kind `client`. Every other install answers
 * `{ "enabled": false }`, keeps nothing, and the page stops reporting.
 *
 * Limited per session (the bearer it carries, hashed, or else the client
 * address) and per client address, with a ceiling for the whole server.
 */
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
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

export function createTelemetryRoutes(limits: { perSession?: number; perAddress?: number; perServer?: number } = {}) {
  const addressKey = createInviteClientKey();
  const sessionKey = async (c: Context) => {
    const authorization = c.req.header('authorization')?.trim();
    return authorization
      ? `session:${createHash('sha256').update(authorization).digest('hex').slice(0, 32)}`
      : `address:${await addressKey(c)}`;
  };
  const perServer = rateLimiter({ windowMs: 60_000, limit: limits.perServer ?? 600, keyGenerator: () => 'client-error', handler: limited });
  const perAddress = rateLimiter({ windowMs: 60_000, limit: limits.perAddress ?? 30, keyGenerator: addressKey, handler: limited });
  const perSession = rateLimiter({ windowMs: 60_000, limit: limits.perSession ?? 10, keyGenerator: sessionKey, handler: limited });

  const routes = new Hono();
  routes.post(
    '/client-error',
    bodyLimit({ maxSize: 24 * 1024, onError: (c) => c.json({ error: 'Request body is too large', code: 'VALIDATION_ERROR' }, 413) }),
    perServer,
    perAddress,
    perSession,
    async (c) => {
      c.header('Cache-Control', 'no-store');
      if (!isErrorTelemetryEnabled()) return c.json({ enabled: false });
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
