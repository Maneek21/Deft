import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { appRuntimeChannelEnabled } from '../lib/app-runtime-channel.js';
import { getAppRunRuntime } from '../lib/app-run-runtime.js';

const MAX_RUNTIME_BODY_BYTES = 1_100_000;
const RUNTIME_READ_DEADLINE_MS = 15_000;
export const appRuntimeChannelRoutes = new Hono();

// Flag gate runs before body consumption or database access. This router must
// be mounted outside human/employee cookie middleware; no cookie is accepted.
appRuntimeChannelRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!appRuntimeChannelEnabled()) {
    return c.json({ error: 'Runtime channel unavailable', code: 'APP_RUNTIME_DISABLED' }, 503);
  }
  if (c.req.header('cookie')) {
    return c.json({ error: 'Runtime credential required', code: 'APP_RUNTIME_ACCESS_DENIED' }, 403);
  }
  await next();
});

async function request(c: Context, maxBytes: number): Promise<Record<string, unknown>> {
  const authorization = c.req.header('authorization') ?? '';
  const match = /^AppRuntime ([A-Za-z0-9_-]{32,512})$/u.exec(authorization);
  if (!match) throw new Error('AUTH');
  if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new Error('JSON');
  }
  const declared = Number(c.req.header('content-length') ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) throw new Error('SIZE');
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new Error('JSON');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + RUNTIME_READ_DEADLINE_MS;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('TIMEOUT');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('TIMEOUT')), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error('SIZE');
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.hasOwn(body, 'session_token')) throw new Error('JSON');
  return { ...body, session_token: match[1] };
}

function failure(c: Context, error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError
    || error instanceof TypeError || (error instanceof Error && ['JSON', 'SIZE'].includes(error.message))) {
    const tooLarge = error instanceof Error && error.message === 'SIZE';
    return c.json({ error: tooLarge ? 'Runtime request too large' : 'Invalid runtime request',
      code: 'VALIDATION_ERROR' }, tooLarge ? 413 : 400);
  }
  if (error instanceof Error && error.message === 'AUTH') {
    return c.json({ error: 'Runtime credential required', code: 'APP_RUNTIME_ACCESS_DENIED' }, 403);
  }
  if (error instanceof Error && error.message === 'TIMEOUT') {
    return c.json({ error: 'Runtime request timed out', code: 'APP_RUNTIME_TIMEOUT' }, 408);
  }
  console.error('[app-runtime] channel request failed');
  return c.json({ error: 'Runtime request failed', code: 'INTERNAL_ERROR' }, 500);
}

appRuntimeChannelRoutes.post('/claim', async (c) => {
  try {
    const payload = await request(c, 4096);
    const claim = await (await getAppRunRuntime()).runtimeChannel.claim(payload);
    return claim ? c.json({ claim }) : c.json({ claim: null });
  } catch (error) { return failure(c, error); }
});
appRuntimeChannelRoutes.post('/start', async (c) => {
  try {
    const payload = await request(c, 4096);
    const started = await (await getAppRunRuntime()).runtimeChannel.start(payload);
    return started ? c.json({ started })
      : c.json({ error: 'Runtime claim unavailable', code: 'APP_RUNTIME_ACCESS_DENIED' }, 403);
  } catch (error) { return failure(c, error); }
});
appRuntimeChannelRoutes.post('/heartbeat', async (c) => {
  try {
    const payload = await request(c, 4096);
    const renewed = await (await getAppRunRuntime()).runtimeChannel.heartbeat(payload);
    return renewed ? c.json({ renewed: true })
      : c.json({ error: 'Runtime claim unavailable', code: 'APP_RUNTIME_ACCESS_DENIED' }, 403);
  } catch (error) { return failure(c, error); }
});
appRuntimeChannelRoutes.post('/result', async (c) => {
  try {
    const payload = await request(c, MAX_RUNTIME_BODY_BYTES);
    const run = await (await getAppRunRuntime()).runtimeChannel.complete(payload);
    return run ? c.json({ run })
      : c.json({ error: 'Runtime claim unavailable', code: 'APP_RUNTIME_ACCESS_DENIED' }, 403);
  } catch (error) { return failure(c, error); }
});
