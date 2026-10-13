import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {EmailActor} from '../lib/email-mailbox-service.js';
import {EmailTemplateError,EmailTemplateService} from '../lib/email-template-service.js';
import {EmailTemplateContentSchema} from '../lib/email-template-store.js';
type VerifiedSession={id:string;org_id:string;sid:string;exp:number};
type Dependencies={verify:(token:string)=>Promise<VerifiedSession>;templates:(actor:EmailActor)=>Promise<Pick<EmailTemplateService,'list'|'read'|'create'|'update'|'archive'|'render'>>;now?:()=>number};
const Identifier=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const TemplateId=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const Create=z.strictObject({template_id:TemplateId,content:EmailTemplateContentSchema});
const Save=z.strictObject({expected_revision:z.number().int().min(1).max(2147483646),content:EmailTemplateContentSchema});
const Archive=z.strictObject({expected_revision:z.number().int().min(1).max(2147483646)});
const List=z.strictObject({cursor:z.string().min(1).max(8192).nullable(),limit:z.number().int().min(1).max(50)});
const Render=z.strictObject({values:z.record(z.string(),z.string().max(8192))});
export function createEmailTemplateRoutes(dependencies:Dependencies){
 const routes=new Hono();
 const verified=async(c:Context):Promise<VerifiedSession|null>=>{
  const match=/^Bearer ([^\s]+)$/.exec(c.req.header('authorization')??'');if(!match)return null;
  try{const session=await dependencies.verify(match[1]!);if(!session.id||!session.org_id||!session.sid||!Number.isFinite(session.exp)||session.exp*1000<=(dependencies.now??Date.now)())return null;return session;}catch{return null;}
 };
 const actor=(s:VerifiedSession):EmailActor=>({user_id:s.id,web_session_id:s.sid,access_expires_at:s.exp*1000});
 const fail=(c:Context,error:unknown)=>{
  if(c.req.raw.signal.aborted)throw error;if(error instanceof z.ZodError)return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);
  if(error instanceof EmailTemplateError){const status=error.code==='EMAIL_TEMPLATE_ACCESS_DENIED'?403:error.code==='EMAIL_TEMPLATE_NOT_FOUND'?404:
   error.code==='EMAIL_TEMPLATE_INVALID'?400:error.code==='EMAIL_TEMPLATE_CONFLICT'?409:503;return c.json({code:error.code},status);}
  return c.json({code:'EMAIL_TEMPLATE_UNAVAILABLE'},503);
 };
 const contentType=(c:Context)=>/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??'');
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 routes.get('/accounts/:accountId/templates',async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  try{
   const query=new URL(c.req.url).searchParams;if([...query.keys()].some(k=>!['cursor','limit'].includes(k)))return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);
   const cursorRaw=query.get('cursor'),limitRaw=query.get('limit')??'50',input=List.parse({cursor:cursorRaw,limit:Number(limitRaw)});
   const scope={org_id:session.org_id,owner_user_id:session.id,account_id:Identifier.parse(c.req.param('accountId'))};
   const result=await(await dependencies.templates(actor(session))).list(actor(session),scope,input.cursor,input.limit,c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return fail(c,error);}
 });
 routes.post('/accounts/:accountId/templates',bodyLimit({maxSize:512*1024,onError:c=>c.json({code:'EMAIL_TEMPLATE_TOO_LARGE'},413)}),async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search||!contentType(c))return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);
  try{let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);}const input=Create.parse(body);
   const scope={org_id:session.org_id,owner_user_id:session.id,account_id:Identifier.parse(c.req.param('accountId'))};
   const result=await(await dependencies.templates(actor(session))).create(actor(session),scope,input.template_id,input.content,c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json(result,201);
  }catch(error){return fail(c,error);}
 });
 routes.get('/accounts/:accountId/templates/:templateId',async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search)return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);
  try{const scope={org_id:session.org_id,owner_user_id:session.id,account_id:Identifier.parse(c.req.param('accountId'))};
   const result=await(await dependencies.templates(actor(session))).read(actor(session),scope,TemplateId.parse(c.req.param('templateId')),c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return fail(c,error);}
 });
 routes.put('/accounts/:accountId/templates/:templateId',bodyLimit({maxSize:512*1024,onError:c=>c.json({code:'EMAIL_TEMPLATE_TOO_LARGE'},413)}),async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search||!contentType(c))return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);
  try{let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);}const input=Save.parse(body);
   const scope={org_id:session.org_id,owner_user_id:session.id,account_id:Identifier.parse(c.req.param('accountId'))};
   const result=await(await dependencies.templates(actor(session))).update(actor(session),scope,TemplateId.parse(c.req.param('templateId')),input.expected_revision,input.content,c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return fail(c,error);}
 });
 routes.post('/accounts/:accountId/templates/:templateId/archive',bodyLimit({maxSize:2*1024,onError:c=>c.json({code:'EMAIL_TEMPLATE_TOO_LARGE'},413)}),async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search||!contentType(c))return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);
  try{let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);}const input=Archive.parse(body);
   const scope={org_id:session.org_id,owner_user_id:session.id,account_id:Identifier.parse(c.req.param('accountId'))};
   const result=await(await dependencies.templates(actor(session))).archive(actor(session),scope,TemplateId.parse(c.req.param('templateId')),input.expected_revision,c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return fail(c,error);}
 });
 routes.post('/accounts/:accountId/templates/:templateId/render',bodyLimit({maxSize:256*1024,onError:c=>c.json({code:'EMAIL_TEMPLATE_TOO_LARGE'},413)}),async c=>{
  const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search||!contentType(c))return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);
  try{let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_TEMPLATE_INVALID'},400);}const input=Render.parse(body);
   const scope={org_id:session.org_id,owner_user_id:session.id,account_id:Identifier.parse(c.req.param('accountId'))};
   const result=await(await dependencies.templates(actor(session))).render(actor(session),scope,TemplateId.parse(c.req.param('templateId')),input.values,c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return fail(c,error);}
 });
 return routes;
}
