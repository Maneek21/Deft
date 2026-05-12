import { rateLimiter } from 'hono-rate-limiter';
import type { Context } from 'hono';

// Per-IP for unauthenticated routes (login, signup, forgot-password).
// 10 requests / minute is enough for a human and brutal on a brute-forcer.
export const authLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  keyGenerator: (c: Context) => {
    return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
           c.req.header('x-real-ip') ||
           'unknown';
  },
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
  keyGenerator: (c: Context) => {
    const user = c.get('user') as { id?: string } | undefined;
    return user?.id || c.req.header('x-forwarded-for') || 'unknown';
  },
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
  keyGenerator: (c: Context) => {
    const user = c.get('user') as { id?: string } | undefined;
    return user?.id || c.req.header('x-forwarded-for') || 'unknown';
  },
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
  keyGenerator: (c: Context) => {
    const user = c.get('user') as { id?: string } | undefined;
    return user?.id || c.req.header('x-forwarded-for') || 'unknown';
  },
  handler: (c) => c.json({
    error: 'Too many requests.',
    code: 'RATE_LIMITED',
  }, 429),
});
