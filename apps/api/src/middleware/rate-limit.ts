// In-memory store — fine for single-instance self-host. If we ever ship
// multi-instance, swap to the hono-rate-limiter Redis store.
import { rateLimiter } from 'hono-rate-limiter';
import type { Context } from 'hono';

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

// Per-IP for unauthenticated routes (login, signup, forgot-password).
// 10 requests / minute is enough for a human and brutal on a brute-forcer.
export const authLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  keyGenerator: ipKey,
  handler: (c) => c.json({
    error: 'Too many requests. Try again in a minute.',
    code: 'RATE_LIMITED',
  }, 429),
});

// Per-user for the agent surface. Agent calls hit Anthropic/OpenAI on every
// request and burn dollars — 30/min/user prevents a runaway client from
// draining a BYOK budget in seconds.
export const agentLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  keyGenerator: userOrIpKey,
  handler: (c) => c.json({
    error: 'Agent rate limit hit. Pause for a minute or talk to your admin about quota.',
    code: 'AGENT_RATE_LIMITED',
  }, 429),
});

// Per-user for uploads. 20/min lets a normal user paste a doc with images;
// stops scripted abuse.
export const uploadLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  keyGenerator: userOrIpKey,
  handler: (c) => c.json({
    error: 'Upload rate limit hit.',
    code: 'UPLOAD_RATE_LIMITED',
  }, 429),
});

// Default — covers everything else. Per-user for authed, per-IP for public.
export const defaultLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  keyGenerator: userOrIpKey,
  handler: (c) => c.json({
    error: 'Too many requests.',
    code: 'RATE_LIMITED',
  }, 429),
});

// Per-IP for unauthenticated webhook dispatch surfaces. GitHub webhooks
// and per-agent public webhooks both can trigger agent runs that burn
// BYOK budget. 60/min/IP tolerates legitimate burst delivery from a
// shared egress IP while stopping single-IP abuse.
export const webhookLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  keyGenerator: ipKey,
  handler: (c) => c.json({
    error: 'Webhook rate limit hit.',
    code: 'WEBHOOK_RATE_LIMITED',
  }, 429),
});
