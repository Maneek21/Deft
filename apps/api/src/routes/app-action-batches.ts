import { Hono } from 'hono';
import { z } from 'zod';
import { verifyWebAccess } from '../lib/web-sessions.js';
import { getAppActionBatchService } from '../lib/app-action-batch-service.js';
import type { ExperienceCaller } from '../lib/app-experience-service.js';
import { appHttpFailure } from './app-http-errors.js';
import { readMcpRequestJson, McpRequestBodyError } from '../lib/mcp-request-body.js';
export function createAppActionBatchRoutes() {
 const routes=new Hono<{Variables:{caller:ExperienceCaller}}>();
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');const bearer=/^Bearer ([^\s]+)$/.exec(c.req.header('authorization')??'');const user=bearer?await verifyWebAccess(bearer[1]!).catch(()=>null):null;
  if(!user)return c.json({error:'Human Web session required',code:'UNAUTHORIZED'},401);
  c.set('caller',{org_id:user.org_id,user_id:user.id,sid:user.sid,access_expires_at:user.exp*1000});await next();});
 const id=(value:string)=>z.string().uuid().parse(value);
 routes.get('/:id',async c=>{try{const caller=c.get('caller');return c.json(await (await getAppActionBatchService()).get({...caller,source:'defty'},id(c.req.param('id'))));}catch(e){return appHttpFailure(c,e,'App action','app-actions');}});
 routes.post('/:id/review',async c=>{try{return c.json(await (await getAppActionBatchService()).review(c.get('caller'),id(c.req.param('id'))));}catch(e){return appHttpFailure(c,e,'App action','app-actions');}});
 routes.post('/:id/approve',async c=>{try{if(!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))return c.json({error:'Invalid request',code:'VALIDATION_ERROR'},400);return c.json(await (await getAppActionBatchService()).approve(c.get('caller'),id(c.req.param('id')),await readMcpRequestJson(c.req.raw,131_072)));}catch(e){if(e instanceof McpRequestBodyError)return c.json({error:'Invalid batch approval request',code:'VALIDATION_ERROR'},e.status);return appHttpFailure(c,e,'App action','app-actions');}});
 routes.post('/:id/cancel',async c=>{try{const caller=c.get('caller');return c.json(await (await getAppActionBatchService()).cancel({...caller,source:'defty'},id(c.req.param('id'))));}catch(e){return appHttpFailure(c,e,'App action','app-actions');}});
 return routes;
}
