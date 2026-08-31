import { Hono, type Context } from 'hono';
import type { AuthUser } from '../middleware/auth.js';
import {
  AppBindingInvokeInputSchema,
  AppCapabilityGetInputSchema,
  AppCapabilityListInputSchema,
} from '../lib/app-action-operations.js';
import { appActionService } from '../lib/app-action-service.js';
import { AppRunPreparedInputCandidateSchema } from '../lib/app-run-prepared-input.js';
import { humanModuleActor } from '../lib/module-service.js';
import { appHttpFailure } from './app-http-errors.js';

export const appActionRoutes = new Hono();

const InvokeSchema = AppBindingInvokeInputSchema.extend({
  input_candidate: AppRunPreparedInputCandidateSchema,
});

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

async function jsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

appActionRoutes.post('/list', async (c) => {
  try {
    const input = AppCapabilityListInputSchema.parse(await jsonBody(c));
    return c.json({ result: await appActionService.list(callerFromContext(c), input) });
  } catch (error) {
    return appHttpFailure(c, error, 'App action', 'app-actions');
  }
});

appActionRoutes.post('/resolve', async (c) => {
  try {
    const input = AppCapabilityGetInputSchema.parse(await jsonBody(c));
    return c.json({ result: await appActionService.resolve(callerFromContext(c), input) });
  } catch (error) {
    return appHttpFailure(c, error, 'App action', 'app-actions');
  }
});

appActionRoutes.post('/prepare', async (c) => {
  try {
    const input = AppBindingInvokeInputSchema.parse(await jsonBody(c));
    const prepared = await appActionService.prepare(callerFromContext(c), input);
    // The browser needs only the safe preview and opaque candidate. Keep the
    // internal authority vector/digest inside the service and sealed payload.
    return c.json({
      result: {
        action: prepared.action,
        safe_preview: prepared.safe_preview,
        input_candidate: prepared.input_candidate,
        replay_identity: prepared.replay_identity,
      },
    });
  } catch (error) {
    return appHttpFailure(c, error, 'App action', 'app-actions');
  }
});

appActionRoutes.post('/invoke', async (c) => {
  try {
    const input = InvokeSchema.parse(await jsonBody(c));
    return c.json({ run: await appActionService.invoke(callerFromContext(c), input) });
  } catch (error) {
    return appHttpFailure(c, error, 'App action', 'app-actions');
  }
});
