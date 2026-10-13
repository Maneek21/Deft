import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {EmailRecipientAssistance,EmailRecipientError,EmailRecipientQuerySchema} from '../lib/email-recipient-assistance.js';
import type {EmailActor} from '../lib/email-mailbox-service.js';
type Session={id:string;org_id:string;sid:string;exp:number};
export function createEmailRecipientRoutes(ports:{verify:(token:string)=>Promise<Session>;service:(actor:EmailActor)=>Promise<Pick<EmailRecipientAssistance,'query'>>;now?:()=>number}){
 const app=new Hono();app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 const verified=async(c:Context)=>{const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!token)return null;try{const s=await ports.verify(token);return s.id&&s.org_id&&s.sid&&Number.isFinite(s.exp)&&s.exp*1000>(ports.now??Date.now)()?s:null;}catch{return null;}};
 app.post('/accounts/:accountId/recipients/query',bodyLimit({maxSize:4096,onError:c=>c.json({code:'EMAIL_RECIPIENT_INVALID'},413)}),async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('Content-Type')??''))return c.json({code:'EMAIL_RECIPIENT_INVALID'},400);
  try{const input=EmailRecipientQuerySchema.parse(await c.req.json()),actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000};const result=await(await ports.service(actor)).query(actor,{org_id:session.org_id,owner_user_id:session.id,account_id:c.req.param('accountId')},input,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);}
  catch(error){if(c.req.raw.signal.aborted)throw error;if(error instanceof EmailRecipientError)return c.json({code:error.code},error.code==='EMAIL_RECIPIENT_ACCESS_DENIED'?403:error.code==='EMAIL_RECIPIENT_INVALID'?400:503);return c.json({code:error instanceof SyntaxError||error instanceof Error&&error.name==='ZodError'?'EMAIL_RECIPIENT_INVALID':'EMAIL_RECIPIENT_UNAVAILABLE'},error instanceof SyntaxError||error instanceof Error&&error.name==='ZodError'?400:503);}
 });return app;
}
