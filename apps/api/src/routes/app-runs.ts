import { Hono, type Context } from 'hono';
import type { AuthUser } from '../middleware/auth.js';
import { AppRunGetInputSchema } from '../lib/app-action-operations.js';
import { appActionService } from '../lib/app-action-service.js';
import { humanModuleActor } from '../lib/module-service.js';
import { listModuleAppRunHistory, listModuleAppRunOutcomes } from '../lib/module-app-run-history.js';
import { appHttpFailure } from './app-http-errors.js';
import { and, eq } from 'drizzle-orm';
import { appRuns } from '@deft/db/schema';
import { db } from '../lib/db.js';
import { AppRunError } from '../lib/app-run-errors.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';

export const appRunRoutes = new Hono();

const RunIdSchema = AppRunGetInputSchema.shape.run_id;

function callerFromContext(c: Context) {
  const user = c.get('user') as AuthUser;
  return {
    actor: humanModuleActor({
      orgId: user.org_id,
      userId: user.id,
      role: user.role ?? 'member',
      source: 'ui',
    }),
  };
}

appRunRoutes.post('/record-history', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const input = await c.req.json().catch(() => null);
    return c.json(await listModuleAppRunHistory(callerFromContext(c).actor, input));
  } catch (error) {
    return appHttpFailure(c, error, 'App Run', 'app-runs');
  }
});

appRunRoutes.post('/record-outcomes', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const input = await c.req.json().catch(() => null);
    return c.json(await listModuleAppRunOutcomes(callerFromContext(c).actor, input));
  } catch (error) {
    return appHttpFailure(c, error, 'App Run', 'app-runs');
  }
});

appRunRoutes.get('/:runId/result', async (c) => {
  try {
    const runId = RunIdSchema.parse(c.req.param('runId'));
    const user = c.get('user') as AuthUser;
    const [locator] = await db.select({ provider_kind: appRuns.provider_kind }).from(appRuns)
      .where(and(eq(appRuns.org_id, user.org_id), eq(appRuns.id, runId))).limit(1);
    if (locator?.provider_kind === 'native') {
      const { assertNativeCalendarEnabled } = await import('../lib/app-native-authority.js');
      assertNativeCalendarEnabled();
      if (!user.sid) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      const { guard } = await resourceSyncWebAuthority(c.req.header('authorization'), { org_id: user.org_id, user_id: user.id, sid: user.sid });
      const { getAppRunRuntime } = await import('../lib/app-run-runtime.js');
      return c.json(await (await getAppRunRuntime()).service.resultReviewedNative({ org_id: user.org_id, user_id: user.id }, runId, guard));
    }
    return c.json(await appActionService.result(callerFromContext(c), runId));
  } catch (error) {
    if (error instanceof ResourceSyncWebAuthenticationError) return c.json({ error: error.message, code: error.code }, error.status);
    return appHttpFailure(c, error, 'App Run', 'app-runs');
  }
});

appRunRoutes.get('/:runId/receipts', async (c) => {
  try {
    const runId = RunIdSchema.parse(c.req.param('runId'));
    return c.json(await appActionService.inspectReceipts(callerFromContext(c), runId));
  } catch (error) {
    return appHttpFailure(c, error, 'App Run', 'app-runs');
  }
});

appRunRoutes.get('/:runId', async (c) => {
  try {
    const runId = RunIdSchema.parse(c.req.param('runId'));
    return c.json({ run: await appActionService.inspectRun(callerFromContext(c), runId) });
  } catch (error) {
    return appHttpFailure(c, error, 'App Run', 'app-runs');
  }
});
