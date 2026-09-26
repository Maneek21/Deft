import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../lib/app-errors.js';
import { AppResourcePrivateReadService, AppResourcePrivateReadError } from '../lib/app-resource-private-read.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { getAppRunRuntime } from '../lib/app-run-runtime.js';
import { isAppResourceSyncChannelEnabled } from '../lib/env.js';

const id = z.string().uuid();
const pageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(25).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

/** The web subject comes from a verified session; refs and path IDs confer no access. */
export const appResourcePrivateReadRoutes = new Hono();
appResourcePrivateReadRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  if (!isAppResourceSyncChannelEnabled()) {
    return c.json({ error: 'Private resources are unavailable', code: 'APP_RESOURCE_SYNC_DISABLED' }, 503);
  }
  await next();
});

async function reader(c: Context) {
  const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'));
  if (actor.kind !== 'human') throw new AppError('Private resource access denied', 'APP_ACCESS_DENIED', 403);
  const runtime = await getAppRunRuntime();
  // Run the web guard inside the reader's authority transaction, before its
  // final consent deadline check. A session lock wait must not outlive consent.
  const service = new AppResourcePrivateReadService(runtime.keys, () => new Date(), runtime.repository, guard);
  return { service, subject: { kind: 'human' as const, org_id: actor.org_id, user_id: actor.actor_id } };
}

function failure(c: Context, error: unknown) {
  if (error instanceof AppResourcePrivateReadError || error instanceof AppError || error instanceof ResourceSyncWebAuthenticationError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof z.ZodError) {
    return c.json({ error: 'Invalid private resource request', code: 'APP_RESOURCE_PRIVATE_INPUT_INVALID' }, 400);
  }
  return c.json({ error: 'Private resources are unavailable', code: 'APP_RESOURCE_PRIVATE_FAILURE' }, 500);
}

appResourcePrivateReadRoutes.get('/bindings/:bindingId/records', async (c) => {
  try {
    const queries = c.req.queries();
    if (Object.values(queries).some((values) => values.length !== 1)) {
      return c.json({ error: 'Invalid private resource request', code: 'APP_RESOURCE_PRIVATE_INPUT_INVALID' }, 400);
    }
    const query = pageQuery.parse(Object.fromEntries(Object.entries(queries).map(([key, values]) => [key, values[0]])));
    const bindingId = id.parse(c.req.param('bindingId'));
    const { service, subject } = await reader(c);
    return c.json(await service.listOwnerPrivateResourcePage(subject, { resource_binding_id: bindingId, ...query }));
  } catch (error) { return failure(c, error); }
});

appResourcePrivateReadRoutes.get('/bindings/:bindingId/records/:projectionId', async (c) => {
  try {
    z.strictObject({}).parse(c.req.query());
    const bindingId = id.parse(c.req.param('bindingId'));
    const projectionId = id.parse(c.req.param('projectionId'));
    const { service, subject } = await reader(c);
    return c.json(await service.getOwnerPrivateResource(subject, {
      resource_binding_id: bindingId, projection_id: projectionId,
    }));
  } catch (error) { return failure(c, error); }
});
