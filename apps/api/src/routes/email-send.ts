import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {EmailActor,EmailScope} from '../lib/email-mailbox-service.js';
import {EmailNativeSendError,type EmailNativeSendService} from '../lib/email-native-send-service.js';
type Session={id:string;org_id:string;sid:string;exp:number};
type Dependencies={verify(token:string):Promise<Session>;send(actor:EmailActor):Promise<Pick<EmailNativeSendService,'send'|'status'>>;reconcile?:(actor:EmailActor,scope:EmailScope)=>Promise<unknown>;now?:()=>number};
const Identifier=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Revision=z.number().int().min(1).max(2147483646);
export function createEmailSendRoutes(dependencies:Dependencies){
 const routes=new Hono(),base='/accounts/:accountId/drafts/:draftId/send';
 const verify=async(c:Context)=>{const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!token)return null;
  try{const session=await dependencies.verify(token);return session.id&&session.org_id&&session.sid&&Number.isFinite(session.exp)&&session.exp*1000>(dependencies.now??Date.now)()?session:null;}catch{return null;}};
 const identity=(c:Context,session:Session)=>({actor:{user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},
  scope:{org_id:session.org_id,owner_user_id:session.id,account_id:Identifier.parse(c.req.param('accountId'))},draftId:z.string().uuid().parse(c.req.param('draftId'))});
 const failure=(c:Context,error:unknown)=>{
  if(c.req.raw.signal.aborted)throw error;
  if(error instanceof z.ZodError)return c.json({code:'EMAIL_SEND_INVALID'},400);
  if(error instanceof EmailNativeSendError)return c.json({code:error.code},error.code==='EMAIL_SEND_ACCESS_DENIED'?403:error.code==='EMAIL_SEND_INVALID'?400
   :error.code==='EMAIL_SEND_NOT_FOUND'?404:error.code==='EMAIL_SEND_CONFLICT'||error.code==='EMAIL_SEND_UNKNOWN'?409
   :error.code==='EMAIL_SEND_LIMIT_EXCEEDED'||error.code==='EMAIL_SEND_SENDER_UNAVAILABLE'||error.code==='EMAIL_SEND_ATTACHMENT_UNAVAILABLE'||error.code==='EMAIL_SEND_REPLY_UNAVAILABLE'?422:503);
  return c.json({code:'EMAIL_SEND_UNAVAILABLE'},503);
 };
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 routes.post(base,bodyLimit({maxSize:1024,onError:c=>c.json({code:'EMAIL_SEND_INVALID'},413)}),async c=>{
  const session=await verify(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_SEND_INVALID'},400);
  try{const {actor,scope,draftId}=identity(c,session);let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_SEND_INVALID'},400);}
   const {expected_revision}=z.strictObject({expected_revision:Revision}).parse(body);
   const result=await(await dependencies.send(actor)).send(actor,scope,draftId,expected_revision,c.req.raw.signal);
   // The provider outcome is already durable. A cache wake failure must never
   // turn an accepted mutation into a resend invitation. Background sync repairs it.
   if(result.state==='accepted'){try{await dependencies.reconcile?.(actor,scope);}catch{/* periodic sync remains authoritative */}}
   c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return failure(c,error);}
 });
 routes.get(base+'/:revision',async c=>{
  const session=await verify(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search)return c.json({code:'EMAIL_SEND_INVALID'},400);
  try{const {actor,scope,draftId}=identity(c,session),revision=z.string().regex(/^[1-9][0-9]{0,9}$/u).transform(Number).pipe(Revision).parse(c.req.param('revision'));
   const result=await(await dependencies.send(actor)).status(actor,scope,draftId,revision,c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json({operation:result});
  }catch(error){return failure(c,error);}
 });
 return routes;
}
