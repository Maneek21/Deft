import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthUser } from '../middleware/auth.js';
import { publicWebAuthority } from '../lib/app-public-web-authority.js';
import { AppError, isAppError } from '../lib/app-errors.js';
import { isModuleError } from '../lib/module-errors.js';
import { appRuntimeChannelEnabled } from '../lib/app-runtime-channel.js';
import { isAppNativeCalendarEnabled } from '../lib/env.js';
import { activatePublicEndpoint, disablePublicEndpoint,
  stagePublicEndpoint, rotatePublicHmacKey } from '../lib/app-public-management.js';
import { resourceSyncWebAuthority } from '../lib/app-resource-sync-web-authority.js';
import { reviewPublicCancellationOwner, submitPublicCancellationOwner } from '../lib/app-public-cancellation-owner.js';
import { AppRunError } from '../lib/app-run-errors.js';
import { appHttpFailure } from './app-http-errors.js';

export const appPublicManagementRoutes = new Hono();
const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const MAX_BODY_BYTES = 8192;
const READ_DEADLINE_MS = 10_000;

async function authority(c: Context) {
  const user = c.get('user') as AuthUser | undefined;
  if (!user?.id || !user.org_id || !user.sid) throw new AppError('Authentication required', 'APP_ACCESS_DENIED', 403);
  return publicWebAuthority(c.req.header('authorization'), user);
}

async function body(c: Context): Promise<unknown> {
  if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new AppError('JSON request required', 'APP_ACTION_INVALID', 400);
  }
  const declared = Number(c.req.header('content-length') ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
    throw new AppError('Public endpoint request too large', 'APP_ACTION_INVALID', 413);
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new AppError('JSON request required', 'APP_ACTION_INVALID', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + READ_DEADLINE_MS;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError('Public endpoint request timed out', 'APP_ACTION_INVALID', 400);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError('Public endpoint request timed out', 'APP_ACTION_INVALID', 400)), remaining);
      })]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new AppError('Public endpoint request too large', 'APP_ACTION_INVALID', 413);
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function failure(c: Context, error: unknown) {
  if (isAppError(error) || isModuleError(error)) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) {
    return c.json({ error: 'Invalid public endpoint request', code: 'VALIDATION_ERROR' }, 400);
  }
  console.error('[app-public-management] request failed');
  return c.json({ error: 'Public endpoint request failed', code: 'INTERNAL_ERROR' }, 500);
}

appPublicManagementRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!appRuntimeChannelEnabled() && !isAppNativeCalendarEnabled()) {
    return c.json({ error: 'Runtime unavailable', code: 'APP_RUNTIME_DISABLED' }, 503);
  }
  await next();
});
appPublicManagementRoutes.post('/endpoints/stage', async (c) => {
  try { const { actor, guard } = await authority(c); return c.json(await stagePublicEndpoint(actor, await body(c), guard), 201); }
  catch (error) { return failure(c, error); }
});
appPublicManagementRoutes.post('/endpoints/:endpointId/activate', async (c) => {
  try { const { actor, guard } = await authority(c); return c.json(await activatePublicEndpoint(actor,
    Id.parse(c.req.param('endpointId')), await body(c), guard)); }
  catch (error) { return failure(c, error); }
});
appPublicManagementRoutes.post('/endpoints/:endpointId/disable', async (c) => {
  try { const { actor, guard } = await authority(c); return c.json(await disablePublicEndpoint(actor,
    Id.parse(c.req.param('endpointId')), guard)); }
  catch (error) { return failure(c, error); }
});
appPublicManagementRoutes.post('/endpoints/:endpointId/rotate-signing-key', async c => {
  try { const { actor, guard } = await authority(c); return c.json(await rotatePublicHmacKey(actor, Id.parse(c.req.param('endpointId')), await body(c), guard)); }
  catch (error) { return failure(c, error); }
});
for (const operation of ['review', 'submit'] as const) appPublicManagementRoutes.post(`/cancellations/:cancellationId/owner/${operation}`, async c => {
  try {
    if (new URL(c.req.url).search) throw new SyntaxError();
    const user = c.get('user') as AuthUser | undefined;
    if (!user?.sid) throw new AppError('Authentication required', 'APP_ACCESS_DENIED', 403);
    const { actor, guard, web_session } = await resourceSyncWebAuthority(c.req.header('authorization'),
      { org_id: user.org_id, user_id: user.id, sid: user.sid });
    const id = z.uuid().parse(c.req.param('cancellationId')), input = await body(c), options = { guard, sid: web_session.sid };
    return c.json(operation === 'review' ? await reviewPublicCancellationOwner(actor, id, input, options)
      : await submitPublicCancellationOwner(actor, id, input, options));
  } catch (error) {
    if (error instanceof AppRunError) return appHttpFailure(c, error, 'App Run', 'app-runs');
    return failure(c, error);
  }
});
