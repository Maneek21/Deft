import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {EmailActor} from '../lib/email-mailbox-service.js';
import {EmailSignatureServiceError,EmailSignatureService} from '../lib/email-signature-service.js';
import {SignatureEntrySchema} from '../lib/email-signature-types.js';

type VerifiedSession={id:string;org_id:string;sid:string;exp:number};
type Dependencies={verify:(token:string)=>Promise<VerifiedSession>;signatures:(actor:EmailActor)=>Promise<Pick<EmailSignatureService,'get'|'put'>>;now?:()=>number};
const Identifier=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const Put=z.strictObject({expected_revision:z.number().int().min(0).max(2147483646),identities:z.array(SignatureEntrySchema).max(32)});
export function createEmailSignatureRoutes(dependencies:Dependencies){
 const routes=new Hono();
 const verified=async(c:Context):Promise<VerifiedSession|null>=>{const match=/^Bearer ([^\s]+)$/.exec(c.req.header('authorization')??'');if(!match)return null;
  try{const s=await dependencies.verify(match[1]!);if(!s.id||!s.org_id||!s.sid||!Number.isFinite(s.exp)||s.exp*1000<=(dependencies.now??Date.now)())return null;return s;}catch{return null;}};
 const actor=(s:VerifiedSession):EmailActor=>({user_id:s.id,web_session_id:s.sid,access_expires_at:s.exp*1000});
 const fail=(c:Context,error:unknown)=>{if(c.req.raw.signal.aborted)throw error;if(error instanceof z.ZodError)return c.json({code:'EMAIL_SIGNATURE_INVALID'},400);
  if(error instanceof EmailSignatureServiceError){const status=error.code==='EMAIL_SIGNATURE_ACCESS_DENIED'?403:error.code==='EMAIL_SIGNATURE_INVALID'?400:error.code==='EMAIL_SIGNATURE_CONFLICT'?409:503;return c.json({code:error.code},status);}
  return c.json({code:'EMAIL_SIGNATURE_UNAVAILABLE'},503);};
 const scope=(s:VerifiedSession,accountId:string)=>({org_id:s.org_id,owner_user_id:s.id,account_id:Identifier.parse(accountId)});
 const json=(c:Context)=>/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??'');
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 routes.get('/accounts/:accountId/signatures',async c=>{const s=await verified(c);if(!s)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);if(new URL(c.req.url).search)return c.json({code:'EMAIL_SIGNATURE_INVALID'},400);
  try{const a=actor(s),result=await(await dependencies.signatures(a)).get(a,scope(s,c.req.param('accountId')),c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);}catch(e){return fail(c,e);}});
 routes.put('/accounts/:accountId/signatures',bodyLimit({maxSize:72*1024,onError:c=>c.json({code:'EMAIL_SIGNATURE_TOO_LARGE'},413)}),async c=>{
  const s=await verified(c);if(!s)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);if(new URL(c.req.url).search||!json(c))return c.json({code:'EMAIL_SIGNATURE_INVALID'},400);
  try{let raw:unknown;try{raw=await c.req.json();}catch{return c.json({code:'EMAIL_SIGNATURE_INVALID'},400);}const input=Put.parse(raw),a=actor(s);
   const result=await(await dependencies.signatures(a)).put(a,scope(s,c.req.param('accountId')),input,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(e){return fail(c,e);}});
 return routes;
}
