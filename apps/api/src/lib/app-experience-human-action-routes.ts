import { Hono, type Context } from 'hono';
import { ExperienceExposureError } from './app-experience-exposure-contract.js';
import type { ExperienceCaller } from './app-experience-service.js';
import { z } from 'zod';
import { verifyWebAccess } from './web-sessions.js';
import { AppExperienceHumanActionService } from './app-experience-human-action-service.js';
import { appHttpFailure } from '../routes/app-http-errors.js';

const uuid = z.string().uuid();
const actionKey = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);
function failure(c: Context, error: unknown) {
  if (error instanceof ExperienceExposureError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof Error && error.message === 'APP_EXPERIENCE_BODY_INVALID') return c.json({ error: 'Invalid App action request', code: 'VALIDATION_ERROR' }, 400);
  return appHttpFailure(c, error, 'App action', 'app-actions');
}
async function body(stream: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
  if (!stream) throw Error('APP_EXPERIENCE_BODY_INVALID');
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, 10_000);
  try {
    for (;;) {
      signal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
      total += item.value.byteLength; if (total > 131_072) throw Error('APP_EXPERIENCE_BODY_INVALID'); chunks.push(item.value);
    }
    if (timedOut) throw Error('APP_EXPERIENCE_BODY_INVALID');
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
    catch { throw Error('APP_EXPERIENCE_BODY_INVALID'); }
  } finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Mount at /api/app-experiences. No Worker SDK operation is provided. */
export function createExperienceHumanActionRoutes(service: () => Promise<AppExperienceHumanActionService>) {
  const routes = new Hono<{ Variables: { humanActionCaller: ExperienceCaller } }>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    if (new URL(c.req.url).search || (['POST', 'PUT'].includes(c.req.method) && !/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? ''))) return c.json({ error: 'Invalid App action request', code: 'VALIDATION_ERROR' }, 400);
    try {
      const bearer = /^Bearer ([^\s]+)$/.exec(c.req.header('authorization') ?? '');
      if (!bearer) return c.json({ error: 'Human Web session required', code: 'UNAUTHORIZED' }, 401);
      const user = await verifyWebAccess(bearer[1]!).catch(() => null);
      if (!user) return c.json({ error: 'Human Web session required', code: 'UNAUTHORIZED' }, 401);
      c.set('humanActionCaller', { org_id: user.org_id, user_id: user.id, sid: user.sid, access_expires_at: user.exp * 1000 });
      await next();
    } catch (error) { return failure(c, error); }
  });
  routes.get('/sessions/:id/human-actions/:key/context', async c => {
    try { return c.json(await (await service()).context(c.get('humanActionCaller'), uuid.parse(c.req.param('id')), actionKey.parse(c.req.param('key')), c.req.raw.signal)); }
    catch (error) { return failure(c, error); }
  });
  routes.get('/sessions/:id/human-actions/:key/submissions/:idempotencyKey', async c => {
    try { return c.json(await (await service()).lookup(c.get('humanActionCaller'), uuid.parse(c.req.param('id')),
      actionKey.parse(c.req.param('key')), uuid.parse(c.req.param('idempotencyKey')), c.req.raw.signal)); }
    catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:id/human-actions/:key/prepare', async c => {
    try { return c.json(await (await service()).prepare(c.get('humanActionCaller' as never), uuid.parse(c.req.param('id')), actionKey.parse(c.req.param('key')), await body(c.req.raw.body, c.req.raw.signal), c.req.raw.signal)); }
    catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:id/human-actions/confirm', async c => {
    try { return c.json(await (await service()).confirm(c.get('humanActionCaller' as never), uuid.parse(c.req.param('id')), await body(c.req.raw.body, c.req.raw.signal), c.req.raw.signal)); }
    catch (error) { return failure(c, error); }
  });
  routes.get('/sessions/:id/agent-policies/:key', async c => {
    try { return c.json(await (await service()).agentPolicy(c.get('humanActionCaller'), uuid.parse(c.req.param('id')), actionKey.parse(c.req.param('key')), undefined, c.req.raw.signal)); }
    catch(error) { return failure(c,error); }
  });
  routes.put('/sessions/:id/agent-policies/:key', async c => {
    try { return c.json(await (await service()).agentPolicy(c.get('humanActionCaller'), uuid.parse(c.req.param('id')), actionKey.parse(c.req.param('key')), await body(c.req.raw.body,c.req.raw.signal), c.req.raw.signal)); }
    catch(error) { return failure(c,error); }
  });
  return routes;
}
