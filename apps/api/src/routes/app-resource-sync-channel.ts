import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { appResourceSyncChannelEnabled } from '../lib/app-resource-sync-channel.js';
import { getAppRunRuntime } from '../lib/app-run-runtime.js';
import { APP_RESOURCE_SYNC_AUDIENCE, APP_RESOURCE_SYNC_CHANNEL_VERSION } from '../lib/app-resource-sync-contract.js';

const MAX_BODY_BYTES = 1_100_000;
const READ_DEADLINE_MS = 15_000;
const identity = { schema_version: APP_RESOURCE_SYNC_CHANNEL_VERSION,
  audience: APP_RESOURCE_SYNC_AUDIENCE } as const;

/** Mounted before human/employee middleware; the token only comes from the
 * dedicated Authorization header and never from a cookie or JSON body. */
export const appResourceSyncChannelRoutes = new Hono();
appResourceSyncChannelRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!appResourceSyncChannelEnabled()) {
    return c.json({ error: 'Resource sync channel unavailable', code: 'APP_RESOURCE_SYNC_DISABLED' }, 503);
  }
  if (c.req.header('cookie')) {
    return c.json({ error: 'Resource sync credential required', code: 'APP_RESOURCE_SYNC_ACCESS_DENIED' }, 403);
  }
  await next();
});

async function request(c: Context, maxBytes: number): Promise<Record<string, unknown>> {
  const match = /^AppRuntime ([A-Za-z0-9_-]{32,512})$/u.exec(c.req.header('authorization') ?? '');
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
  const deadline = Date.now() + READ_DEADLINE_MS;
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
    return c.json({ error: tooLarge ? 'Resource sync request too large' : 'Invalid resource sync request',
      code: tooLarge ? 'APP_RESOURCE_SYNC_TOO_LARGE' : 'APP_RESOURCE_SYNC_INVALID_REQUEST' },
    tooLarge ? 413 : 400);
  }
  if (error instanceof Error && error.message === 'AUTH') {
    return c.json({ error: 'Resource sync credential required',
      code: 'APP_RESOURCE_SYNC_ACCESS_DENIED' }, 403);
  }
  if (error instanceof Error && error.message === 'TIMEOUT') {
    return c.json({ error: 'Resource sync request timed out',
      code: 'APP_RESOURCE_SYNC_TIMEOUT' }, 408);
  }
  console.error('[app-resource-sync] channel request failed');
  return c.json({ error: 'Resource sync request failed', code: 'APP_RESOURCE_SYNC_FAILURE' }, 500);
}

appResourceSyncChannelRoutes.post('/claim', async (c) => {
  try {
    const payload = await request(c, 4096);
    const claim = await (await getAppRunRuntime()).resourceSyncChannel.claim(payload);
    return c.json({ ...identity, claim });
  } catch (error) { return failure(c, error); }
});
appResourceSyncChannelRoutes.post('/start', async (c) => {
  try {
    const payload = await request(c, 4096);
    const started = await (await getAppRunRuntime()).resourceSyncChannel.start(payload);
    return started ? c.json({ ...identity, started })
      : c.json({ error: 'Resource sync credential required',
        code: 'APP_RESOURCE_SYNC_ACCESS_DENIED' }, 403);
  } catch (error) { return failure(c, error); }
});
appResourceSyncChannelRoutes.post('/heartbeat', async (c) => {
  try {
    const payload = await request(c, 4096);
    const renewed = await (await getAppRunRuntime()).resourceSyncChannel.heartbeat(payload);
    return renewed ? c.json({ ...identity, work_kind: 'sync_page', ...renewed, renewed: true })
      : c.json({ error: 'Resource sync credential required',
        code: 'APP_RESOURCE_SYNC_ACCESS_DENIED' }, 403);
  } catch (error) { return failure(c, error); }
});
appResourceSyncChannelRoutes.post('/result', async (c) => {
  try {
    const payload = await request(c, MAX_BODY_BYTES);
    const accepted = await (await getAppRunRuntime()).resourceSyncChannel.complete(payload);
    return accepted ? c.json({ ...identity, work_kind: 'sync_page', ...accepted, accepted: true })
      : c.json({ error: 'Resource sync credential required',
        code: 'APP_RESOURCE_SYNC_ACCESS_DENIED' }, 403);
  } catch (error) { return failure(c, error); }
});
