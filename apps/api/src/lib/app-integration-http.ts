import type {Context,Hono} from 'hono';import {readBoundedAppDataBytes} from './app-connection-session-registry.js';import {createAppResourcePrivateReadLimits} from '../middleware/app-resource-private-limits.js';import {isAppOwnerConnectionsEnabled} from './env.js';
export function appIntegrationPrivateLimits(routes:Hono){routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');if(process.env.DEFT_APPS_ENABLED!=='true'||!isAppOwnerConnectionsEnabled())return c.json({error:'App integration unavailable'},503);await next();});routes.use('*',createAppResourcePrivateReadLimits({peerPerMinute:120,globalConcurrent:16,peerConcurrent:4}));}
export async function appIntegrationJson(c:Context,maximum=32768){
 if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))throw Error('APP_ACTION_INVALID');
 const signal=AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(15000)]),bytes=await readBoundedAppDataBytes(c.req.raw.body,maximum,signal);
 try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
}
