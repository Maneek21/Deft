import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { getAppRunRuntime } from '../lib/app-run-runtime.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { AppPrivateDeftyService } from '../lib/app-private-defty-service.js';
import { PrivateResourceAccessError } from '../lib/app-resource-access-contract.js';
import { AppError } from '../lib/app-errors.js';
import { PrivateDeftyCapacityError, PrivateDeftyRequestError } from '../lib/app-private-defty-contract.js';

export const appPrivateDeftyRoutes = new Hono();
appPrivateDeftyRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache');
  await next();
});
const bound = (maxSize: number) => bodyLimit({ maxSize,
  onError: c => c.json({ error: 'Private context request exceeds its bound', code: 'APP_PRIVATE_DEFTY_INPUT_INVALID' }, 413) });
async function caller(c: Context) {
  z.strictObject({}).parse(c.req.queries());
  const { actor, guard, web_session } = await resourceSyncWebAuthority(c.req.header('authorization'));
  const runtime = await getAppRunRuntime();
  return { service: new AppPrivateDeftyService(runtime.keys),
    subject: { org_id: actor.org_id, user_id: actor.actor_id, sid: web_session.sid, guard } };
}
function failure(c: Context, error: unknown) {
  if (error instanceof PrivateDeftyRequestError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof PrivateDeftyCapacityError) return c.json({ error: error.message, code: error.code, capacity: error.capacity }, error.status);
  if (error instanceof PrivateResourceAccessError || error instanceof ResourceSyncWebAuthenticationError || error instanceof AppError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof z.ZodError) return c.json({ error: 'Invalid private context request', code: 'APP_PRIVATE_DEFTY_INPUT_INVALID' }, 400);
  // Provider bodies, prompts, plaintext and stacks never enter the response/log.
  return c.json({ error: 'Private context unavailable', code: 'APP_PRIVATE_DEFTY_UNAVAILABLE' }, 503);
}
appPrivateDeftyRoutes.post('/review', bound(8192), async c => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.prepare(subject, await c.req.json(), c.req.raw.signal));
  } catch (error) { return failure(c, error); }
});
appPrivateDeftyRoutes.post('/accept', bound(16384), async c => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.accept(subject, await c.req.json(), c.req.raw.signal), 201);
  } catch (error) { return failure(c, error); }
});
appPrivateDeftyRoutes.delete('/grants/:id', async c => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.revoke(subject, z.string().uuid().parse(c.req.param('id')), c.req.raw.signal));
  } catch (error) { return failure(c, error); }
});
appPrivateDeftyRoutes.get('/spaces/:id/history', async c => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.history(subject, z.string().uuid().parse(c.req.param('id')), c.req.raw.signal));
  } catch (error) { return failure(c, error); }
});
// Escaped JSON can expand a legitimate16KiB prompt to roughly96KiB.
appPrivateDeftyRoutes.post('/spaces/:id/turns', bound(131072), async c => {
  try {
    const { service, subject } = await caller(c);
    return c.json(await service.turn(subject, z.string().uuid().parse(c.req.param('id')),
      await c.req.json(), c.req.raw.signal));
  } catch (error) { return failure(c, error); }
});
