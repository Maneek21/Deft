import {AppError} from '../lib/app-errors.js';
import {Hono,type Context} from 'hono';
import {z} from 'zod';
import {resourceSyncWebAuthority} from '../lib/app-resource-sync-web-authority.js';
import {readBoundedAppDataBytes} from '../lib/app-connection-session-registry.js';
import {createAppResourceSyncLimits} from '../middleware/app-resource-sync-limits.js';
import {createAppResourcePrivateReadLimits} from '../middleware/app-resource-private-limits.js';
import {isAppOwnerConnectionsEnabled} from '../lib/env.js';
import {integrationToolAuthority} from '../lib/app-integration-tool-runtime.js';
import {maybeAppIntegrationHumanReadAuthority} from '../lib/app-integration-recipient-transport.js';
import {integrationToolReviewService} from '../lib/app-integration-tool-review.js';
import {writeIntegrationToolGrant,revokeIntegrationToolGrant} from '../lib/app-integration-tool-grants.js';
import {appHttpFailure} from './app-http-errors.js';
const invalid=()=>new AppError('Invalid integration request','APP_ACTION_INVALID',400);
async function body(c:Context,maximum=614400){
 if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))throw invalid();
 const controller=new AbortController(),abort=()=>controller.abort();c.req.raw.signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,15000);
 try{const bytes=await readBoundedAppDataBytes(c.req.raw.body,maximum,controller.signal);try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}catch{throw invalid();}}
 finally{clearTimeout(timer);c.req.raw.signal.removeEventListener('abort',abort);}
}
async function caller(c:Context){const auth=await resourceSyncWebAuthority(c.req.header('authorization'));return {org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};}
export function createAppIntegrationToolRoutes(){
 const routes=new Hono(),enabled=()=>process.env.DEFT_APPS_ENABLED==='true'&&isAppOwnerConnectionsEnabled();
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');c.header('X-Content-Type-Options','nosniff');if(!enabled())return c.json({error:'Integration tools unavailable',code:'APP_FEATURE_DISABLED'},503);await next();if(!enabled())return c.json({error:'Integration tools unavailable',code:'APP_FEATURE_DISABLED'},503);});
 routes.use('/runtime/*',createAppResourceSyncLimits({globalPerMinute:600,peerPerMinute:600,globalConcurrent:32,peerConcurrent:16,maxPeerBuckets:1024}));
 routes.use('/grants*',createAppResourcePrivateReadLimits({peerPerMinute:120,globalConcurrent:16,peerConcurrent:4}));
 routes.use('/experiences/*',createAppResourcePrivateReadLimits({peerPerMinute:120,globalConcurrent:16,peerConcurrent:4}));
 routes.post('/runtime/authority',async c=>{try{const input=await body(c),authorization=c.req.header('authorization');return c.json(await maybeAppIntegrationHumanReadAuthority(input,authorization)??await integrationToolAuthority(input,authorization));}catch(error){return appHttpFailure(c,error,'App action','app-actions');}});
 routes.post('/grants',async c=>{try{const owner=await caller(c);return c.json(await writeIntegrationToolGrant(owner,await body(c,8192)));}catch(error){return appHttpFailure(c,error,'App action','app-actions');}});
 routes.post('/grants/:id/revoke',async c=>{try{const owner=await caller(c),input=z.strictObject({expected_revision:z.number().int().positive()}).parse(await body(c,512));return c.json(await revokeIntegrationToolGrant(owner,z.uuid().parse(c.req.param('id')),input.expected_revision));}catch(error){return appHttpFailure(c,error,'App action','app-actions');}});
 routes.post('/experiences/:sessionId/preparations/:invocationId/review',async c=>{try{const service=await integrationToolReviewService(await caller(c));z.strictObject({}).parse(await body(c,512));return c.json(await service.prepare(c.req.param('sessionId'),c.req.param('invocationId'),c.req.raw.signal));}catch(error){return appHttpFailure(c,error,'App action','app-actions');}});
 routes.post('/experiences/:sessionId/confirm',async c=>{try{const service=await integrationToolReviewService(await caller(c));return c.json(await service.confirm(c.req.param('sessionId'),await body(c,131072),c.req.raw.signal));}catch(error){return appHttpFailure(c,error,'App action','app-actions');}});
 routes.get('/experiences/:sessionId/preparations/:invocationId/status',async c=>{try{if(new URL(c.req.url).search)throw invalid();const service=await integrationToolReviewService(await caller(c));return c.json(await service.status(c.req.param('sessionId'),c.req.param('invocationId'),c.req.raw.signal));}catch(error){return appHttpFailure(c,error,'App action','app-actions');}});
 return routes;
}
export const appIntegrationToolRoutes=createAppIntegrationToolRoutes();
