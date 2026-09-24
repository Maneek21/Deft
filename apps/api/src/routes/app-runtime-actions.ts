import { Hono } from 'hono';
import type { AuthUser } from '../middleware/auth.js';
import { AppRuntimeActionService, appRuntimeActionService } from '../lib/app-runtime-action-service.js';
import { AppRunError } from '../lib/app-run-errors.js';
import { appRuntimeChannelEnabled } from '../lib/app-runtime-channel.js';
import { appHttpFailure } from './app-http-errors.js';

const MAX_REQUEST_BYTES = 65_536;
const READ_DEADLINE_MS = 10_000;

async function boundedJson(stream: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (!stream) throw new AppRunError('APP_RUN_INPUT_INVALID');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + READ_DEADLINE_MS;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppRunError('APP_RUN_INPUT_INVALID');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AppRunError('APP_RUN_INPUT_INVALID')), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        throw new AppRunError('APP_RUN_INPUT_TOO_LARGE');
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new AppRunError('APP_RUN_INPUT_INVALID');
  }
}

/** Mount behind the existing authenticated API group only after 03a review. */
export function createAppRuntimeActionRoutes(service: AppRuntimeActionService = appRuntimeActionService) {
  const routes = new Hono();
  routes.get('/:runId/review', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      if (!appRuntimeChannelEnabled()) throw new AppRunError('APP_RUNS_DISABLED');
      const user = c.get('user') as AuthUser | undefined;
      if (!user?.id || !user.org_id) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      return c.json({ review: await service.review({ org_id: user.org_id, user_id: user.id },
        c.req.param('runId')) });
    } catch (error) {
      return appHttpFailure(c, error, 'App Run', 'app-runs');
    }
  });
  routes.post('/invoke', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      if (!appRuntimeChannelEnabled()) throw new AppRunError('APP_RUNS_DISABLED');
      const user = c.get('user') as AuthUser | undefined;
      if (!user?.id || !user.org_id) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
        throw new AppRunError('APP_RUN_INPUT_INVALID');
      }
      const declared = Number(c.req.header('content-length') ?? 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_REQUEST_BYTES) {
        throw new AppRunError('APP_RUN_INPUT_TOO_LARGE');
      }
      const raw = await boundedJson(c.req.raw.body);
      return c.json({ run: await service.invoke({ org_id: user.org_id, user_id: user.id }, raw) });
    } catch (error) {
      return appHttpFailure(c, error, 'App Run', 'app-runs');
    }
  });
  return routes;
}

export const appRuntimeActionRoutes = createAppRuntimeActionRoutes();
