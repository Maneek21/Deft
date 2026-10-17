import { Hono, type Context } from 'hono';
import { AppConnectionSessionService } from '../lib/app-connection-session-service.js';
import { appConnectionRuntimeAuthority, productionAppConnectionSessionPorts } from '../lib/app-connection-session-authority.js';
import { resourceSyncWebAuthority, ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { readBoundedConnectionJson } from '../lib/app-connection-session-registry.js';
import { AppError } from '../lib/app-errors.js';
import { z } from 'zod';
import { isAppOwnerConnectionsEnabled } from '../lib/env.js';
import { createAppResourceSyncLimits } from '../middleware/app-resource-sync-limits.js';
import { createAppResourcePrivateReadLimits } from '../middleware/app-resource-private-limits.js';

// APPS_ENABLED is also a boot-time mounting decision elsewhere. Read the exact
// current flag here so this independently mounted audience fails closed.
const enabled = () => process.env.DEFT_APPS_ENABLED === 'true' && isAppOwnerConnectionsEnabled();
const disabled = (c: Context) => c.json({ error: 'Account connections unavailable', code: 'APP_FEATURE_DISABLED' }, 503);

const invalid = () => new AppError('Invalid connection request', 'APP_ACTION_INVALID', 400);
async function body(c: Context) {
  if (new URL(c.req.url).search || !/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type') ?? '')) throw invalid();
  const length = Number(c.req.header('content-length') ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > 16384) throw invalid();
  const controller = new AbortController();
  const abort = () => controller.abort();
  c.req.raw.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try { c.req.raw.signal.throwIfAborted(); return await readBoundedConnectionJson(c.req.raw.body, controller.signal); }
  catch { throw invalid(); }
  finally { clearTimeout(timer); c.req.raw.signal.removeEventListener('abort', abort); }
}
function failure(c: Context, error: unknown) {
  if (error instanceof AppError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof ResourceSyncWebAuthenticationError) return c.json({ error: 'Connection authentication required', code: 'APP_ACCESS_DENIED' }, 401);
  if (error instanceof z.ZodError) return c.json({ error: 'Invalid connection request', code: 'VALIDATION_ERROR' }, 400);
  // Callback codes and credentials must never enter error logs/responses.
  return c.json({ error: 'Connection request unavailable', code: 'APP_PROVIDER_UNAVAILABLE' }, 503);
}

/** Public web routes authenticate the exact human SID. Runtime introspection
 * has a distinct deployment-scoped token and accepts no human bearer. */
export function createAppConnectionSessionRoutes() {
  const routes = new Hono();
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache');
    c.header('X-Content-Type-Options', 'nosniff');
    if (!enabled()) return disabled(c);
    await next();
    if (!enabled()) return disabled(c);
  });
  // Separate bounded socket-peer/global/concurrency budgets ahead of body and
  // credential parsing. One callback performs many online authority checks;
  // their shared operator egress must not spend the human management budget.
  routes.use('/runtime/authority', createAppResourceSyncLimits({ globalPerMinute: 600, peerPerMinute: 600,
    globalConcurrent: 60, peerConcurrent: 16, maxPeerBuckets: 1024 }));
  routes.use('/runtime/reattach-authority', createAppResourceSyncLimits({ globalPerMinute: 600, peerPerMinute: 600,
    globalConcurrent: 60, peerConcurrent: 16, maxPeerBuckets: 1024 }));
  for(const path of ['authority-v2','upgrade-authority'])routes.use(`/runtime/${path}`,createAppResourceSyncLimits({globalPerMinute:600,peerPerMinute:600,globalConcurrent:60,peerConcurrent:16,maxPeerBuckets:1024}));
  routes.use('/runtime/consent-continuation-authority',createAppResourceSyncLimits({globalPerMinute:600,peerPerMinute:600,globalConcurrent:60,peerConcurrent:16,maxPeerBuckets:1024}));
  const ownerLimits = createAppResourcePrivateReadLimits({peerPerMinute: 600, globalConcurrent: 32, peerConcurrent: 16});
  routes.use('/installations/:installationId/context',ownerLimits);
  routes.use('/installations/:installationId/consent-continuation-context',ownerLimits);
  for(const operation of ['review','activate','status'])routes.use(`/consent-continuation/${operation}`,ownerLimits);
  routes.use('/installations/:installationId/upgrade-context',ownerLimits);
  for (const operation of ['begin', 'callback', 'status', 'disconnect']) routes.use(`/${operation}`, ownerLimits);
  for (const operation of ['review', 'activate', 'status']) routes.use(`/reattach/${operation}`, ownerLimits);
  for(const operation of ['review','begin','callback','status'])routes.use(`/upgrade/${operation}`,ownerLimits);
  routes.post('/runtime/consent-continuation-authority',async c=>{
    try{const {appConnectionConsentContinuationRuntimeAuthority}=await import('../lib/app-connection-consent-continuation-authority.js');
      return c.json(await appConnectionConsentContinuationRuntimeAuthority(await body(c),c.req.header('authorization')));
    }catch(error){return failure(c,error);}
  });
  routes.get('/installations/:installationId/consent-continuation-context',async c=>{
    try{if(new URL(c.req.url).search)throw invalid();const injected=c.get('user');
      const auth=await resourceSyncWebAuthority(c.req.header('authorization'),injected?{org_id:injected.org_id,user_id:injected.id,sid:injected.sid}:undefined);
      const caller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};
      const {appConnectionConsentContinuationContext}=await import('../lib/app-connection-consent-continuation-authority.js');
      return c.json(await appConnectionConsentContinuationContext(caller,z.string().uuid().parse(c.req.param('installationId')),auth.guard));
    }catch(error){return failure(c,error);}
  });
  for(const operation of ['review','activate','status'] as const)routes.post(`/consent-continuation/${operation}`,async c=>{
    try{const injected=c.get('user');const auth=await resourceSyncWebAuthority(c.req.header('authorization'),injected?{org_id:injected.org_id,user_id:injected.id,sid:injected.sid}:undefined);
      const caller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};
      const {AppConnectionConsentContinuationService}=await import('../lib/app-connection-consent-continuation-service.js');
      return c.json(await new AppConnectionConsentContinuationService(caller,auth.guard)[operation](await body(c)));
    }catch(error){return failure(c,error);}
  });
  routes.get('/installations/:installationId/upgrade-context',async c=>{
    try{
      if(new URL(c.req.url).search)throw new AppError('Invalid connection context','APP_ACTION_INVALID',400);
      const auth=await resourceSyncWebAuthority(c.req.header('authorization'));
      const caller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};
      const {appConnectionUpgradeInstallationContext}=await import('../lib/app-connection-upgrade-context.js');
      return c.json(await appConnectionUpgradeInstallationContext(caller,z.string().uuid().parse(c.req.param('installationId')),auth.guard));
    }catch(error){return failure(c,error);}
  });
  for(const operation of ['begin','callback'])routes.use(`/v2/${operation}`,ownerLimits);
  for(const operation of ['upgrade-authority','authority-v2'] as const)routes.post(`/runtime/${operation}`,async c=>{
    try{const raw=await body(c);
      if(operation==='upgrade-authority'&&(raw as {schema_version?:string}).schema_version==='deft.app_connection_credential_repair_runtime.v1'){
        const {appConnectionCredentialRepairRuntimeAuthority}=await import('../lib/app-connection-credential-repair-authority.js');
        return c.json(await appConnectionCredentialRepairRuntimeAuthority(raw,c.req.header('authorization')));
      }
      const functions=await import('../lib/app-connection-upgrade-authority.js');
      return c.json(await functions[operation==='upgrade-authority'?'appConnectionUpgradeRuntimeAuthority':'appConnectionRuntimeV2Authority'](raw,c.req.header('authorization')));
    }catch(error){return failure(c,error);}
  });
  for(const operation of ['review','begin','callback','status'] as const)routes.post(`/upgrade/${operation}`,async c=>{
    try{const injected=c.get('user');const auth=await resourceSyncWebAuthority(c.req.header('authorization'),injected?{org_id:injected.org_id,user_id:injected.id,sid:injected.sid}:undefined);
      const caller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};
      const raw=await body(c);
      if((raw as {mode?:string}).mode==='credential_repair'){
        const {AppConnectionCredentialRepairService}=await import('../lib/app-connection-credential-repair-service.js');
        const {productionAppConnectionCredentialRepairPorts}=await import('../lib/app-connection-credential-repair-authority.js');
        return c.json(await new AppConnectionCredentialRepairService(productionAppConnectionCredentialRepairPorts(caller,auth.guard))[operation](caller,raw));
      }
      const {AppConnectionUpgradeService}=await import('../lib/app-connection-upgrade-service.js');
      const {productionAppConnectionUpgradePorts}=await import('../lib/app-connection-upgrade-authority.js');
      return c.json(await new AppConnectionUpgradeService(productionAppConnectionUpgradePorts(caller,auth.guard))[operation](caller,raw));
    }catch(error){return failure(c,error);}
  });
  for(const operation of ['begin','callback'] as const)routes.post(`/v2/${operation}`,async c=>{
    try{const injected=c.get('user');const auth=await resourceSyncWebAuthority(c.req.header('authorization'),injected?{org_id:injected.org_id,user_id:injected.id,sid:injected.sid}:undefined);
      const caller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};
      const {currentAppConnectionSessionV2Authority}=await import('../lib/app-connection-session-authority.js');
      const ports=productionAppConnectionSessionPorts(caller,auth.guard);
      return c.json(await new AppConnectionSessionService({...ports,currentAuthority:(active,nomination)=>currentAppConnectionSessionV2Authority(active,nomination,auth.guard)})[operation](caller,await body(c)));
    }catch(error){return failure(c,error);}
  });
  routes.post('/runtime/authority', async c => {
    try { return c.json(await appConnectionRuntimeAuthority(await body(c), c.req.header('authorization'))); }
    catch (error) { return failure(c, error); }
  });
  routes.post('/runtime/reattach-authority', async c => {
    try {
      const { appConnectionReattachmentRuntimeAuthority } = await import('../lib/app-connection-reattachment-authority.js');
      return c.json(await appConnectionReattachmentRuntimeAuthority(await body(c), c.req.header('authorization')));
    } catch (error) { return failure(c, error); }
  });
  for (const operation of ['review', 'activate', 'status'] as const) {
    routes.post(`/reattach/${operation}`, async c => {
      try {
        const injected = c.get('user');
        const auth = await resourceSyncWebAuthority(c.req.header('authorization'), injected ? {
          org_id: injected.org_id, user_id: injected.id, sid: injected.sid } : undefined);
        const caller = { org_id: auth.actor.org_id, user_id: auth.actor.actor_id, sid: auth.web_session.sid,
          access_expires_at: auth.web_session.expires_at };
        const { AppConnectionReattachmentService } = await import('../lib/app-connection-reattachment-service.js');
        const { productionAppConnectionReattachmentPorts } = await import('../lib/app-connection-reattachment-authority.js');
        return c.json(await new AppConnectionReattachmentService(productionAppConnectionReattachmentPorts(caller, auth.guard))
          [operation](caller, await body(c)));
      } catch (error) { return failure(c, error); }
    });
  }
  routes.get('/installations/:installationId/context',async c=>{
    try{
      if(new URL(c.req.url).search)throw invalid();
      const injected=c.get('user');
      const auth=await resourceSyncWebAuthority(c.req.header('authorization'),injected?{org_id:injected.org_id,user_id:injected.id,sid:injected.sid}:undefined);
      const caller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};
      const {appConnectionInstallationContext}=await import('../lib/app-connection-session-context.js');
      return c.json(await appConnectionInstallationContext(caller,z.string().uuid().parse(c.req.param('installationId')),auth.guard));
    }catch(error){return failure(c,error);}
  });
  for (const operation of ['begin', 'callback', 'status', 'disconnect'] as const) {
    routes.post(`/${operation}`, async c => {
      try {
        const injected = c.get('user');
        const auth = await resourceSyncWebAuthority(c.req.header('authorization'), injected ? {
          org_id: injected.org_id, user_id: injected.id, sid: injected.sid } : undefined);
        const caller = { org_id: auth.actor.org_id, user_id: auth.actor.actor_id, sid: auth.web_session.sid,
          access_expires_at: auth.web_session.expires_at };
        const service = new AppConnectionSessionService(productionAppConnectionSessionPorts(caller, auth.guard));
        return c.json(await service[operation](caller, await body(c)));
      } catch (error) { return failure(c, error); }
    });
  }
  return routes;
}
export const appConnectionSessionRoutes = createAppConnectionSessionRoutes();
