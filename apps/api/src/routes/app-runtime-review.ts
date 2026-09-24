import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AuthUser } from '../middleware/auth.js';
import { humanModuleActor } from '../lib/module-service.js';
import { appRuntimeChannelEnabled } from '../lib/app-runtime-channel.js';
import { activateRuntimeApp, prepareRuntimeAppReview } from '../lib/app-runtime-review.js';
import { isAppError } from '../lib/app-errors.js';
import { isModuleError } from '../lib/module-errors.js';

/** Mounted behind the normal authenticated human API middleware. */
export const appRuntimeReviewRoutes = new Hono();
appRuntimeReviewRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!appRuntimeChannelEnabled()) return c.json({ error: 'Runtime unavailable', code: 'APP_RUNTIME_DISABLED' }, 503);
  await next();
});
appRuntimeReviewRoutes.use('*', bodyLimit({ maxSize: 8192 }));
for (const operation of ['review', 'activate'] as const) {
  appRuntimeReviewRoutes.post(`/:installationId/${operation}`, async (c) => {
    const user = c.get('user') as AuthUser | undefined;
    if (!user) return c.json({ error: 'Authentication required', code: 'APP_ACCESS_DENIED' }, 401);
    try {
      const actor = humanModuleActor({ orgId: user.org_id, userId: user.id, role: user.role ?? 'member', source: 'rest' });
      const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).parse(c.req.param('installationId'));
      const body: unknown = await c.req.json();
      const result = operation === 'review' ? await prepareRuntimeAppReview(actor, id, body)
        : await activateRuntimeApp(actor, id, body);
      return c.json(result);
    } catch (error) {
      if (isAppError(error) || isModuleError(error)) return c.json({ error: error.message, code: error.code }, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid review request', code: 'VALIDATION_ERROR' }, 400);
      return c.json({ error: 'Runtime review failed', code: 'INTERNAL_ERROR' }, 500);
    }
  });
}
