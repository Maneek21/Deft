import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {EmailMailboxError,type EmailActor} from '../lib/email-mailbox-service.js';
import {EmailProviderDraftSettingsError,type PostgresEmailProviderDraftSettings} from '../lib/email-provider-draft-settings.js';
type Session={id:string;org_id:string;sid:string;exp:number};
type Dependencies={verify:(token:string)=>Promise<Session>;settings:(actor:EmailActor)=>Promise<Pick<PostgresEmailProviderDraftSettings,'get'|'update'>>;now?:()=>number};
const Id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Update=z.strictObject({enabled:z.boolean(),expected_revision:z.number().int().min(1).max(2147483646)});
export function createEmailProviderDraftSettingsRoutes(dependencies:Dependencies){
 const routes=new Hono(),base='/accounts/:accountId/provider-draft-sync';
 const verified=async(c:Context)=>{const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!token)return null;
  try{const session=await dependencies.verify(token);if(!Id.safeParse(session.id).success||!Id.safeParse(session.org_id).success||!Id.safeParse(session.sid).success||!Number.isFinite(session.exp)||session.exp*1000<=(dependencies.now??Date.now)())return null;return session;}catch{return null;}};
 const actor=(session:Session):EmailActor=>({user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000});
 const failure=(c:Context,error:unknown)=>{
  if(c.req.raw.signal.aborted)throw error;
  if(error instanceof z.ZodError)return c.json({code:'EMAIL_DRAFT_SYNC_INVALID'},400);
  if(error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
  if(error instanceof EmailProviderDraftSettingsError)return c.json({code:error.code},error.code==='EMAIL_DRAFT_SYNC_CONFLICT'?409:error.code==='EMAIL_DRAFT_SYNC_UNSUPPORTED'?422:400);
  return c.json({code:'EMAIL_DRAFT_SYNC_UNAVAILABLE'},503);
 };
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 routes.get(base,async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search)return c.json({code:'EMAIL_DRAFT_SYNC_INVALID'},400);
  try{const human=actor(session),value=await(await dependencies.settings(human)).get(human,session.org_id,Id.parse(c.req.param('accountId')),c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json(value);}catch(error){return failure(c,error);}
 });
 routes.patch(base,bodyLimit({maxSize:1024,onError:c=>c.json({code:'EMAIL_DRAFT_SYNC_INVALID'},413)}),async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_DRAFT_SYNC_INVALID'},400);
  let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_DRAFT_SYNC_INVALID'},400);}
  try{const human=actor(session),value=await(await dependencies.settings(human)).update(human,session.org_id,Id.parse(c.req.param('accountId')),Update.parse(body),c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json(value);}catch(error){return failure(c,error);}
 });
 return routes;
}
