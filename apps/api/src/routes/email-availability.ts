import {Hono,type Context} from 'hono';
import {z} from 'zod';
import type {EmailAvailability,EmailConnectionTargetPage} from '../lib/email-availability.js';
import type {EmailActor} from '../lib/email-mailbox-service.js';
type Session={id:string;org_id:string;sid:string;exp:number};
type Dependencies={enabled:()=>boolean;verify:(token:string)=>Promise<Session>;legacyInstallations:(orgId:string,ownerId:string,signal:AbortSignal)=>Promise<readonly string[]>;
 connectionTargets?:(actor:EmailActor,orgId:string,signal:AbortSignal)=>Promise<EmailConnectionTargetPage>;now?:()=>number};
const ResponseSchema=z.strictObject({available:z.boolean(),legacy_installation_ids:z.array(z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v))).max(50)});
const TargetsSchema=z.strictObject({targets:z.array(z.strictObject({provider:z.enum(['gmail','microsoft']),primary_address:z.string().email().max(320),display_label:z.string().max(256),
 native_email:z.strictObject({account_id:z.string().min(1).max(256),resource_binding_id:z.string().min(1).max(256),state:z.enum(['available','active','unavailable'])})})).max(50),has_more:z.boolean(),unavailable_count:z.number().int().min(0).max(50)});
const unavailable:EmailAvailability=Object.freeze({available:false,legacy_installation_ids:Object.freeze([])});
export function createEmailAvailabilityRoutes(deps:Dependencies){
 const routes=new Hono();
 routes.get('/availability',async(c:Context)=>{
  c.header('Cache-Control','no-store');c.header('Pragma','no-cache');
  if(!deps.enabled())return c.json(unavailable);
  if(new URL(c.req.url).search)return c.json(unavailable);
  const match=/^Bearer ([^\s]+)$/.exec(c.req.header('authorization')??'');if(!match)return c.json(unavailable);
  try{
   const session=await deps.verify(match[1]!);if(!session?.id||!session.org_id||!session.sid||!Number.isFinite(session.exp)
    ||session.exp*1000<=(deps.now??Date.now)())return c.json(unavailable);
   let ids:readonly string[]=[];try{ids=await deps.legacyInstallations(session.org_id,session.id,c.req.raw.signal);}catch{ids=[];}
   c.req.raw.signal.throwIfAborted();const result=ResponseSchema.parse({available:true,legacy_installation_ids:ids});return c.json(result);
  }catch{return c.json(unavailable);}
 });
 routes.get('/connection-targets',async(c:Context)=>{
  c.header('Cache-Control','no-store');c.header('Pragma','no-cache');
  if(!deps.enabled())return c.json({code:'EMAIL_NATIVE_DISABLED'},503);
  if(new URL(c.req.url).search)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
  const match=/^Bearer ([^\s]+)$/.exec(c.req.header('authorization')??'');if(!match)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  try{const session=await deps.verify(match[1]!);if(!session.id||!session.org_id||!session.sid||!Number.isFinite(session.exp)||session.exp*1000<=(deps.now??Date.now)())return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
   if(!deps.connectionTargets)return c.json({code:'EMAIL_TARGETS_UNAVAILABLE'},503);
   const actor:EmailActor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000};
   const result=TargetsSchema.parse(await deps.connectionTargets(actor,session.org_id,c.req.raw.signal));c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){if(c.req.raw.signal.aborted)throw error;return c.json({code:'EMAIL_TARGETS_UNAVAILABLE'},503);}
 });
 return routes;
}
