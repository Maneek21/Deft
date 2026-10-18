import {AppRecordMirrorService} from '../lib/app-record-mirror-service.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AppDataService } from '../lib/app-data-service.js';
import { AppDataResourceBatchService } from '../lib/app-data-resource-batch-service.js';
import { AppExperienceExposureService } from '../lib/app-experience-exposure.js';
import { AppExperienceHumanActionService } from '../lib/app-experience-human-action-service.js';
import { getAppRunRuntime } from '../lib/app-run-runtime.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { AppError } from '../lib/app-errors.js';
import { readBoundedAppDataBytes } from '../lib/app-connection-session-registry.js';
import { appHttpFailure } from './app-http-errors.js';
import { isAppOwnerConnectionsEnabled } from '../lib/env.js';
import { createAppResourcePrivateReadLimits } from '../middleware/app-resource-private-limits.js';

const id = z.string().uuid(), key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u);
async function service(c: Context) {
  const auth = await resourceSyncWebAuthority(c.req.header('authorization'));
  const caller = { org_id: auth.actor.org_id, user_id: auth.actor.actor_id, sid: auth.web_session.sid,
    access_expires_at: auth.web_session.expires_at };
  const runtime = await getAppRunRuntime(), exposure = new AppExperienceExposureService(runtime.keys);
  return new AppDataResourceBatchService(new AppDataService(caller, auth.guard),
    new AppExperienceHumanActionService(exposure, runtime), exposure, runtime.keys, runtime);
}
async function body(c: Context, maximumBytes = 131072) {
  if (new URL(c.req.url).search || !/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type') ?? ''))
    throw new AppError('Invalid record action request', 'APP_ACTION_INVALID', 400);
  const controller = new AbortController(), abort = () => controller.abort();
  c.req.raw.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(
    await readBoundedAppDataBytes(c.req.raw.body, maximumBytes, controller.signal))); }
  finally { clearTimeout(timer); c.req.raw.signal.removeEventListener('abort', abort); }
}
function failure(c: Context, error: unknown) {
  if (error instanceof ResourceSyncWebAuthenticationError)
    return c.json({ error: 'Record action authentication required', code: 'APP_ACCESS_DENIED' }, 401);
  if (error instanceof SyntaxError || error instanceof TypeError)
    return c.json({ error: 'Invalid record action request', code: 'VALIDATION_ERROR' }, 400);
  return appHttpFailure(c, error, 'App action', 'app-actions');
}
export const appDataActionRoutes = new Hono();
appDataActionRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache'); c.header('X-Content-Type-Options', 'nosniff');
  if (process.env.DEFT_APPS_ENABLED !== 'true' || !isAppOwnerConnectionsEnabled())
    return c.json({ error: 'Record actions unavailable', code: 'APP_FEATURE_DISABLED' }, 503);
  await next();
  if (process.env.DEFT_APPS_ENABLED !== 'true' || !isAppOwnerConnectionsEnabled())
    return c.json({ error: 'Record actions unavailable', code: 'APP_FEATURE_DISABLED' }, 503);
});
appDataActionRoutes.use('/experiences/*', createAppResourcePrivateReadLimits({ peerPerMinute: 600,
  globalConcurrent: 32, peerConcurrent: 16 }));
appDataActionRoutes.post('/experiences/:experienceId/targets/:target/actions/:action/prepare', async c => {
  try { return c.json(await (await service(c)).prepare(id.parse(c.req.param('experienceId')),
    key.parse(c.req.param('target')), key.parse(c.req.param('action')), await body(c), c.req.raw.signal)); }
  catch (error) { return failure(c, error); }
});
appDataActionRoutes.post('/experiences/:experienceId/targets/:target/actions/confirm', async c => {
  try { return c.json(await (await service(c)).confirm(id.parse(c.req.param('experienceId')),
    key.parse(c.req.param('target')), await body(c), c.req.raw.signal)); }
  catch (error) { return failure(c, error); }
});
appDataActionRoutes.post('/experiences/:experienceId/targets/:target/resource-actions/:action/prepare',async c=>{
  try{return c.json(await (await service(c)).prepareResource(id.parse(c.req.param('experienceId')),
    key.parse(c.req.param('target')),key.parse(c.req.param('action')),await body(c),c.req.raw.signal));}
  catch(error){return failure(c,error);}
});
appDataActionRoutes.post('/experiences/:experienceId/targets/:target/resource-actions/confirm',async c=>{
  try{return c.json(await (await service(c)).confirmResource(id.parse(c.req.param('experienceId')),
    key.parse(c.req.param('target')),await body(c),c.req.raw.signal));}
  catch(error){return failure(c,error);}
});

