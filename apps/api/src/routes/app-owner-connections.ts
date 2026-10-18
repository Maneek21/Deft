import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../lib/app-errors.js';
import { AppOwnerConnectionService } from '../lib/app-owner-connection-service.js';
import { getAppRunRuntime } from '../lib/app-run-runtime.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { isAppOwnerConnectionsEnabled } from '../lib/env.js';
import { isModuleError } from '../lib/module-errors.js';
import {AppConnectionService} from '../lib/app-connection-service.js';
import {getAppConnectionRegistry} from '../lib/app-connection-registry.js';
import {AppExperienceExposureService} from '../lib/app-experience-exposure.js';

export const appOwnerConnectionRoutes = new Hono();
function failure(c: Context, error: unknown) {
  if (isModuleError(error)) return c.json({ error: 'Owner connection access denied', code: 'APP_ACCESS_DENIED' }, error.status);
  if (error instanceof ResourceSyncWebAuthenticationError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof AppError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
    return c.json({ error: 'Invalid owner connection request', code: 'VALIDATION_ERROR' }, 400);
  return c.json({ error: 'Owner connection request failed', code: 'INTERNAL_ERROR' }, 500);
}
async function body(c: Context) {
  if (new URL(c.req.url).search || c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    throw new AppError('JSON owner connection request required', 'APP_ACTION_INVALID', 400);
  const declared = Number(c.req.header('content-length') ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > 16384) throw new AppError('Owner connection request too large', 'APP_ACTION_INVALID', 413);
  const reader = c.req.raw.body?.getReader(); if (!reader) throw new AppError('JSON request required', 'APP_ACTION_INVALID', 400);
  let length = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const chunks: Uint8Array[] = [];
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError('Owner connection request timed out', 'APP_ACTION_INVALID', 400)), 15000); });
  try {
    for (;;) { const next = await Promise.race([reader.read(), timeout]); if (next.done) break;
      length += next.value.byteLength; if (length > 16384) throw new AppError('Owner connection request too large', 'APP_ACTION_INVALID', 413); chunks.push(next.value); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown;
  } finally { if (timer) clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
appOwnerConnectionRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!isAppOwnerConnectionsEnabled()) return c.json({ error: 'Owner connections unavailable', code: 'APP_FEATURE_DISABLED' }, 503);
  try { await resourceSyncWebAuthority(c.req.header('authorization')); } catch (error) { return failure(c, error); }
  await next();
});
appOwnerConnectionRoutes.get('/:installationId/context', async c => {
  try { if (new URL(c.req.url).search) throw new TypeError('Unexpected query');
    const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await new AppOwnerConnectionService((await getAppRunRuntime()).keys).context(actor, c.req.param('installationId'), guard));
  } catch (error) { return failure(c, error); }
});
appOwnerConnectionRoutes.post('/:installationId/connections/:targetKey/manage',async c=>{
  try{const input=await body(c),{actor,web_session}=await resourceSyncWebAuthority(c.req.header('authorization'));
    const nomination=z.strictObject({installation_id:z.string().uuid(),target_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)}).parse({installation_id:c.req.param('installationId'),target_key:c.req.param('targetKey')});
    const caller={org_id:actor.org_id,user_id:actor.actor_id,sid:web_session.sid,access_expires_at:web_session.expires_at};
    return c.json(await new AppConnectionService(await getAppConnectionRegistry(),new AppExperienceExposureService((await getAppRunRuntime()).keys))
      .invokeRetained(caller,nomination,input,c.req.header('origin'),c.req.raw.signal));
  }catch(error){return failure(c,error);}
});
appOwnerConnectionRoutes.get('/:installationId/connections',async c=>{
  try{if(new URL(c.req.url).search)throw new TypeError('Unexpected query');
    const {actor,web_session}=await resourceSyncWebAuthority(c.req.header('authorization'));
    const caller={org_id:actor.org_id,user_id:actor.actor_id,sid:web_session.sid,access_expires_at:web_session.expires_at};
    return c.json(await new AppConnectionService(await getAppConnectionRegistry(),new AppExperienceExposureService((await getAppRunRuntime()).keys))
      .retainedTargets(caller,c.req.param('installationId'),c.req.raw.signal));
  }catch(error){return failure(c,error);}
});
for (const operation of ['review', 'activate'] as const) appOwnerConnectionRoutes.post(`/resources/limits/${operation}`, async c => {
  try { const input = await body(c), { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'));
    const output = await new AppOwnerConnectionService((await getAppRunRuntime()).keys).resourcePageLimits(actor, input, guard, operation === 'activate');
    return c.json(operation === 'review' ? { review: output } : { binding: output });
  } catch (error) { return failure(c, error); }
});
for (const kind of ['admissions', 'resources', 'actions'] as const) {
  for (const operation of ['review', 'activate'] as const) appOwnerConnectionRoutes.post(`/${kind}/${operation}`, async c => {
    try { const input = await body(c), { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'));
      const service = new AppOwnerConnectionService((await getAppRunRuntime()).keys);
      const output = kind === 'admissions' ? operation === 'review' ? await service.reviewAdmission(actor, input, guard)
        : await service.activateAdmission(actor, input, guard) : kind === 'resources' ? await service.resource(actor, input, guard, operation === 'activate')
          : await service.action(actor, input, guard, operation === 'activate');
      return c.json(operation === 'review' ? { review: output } : kind === 'admissions' ? { admission: output } : { binding: output }, operation === 'activate' ? 201 : 200);
    } catch (error) { return failure(c, error); }
  });
}
appOwnerConnectionRoutes.post('/admissions/:admissionId/revoke', async c => {
  try { z.strictObject({}).parse(await body(c)); const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await new AppOwnerConnectionService((await getAppRunRuntime()).keys).revokeAdmission(actor, c.req.param('admissionId'), guard));
  } catch (error) { return failure(c, error); }
});
