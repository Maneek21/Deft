import {Hono,type Context} from 'hono';
import type {UnofficialStatusCode} from 'hono/utils/http-status';
import {z} from 'zod';
import {APP_DATA_FRAME_MEDIA_TYPE,APP_DATA_LIMITS,AppDataResolveInputSchema,parseAppDataFrame,frameAppData} from '@deft/app-kit';
import {AppDataService} from '../lib/app-data-service.js';
import {appRecordMirrorRuntime} from '../lib/app-record-mirror-runtime.js';
import {appDataRuntimeAuthority} from '../lib/app-data-authority.js';
import {readBoundedAppDataBytes} from '../lib/app-connection-session-registry.js';
import {resourceSyncWebAuthority,ResourceSyncWebAuthenticationError} from '../lib/app-resource-sync-web-authority.js';
import {AppError} from '../lib/app-errors.js';
import {isAppOwnerConnectionsEnabled} from '../lib/env.js';
import {createAppResourceSyncLimits} from '../middleware/app-resource-sync-limits.js';
import {createAppResourcePrivateReadLimits} from '../middleware/app-resource-private-limits.js';
import {withAppDataBinaryIo} from '../lib/app-data-io-limits.js';
const enabled=()=>process.env.DEFT_APPS_ENABLED==='true'&&isAppOwnerConnectionsEnabled();
const invalid=()=>new AppError('Invalid App data request','APP_ACTION_INVALID',400);
export function appDataContextOptions(url:string){
 const query=new URL(url).searchParams;if(!query.size)return {};
 if(query.size!==1||!query.has('target_key'))throw invalid();
 const input=AppDataResolveInputSchema.pick({target_key:true}).parse({target_key:query.get('target_key')});
 return {targetKey:input.target_key,includeIdentities:false};
}
async function readBody(c:Context,binary=false,limit?:number){
 if(new URL(c.req.url).search)throw invalid();const type=c.req.header('content-type')??'';
 if(binary?type!==APP_DATA_FRAME_MEDIA_TYPE:!/^application\/json(?:\s*;|$)/iu.test(type))throw invalid();
 const maximum=limit??(binary?APP_DATA_LIMITS.file_bytes+APP_DATA_LIMITS.frame_header_bytes+4:APP_DATA_LIMITS.json_bytes);
 const size=Number(c.req.header('content-length')??0);if(!Number.isSafeInteger(size)||size<0||size>maximum)throw invalid();
 const controller=new AbortController(),abort=()=>controller.abort();c.req.raw.signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,15000);
 try{const bytes=await readBoundedAppDataBytes(c.req.raw.body,maximum,controller.signal);return binary?parseAppDataFrame(bytes):JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}
 finally{clearTimeout(timer);c.req.raw.signal.removeEventListener('abort',abort);}
}
async function service(c:Context){const auth=await resourceSyncWebAuthority(c.req.header('authorization'));return new AppDataService({org_id:auth.actor.org_id,user_id:auth.actor.actor_id,
 sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at},auth.guard);}
function failure(c:Context,error:unknown){
 if(error instanceof AppError)return c.json({error:error.message,code:error.code},error.status);
 if(error instanceof ResourceSyncWebAuthenticationError)return c.json({error:'App data authentication required',code:'APP_ACCESS_DENIED'},401);
 if(error instanceof z.ZodError||error instanceof SyntaxError||error instanceof TypeError)return c.json({error:'Invalid App data request',code:'VALIDATION_ERROR'},400);
 // A closed incoming request is not evidence of backend unavailability. Keep
 // authority/validation errors above and unrelated backend failures below;
 // an internal operation timeout alone must never acquire this classification.
 // The service retains its indeterminate journal after any possible dispatch.
 if(c.req.raw.signal.aborted&&error instanceof Error&&error.name==='AbortError')return c.json({error:'App data request cancelled',code:'APP_REQUEST_ABORTED'},499 as UnofficialStatusCode);
 return c.json({error:'App data request unavailable',code:'APP_PROVIDER_UNAVAILABLE'},503);
}
export function createAppDataRoutes(){const routes=new Hono();
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');c.header('X-Content-Type-Options','nosniff');
  if(!enabled())return c.json({error:'App data unavailable',code:'APP_FEATURE_DISABLED'},503);await next();
  if(!enabled())return c.json({error:'App data unavailable',code:'APP_FEATURE_DISABLED'},503);
 });
 routes.use('/runtime/*',createAppResourceSyncLimits({globalPerMinute:600,peerPerMinute:600,globalConcurrent:60,peerConcurrent:16,maxPeerBuckets:1024}));
 const owner=createAppResourcePrivateReadLimits({peerPerMinute:600,globalConcurrent:32,peerConcurrent:16});routes.use('/connections/*',owner);routes.use('/installations/*',owner);
 routes.post('/runtime/record-mirrors',async c=>{try{return c.json(await appRecordMirrorRuntime(await readBody(c,false,APP_DATA_LIMITS.frame_header_bytes),c.req.header('authorization')));}catch(error){return failure(c,error);}});
 routes.post('/runtime/authority',async c=>{try{return c.json(await appDataRuntimeAuthority(await readBody(c,false,APP_DATA_LIMITS.frame_header_bytes),c.req.header('authorization')));}catch(error){return failure(c,error);}});
 routes.get('/installations/:installationId/context',async c=>{try{const options=appDataContextOptions(c.req.url),active=await service(c);return c.json(await active.context(z.string().uuid().parse(c.req.param('installationId')),options));}catch(error){return failure(c,error);}});
 routes.post('/installations/:installationId/resolve',async c=>{try{const active=await service(c);return c.json(await active.resolve(z.string().uuid().parse(c.req.param('installationId')),await readBody(c,false,1024)));}catch(error){return failure(c,error);}});
 for(const operation of ['review','activate'] as const)routes.post(`/connections/:sessionId/consent/${operation}`,async c=>{try{const active=await service(c);return c.json(await active[operation](z.string().uuid().parse(c.req.param('sessionId')),await readBody(c)));}catch(error){return failure(c,error);}});
 routes.post('/connections/:sessionId/consent/revoke',async c=>{try{const active=await service(c),input=z.strictObject({consent_id:z.string().uuid()}).parse(await readBody(c));return c.json(await active.revoke(z.string().uuid().parse(c.req.param('sessionId')),input.consent_id));}catch(error){return failure(c,error);}});
 for(const binary of [false,true])routes.post(`/connections/:sessionId/${binary?'binary':'requests'}`,async c=>{try{const active=await service(c);
  return await withAppDataBinaryIo(active.caller,binary?'file_upload':'metadata',async()=>{const raw=await readBody(c,binary);
  const framed=binary?raw as {header:unknown;bytes:Uint8Array}:null;
  const reply=await active.invoke(z.string().uuid().parse(c.req.param('sessionId')),framed?.header??raw,framed?.bytes,c.req.raw.signal);
  if(reply.metadata&&reply.bytes)return new Response(frameAppData(reply.metadata,reply.bytes) as BodyInit,{headers:{'Content-Type':APP_DATA_FRAME_MEDIA_TYPE,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  return c.json(reply.result);});
 }catch(error){return failure(c,error);}});
 return routes;
}
export const appDataRoutes=createAppDataRoutes();
