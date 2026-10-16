import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { getAppRunRuntime } from '../lib/app-run-runtime.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { AppPrivateMcpService } from '../lib/app-private-mcp-service.js';
import { PrivateResourceAccessError } from '../lib/app-resource-access-contract.js';
import { AppError } from '../lib/app-errors.js';

export const appPrivateMcpRoutes = new Hono();
appPrivateMcpRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache');
  await next();
});
const bound = (maxSize: number) => bodyLimit({ maxSize, onError: c => c.json({ error: 'Invalid MCP access request', code: 'APP_PRIVATE_MCP_INPUT_INVALID' }, 400) });
async function caller(c: Context) {
  z.strictObject({}).parse(c.req.queries());
  const { actor, guard, web_session } = await resourceSyncWebAuthority(c.req.header('authorization'));
  const runtime = await getAppRunRuntime();
  return { service: new AppPrivateMcpService(runtime.keys), subject: { org_id: actor.org_id, user_id: actor.actor_id, sid: web_session.sid, guard } };
}
function fail(c: Context, error: unknown) {
  if (error instanceof PrivateResourceAccessError || error instanceof ResourceSyncWebAuthenticationError || error instanceof AppError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof z.ZodError) return c.json({ error: 'Invalid MCP access request', code: 'APP_PRIVATE_MCP_INPUT_INVALID' }, 400);
  return c.json({ error: 'Private MCP access unavailable', code: 'APP_PRIVATE_MCP_FAILURE' }, 500);
}
appPrivateMcpRoutes.post('/reviews', bound(8192), async c => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.prepare(subject, await c.req.json(), c.req.raw.signal));
  } catch (error) { return fail(c, error); }
});
appPrivateMcpRoutes.post('/grants', bound(16384), async c => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.accept(subject, await c.req.json(), c.req.raw.signal), 201);
  } catch (error) { return fail(c, error); }
});
appPrivateMcpRoutes.delete('/grants/:id', async c => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.revoke(subject, z.string().uuid().parse(c.req.param('id')), c.req.raw.signal));
  } catch (error) { return fail(c, error); }
});
appPrivateMcpRoutes.post('/inventory', bound(8192), async c => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.inventory(subject, await c.req.json(), c.req.raw.signal));
  } catch (error) { return fail(c, error); }
});
appPrivateMcpRoutes.post('/prune', bound(8192), async c => {
  try {
    z.strictObject({}).parse(await c.req.json());
    const { service, subject } = await caller(c);
    return c.json(await service.prune(subject, c.req.raw.signal));
  } catch (error) { return fail(c, error); }
});
