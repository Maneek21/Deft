import { Hono, type Context } from 'hono';
import type { AuthUser } from '../middleware/auth.js';
import { AppRunGetInputSchema } from '../lib/app-action-operations.js';
import { appActionService } from '../lib/app-action-service.js';
import { humanModuleActor } from '../lib/module-service.js';
import { listModuleAppRunHistory, listModuleAppRunOutcomes } from '../lib/module-app-run-history.js';
import { appHttpFailure } from './app-http-errors.js';
import { sql } from 'drizzle-orm';
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
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  try {
    const runId = RunIdSchema.parse(c.req.param('runId'));
    const user = c.get('user') as AuthUser;
    // Keep this advisory discriminator independent of the full growing schema
    // relation graph; the native reader revalidates the exact scoped Run.
    const locator = (await db.execute(sql<{ provider_kind: string; protocol_version: string | null }>`SELECT r.provider_kind,v.protocol_version
      FROM app_runs r LEFT JOIN app_versions v ON v.org_id=r.org_id AND v.id=r.origin_app_version_id
      WHERE r.org_id=${user.org_id} AND r.id=${runId} LIMIT 1`)).rows[0];
    if (locator?.provider_kind === 'native') {
      const { assertNativeCalendarEnabled } = await import('../lib/app-native-authority.js');
      assertNativeCalendarEnabled();
      if (!user.sid) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      const { guard } = await resourceSyncWebAuthority(c.req.header('authorization'), { org_id: user.org_id, user_id: user.id, sid: user.sid });
      const { getAppRunRuntime } = await import('../lib/app-run-runtime.js');
      return c.json(await (await getAppRunRuntime()).service.resultReviewedNative({ org_id: user.org_id, user_id: user.id }, runId, guard));
    }
    if (locator?.provider_kind === 'app_runtime' && locator.protocol_version === '7') {
      if (!user.sid) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      const { guard } = await resourceSyncWebAuthority(c.req.header('authorization'),
        { org_id: user.org_id, user_id: user.id, sid: user.sid });
      const { getAppRunRuntime } = await import('../lib/app-run-runtime.js');
      return c.json(await (await getAppRunRuntime()).service.resultReviewedAttachmentRuntime(
        { org_id: user.org_id, user_id: user.id }, runId, async (tx, participants, expires_at) => {
          const { attachmentFinalAuthorityIsCurrent } = await import('../lib/app-attachment-authority.js');
          const { isAppV5RuntimeActionsEnabled } = await import('../lib/env.js');
          if (!await attachmentFinalAuthorityIsCurrent(tx, participants, { guard, expires_at })
            || !isAppV5RuntimeActionsEnabled()) throw new AppRunError('APP_RUN_AUTHORIZATION_STALE');
        }));
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
