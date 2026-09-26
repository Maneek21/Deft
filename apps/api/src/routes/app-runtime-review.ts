import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AuthUser } from '../middleware/auth.js';
import { appRuntimeChannelEnabled } from '../lib/app-runtime-channel.js';
import { activateRuntimeApp, prepareRuntimeAppReview, getRuntimeAppReviewContext,
  type RuntimeAppReviewOptions } from '../lib/app-runtime-review.js';
import { isAppError } from '../lib/app-errors.js';
import { isModuleError } from '../lib/module-errors.js';
import { isAppResourceSyncChannelEnabled } from '../lib/env.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
class RuntimeReviewChannelDisabledError extends Error {
  readonly code = 'APP_RUNTIME_DISABLED';
  readonly status = 503;
}
const assertAdmission: NonNullable<RuntimeAppReviewOptions['assertAdmission']> = manifest => {
  // Preserve existing v1 declaration review. The additive v2 path grants no
  // Runtime action support, including for action-bearing protocol 5 Apps.
  if (appRuntimeChannelEnabled()) return;
  if (isAppResourceSyncChannelEnabled() && manifest.schema_version === '5'
    && manifest.runtime_actions.length === 0 && manifest.sync_descriptors.length > 0) return;
  throw new RuntimeReviewChannelDisabledError('Runtime review channel unavailable');
};
async function authority(c: Context) {
  const user = c.get('user') as AuthUser | undefined;
  if (!user?.sid) throw new ResourceSyncWebAuthenticationError('Web authentication required');
  const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'),
    { org_id: user.org_id, user_id: user.id, sid: user.sid });
  return { actor, options: { guard, assertAdmission } };
}
function failure(c: Context, error: unknown) {
  if (isAppError(error) || isModuleError(error) || error instanceof ResourceSyncWebAuthenticationError
    || error instanceof RuntimeReviewChannelDisabledError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid review request', code: 'VALIDATION_ERROR' }, 400);
  return c.json({ error: 'Runtime review failed', code: 'INTERNAL_ERROR' }, 500);
}

/** Mounted behind the normal authenticated human API middleware. */
export const appRuntimeReviewRoutes = new Hono();
appRuntimeReviewRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  if (!appRuntimeChannelEnabled() && !isAppResourceSyncChannelEnabled()) return c.json({ error: 'Runtime unavailable', code: 'APP_RUNTIME_DISABLED' }, 503);
  await next();
});
appRuntimeReviewRoutes.use('*', bodyLimit({ maxSize: 8192 }));
appRuntimeReviewRoutes.get('/:installationId/context', async c => {
  try {
    const queries = c.req.queries();
    if (Object.values(queries).some(values => values.length !== 1)) throw new SyntaxError();
    const query = z.strictObject({ app_version_id: Id }).parse(c.req.query());
    const { actor, options } = await authority(c);
    return c.json(await getRuntimeAppReviewContext(actor, Id.parse(c.req.param('installationId')),
      query.app_version_id, options));
  } catch (error) { return failure(c, error); }
});
for (const operation of ['review', 'activate'] as const) {
  appRuntimeReviewRoutes.post(`/:installationId/${operation}`, async (c) => {
    try {
      const { actor, options } = await authority(c);
      const id = Id.parse(c.req.param('installationId'));
      const body: unknown = await c.req.json();
      const result = operation === 'review' ? await prepareRuntimeAppReview(actor, id, body, options)
        : await activateRuntimeApp(actor, id, body, options);
      return c.json(result);
    } catch (error) {
      return failure(c, error);
    }
  });
}
