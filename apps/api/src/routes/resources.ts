import { Hono } from 'hono';
import { nativeResourceService } from '../lib/native-resource-service.js';
import { ResourceAuthorizationError } from '../lib/resource-authorization.js';

const MAX_REF_CHARS = 2_048;

/** Mounted only behind existing web authentication and the Apps feature gate. */
export const resourceRoutes = new Hono();
resourceRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  await next();
});
resourceRoutes.get('/resolve', async (c) => {
  const queries = c.req.queries();
  const value = queries.ref?.[0];
  if (Object.keys(queries).length !== 1 || queries.ref?.length !== 1
    || !value || value.length > MAX_REF_CHARS) {
    return c.json({ error: 'Resource reference is invalid', code: 'RESOURCE_REF_INVALID' }, 400);
  }
  let ref: unknown;
  try { ref = JSON.parse(value); }
  catch { return c.json({ error: 'Resource reference is invalid', code: 'RESOURCE_REF_INVALID' }, 400); }
  const user = c.get('user');
  if (!user?.id || !user.org_id || !user.sid) {
    return c.json({ error: 'Resource access denied', code: 'RESOURCE_ACCESS_DENIED' }, 403);
  }
  try {
    return c.json(await nativeResourceService.resolve(
      { org_id: user.org_id, user_id: user.id, sid: user.sid }, ref));
  } catch (error) {
    if (error instanceof ResourceAuthorizationError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    return c.json({ error: 'Resource provider failed safely', code: 'RESOURCE_PROVIDER_FAILURE' }, 500);
  }
});
