/**
 * Help for the signed-in person (telemetry contract, section 2).
 *
 *   GET  /api/support/config  what the help menu offers here
 *   POST /api/support/report  "Report a problem" (hosted cells only)
 *
 * Any signed-in person may use both, guests included. Hosted cells forward a
 * report to the control plane and answer with a short reference. Self-hosted
 * Deft never sends one: the menu shows the administrator's own support
 * address when DEFT_SUPPORT_EMAIL is set, and nothing otherwise.
 *
 * Reports are limited per person and per client address.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { rateLimiter } from 'hono-rate-limiter';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '@deft/db/schema';
import { db } from '../lib/db.js';
import { createInviteClientKey } from '../lib/invite-client-ip.js';
import { isPausedStart } from '../lib/paused-start.js';
import { browserFamily, scrubRequestIds } from '../lib/telemetry/scrub.js';
import { webPageTemplate } from '../lib/telemetry/route-templates.js';
import { problemReportTarget, selfHostedSupportEmail } from '../lib/telemetry/settings.js';
import {
  buildProblemReport,
  cleanReportText,
  REPORT_CATEGORIES,
  REPORT_TEXT_MAX,
  reportReference,
  sendProblemReport,
  type ReportRole,
} from '../lib/telemetry/problem-report.js';

const reportSchema = z.object({
  category: z.enum(REPORT_CATEGORIES),
  text: z.string().max(REPORT_TEXT_MAX + 200),
  email_me: z.boolean().default(true),
  page: z.string().max(2048).optional(),
  request_ids: z.array(z.string().max(64)).max(20).optional(),
});

const ROLES = new Set<ReportRole>(['owner', 'admin', 'member', 'guest']);

/** Test seams. The reporter's address comes from their account, never the form. */
export const supportDeps = {
  env: process.env as NodeJS.ProcessEnv,
  isPaused: (): boolean => isPausedStart(),
  accountEmail: async (userId: string): Promise<string | null> => {
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.email ?? null;
  },
};

function reportsAvailable(): boolean {
  return !supportDeps.isPaused() && problemReportTarget(supportDeps.env) !== null;
}

const limited = (c: Context) => c.json({ error: 'Too many reports. Try again in a few minutes.', code: 'RATE_LIMITED' }, 429);

export function createSupportRoutes(limits: { perPerson?: number; perAddress?: number; windowMs?: number } = {}) {
  const windowMs = limits.windowMs ?? 10 * 60 * 1000;
  const addressKey = createInviteClientKey();
  const perPerson = rateLimiter({
    windowMs,
    limit: limits.perPerson ?? 5,
    keyGenerator: async (c) => (c.get('user') as { id?: string } | undefined)?.id ?? `address:${await addressKey(c)}`,
    handler: limited,
  });
  const perAddress = rateLimiter({ windowMs, limit: limits.perAddress ?? 20, keyGenerator: addressKey, handler: limited });

  const routes = new Hono();

  routes.get('/config', (c) => c.json({
    report: reportsAvailable(),
    contact_email: selfHostedSupportEmail(supportDeps.env),
  }));

  routes.post(
    '/report',
    bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'Request body is too large', code: 'VALIDATION_ERROR' }, 413) }),
    perPerson,
    perAddress,
    async (c) => {
      const user = c.get('user');
      if (!user?.id) return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
      const role = user.role;
      if (!role || !ROLES.has(role)) return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
      const target = supportDeps.isPaused() ? null : problemReportTarget(supportDeps.env);
      if (!target) {
        return c.json({ error: 'Problem reports are not available on this Deft server.', code: 'NOT_AVAILABLE' }, 404);
      }
      const parsed = reportSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
      const text = cleanReportText(parsed.data.text);
      if (!text) return c.json({ error: 'Describe the problem first.', code: 'VALIDATION_ERROR' }, 400);

      const replyEmail = parsed.data.email_me ? await supportDeps.accountEmail(user.id) : null;
      const report = await buildProblemReport(target, {
        role,
        category: parsed.data.category,
        text,
        route: webPageTemplate(parsed.data.page) ?? '/',
        client: browserFamily(c.req.header('user-agent')),
        requestIds: scrubRequestIds(parsed.data.request_ids),
        replyEmail,
      });
      if (!(await sendProblemReport(target, report))) {
        return c.json({ error: 'Your report could not be sent. Try again in a few minutes.', code: 'REPORT_NOT_SENT' }, 503);
      }
      return c.json({ reference: reportReference(report.report_id) }, 201);
    },
  );

  return routes;
}

export const supportRoutes = createSupportRoutes();
