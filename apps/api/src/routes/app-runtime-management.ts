import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthUser } from '../middleware/auth.js';
import { humanModuleActor } from '../lib/module-service.js';
import { AppError } from '../lib/app-errors.js';
import {
  activateRuntimeBinding, inspectRuntimeBinding, issueRuntimeOperatorSession,
  prepareRuntimeBindingReview, revokeRuntimeBinding,
  revokeRuntimeRegistration, revokeRuntimeSession,
} from '../lib/app-runtime-management.js';

export const appRuntimeManagementRoutes = new Hono();
const MAX_MANAGEMENT_BODY_BYTES = 16_384;
const READ_DEADLINE_MS = 15_000;
const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

function actor(c: Context) {
  const user = c.get('user') as AuthUser | undefined;
  if (!user?.id || !user.org_id) {
    throw new AppError('Authentication required', 'APP_ACCESS_DENIED', 403);
  }
  return humanModuleActor({ orgId: user.org_id, userId: user.id,
    role: user.role ?? 'member', source: 'rest' });
}

async function body(c: Context): Promise<unknown> {
  if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new AppError('JSON request required', 'APP_ACTION_INVALID', 400);
  }
  const declared = Number(c.req.header('content-length') ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_MANAGEMENT_BODY_BYTES) {
    throw new AppError('App Runtime request too large', 'APP_ACTION_INVALID', 413);
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new AppError('JSON request required', 'APP_ACTION_INVALID', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + READ_DEADLINE_MS;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError('App Runtime request timed out', 'APP_ACTION_INVALID', 400);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AppError('App Runtime request timed out', 'APP_ACTION_INVALID', 400)), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_MANAGEMENT_BODY_BYTES) {
        throw new AppError('App Runtime request too large', 'APP_ACTION_INVALID', 413);
      }
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
  if (error instanceof AppError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) {
    return c.json({ error: 'Invalid App Runtime request', code: 'VALIDATION_ERROR' }, 400);
  }
  console.error('[app-runtime-management] request failed');
  return c.json({ error: 'App Runtime request failed', code: 'INTERNAL_ERROR' }, 500);
}

appRuntimeManagementRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

appRuntimeManagementRoutes.post('/reviews/prepare', async (c) => {
  try { return c.json({ review: await prepareRuntimeBindingReview(actor(c), await body(c)) }); }
  catch (error) { return failure(c, error); }
});
appRuntimeManagementRoutes.post('/bindings/activate', async (c) => {
  try { return c.json({ binding: await activateRuntimeBinding(actor(c), await body(c)) }, 201); }
  catch (error) { return failure(c, error); }
});
appRuntimeManagementRoutes.post('/bindings/:bindingId/sessions', async (c) => {
  try { return c.json({ session: await issueRuntimeOperatorSession(actor(c),
    Id.parse(c.req.param('bindingId'))) }, 201); }
  catch (error) { return failure(c, error); }
});
appRuntimeManagementRoutes.get('/bindings/:bindingId', async (c) => {
  try { return c.json(await inspectRuntimeBinding(actor(c), Id.parse(c.req.param('bindingId')))); }
  catch (error) { return failure(c, error); }
});
appRuntimeManagementRoutes.post('/bindings/:bindingId/revoke', async (c) => {
  try { return c.json(await revokeRuntimeBinding(actor(c), Id.parse(c.req.param('bindingId')))); }
  catch (error) { return failure(c, error); }
});
appRuntimeManagementRoutes.post('/registrations/:registrationId/revoke', async (c) => {
  try { return c.json(await revokeRuntimeRegistration(actor(c), Id.parse(c.req.param('registrationId')))); }
  catch (error) { return failure(c, error); }
});
appRuntimeManagementRoutes.post('/sessions/:sessionId/revoke', async (c) => {
  try { return c.json(await revokeRuntimeSession(actor(c), Id.parse(c.req.param('sessionId')))); }
  catch (error) { return failure(c, error); }
});
