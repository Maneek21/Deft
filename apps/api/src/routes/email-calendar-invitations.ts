import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {EmailActor} from '../lib/email-mailbox-service.js';
import type {EmailCalendarInvitationService} from '../lib/email-calendar-invitation-service.js';
import {EmailInvitationApplySchema} from '../lib/email-calendar-invitation-contract.js';
type Session={id:string;org_id:string;sid:string;exp:number};
type Dependencies={verify(token:string):Promise<Session>;service(actor:EmailActor):Promise<Pick<EmailCalendarInvitationService,'preview'|'apply'|'readRequest'>>;now?:()=>number};
const Id=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v)),Logical=z.string().regex(/^mail_[a-f0-9]{64}$/u);
export function createEmailCalendarInvitationRoutes(dependencies:Dependencies){
 const routes=new Hono(),base='/accounts/:accountId/invitations';
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 const identity=async(c:Context)=>{const bearer=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!bearer)return null;
  let session:Session;try{session=await dependencies.verify(bearer);}catch{return null;}
  if(!session.id||!session.org_id||!session.sid||!Number.isFinite(session.exp)||session.exp*1000<=(dependencies.now??Date.now)())return null;
  return {actor:{user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},scope:{org_id:session.org_id,owner_user_id:session.id,account_id:Id.parse(c.req.param('accountId'))}};
 };
 const failure=(c:Context,error:unknown)=>{if(c.req.raw.signal.aborted)throw error;if(error instanceof z.ZodError)return c.json({code:'EMAIL_INVITATION_INVALID'},400);
  const code=error instanceof Error?error.message:'';
  if(['EMAIL_ACCESS_DENIED','EMAIL_INVITATION_ACCESS_DENIED','EMAIL_SEND_ACCESS_DENIED'].includes(code))return c.json({code:'EMAIL_ACCESS_DENIED'},403);
  if(code==='EMAIL_MESSAGE_NOT_FOUND')return c.json({code},404);
  if(['EMAIL_INVITATION_PREVIEW_STALE','EMAIL_INVITATION_STALE','EMAIL_INVITATION_VERSION_CONFLICT','EMAIL_INVITATION_REQUEST_CONFLICT','EMAIL_INVITATION_CALENDAR_EDITED','EMAIL_INVITATION_CALENDAR_DELETED'].includes(code))return c.json({code},409);
  if(['EMAIL_INVITATION_INVALID','EMAIL_INVITATION_UNSUPPORTED','EMAIL_INVITATION_NOT_IMPORTED','EMAIL_INVITATION_SERIES_CANCELLED','EMAIL_INVITATION_SERIES_LIMIT','EMAIL_INVITATION_TIME_UNSUPPORTED','EMAIL_INVITATION_SEND_UNAVAILABLE','EMAIL_SEND_INVALID','EMAIL_SEND_SENDER_UNAVAILABLE','EMAIL_SEND_LIMIT_EXCEEDED'].includes(code))return c.json({code},422);
  return c.json({code:'EMAIL_INVITATION_UNAVAILABLE'},503);
 };
 routes.get('/accounts/:accountId/messages/:logicalId/invitations',async c=>{try{
  const value=await identity(c);if(!value)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);if(new URL(c.req.url).search)return c.json({code:'EMAIL_INVITATION_INVALID'},400);
  const result=await(await dependencies.service(value.actor)).preview(value.actor,value.scope,Logical.parse(c.req.param('logicalId')),c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);
 }catch(error){return failure(c,error);}});
 routes.get(base+'/requests/:requestId',async c=>{try{
  const value=await identity(c);if(!value)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);if(new URL(c.req.url).search)return c.json({code:'EMAIL_INVITATION_INVALID'},400);
  const receipt=await(await dependencies.service(value.actor)).readRequest(value.actor,value.scope,z.uuid().parse(c.req.param('requestId')),c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json({receipt});
 }catch(error){return failure(c,error);}});
 routes.post(base+'/apply',bodyLimit({maxSize:16*1024,onError:c=>c.json({code:'EMAIL_INVITATION_INVALID'},413)}),async c=>{try{
  const value=await identity(c);if(!value)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_INVITATION_INVALID'},400);
  let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_INVITATION_INVALID'},400);}
  const request=EmailInvitationApplySchema.parse(body),result=await(await dependencies.service(value.actor)).apply(value.actor,value.scope,request,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result,request.action.kind==='rsvp'&&request.action.send_response?202:200);
 }catch(error){return failure(c,error);}});
 return routes;
}
