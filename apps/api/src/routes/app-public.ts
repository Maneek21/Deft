import { Hono } from 'hono';
import { AppPublicError, AppPublicClaimService, appPublicClaimService } from '../lib/app-public-service.js';
import { appPublicLimits } from '../middleware/app-public-limits.js';

// Deliberately unmounted until the public gateway review and limits are wired.
// This route never reads workspace cookies, bearer headers or c.get('user').
const HARD_BODY_LIMIT = 8192;
const READ_DEADLINE_MS = 10_000;

async function boundedBody(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, READ_DEADLINE_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) throw new AppPublicError('PUBLIC_UNAVAILABLE', 503);
      if (done) break;
      size += value.byteLength;
      if (size > HARD_BODY_LIMIT) {
        void reader.cancel().catch(() => undefined);
        throw new AppPublicError('PUBLIC_PAYLOAD_TOO_LARGE', 413);
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export function createAppPublicRoutes(service: AppPublicClaimService = appPublicClaimService) {
  const routes = new Hono();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!service.isEnabled()) {
      return c.json({ error: 'Public endpoint not found', code: 'PUBLIC_NOT_FOUND' }, 404);
    }
    await next();
  });
  routes.use('*', appPublicLimits);
  routes.post('/:slug/claims', async (c) => {
  try {
    if (!service.isEnabled()) throw new AppPublicError('PUBLIC_NOT_FOUND', 404);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
      return c.json({ error: 'JSON body required', code: 'PUBLIC_INVALID_INPUT' }, 400);
    }
    const rawBody = await boundedBody(c.req.raw.body);
    const result = await service.claim(c.req.param('slug'), rawBody);
    c.header('Cache-Control', 'no-store');
    return c.json({ result }, result.replayed ? 200 : 201);
  } catch (error) {
    c.header('Cache-Control', 'no-store');
    if (error instanceof AppPublicError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    return c.json({ error: 'Public claim is temporarily unavailable', code: 'PUBLIC_UNAVAILABLE' }, 503);
  }
  });
  return routes;
}

export const appPublicRoutes = createAppPublicRoutes();
