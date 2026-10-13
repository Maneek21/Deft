import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {EmailActor} from '../lib/email-mailbox-service.js';
import {EmailOutboxEnqueueSchema,EmailOutboxScheduleInputSchema} from '../lib/email-outbox-contract.js';
import type {EmailOutboxService} from '../lib/email-outbox-service.js';
type Session={id:string;org_id:string;sid:string;exp:number};
type PublicService=Pick<EmailOutboxService,'enqueue'|'cancel'|'reschedule'|'read'|'list'|'readRequest'|'readDraft'>;
type Dependencies={verify(token:string):Promise<Session>;service(actor:EmailActor):Promise<PublicService>;now?:()=>number};
const Id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Revision=z.number().int().min(1).max(128);
export function createEmailOutboxRoutes(dependencies:Dependencies){
 const routes=new Hono(),base='/accounts/:accountId/outbox';
 const session=async(c:Context)=>{const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!token)return null;
  try{const value=await dependencies.verify(token);return value.id&&value.org_id&&value.sid&&Number.isFinite(value.exp)&&value.exp*1000>(dependencies.now??Date.now)()?value:null;}catch{return null;}};
 const identity=(c:Context,value:Session)=>({actor:{user_id:value.id,web_session_id:value.sid,access_expires_at:value.exp*1000},scope:{org_id:value.org_id,owner_user_id:value.id,account_id:Id.parse(c.req.param('accountId'))}});
 const failure=(c:Context,error:unknown)=>{if(c.req.raw.signal.aborted)throw error;if(error instanceof z.ZodError)return c.json({code:'EMAIL_OUTBOX_INVALID'},400);
  const code=error instanceof Error?error.message:'';
  if(['EMAIL_ACCESS_DENIED','EMAIL_SEND_ACCESS_DENIED','EMAIL_OUTBOX_ACCESS_DENIED','EMAIL_OUTBOX_LEASE_DENIED'].includes(code))return c.json({code:'EMAIL_ACCESS_DENIED'},403);
  if(code==='EMAIL_OUTBOX_NOT_FOUND')return c.json({code},404);
  if(code==='EMAIL_OUTBOX_CONFLICT')return c.json({code},409);
  if(['EMAIL_OUTBOX_INVALID','EMAIL_OUTBOX_SCHEDULE_INVALID','EMAIL_OUTBOX_SCHEDULE_GAP','EMAIL_OUTBOX_SCHEDULE_AMBIGUOUS','EMAIL_OUTBOX_SCHEDULE_PAST','EMAIL_OUTBOX_LIMIT',
   'EMAIL_SEND_INVALID','EMAIL_SEND_LIMIT_EXCEEDED','EMAIL_SEND_SENDER_UNAVAILABLE','EMAIL_SEND_ATTACHMENT_UNAVAILABLE','EMAIL_SEND_REPLY_UNAVAILABLE'].includes(code))return c.json({code},422);
  return c.json({code:'EMAIL_OUTBOX_UNAVAILABLE'},503);};
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 routes.get(base,async c=>{
  const value=await session(c);if(!value)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  try{const query=z.strictObject({limit:z.string().regex(/^[1-9][0-9]?$/u).transform(Number).default(30),cursor:z.string().min(1).max(8192).optional()}).parse(c.req.query());
   const {actor,scope}=identity(c,value),result=await(await dependencies.service(actor)).list(actor,scope,{limit:query.limit,cursor:query.cursor??null},c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return failure(c,error);}
 });
 routes.get(base+'/:outboxId',async c=>{
  const value=await session(c);if(!value)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  try{if(new URL(c.req.url).search)return c.json({code:'EMAIL_OUTBOX_INVALID'},400);const {actor,scope}=identity(c,value),id=z.string().uuid().parse(c.req.param('outboxId'));
   const result=await(await dependencies.service(actor)).read(actor,scope,id,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return result?c.json(result):c.json({code:'EMAIL_OUTBOX_NOT_FOUND'},404);
  }catch(error){return failure(c,error);}
 });
 routes.get(base+'/requests/:requestId',async c=>{
  const value=await session(c);if(!value)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  try{if(new URL(c.req.url).search)return c.json({code:'EMAIL_OUTBOX_INVALID'},400);const {actor,scope}=identity(c,value),id=z.string().uuid().parse(c.req.param('requestId'));
   const result=await(await dependencies.service(actor)).readRequest(actor,scope,id,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json({operation:result});
  }catch(error){return failure(c,error);}
 });
 routes.get('/accounts/:accountId/drafts/:draftId/outbox/:revision',async c=>{
  const value=await session(c);if(!value)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  try{if(new URL(c.req.url).search)return c.json({code:'EMAIL_OUTBOX_INVALID'},400);const {actor,scope}=identity(c,value),id=z.string().uuid().parse(c.req.param('draftId'));
   const revision=z.string().regex(/^[1-9][0-9]{0,9}$/u).transform(Number).pipe(z.number().int().max(2147483645)).parse(c.req.param('revision'));
   const result=await(await dependencies.service(actor)).readDraft(actor,scope,id,revision,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json({operation:result});
  }catch(error){return failure(c,error);}
 });
 const mutate=(action:'enqueue'|'cancel'|'reschedule')=>async(c:Context)=>{
  const value=await session(c);if(!value)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_OUTBOX_INVALID'},400);
  try{let raw:unknown;try{raw=await c.req.json();}catch{return c.json({code:'EMAIL_OUTBOX_INVALID'},400);}
   const body=action==='enqueue'?EmailOutboxEnqueueSchema.parse(raw):action==='cancel'?z.strictObject({expected_revision:Revision}).parse(raw):z.strictObject({expected_revision:Revision,schedule:EmailOutboxScheduleInputSchema}).parse(raw);
   const {actor,scope}=identity(c,value),service=await dependencies.service(actor);
   const input=action==='enqueue'?body:{...body,outbox_id:z.string().uuid().parse(c.req.param('outboxId'))};
   const result=await service[action](actor,scope,input,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result,action==='enqueue'?202:200);
  }catch(error){return failure(c,error);}
 };
 const bound=()=>bodyLimit({maxSize:4096,onError:(c:Context)=>c.json({code:'EMAIL_OUTBOX_INVALID'},413)});
 routes.post(base,bound(),mutate('enqueue'));routes.post(base+'/:outboxId/cancel',bound(),mutate('cancel'));routes.post(base+'/:outboxId/reschedule',bound(),mutate('reschedule'));
 return routes;
}
