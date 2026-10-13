import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {EmailMailboxError,type EmailActor} from '../lib/email-mailbox-service.js';
const Id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Revision=z.number().int().min(1).max(2147483647);
export const EmailProviderDraftPublicStatusSchema=z.strictObject({account_id:Id,draft_id:z.string().uuid(),enabled:z.boolean(),draft_revision:Revision.nullable(),
 state:z.enum(['not_synced','queued','syncing','synced','conflict','unknown','unsupported','delete_pending','deleted','paused']),
 desired_revision:Revision.nullable(),synced_revision:Revision.nullable(),generation:Revision.nullable(),updated_at:z.iso.datetime().nullable(),recovery_available:z.boolean(),recovery_pending:z.boolean()});
export type EmailProviderDraftPublicStatus=z.infer<typeof EmailProviderDraftPublicStatusSchema>;
const Recover=z.strictObject({expected_revision:Revision,expected_generation:Revision});
type Session={id:string;org_id:string;sid:string;exp:number};
type Dependencies={verify:(token:string)=>Promise<Session>;read:(actor:EmailActor,orgId:string,accountId:string,draftId:string,signal?:AbortSignal)=>Promise<EmailProviderDraftPublicStatus>;
 recover:(actor:EmailActor,orgId:string,accountId:string,draftId:string,input:z.infer<typeof Recover>,signal?:AbortSignal)=>Promise<{account_id:string;draft_id:string;state:'queued'}>;now?:()=>number};
export function createEmailProviderDraftStatusRoutes(dependencies:Dependencies){
 const routes=new Hono(),base='/accounts/:accountId/drafts/:draftId/provider-sync',now=dependencies.now??Date.now;
 const verified=async(c:Context)=>{const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!token)return null;
  try{const session=await dependencies.verify(token);if(!Id.safeParse(session.id).success||!Id.safeParse(session.org_id).success||!Id.safeParse(session.sid).success||!Number.isFinite(session.exp)||session.exp*1000<=now())return null;return session;}catch{return null;}};
 const actor=(session:Session):EmailActor=>({user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000});
 const final=(c:Context,session:Session)=>{c.req.raw.signal.throwIfAborted();if(session.exp*1000<=now())throw new EmailMailboxError('EMAIL_ACCESS_DENIED');};
 const failure=(c:Context,error:unknown)=>{if(c.req.raw.signal.aborted)throw error;
  if(error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
  const code=error instanceof Error?error.message:'';
  if(code==='EMAIL_DRAFT_SYNC_ACCESS_DENIED')return c.json({code:'EMAIL_ACCESS_DENIED'},403);
  if(code==='EMAIL_DRAFT_SYNC_INVALID')return c.json({code},400);
  if(code==='EMAIL_DRAFT_SYNC_CONFLICT')return c.json({code},409);
  if(code==='EMAIL_DRAFT_SYNC_UNSUPPORTED')return c.json({code},422);
  return c.json({code:'EMAIL_DRAFT_SYNC_UNAVAILABLE'},503);};
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 routes.get(base,async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  const account=Id.safeParse(c.req.param('accountId')),draft=z.string().uuid().safeParse(c.req.param('draftId'));
  if(new URL(c.req.url).search||!account.success||!draft.success)return c.json({code:'EMAIL_DRAFT_SYNC_INVALID'},400);
  try{const value=EmailProviderDraftPublicStatusSchema.parse(await dependencies.read(actor(session),session.org_id,account.data,draft.data,c.req.raw.signal));
   if(value.account_id!==account.data||value.draft_id!==draft.data)throw Error();final(c,session);return c.json(value);}catch(error){return failure(c,error);}
 });
 routes.post(base+'/recover',bodyLimit({maxSize:1024,onError:c=>c.json({code:'EMAIL_DRAFT_SYNC_INVALID'},413)}),async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  const account=Id.safeParse(c.req.param('accountId')),draft=z.string().uuid().safeParse(c.req.param('draftId'));
  if(new URL(c.req.url).search||!account.success||!draft.success||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_DRAFT_SYNC_INVALID'},400);
  let input:z.infer<typeof Recover>;try{input=Recover.parse(await c.req.json());}catch{return c.json({code:'EMAIL_DRAFT_SYNC_INVALID'},400);}
  try{const value=z.strictObject({account_id:Id,draft_id:z.string().uuid(),state:z.literal('queued')}).parse(await dependencies.recover(actor(session),session.org_id,account.data,draft.data,input,c.req.raw.signal));
   if(value.account_id!==account.data||value.draft_id!==draft.data)throw Error();final(c,session);return c.json(value,202);}catch(error){return failure(c,error);}
 });
 return routes;
}
