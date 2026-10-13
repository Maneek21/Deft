import {Hono} from 'hono';
import {z} from 'zod';
import {EmailMailboxError,type EmailActor} from '../lib/email-mailbox-service.js';
import type {EmailMessageSummaryService} from '../lib/email-message-summary.js';
export function createEmailMessageSummaryRoutes(ports:{verify:(token:string)=>Promise<{id:string;org_id:string;sid:string;exp:number}>;service:(actor:EmailActor)=>Promise<Pick<EmailMessageSummaryService,'read'>>;now?:()=>number}){
 const app=new Hono();app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 app.get('/accounts/:accountId/messages/:logicalId/summary',async c=>{
  const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('Authorization')??'')?.[1];if(!token)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  let session;try{session=await ports.verify(token);if(!session.id||!session.org_id||!session.sid||!Number.isFinite(session.exp)||session.exp*1000<=(ports.now??Date.now)())throw Error();}catch{return c.json({code:'EMAIL_AUTH_REQUIRED'},401);}
  if(new URL(c.req.url).search)return c.json({code:'EMAIL_MESSAGE_INVALID'},400);
  try{const actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},row=await(await ports.service(actor)).read(actor,{org_id:session.org_id,owner_user_id:session.id,account_id:c.req.param('accountId')},c.req.param('logicalId'),c.req.raw.signal);c.req.raw.signal.throwIfAborted();return row?c.json(row):c.json({code:'EMAIL_MESSAGE_NOT_FOUND'},404);}
  catch(error){if(c.req.raw.signal.aborted)throw error;return c.json({code:error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED'?'EMAIL_ACCESS_DENIED':error instanceof z.ZodError?'EMAIL_MESSAGE_INVALID':'EMAIL_MESSAGE_UNAVAILABLE'},error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED'?403:error instanceof z.ZodError?400:503);}
 });return app;
}
