import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {EmailActor,EmailScope} from '../lib/email-mailbox-service.js';
import {EmailNativeTriageError,type EmailNativeTriageService} from '../lib/email-native-triage.js';

type Session={id:string;org_id:string;sid:string;exp:number};
type Dependencies={verify(token:string):Promise<Session>;triage(actor:EmailActor):Promise<Pick<EmailNativeTriageService,'apply'|'status'|'undo'>>;reconcile?:(actor:EmailActor,scope:EmailScope)=>Promise<unknown>;now?:()=>number};
const Identifier=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Operation=z.string().uuid();
const Apply=z.strictObject({operation_id:Operation,kind:z.enum(['mark_read','mark_unread','star','unstar','archive','trash','move','labels','spam','not_spam','restore']),
 logical_message_ids:z.array(z.string().regex(/^mail_[a-f0-9]{64}$/u)).min(1).max(25).refine(ids=>new Set(ids).size===ids.length),destination_id:z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/u).optional(),
 label_action:z.enum(['add','remove']).optional(),destination_ids:z.array(z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/u)).min(1).max(16).refine(ids=>new Set(ids).size===ids.length).optional()})
 .refine(input=>input.kind==='labels'?input.label_action!==undefined&&input.destination_ids!==undefined&&input.destination_id===undefined
  :input.label_action===undefined&&input.destination_ids===undefined&&(input.kind==='move'?input.destination_id!==undefined:input.destination_id===undefined));

/** Native human actions use the session owner and opaque cached identities.
 * An uncertain HTTP response is recovered by status, never a new operation. */
export function createEmailTriageRoutes(dependencies:Dependencies){
 const routes=new Hono();
 const verified=async(c:Context)=>{const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!token)return null;
  try{const session=await dependencies.verify(token);return session.id&&session.org_id&&session.sid&&Number.isFinite(session.exp)&&session.exp*1000>(dependencies.now??Date.now)()?session:null;}catch{return null;}};
 const identity=(c:Context,session:Session)=>({actor:{user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},
  scope:{org_id:session.org_id,owner_user_id:session.id,account_id:Identifier.parse(c.req.param('accountId'))}});
 const fail=(c:Context,error:unknown)=>{
  if(c.req.raw.signal.aborted)throw error;
  if(error instanceof z.ZodError)return c.json({code:'EMAIL_TRIAGE_REQUEST_INVALID'},400);
  if(error instanceof EmailNativeTriageError)return c.json({code:error.code},error.code==='EMAIL_ACCESS_DENIED'?403:error.code==='EMAIL_MESSAGE_NOT_FOUND'?404:error.code==='EMAIL_TRIAGE_OPERATION_UNSUPPORTED'?400:503);
  const code=error instanceof Error?error.message:'';
  if(['EMAIL_TRIAGE_BUSY','EMAIL_TRIAGE_OPERATION_CONFLICT','EMAIL_TRIAGE_JOURNAL_CONFLICT'].includes(code))return c.json({code},409);
  // Do not leak provider responses, locators or credentials through failures.
  return c.json({code:'EMAIL_TRIAGE_UNAVAILABLE'},503);
 };
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 const base='/accounts/:accountId/operations';
 routes.get(base+'/:operationId',async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search)return c.json({code:'EMAIL_TRIAGE_REQUEST_INVALID'},400);
  try{const {actor,scope}=identity(c,session),id=Operation.parse(c.req.param('operationId'));
   const result=await(await dependencies.triage(actor)).status(actor,scope,id,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return fail(c,error);}
 });
 for(const undo of [false,true])routes.post(undo?base+'/:operationId/undo':base,bodyLimit({maxSize:undo?16384:160*1024,onError:c=>c.json({code:'EMAIL_TRIAGE_REQUEST_TOO_LARGE'},413)}),async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_TRIAGE_REQUEST_INVALID'},400);
  try{let body:unknown;const bytes=new Uint8Array(await c.req.arrayBuffer());
   try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return bytes.length>16384?c.json({code:'EMAIL_TRIAGE_REQUEST_TOO_LARGE'},413):c.json({code:'EMAIL_TRIAGE_REQUEST_INVALID'},400);}
   if((undo||!body||typeof body!=='object'||(body as {kind?:unknown}).kind!=='labels')&&bytes.length>16384)return c.json({code:'EMAIL_TRIAGE_REQUEST_TOO_LARGE'},413);
   const {actor,scope}=identity(c,session);
   const input=undo?z.strictObject({undo_operation_id:Operation}).parse(body):Apply.parse(body);
   const id=undo?Operation.parse(c.req.param('operationId')):undefined;
   const service=await dependencies.triage(actor),result='undo_operation_id' in input
    ?await service.undo(actor,scope,id!,input.undo_operation_id,c.req.raw.signal):await service.apply(actor,scope,input,c.req.raw.signal);
   // The provider outcome is already durable. A cache wake failure must never
   // turn an accepted mutation into a resend invitation. Background sync repairs it.
   if(result.items.some(item=>item.state==='succeeded')){try{await dependencies.reconcile?.(actor,scope);}catch{/* periodic sync remains authoritative */}}
   c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return fail(c,error);}
 });
 return routes;
}
