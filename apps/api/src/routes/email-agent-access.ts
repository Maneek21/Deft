import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { EmailAgentAccessChange } from '../lib/email-agent-access.js';
import type { EmailActor, EmailScope } from '../lib/email-mailbox-service.js';
type Session={id:string;org_id:string;sid:string;exp:number};
export function createEmailAgentAccessRoutes(deps:{verify:(token:string)=>Promise<Session>;service:()=>Promise<{list(actor:EmailActor,scope:EmailScope):Promise<unknown>;change(actor:EmailActor,scope:EmailScope,raw:unknown):Promise<unknown>}>}){
 const routes=new Hono();
  routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 routes.get('/send-reviews/:actionId',async c=>{
  const bearer=/^Bearer ([^\s]+)$/.exec(c.req.header('authorization')??'');if(!bearer)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  let session:Session;try{session=await deps.verify(bearer[1]!);if(!session.sid||session.exp*1000<=Date.now())throw Error();}catch{return c.json({code:'EMAIL_AUTH_REQUIRED'},401);}
  try{
   // Verify current human SID, not only the access JWT, before showing mail.
   const {getEmailMailboxAuthority}=await import('../lib/email-account-authority-router.js');const {db}=await import('../lib/db.js');
   const {emailSendReviewPreview}=await import('../lib/email-agent-tool-runtime.js');
   const preview=await emailSendReviewPreview(c.req.param('actionId'),session.org_id,session.id);
   await(await getEmailMailboxAuthority(db)).current({user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},{org_id:session.org_id,owner_user_id:session.id,account_id:preview.account_id},'human_read');
   return c.json(preview);
  }catch(error){const code=error instanceof Error&&error.message==='EMAIL_SEND_REVIEW_STALE'?'EMAIL_SEND_REVIEW_STALE':'EMAIL_ACCESS_DENIED';return c.json({code},code==='EMAIL_SEND_REVIEW_STALE'?409:403);}
 });
 routes.on(['GET','PUT'],'/accounts/:accountId/agent-access',bodyLimit({maxSize:4096}),async c=>{
  const token=/^Bearer ([^\s]+)$/.exec(c.req.header('authorization')??'');if(!token)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  let session:Session;try{session=await deps.verify(token[1]!);if(!session.sid||!session.id||!session.org_id||session.exp*1000<=Date.now())throw Error();}catch{return c.json({code:'EMAIL_AUTH_REQUIRED'},401);}
  try{
   const actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},scope={org_id:session.org_id,owner_user_id:session.id,account_id:z.string().min(1).max(256).parse(c.req.param('accountId'))};
   const service=await deps.service();
   return c.json(c.req.method==='GET'?await service.list(actor,scope):await service.change(actor,scope,EmailAgentAccessChange.parse(await c.req.json())));
  }catch(error){const code=error instanceof z.ZodError?'EMAIL_AGENT_GRANT_INVALID':error instanceof Error&&['EMAIL_ACCESS_DENIED','EMAIL_AGENT_GRANT_CONFLICT'].includes(error.message)?error.message:'EMAIL_AGENT_GRANT_UNAVAILABLE';return c.json({code},code==='EMAIL_ACCESS_DENIED'?403:code==='EMAIL_AGENT_GRANT_CONFLICT'?409:code==='EMAIL_AGENT_GRANT_INVALID'?400:503);}
 });return routes;
}
