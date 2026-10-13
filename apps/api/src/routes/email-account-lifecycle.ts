import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {EmailAccountLifecycleRequestSchema,type EmailAccountLifecycleService} from '../lib/email-account-lifecycle-service.js';
import type {EmailActor,EmailScope} from '../lib/email-mailbox-service.js';
type Session={id:string;org_id:string;sid:string;exp:number};
const Id=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
export function createEmailAccountLifecycleRoutes(ports:{verify(token:string):Promise<Session>;service():Promise<Pick<EmailAccountLifecycleService,'read'|'update'|'catalog'>>;now?:()=>number}){
 const app=new Hono(),path='/accounts/:accountId/lifecycle';
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 const session=async(c:Context)=>{const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!token)return null;try{const value=await ports.verify(token);return value.id&&value.org_id&&value.sid&&Number.isFinite(value.exp)&&value.exp*1000>(ports.now??Date.now)()?value:null;}catch{return null;}};
 const actor=(s:Session):EmailActor=>({user_id:s.id,web_session_id:s.sid,access_expires_at:s.exp*1000});
 const scope=(c:Context,s:Session):EmailScope=>({org_id:s.org_id,owner_user_id:s.id,account_id:Id.parse(c.req.param('accountId'))});
 const fail=(c:Context,error:unknown)=>{if(c.req.raw.signal.aborted)throw error;if(error instanceof z.ZodError)return c.json({code:'EMAIL_ACCOUNT_LIFECYCLE_INVALID'},400);const code=error instanceof Error?error.message:'';
  if(code==='EMAIL_ACCESS_DENIED')return c.json({code},403);if(code==='EMAIL_ACCOUNT_LIFECYCLE_CONFLICT')return c.json({code},409);
  if(['EMAIL_ACCOUNT_CONNECTION_UNAVAILABLE','EMAIL_ACCOUNT_CAPABILITY_UNAVAILABLE'].includes(code))return c.json({code},422);return c.json({code:'EMAIL_ACCOUNT_LIFECYCLE_UNAVAILABLE'},503);};
 app.get('/accounts/lifecycle',async c=>{const s=await session(c);if(!s)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);try{if(new URL(c.req.url).search)return c.json({code:'EMAIL_ACCOUNT_LIFECYCLE_INVALID'},400);const result=await(await ports.service()).catalog(actor(s),s.org_id,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);}catch(error){return fail(c,error);}});
 app.get(path,async c=>{const s=await session(c);if(!s)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);try{if(new URL(c.req.url).search)return c.json({code:'EMAIL_ACCOUNT_LIFECYCLE_INVALID'},400);const result=await(await ports.service()).read(actor(s),scope(c,s),c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);}catch(error){return fail(c,error);}});
 app.patch(path,bodyLimit({maxSize:4096,onError:c=>c.json({code:'EMAIL_ACCOUNT_LIFECYCLE_INVALID'},413)}),async c=>{const s=await session(c);if(!s)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);try{if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_ACCOUNT_LIFECYCLE_INVALID'},400);
  let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_ACCOUNT_LIFECYCLE_INVALID'},400);}const input=EmailAccountLifecycleRequestSchema.parse(body),result=await(await ports.service()).update(actor(s),scope(c,s),input,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);}catch(error){return fail(c,error);}});
 return app;
}
