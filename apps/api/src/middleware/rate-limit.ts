// In-memory store — fine for single-instance self-host. If we ever ship
// multi-instance, swap to the hono-rate-limiter Redis store.
import { rateLimiter } from 'hono-rate-limiter';
import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';

const isProduction = process.env.NODE_ENV === 'production';

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const AUTH_LIMIT_PER_MINUTE = positiveIntFromEnv(
  'DEFT_AUTH_RATE_LIMIT_PER_MINUTE',
  isProduction ? 10 : 120,
);
const AGENT_LIMIT_PER_MINUTE = positiveIntFromEnv(
  'DEFT_AGENT_RATE_LIMIT_PER_MINUTE',
  isProduction ? 30 : 300,
);
const UPLOAD_LIMIT_PER_MINUTE = positiveIntFromEnv(
  'DEFT_UPLOAD_RATE_LIMIT_PER_MINUTE',
  isProduction ? 20 : 120,
);
const DEFAULT_LIMIT_PER_MINUTE = positiveIntFromEnv(
  'DEFT_DEFAULT_RATE_LIMIT_PER_MINUTE',
  // The web app is a chatty SPA: a normal dashboard/chat/task sweep can issue
  // many protected reads before the user even sends a message. Keep auth,
  // upload, webhook, and agent-spend surfaces tighter, but give authenticated
  // app routes enough room for multi-user pilot/demo workflows.
  isProduction ? 600 : 2000,
);
const WEBHOOK_LIMIT_PER_MINUTE = positiveIntFromEnv(
  'DEFT_WEBHOOK_RATE_LIMIT_PER_MINUTE',
  isProduction ? 60 : 600,
);

function userOrIpKey(c: Context): string {
  const user = c.get('user') as { id?: string } | undefined;
  return user?.id ||
         c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
         c.req.header('x-real-ip') ||
         'unknown';
}

function ipKey(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
         c.req.header('x-real-ip') ||
         'unknown';
}

export function shouldBypassRateLimitForAudit(c: Context): boolean {
  if (process.env.NODE_ENV === 'production') return false;

  const expected = process.env.DEFT_AUDIT_BYPASS_TOKEN;
  if (!expected) return false;

  const provided = c.req.header('x-deft-audit-token');
  if (!provided) return false;

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function withAuditBypass(limiter: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    if (shouldBypassRateLimitForAudit(c)) {
      await next();
      return;
    }
    return limiter(c, next);
  };
}

// Per-IP for unauthenticated routes (login, signup, forgot-password).
// 10 requests / minute is enough for a human and brutal on a brute-forcer.
export const authLimiter = withAuditBypass(rateLimiter({
  windowMs: 60 * 1000,
  limit: AUTH_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  keyGenerator: ipKey,
  handler: (c) => c.json({
    error: 'Too many requests. Try again in a minute.',
    code: 'RATE_LIMITED',
  }, 429),
}));

// Per-user for the agent surface. Agent calls hit Anthropic/OpenAI on every
// request and burn dollars — 30/min/user prevents a runaway client from
// draining a BYOK budget in seconds.
export const agentLimiter = withAuditBypass(rateLimiter({
  windowMs: 60 * 1000,
  limit: AGENT_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  keyGenerator: userOrIpKey,
  handler: (c) => c.json({
    error: 'Agent rate limit hit. Pause for a minute or talk to your admin about quota.',
    code: 'AGENT_RATE_LIMITED',
  }, 429),
}));

// Per-user for uploads. 20/min lets a normal user paste a doc with images;
// stops scripted abuse.
export const uploadLimiter = withAuditBypass(rateLimiter({
  windowMs: 60 * 1000,
  limit: UPLOAD_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  keyGenerator: userOrIpKey,
  handler: (c) => c.json({
    error: 'Upload rate limit hit.',
    code: 'UPLOAD_RATE_LIMITED',
  }, 429),
}));

// Default — covers everything else. Per-user for authed, per-IP for public.
export const defaultLimiter = withAuditBypass(rateLimiter({
  windowMs: 60 * 1000,
  limit: DEFAULT_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  keyGenerator: userOrIpKey,
  handler: (c) => c.json({
    error: 'Too many requests.',
    code: 'RATE_LIMITED',
  }, 429),
}));

// Per-IP for unauthenticated webhook dispatch surfaces. GitHub webhooks
// and per-agent public webhooks both can trigger agent runs that burn
// BYOK budget. 60/min/IP tolerates legitimate burst delivery from a
// shared egress IP while stopping single-IP abuse.
export const webhookLimiter = withAuditBypass(rateLimiter({
  windowMs: 60 * 1000,
  limit: WEBHOOK_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  keyGenerator: ipKey,
  handler: (c) => c.json({
    error: 'Webhook rate limit hit.',
    code: 'WEBHOOK_RATE_LIMITED',
  }, 429),
}));
