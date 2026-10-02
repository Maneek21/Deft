import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../lib/app-errors.js';
import { appResourceSyncChannelEnabled } from '../lib/app-resource-sync-channel.js';
import { AppResourceSyncManagement } from '../lib/app-resource-sync-management.js';
import { getAppRunRuntime } from '../lib/app-run-runtime.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { assertOwnedResourceSyncRegistration, inspectResourceSyncBinding,
  listResourceSyncBindings } from '../lib/app-resource-sync-status.js';
import { listEligibleResourceSyncOperators, listAssignedResourceSyncBindings,
  listOwnResourceSyncSessions } from '../lib/app-resource-sync-operator.js';

const MAX_MANAGEMENT_BODY_BYTES = 16_384;
const READ_DEADLINE_MS = 15_000;
const Id = z.string().uuid();
class ResourceSyncManagementDisabledError extends Error {
  readonly code = 'APP_RESOURCE_SYNC_DISABLED';
  readonly status = 503;
}
async function authority(authorization: string | undefined) {
  const { actor, guard } = await resourceSyncWebAuthority(authorization);
  return { actor, guard: async (tx: Parameters<typeof guard>[0]) => {
    await guard(tx);
    if (!appResourceSyncChannelEnabled()) throw new ResourceSyncManagementDisabledError('Private sync management unavailable');
  } };
}
function query(c: Context) {
  const entries = [...new URL(c.req.url).searchParams.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new SyntaxError('Duplicate query');
  return Object.fromEntries(entries);
}
async function body(c: Context, emptyOnly = false): Promise<unknown> {
  if (!emptyOnly && c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new AppError('JSON request required', 'APP_ACTION_INVALID', 400);
  }
  const declared = Number(c.req.header('content-length') ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_MANAGEMENT_BODY_BYTES) {
    throw new AppError('Private sync request too large', 'APP_ACTION_INVALID', 413);
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) {
    if (emptyOnly) return null;
    throw new AppError('JSON request required', 'APP_ACTION_INVALID', 400);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + READ_DEADLINE_MS;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError('Private sync request timed out', 'APP_ACTION_INVALID', 400);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AppError('Private sync request timed out', 'APP_ACTION_INVALID', 400)), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_MANAGEMENT_BODY_BYTES) {
        throw new AppError('Private sync request too large', 'APP_ACTION_INVALID', 413);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  if (emptyOnly) {
    if (size !== 0) throw new SyntaxError('Unexpected body');
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function failure(c: Context, error: unknown) {
  if (error instanceof AppError || error instanceof ResourceSyncWebAuthenticationError
    || error instanceof ResourceSyncManagementDisabledError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) {
    return c.json({ error: 'Invalid private sync management request', code: 'VALIDATION_ERROR' }, 400);
  }
  console.error('[app-resource-sync-management] request failed');
  return c.json({ error: 'Private sync management request failed', code: 'INTERNAL_ERROR' }, 500);
}

export function createAppResourceSyncManagementRoutes(options: {
  management: () => Promise<AppResourceSyncManagement>;
}) {
  const routes = new Hono();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    if (!appResourceSyncChannelEnabled()) {
      return c.json({ error: 'Private sync management unavailable', code: 'APP_RESOURCE_SYNC_DISABLED' }, 503);
    }
    // Authenticate before parsing bodies or looking up Runtime keys. Each handler
    // authenticates again after body consumption and pins the final transaction SID.
    try { await authority(c.req.header('authorization')); }
    catch (error) { return failure(c, error); }
    await next();
  });
  routes.get('/setup', async (c) => {
    try {
      const { actor, guard } = await authority(c.req.header('authorization'));
      const entries = [...new URL(c.req.url).searchParams.entries()];
      if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new SyntaxError('Duplicate query');
      return c.json({ setup: await (await options.management()).setupContext(actor,
        Object.fromEntries(entries), guard) });
    } catch (error) { return failure(c, error); }
  });
  routes.get('/operators', async c => {
    try {
      const { actor, guard } = await authority(c.req.header('authorization'));
      return c.json(await listEligibleResourceSyncOperators(actor, query(c), guard));
    } catch (error) { return failure(c, error); }
  });
  routes.get('/operator/assignments', async c => {
    try {
      const { actor, guard } = await authority(c.req.header('authorization'));
      return c.json(await listAssignedResourceSyncBindings(actor, query(c), guard));
    } catch (error) { return failure(c, error); }
  });
  routes.get('/bindings/:bindingId/sessions', async c => {
    try {
      const { actor, guard } = await authority(c.req.header('authorization'));
      return c.json(await listOwnResourceSyncSessions(actor, Id.parse(c.req.param('bindingId')), query(c), guard));
    } catch (error) { return failure(c, error); }
  });
  routes.post('/reviews/prepare', async (c) => {
    try {
      z.strictObject({}).parse(c.req.query());
      const input = await body(c);
      const { actor, guard } = await authority(c.req.header('authorization'));
      return c.json({ review: await (await options.management()).prepareConsent(actor, input, guard) });
    } catch (error) { return failure(c, error); }
  });
  routes.post('/bindings/activate', async (c) => {
    try {
      z.strictObject({}).parse(c.req.query());
      const input = await body(c);
      const { actor, guard } = await authority(c.req.header('authorization'));
      return c.json({ binding: await (await options.management()).activateConsent(actor, input, guard) }, 201);
    } catch (error) { return failure(c, error); }
  });
  routes.get('/bindings', async (c) => {
    try {
      const { actor, guard } = await authority(c.req.header('authorization'));
      const entries = [...new URL(c.req.url).searchParams.entries()];
      if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new SyntaxError('Duplicate query');
      return c.json(await listResourceSyncBindings(actor, Object.fromEntries(entries), guard));
    } catch (error) { return failure(c, error); }
  });
  routes.get('/bindings/:bindingId', async (c) => {
    try {
      const { actor, guard } = await authority(c.req.header('authorization'));
      z.strictObject({}).parse(c.req.query());
      return c.json(await inspectResourceSyncBinding(actor, Id.parse(c.req.param('bindingId')), guard));
    } catch (error) { return failure(c, error); }
  });
  // No-body operations reject a body/query rather than ignoring caller-supplied authority.
  async function operation(c: Context) {
    z.strictObject({}).parse(c.req.query());
    await body(c, true);
    return authority(c.req.header('authorization'));
  }
  routes.post('/bindings/:bindingId/sessions', async (c) => {
    try {
      const { actor, guard } = await operation(c);
      return c.json({ session: await (await options.management()).issueOperatorSession(actor,
        Id.parse(c.req.param('bindingId')), guard) }, 201);
    } catch (error) { return failure(c, error); }
  });
  routes.post('/bindings/:bindingId/revoke', async (c) => {
    try {
      const { actor, guard } = await operation(c);
      return c.json(await (await options.management()).revokeConsent(actor, Id.parse(c.req.param('bindingId')), guard));
    } catch (error) { return failure(c, error); }
  });
  routes.post('/registrations/:registrationId/revoke', async (c) => {
    try {
      const { actor, guard } = await operation(c);
      const id = Id.parse(c.req.param('registrationId'));
      return c.json(await (await options.management()).revokeRegistration(actor, id, async (tx) => {
        await assertOwnedResourceSyncRegistration(tx, actor, id);
        await guard(tx);
      }));
    } catch (error) { return failure(c, error); }
  });
  routes.post('/sessions/:sessionId/revoke', async (c) => {
    try {
      const { actor, guard } = await operation(c);
      return c.json(await (await options.management()).revokeOperatorSession(actor,
        Id.parse(c.req.param('sessionId')), guard));
    } catch (error) { return failure(c, error); }
  });
  return routes;
}

export const appResourceSyncManagementRoutes = createAppResourceSyncManagementRoutes({
  management: async () => new AppResourceSyncManagement((await getAppRunRuntime()).keys),
});
