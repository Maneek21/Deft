import { Hono, type Context } from 'hono';
import type { AuthUser } from '../middleware/auth.js';
import { AppExperienceService, appExperienceService } from '../lib/app-experience-service.js';
import { appHttpFailure } from './app-http-errors.js';
import { verifyWebAccess } from '../lib/web-sessions.js';
import { isAppExperienceResourceExposureEnabled } from '../lib/env.js';
import { AppExperienceExposureService } from '../lib/app-experience-exposure.js';
import { getAppRunRuntime } from '../lib/app-run-runtime.js';
import { ExperienceExposureError } from '../lib/app-experience-exposure-contract.js';
import { z } from 'zod';
import { AppPrivateStateService } from '../lib/app-private-state-service.js';
import { AppPrivateStateAdoptionService } from '../lib/app-private-state-adoption-service.js';

const MAX_ACTION_BYTES = 65_536;
const READ_DEADLINE_MS = 10_000;

async function boundedJson(stream: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (!stream) throw new Error('APP_EXPERIENCE_BODY_INVALID');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const deadline = Date.now() + READ_DEADLINE_MS;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('APP_EXPERIENCE_BODY_INVALID');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('APP_EXPERIENCE_BODY_INVALID')), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ACTION_BYTES) throw new Error('APP_EXPERIENCE_BODY_INVALID');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new Error('APP_EXPERIENCE_BODY_INVALID'); }
}

async function caller(c: Context) {
  const bearer = /^Bearer ([^\s]+)$/.exec(c.req.header('authorization') ?? '');
  if (!bearer) throw new Error('APP_EXPERIENCE_NO_AUTH');
  let user: Awaited<ReturnType<typeof verifyWebAccess>>;
  try { user = await verifyWebAccess(bearer[1]!); } catch { throw new Error('APP_EXPERIENCE_NO_AUTH'); }
  const injected = c.get('user') as AuthUser | undefined;
  if (injected && (injected.id !== user.id || injected.org_id !== user.org_id || injected.sid !== user.sid)) throw new Error('APP_EXPERIENCE_NO_AUTH');
  return { org_id: user.org_id, user_id: user.id, sid: user.sid, access_expires_at: user.exp * 1000 };
}

function failure(c: Context, error: unknown) {
  if (error instanceof ExperienceExposureError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof Error && error.message === 'APP_EXPERIENCE_BODY_INVALID') {
    return c.json({ error: 'Invalid Experience action request', code: 'VALIDATION_ERROR' }, 400);
  }
  if (error instanceof Error && error.message === 'APP_EXPERIENCE_NO_AUTH') {
    return c.json({ error: 'Experience access denied', code: 'APP_ACCESS_DENIED' }, 403);
  }
  return appHttpFailure(c, error, 'App action', 'app-actions');
}

