import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { appAttachmentSyncChannelEnabled } from '../lib/app-attachment-sync-channel.js';
import { getAppAttachmentRuntime } from '../lib/app-attachment-runtime.js';
import { readAttachmentFrame } from '../lib/app-attachment-frame.js';
import { AppError } from '../lib/app-errors.js';
import { APP_RESOURCE_SYNC_CHANNEL_VERSION_V3 } from '@deft/app-kit';
const APP_RESOURCE_SYNC_AUDIENCE='app_resource_sync' as const;
const APP_RESOURCE_SYNC_CHANNEL_VERSION=APP_RESOURCE_SYNC_CHANNEL_VERSION_V3;

const MAX_BODY_BYTES = 1_100_000;
const READ_DEADLINE_MS = 10_000;
const identity = { schema_version: APP_RESOURCE_SYNC_CHANNEL_VERSION,
  audience: APP_RESOURCE_SYNC_AUDIENCE } as const;

/** Mounted before human/employee middleware; the token only comes from the
 * dedicated Authorization header and never from a cookie or JSON body. */
export const appAttachmentSyncChannelRoutes = new Hono();
appAttachmentSyncChannelRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!appAttachmentSyncChannelEnabled()) {
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
  if(error instanceof AppError) return c.json({error:error.message,code:error.code},error.status as 400|403|409|503);
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

appAttachmentSyncChannelRoutes.post('/claim', async (c) => {
  try {
    const payload = await request(c, 4096);
    const claim = await (await getAppAttachmentRuntime()).channel.claim(payload);
    return c.json({ ...identity, claim });
  } catch (error) { return failure(c, error); }
});
appAttachmentSyncChannelRoutes.post('/start', async (c) => {
  try {
    const payload = await request(c, 4096);
    const started = await (await getAppAttachmentRuntime()).channel.start(payload);
    return started ? c.json({ ...identity, started })
      : c.json({ error: 'Resource sync credential required',
        code: 'APP_RESOURCE_SYNC_ACCESS_DENIED' }, 403);
  } catch (error) { return failure(c, error); }
});
appAttachmentSyncChannelRoutes.post('/heartbeat', async (c) => {
  try {
    const payload = await request(c, 4096);
    const renewed = await (await getAppAttachmentRuntime()).channel.heartbeat(payload);
    return renewed ? c.json({ ...identity, work_kind: 'sync_page', ...renewed, renewed: true })
      : c.json({ error: 'Resource sync credential required',
        code: 'APP_RESOURCE_SYNC_ACCESS_DENIED' }, 403);
  } catch (error) { return failure(c, error); }
});
appAttachmentSyncChannelRoutes.post('/result', async (c) => {
  try {
    const payload = await request(c, MAX_BODY_BYTES);
    const accepted = await (await getAppAttachmentRuntime()).channel.complete(payload);
    return accepted ? c.json({ ...identity, work_kind: 'sync_page', ...accepted, accepted: true })
      : c.json({ error: 'Resource sync credential required',
        code: 'APP_RESOURCE_SYNC_ACCESS_DENIED' }, 403);
  } catch (error) { return failure(c, error); }
});

appAttachmentSyncChannelRoutes.post('/attachments/stage',async c=>{
  let frame: Awaited<ReturnType<typeof readAttachmentFrame>>|undefined;
  try {
    const match=/^AppRuntime ([A-Za-z0-9_-]{32,512})$/u.exec(c.req.header('authorization')??'');
    if(!match)throw new Error('AUTH');
    if(c.req.header('content-type')?.trim().toLowerCase()!=='application/vnd.deft.sync-attachment.v1')throw new Error('JSON');
    if(new URL(c.req.url).search)throw new Error('JSON');
    const length=c.req.header('content-length');
    frame=await readAttachmentFrame(c.req.raw.body,c.req.raw.signal,length===undefined?undefined:Number(length));
    const reply=await (await getAppAttachmentRuntime()).custody.stage(frame.header,match[1]!,frame.readBytes,c.req.raw.signal,frame.deadline);
    return c.json(reply);
  }catch(error){return failure(c,error);}finally{await frame?.close();}
});
