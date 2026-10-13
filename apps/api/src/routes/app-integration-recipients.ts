import {Hono} from 'hono';import {z} from 'zod';
import {appIntegrationRecipientService} from '../lib/app-integration-recipient-service.js';
import {appIntegrationJson} from '../lib/app-integration-http.js';
import {createAppResourcePrivateReadLimits} from '../middleware/app-resource-private-limits.js';
import {isAppOwnerConnectionsEnabled} from '../lib/env.js';
import {appHttpFailure} from './app-http-errors.js';
export function appIntegrationRecipientRoutes(){
 const routes=new Hono();routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');if(process.env.DEFT_APPS_ENABLED!=='true'||!isAppOwnerConnectionsEnabled())return c.json({error:'Recipient assistance unavailable'},503);await next();});
 routes.use('*',createAppResourcePrivateReadLimits({peerPerMinute:120,globalConcurrent:16,peerConcurrent:4}));
 routes.post('/:sessionId/search',async c=>{try{
  if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))throw Error('APP_ACTION_INVALID');
  const input=await appIntegrationJson(c,2048);
  return c.json(await(await appIntegrationRecipientService(c.req.header('authorization'),z.uuid().parse(c.req.param('sessionId')))).suggest(input,c.req.raw.signal));
 }catch(error){return appHttpFailure(c,error,'App action','app-actions');}});return routes;
}
