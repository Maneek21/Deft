import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {EmailImapSetupProfileSchema} from '../lib/email-imap-custody.js';
import type {EmailActor} from '../lib/email-mailbox-service.js';
import type {EmailEnrollmentResult} from '../lib/email-mailbox-enrollment.js';

type Dependencies={verify(token:string):Promise<{id:string;org_id:string;sid:string;exp:number}>;
 setup(actor:EmailActor,orgId:string,input:{account_id:string;resource_binding_id:string;expected_revision:number;profile:z.infer<typeof EmailImapSetupProfileSchema>},signal?:AbortSignal):Promise<EmailEnrollmentResult>;now?:()=>number};
/** Credential-bearing setup is a single no-store POST; credentials never
 * appear in query strings, response bodies, logs or provider adapter options. */
export function createEmailImapSetupRoutes(dependencies:Dependencies){
 const routes=new Hono();
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 routes.post('/accounts/:accountId/imap-setup',bodyLimit({maxSize:65536,onError:c=>c.json({code:'EMAIL_REQUEST_TOO_LARGE'},413)}),async c=>{
  const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];
  if(!token)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  let session:Awaited<ReturnType<Dependencies['verify']>>;
  try{session=await dependencies.verify(token);if(!session.id||!session.org_id||!session.sid||!Number.isFinite(session.exp)||session.exp*1000<=(dependencies.now??Date.now)())throw Error();}
  catch{return c.json({code:'EMAIL_AUTH_REQUIRED'},401);}
  if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_REQUEST_INVALID'},400);
  let input:z.infer<typeof EmailImapSetupProfileSchema>|undefined;
  try{
   const accountId=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v)).parse(c.req.param('accountId'));
   let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_REQUEST_INVALID'},400);}
   const parsed=z.strictObject({resource_binding_id:z.string().uuid(),expected_revision:z.number().int().min(0).max(2147483645),profile:EmailImapSetupProfileSchema}).parse(body);
   input=parsed.profile;
   const result=await dependencies.setup({user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},session.org_id,{account_id:accountId,...parsed},c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json({account_id:result.account_id,provider:result.provider,state:result.state,authority_revision:result.authority_revision});
  }catch(error){
   if(c.req.raw.signal.aborted)throw error;
   if(error instanceof z.ZodError)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
   const code=error&&typeof error==='object'&&'code'in error?error.code:error instanceof Error?error.message:'';
   if(code==='EMAIL_ACCESS_DENIED')return c.json({code},403);
   if(code==='EMAIL_IMAP_CUSTODY_CONFLICT'||code==='EMAIL_IMAP_PRINCIPAL_IMMUTABLE')return c.json({code:'EMAIL_IMAP_SETUP_CONFLICT'},409);
   return c.json({code:'EMAIL_IMAP_SETUP_FAILED'},422);
  }finally{if(input){input.password='';if(input.smtp)input.smtp.password='';}}
 });
 return routes;
}
