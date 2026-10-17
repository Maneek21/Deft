import {Hono,type Context} from 'hono';
import {z} from 'zod';
import {AppConnectionFormService} from '../lib/app-connection-form-service.js';
import {appConnectionFormRuntimeAuthority,productionAppConnectionFormPorts} from '../lib/app-connection-form-authority.js';
import {resourceSyncWebAuthority,ResourceSyncWebAuthenticationError} from '../lib/app-resource-sync-web-authority.js';
import {readBoundedConnectionJson} from '../lib/app-connection-session-registry.js';
import {AppError} from '../lib/app-errors.js';
import {isAppOwnerConnectionsEnabled} from '../lib/env.js';
import {createAppResourceSyncLimits} from '../middleware/app-resource-sync-limits.js';
import {createAppResourcePrivateReadLimits} from '../middleware/app-resource-private-limits.js';
import {appConnectionFormContext} from '../lib/app-connection-form-context.js';
const enabled=()=>process.env.DEFT_APPS_ENABLED==='true'&&isAppOwnerConnectionsEnabled();
const disabled=(c:Context)=>c.json({error:'Credential setup unavailable',code:'APP_FEATURE_DISABLED'},503);
async function body(c:Context){if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))throw new AppError('Invalid setup metadata','APP_ACTION_INVALID',400);
 const length=Number(c.req.header('content-length')??0);if(!Number.isSafeInteger(length)||length<0||length>16384)throw new AppError('Invalid setup metadata','APP_ACTION_INVALID',400);
 try{return await readBoundedConnectionJson(c.req.raw.body,AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(10000)]));}catch{throw new AppError('Invalid setup metadata','APP_ACTION_INVALID',400);}}
function failure(c:Context,error:unknown){if(error instanceof AppError)return c.json({error:error.message,code:error.code},error.status);
 if(error instanceof ResourceSyncWebAuthenticationError)return c.json({error:'Authentication required',code:'APP_ACCESS_DENIED'},401);
 if(error instanceof z.ZodError)return c.json({error:'Invalid setup metadata',code:'VALIDATION_ERROR'},400);
 const code=(error as {code?:unknown})?.code,status=(error as {status?:unknown})?.status;
 if((code==='APP_ACCESS_DENIED'||code==='APP_STATE_CONFLICT')&&(status===403||status===409))return c.json({error:'Credential setup access changed',code},status);
 return c.json({error:'Credential setup unavailable',code:'APP_PROVIDER_UNAVAILABLE'},503);}
export function createAppConnectionFormRoutes(){const routes=new Hono();
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');if(!enabled())return disabled(c);await next();if(!enabled())return disabled(c);});
 routes.use('/runtime/authority',createAppResourceSyncLimits({globalPerMinute:600,peerPerMinute:600,globalConcurrent:60,peerConcurrent:16,maxPeerBuckets:1024}));
 routes.post('/runtime/authority',async c=>{try{return c.json(await appConnectionFormRuntimeAuthority(await body(c),c.req.header('authorization')));}catch(error){return failure(c,error);}});
 const owner=createAppResourcePrivateReadLimits({peerPerMinute:600,globalConcurrent:32,peerConcurrent:16});
 routes.use('/installations/*',owner);routes.get('/installations/:installationId/context',async c=>{try{
  if(new URL(c.req.url).search)throw new AppError('Invalid setup context','APP_ACTION_INVALID',400);
  const installationId=z.string().uuid().parse(c.req.param('installationId')),auth=await resourceSyncWebAuthority(c.req.header('authorization')),
   caller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};
  if(!enabled())return disabled(c);return c.json(await appConnectionFormContext(caller,installationId,auth.guard));
 }catch(error){return failure(c,error);}});
 for(const operation of ['begin','status','disconnect'] as const){routes.use('/'+operation,owner);routes.post('/'+operation,async c=>{try{const auth=await resourceSyncWebAuthority(c.req.header('authorization')),
   caller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at},service=new AppConnectionFormService(productionAppConnectionFormPorts(caller,auth.guard)),input=await body(c);
   if(!enabled())return disabled(c);return c.json(operation==='begin'?await service.begin(caller,input):await service.manage(caller,input,operation));}catch(error){return failure(c,error);}});}
 return routes;
}
