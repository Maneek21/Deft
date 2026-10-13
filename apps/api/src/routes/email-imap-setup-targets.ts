import {Hono} from 'hono';
import {z} from 'zod';
import {EmailMailboxError,type EmailActor} from '../lib/email-mailbox-service.js';
import type {EmailImapSetupTarget} from '../lib/email-imap-setup-targets.js';
const View=z.strictObject({items:z.array(z.strictObject({account_id:z.string().min(1).max(256),resource_binding_id:z.string().uuid(),credential_revision:z.number().int().min(0).max(2147483645),display_label:z.string().max(256),primary_address:z.union([z.literal(''),z.string().email().max(320)]),state:z.enum(['available','active','needs_attention'])})).max(50),has_more:z.boolean()});
export function createEmailImapSetupTargetRoutes(dependencies:{verify:(token:string)=>Promise<{id:string;org_id:string;sid:string;exp:number}>;list:(actor:EmailActor,orgId:string,signal?:AbortSignal)=>Promise<{items:EmailImapSetupTarget[];has_more:boolean}>;now?:()=>number}){
 const routes=new Hono(),now=dependencies.now??Date.now;routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 routes.get('/imap-setup-targets',async c=>{
  const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!token)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  let session:Awaited<ReturnType<typeof dependencies.verify>>;try{session=await dependencies.verify(token);if(!session.id||!session.org_id||!session.sid||!Number.isFinite(session.exp)||session.exp*1000<=now())throw Error();}catch{return c.json({code:'EMAIL_AUTH_REQUIRED'},401);}
  if(new URL(c.req.url).search)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
  try{const value=View.parse(await dependencies.list({user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},session.org_id,c.req.raw.signal));c.req.raw.signal.throwIfAborted();if(session.exp*1000<=now())throw new EmailMailboxError('EMAIL_ACCESS_DENIED');return c.json(value);}
  catch(error){if(c.req.raw.signal.aborted)throw error;return c.json({code:error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED'?'EMAIL_ACCESS_DENIED':'EMAIL_IMAP_SETUP_UNAVAILABLE'},error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED'?403:503);}
 });return routes;
}