// Aggregate review bodies are bounded separately; ordinary action budgets remain unchanged.
appDataActionRoutes.post('/experiences/:experienceId/targets/:target/resource-action-batches/:action/prepare',async c=>{
  try{return c.json(await (await service(c)).prepareBatch(id.parse(c.req.param('experienceId')),
    key.parse(c.req.param('target')),key.parse(c.req.param('action')),await body(c,524288),c.req.raw.signal));}
  catch(error){return failure(c,error);}
});
appDataActionRoutes.post('/experiences/:experienceId/targets/:target/resource-action-batches/confirm',async c=>{
  try{return c.json(await (await service(c)).confirmBatch(id.parse(c.req.param('experienceId')),
    key.parse(c.req.param('target')),await body(c,524288),c.req.raw.signal));}
  catch(error){return failure(c,error);}
});
appDataActionRoutes.get('/experiences/:experienceId/targets/:target/resource-action-batches/:batchId',async c=>{
  try{if(new URL(c.req.url).search)throw new AppError('Invalid record action request','APP_ACTION_INVALID',400);
    return c.json(await (await service(c)).statusBatch(id.parse(c.req.param('experienceId')),
      key.parse(c.req.param('target')),id.parse(c.req.param('batchId')),c.req.raw.signal));}
  catch(error){return failure(c,error);}
});
appDataActionRoutes.post('/experiences/:experienceId/targets/:target/actions/future/status',async c=>{
 try{return c.json(await(await service(c)).futureStatus(id.parse(c.req.param('experienceId')),key.parse(c.req.param('target')),await body(c)));}catch(error){return failure(c,error);}
});
appDataActionRoutes.post('/experiences/:experienceId/targets/:target/actions/future/cancel',async c=>{
 try{return c.json(await(await service(c)).futureCancel(id.parse(c.req.param('experienceId')),key.parse(c.req.param('target')),await body(c),c.req.raw.signal));}catch(error){return failure(c,error);}
});
appDataActionRoutes.post('/experiences/:experienceId/targets/:target/actions/future/reconcile',async c=>{
 try{const input=z.strictObject({request_id:id,phase:z.enum(['commit','restore'])}).parse(await body(c));return c.json(await(await service(c)).futureReconcile(id.parse(c.req.param('experienceId')),key.parse(c.req.param('target')),input.request_id,input.phase,c.req.raw.signal));}catch(error){return failure(c,error);}
});

async function mirrorService(c:Context){const auth=await resourceSyncWebAuthority(c.req.header('authorization')),runtime=await getAppRunRuntime();return new AppRecordMirrorService(new AppDataService({org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at},auth.guard),new AppExperienceExposureService(runtime.keys),runtime.keys);}
for(const operation of ['review','confirm','status','pause'] as const)appDataActionRoutes.post(`/experiences/:experienceId/targets/:target/record-mirrors/${operation}`,async c=>{try{const mirror=await mirrorService(c),experience=id.parse(c.req.param('experienceId')),target=key.parse(c.req.param('target')),input=await body(c);return c.json(operation==='review'?await mirror.review(experience,target,input,c.req.raw.signal):operation==='confirm'?await mirror.confirm(experience,target,input,c.req.raw.signal):operation==='pause'?await mirror.pause(experience,target,input):await mirror.read(experience,target,input));}catch(error){return failure(c,error);}});