/** Mount behind the existing web Bearer-authenticated API group. */
export function createAppExperienceRoutes(service: AppExperienceService = appExperienceService) {
  const routes = new Hono();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    await next();
  });
  routes.post('/:installationId/:experienceKey/sessions', async (c) => {
    try {
      return c.json(await service.create(await caller(c),
        c.req.param('installationId'), c.req.param('experienceKey')));
    } catch (error) { return failure(c, error); }
  });
  routes.get('/sessions/:sessionId/live', async (c) => {
    try {
      return c.json(await service.live(await caller(c),
        c.req.param('sessionId')));
    } catch (error) { return failure(c, error); }
  });
  routes.get('/sessions/:sessionId/runs/:runId', async (c) => {
    try {
      if (new URL(c.req.url).search) throw new Error('APP_EXPERIENCE_BODY_INVALID');
      return c.json(await service.runStatus(await caller(c), c.req.param('sessionId'), c.req.param('runId'), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.get('/sessions/:sessionId/runs/:runId/review-target', async c => {
    try {
      if (new URL(c.req.url).search) throw new Error('APP_EXPERIENCE_BODY_INVALID');
      return c.json(await service.runReviewTarget(await caller(c), c.req.param('sessionId'), c.req.param('runId'), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.delete('/sessions/:sessionId', async (c) => {
    try {
      return c.json(await service.revoke(await caller(c),
        c.req.param('sessionId')));
    } catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:sessionId/actions/:actionKey', async (c) => {
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
        throw new Error('APP_EXPERIENCE_BODY_INVALID');
      }
      const declared = Number(c.req.header('content-length') ?? 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_ACTION_BYTES) {
        throw new Error('APP_EXPERIENCE_BODY_INVALID');
      }
      const body = await boundedJson(c.req.raw.body);
      return c.json(await service.action(await caller(c),
        c.req.param('sessionId'), c.req.param('actionKey'), body));
    } catch (error) { return failure(c, error); }
  });
  const exposure = async () => {
    if (!isAppExperienceResourceExposureEnabled()) throw new ExperienceExposureError('APP_EXPERIENCE_EXPOSURE_DISABLED', 503);
    return new AppExperienceExposureService((await getAppRunRuntime()).keys);
  };
  const noQuery = (c: Context) => {
    if (new URL(c.req.url).search) throw new Error('APP_EXPERIENCE_BODY_INVALID');
  };
  const jsonBody = async (c: Context) => {
    noQuery(c);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) throw new Error('APP_EXPERIENCE_BODY_INVALID');
    const declared = Number(c.req.header('content-length') ?? 0);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_ACTION_BYTES) throw new Error('APP_EXPERIENCE_BODY_INVALID');
    c.req.raw.signal.throwIfAborted();
    return boundedJson(c.req.raw.body);
  };
  routes.post('/sessions/:sessionId/access/acquire', async c => {
    try { const host = await caller(c); z.strictObject({}).parse(await jsonBody(c));
      return c.json(await (await exposure()).acquire(host, c.req.param('sessionId'), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:sessionId/access/review', async c => {
    try { const host = await caller(c); z.strictObject({}).parse(await jsonBody(c));
      return c.json(await (await exposure()).reviewAccess(host, c.req.param('sessionId'), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:sessionId/access/accept', async c => {
    try { const host = await caller(c); const body = await jsonBody(c);
      return c.json(await (await exposure()).acceptAccess(host, c.req.param('sessionId'), body, c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:sessionId/refresh', async c => {
    try { const host = await caller(c); z.strictObject({}).parse(await jsonBody(c));
      return c.json(await (await exposure()).refresh(host, c.req.param('sessionId'), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.delete('/sessions/:sessionId/access', async c => {
    try { noQuery(c); return c.json(await (await exposure()).revokeAccess(await caller(c), c.req.param('sessionId'), c.req.raw.signal)); }
    catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:sessionId/exposure/review', async c => {
    try {
      const host = await caller(c); const consumer = await exposure();
      z.strictObject({}).parse(await jsonBody(c));
      return c.json(await consumer.prepare(host, c.req.param('sessionId'), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:sessionId/exposure/accept', async c => {
    try {
      const host = await caller(c); const consumer = await exposure();
      return c.json(await consumer.accept(host, c.req.param('sessionId'), await jsonBody(c), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.get('/sessions/:sessionId/exposure', async c => {
    try {
      noQuery(c);
      return c.json(await (await exposure()).status(await caller(c), c.req.param('sessionId'), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.delete('/sessions/:sessionId/exposure', async c => {
    try { noQuery(c); return c.json(await (await exposure()).revoke(await caller(c), c.req.param('sessionId'), c.req.raw.signal)); }
    catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:sessionId/resources/:resourceKey', async c => {
    try {
      const host = await caller(c); const consumer = await exposure();
      return c.json(await consumer.read(host, c.req.param('sessionId'), c.req.param('resourceKey'), await jsonBody(c), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:sessionId/resources/:resourceKey/target', async c => {
    try {
      return c.json(await (await exposure()).resourceTarget(await caller(c), c.req.param('sessionId'),
        c.req.param('resourceKey'), await jsonBody(c), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:sessionId/state/:stateKey', async c => {
    try {
      const consumer = new AppPrivateStateService((await getAppRunRuntime()).keys);
      return c.json(await consumer.request(await caller(c), c.req.param('sessionId'), c.req.param('stateKey'), await jsonBody(c), c.req.raw.signal));
    } catch (error) { return failure(c, error); }
  });
  for (const operation of ['context', 'review', 'activate'] as const) {
    routes.post(`/sessions/:sessionId/state/:stateKey/adoption/${operation}`, async c => {
      try {
        const consumer = new AppPrivateStateAdoptionService((await getAppRunRuntime()).keys);
        return c.json(await consumer.request(await caller(c), c.req.param('sessionId'), c.req.param('stateKey'),
          operation, await jsonBody(c), c.req.raw.signal));
      } catch (error) { return failure(c, error); }
    });
  }
  return routes;
}

export const appExperienceRoutes = createAppExperienceRoutes();
