import { Hono, type Context } from 'hono';
import type { AuthUser } from '../middleware/auth.js';
import { AppExperienceService, appExperienceService } from '../lib/app-experience-service.js';
import { appHttpFailure } from './app-http-errors.js';

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

function caller(user: AuthUser | undefined) {
  if (!user?.id || !user.org_id || !user.sid) throw new Error('APP_EXPERIENCE_NO_AUTH');
  return { org_id: user.org_id, user_id: user.id, sid: user.sid };
}

function failure(c: Context, error: unknown) {
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
      return c.json(await service.create(caller(c.get('user') as AuthUser | undefined),
        c.req.param('installationId'), c.req.param('experienceKey')));
    } catch (error) { return failure(c, error); }
  });
  routes.get('/sessions/:sessionId/live', async (c) => {
    try {
      return c.json(await service.live(caller(c.get('user') as AuthUser | undefined),
        c.req.param('sessionId')));
    } catch (error) { return failure(c, error); }
  });
  routes.delete('/sessions/:sessionId', async (c) => {
    try {
      return c.json(await service.revoke(caller(c.get('user') as AuthUser | undefined),
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
      return c.json(await service.action(caller(c.get('user') as AuthUser | undefined),
        c.req.param('sessionId'), c.req.param('actionKey'), body));
    } catch (error) { return failure(c, error); }
  });
  return routes;
}

export const appExperienceRoutes = createAppExperienceRoutes();
