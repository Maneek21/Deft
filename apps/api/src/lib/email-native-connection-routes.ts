import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {EmailActor} from './email-mailbox-service.js';
import type {NativeEmailConnectionService} from './email-native-connection-service.js';
type Session={id:string;org_id:string;sid:string;exp:number};
/** Mount at /api/email. OAuth redirects land on the fixed frontend path
 * /email/connections/callback or the configured legacy callback; this factory never redirects or logs codes. */
export function createNativeEmailConnectionRoutes(ports:{verify(token:string):Promise<Session>;service():Promise<Pick<NativeEmailConnectionService,'providers'|'begin'|'callback'|'read'>>;now?:()=>number}){
 const app=new Hono(),now=ports.now??Date.now;
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 const session=async(c:Context)=>{const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!token)return null;try{const s=await ports.verify(token);return s.id&&s.org_id&&s.sid&&Number.isFinite(s.exp)&&s.exp*1000>now()?s:null;}catch{return null;}};
 const actor=(s:Session):EmailActor=>({user_id:s.id,web_session_id:s.sid,access_expires_at:s.exp*1000});
 const scope=(s:Session)=>({org_id:s.org_id,owner_user_id:s.id});
 const fail=(c:Context,error:unknown)=>{if(c.req.raw.signal.aborted)throw error;if(error instanceof z.ZodError)return c.json({code:'EMAIL_CONNECTION_INVALID'},400);const code=error instanceof Error?error.message:'';
  if(code==='EMAIL_ACCESS_DENIED')return c.json({code},403);
  if(code==='EMAIL_CONNECTION_CONFLICT')return c.json({code},409);
  if(['EMAIL_CONNECTION_PROFILE_UNAVAILABLE','EMAIL_CONNECTION_CAPABILITY_UNAVAILABLE','EMAIL_CONNECTION_IDENTITY_CHANGED','EMAIL_CONNECTION_LIMIT'].includes(code))return c.json({code},422);
  return c.json({code:'EMAIL_CONNECTION_UNAVAILABLE'},503);
 };
 app.get('/connections/providers',async c=>{const s=await session(c);if(!s)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);try{if(new URL(c.req.url).search)return c.json({code:'EMAIL_CONNECTION_INVALID'},400);const result=await(await ports.service()).providers(actor(s),scope(s),c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);}catch(error){return fail(c,error);}});
 app.get('/connections/requests/:requestId',async c=>{const s=await session(c);if(!s)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);try{if(new URL(c.req.url).search)return c.json({code:'EMAIL_CONNECTION_INVALID'},400);const requestId=z.uuid().parse(c.req.param('requestId')),result=await(await ports.service()).read(actor(s),scope(s),requestId,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return result?c.json(result):c.json({code:'EMAIL_CONNECTION_NOT_FOUND'},404);}catch(error){return fail(c,error);}});
 for(const operation of ['begin','callback'] as const)app.post('/connections/'+operation,bodyLimit({maxSize:8192,onError:c=>c.json({code:'EMAIL_CONNECTION_INVALID'},413)}),async c=>{
  const s=await session(c);if(!s)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  try{if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_CONNECTION_INVALID'},400);
   let input:unknown;try{input=await c.req.json();}catch{return c.json({code:'EMAIL_CONNECTION_INVALID'},400);}
   const result=await(await ports.service())[operation](actor(s),scope(s),input,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return fail(c,error);}
 });
 return app;
}
