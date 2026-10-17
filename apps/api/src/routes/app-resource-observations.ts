import {Hono,type Context} from 'hono';
import {z} from 'zod';
import {AppResourceObservationService} from '../lib/app-resource-observation-service.js';
import {resourceObservationRuntimeAuthority} from '../lib/app-resource-observation-runtime.js';
import {resourceSyncWebAuthority,ResourceSyncWebAuthenticationError} from '../lib/app-resource-sync-web-authority.js';
import {readBoundedAppDataBytes} from '../lib/app-connection-session-registry.js';
import {AppError} from '../lib/app-errors.js';
import {isAppAttachmentBrokerEnabled,isAppOwnerConnectionsEnabled} from '../lib/env.js';
import {createAppResourceSyncLimits} from '../middleware/app-resource-sync-limits.js';
import {createAppResourcePrivateReadLimits} from '../middleware/app-resource-private-limits.js';
async function body(c:Context){
 if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))throw new SyntaxError('JSON required');
 const size=Number(c.req.header('content-length')??0);if(!Number.isSafeInteger(size)||size<0||size>16384)throw new SyntaxError('Body size');
 const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,15000);
 c.req.raw.signal.addEventListener('abort',abort,{once:true});
 try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await readBoundedAppDataBytes(c.req.raw.body,16384,controller.signal)));}
 finally{clearTimeout(timer);c.req.raw.signal.removeEventListener('abort',abort);}
}
function failure(c:Context,error:unknown){
 if(error instanceof AppError)return c.json({code:error.code,error:error.message},error.status);
 if(error instanceof ResourceSyncWebAuthenticationError)return c.json({code:'APP_ACCESS_DENIED',error:'Observation authentication required'},401);
 if(error instanceof z.ZodError||error instanceof SyntaxError||error instanceof TypeError)return c.json({code:'VALIDATION_ERROR',error:'Invalid observation request'},400);
 return c.json({code:'APP_PROVIDER_UNAVAILABLE',error:'Observation unavailable'},503);
}
export const appResourceObservationRoutes=new Hono();
const enabled=()=>process.env.DEFT_APPS_ENABLED==='true'&&isAppAttachmentBrokerEnabled()&&isAppOwnerConnectionsEnabled();
appResourceObservationRoutes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');
 if(!enabled())return c.json({code:'APP_FEATURE_DISABLED',error:'Observation unavailable'},503);await next();
 if(!enabled())return c.json({code:'APP_FEATURE_DISABLED',error:'Observation unavailable'},503);
});
appResourceObservationRoutes.use('/runtime/*',createAppResourceSyncLimits({globalPerMinute:600,peerPerMinute:600,globalConcurrent:60,peerConcurrent:16,maxPeerBuckets:1024}));
appResourceObservationRoutes.use('/consent/*',createAppResourcePrivateReadLimits({peerPerMinute:600,globalConcurrent:32,peerConcurrent:16}));
appResourceObservationRoutes.post('/runtime/authority',async c=>{try{if(c.req.header('cookie'))throw new AppError('Runtime credential required','APP_ACCESS_DENIED',403);return c.json(await resourceObservationRuntimeAuthority(await body(c),c.req.header('authorization')));}catch(error){return failure(c,error);}});
for(const operation of ['review','activate','revoke','status'] as const)appResourceObservationRoutes.post('/consent/'+operation,async c=>{
 try{const input=await body(c),auth=await resourceSyncWebAuthority(c.req.header('authorization'));
  return c.json(await new AppResourceObservationService()[operation](auth.actor,input,auth.guard));}catch(error){return failure(c,error);}
});

appResourceObservationRoutes.use('/installations/*',createAppResourcePrivateReadLimits({peerPerMinute:600,globalConcurrent:32,peerConcurrent:16}));
appResourceObservationRoutes.get('/installations/:installationId/context',async c=>{try{
 if(new URL(c.req.url).search)throw new SyntaxError('Unexpected query');
 const installationId=z.string().uuid().parse(c.req.param('installationId')),auth=await resourceSyncWebAuthority(c.req.header('authorization'));
 return c.json(await new AppResourceObservationService().context(auth.actor,installationId,auth.guard));
}catch(error){return failure(c,error);}});
