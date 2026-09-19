import { Hono, type Context } from 'hono';
import type { AuthUser } from '../middleware/auth.js';
import { AppRunGetInputSchema } from '../lib/app-action-operations.js';
import { appActionService } from '../lib/app-action-service.js';
import { humanModuleActor } from '../lib/module-service.js';
import { listModuleAppRunHistory, listModuleAppRunOutcomes } from '../lib/module-app-run-history.js';
import { appHttpFailure } from './app-http-errors.js';

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
    return c.json(await appActionService.result(callerFromContext(c), runId));
  } catch (error) {
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
