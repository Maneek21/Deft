import {Hono,type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {EmailActor} from '../lib/email-mailbox-service.js';
import type {EmailAttachmentService} from '../lib/email-attachment-service.js';
import {EMAIL_ATTACHMENT_MAX_BYTES} from '../lib/email-attachment-crypto.js';
type Session={id:string;org_id:string;sid:string;exp:number};
type Dependencies={verify(token:string):Promise<Session>;files(actor:EmailActor):Promise<Pick<EmailAttachmentService,'upload'|'detach'|'read'>>;now?:()=>number};
const UUID=z.string().uuid(),Identifier=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const active=new Map<string,number>();let total=0;
async function consume<T>(owner:string,request:Request,use:(bytes:Uint8Array)=>Promise<T>):Promise<T>{
 if(total>=8||(active.get(owner)??0)>=2)throw Error('EMAIL_ATTACHMENT_BUSY');
 const declared=request.headers.get('content-length');if(declared!==null&&(!/^(0|[1-9][0-9]*)$/u.test(declared)||Number(declared)>EMAIL_ATTACHMENT_MAX_BYTES))throw Error('EMAIL_ATTACHMENT_TOO_LARGE');
 total++;active.set(owner,(active.get(owner)??0)+1);const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let joined:Uint8Array|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 let reject!: (error:unknown)=>void;const interrupted=new Promise<never>((_,fail)=>{reject=fail;});
 const abort=()=>{reject(Error('EMAIL_ATTACHMENT_INTERRUPTED'));void reader?.cancel().catch(()=>{});};
 try{
  if(request.signal.aborted)throw Error('EMAIL_ATTACHMENT_INTERRUPTED');request.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,60_000);
  let length=0;if(reader)for(;;){const next=await Promise.race([reader.read(),interrupted]);if(next.done)break;length+=next.value.byteLength;
   chunks.push(next.value);if(length>EMAIL_ATTACHMENT_MAX_BYTES)throw Error('EMAIL_ATTACHMENT_TOO_LARGE');}
  if(declared!==null&&Number(declared)!==length)throw Error('EMAIL_ATTACHMENT_INVALID');
  clearTimeout(timer);timer=undefined;request.signal.removeEventListener('abort',abort);request.signal.throwIfAborted();
  joined=new Uint8Array(length);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}return await use(joined);
 }finally{
  if(timer)clearTimeout(timer);request.signal.removeEventListener('abort',abort);void reader?.cancel().catch(()=>{});reader?.releaseLock();
  joined?.fill(0);for(const chunk of chunks)chunk.fill(0);total--;const count=(active.get(owner)??1)-1;if(count)active.set(owner,count);else active.delete(owner);
 }
}
export function createEmailAttachmentRoutes(dependencies:Dependencies){
 const routes=new Hono(),base='/accounts/:accountId/drafts/:draftId/files/:fileId';
 const verify=async(c:Context)=>{const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('authorization')??'')?.[1];if(!token)return null;
  try{const session=await dependencies.verify(token);return session.id&&session.org_id&&session.sid&&Number.isFinite(session.exp)&&session.exp*1000>(dependencies.now??Date.now)()?session:null;}catch{return null;}};
 const identity=(c:Context,session:Session)=>({actor:{user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},
  scope:{org_id:session.org_id,owner_user_id:session.id,account_id:Identifier.parse(c.req.param('accountId'))},draftId:UUID.parse(c.req.param('draftId')),fileId:UUID.parse(c.req.param('fileId'))});
 const failure=(c:Context,error:unknown)=>{
  if(c.req.raw.signal.aborted)throw error;
  if(error instanceof z.ZodError||error instanceof URIError)return c.json({code:'EMAIL_ATTACHMENT_INVALID'},400);
  const code=error instanceof Error?error.message:'';
  if(code==='EMAIL_DRAFT_CONFLICT')return c.json({code},409);
  if(code==='EMAIL_ATTACHMENT_TOO_LARGE')return c.json({code},413);
  if(['EMAIL_ATTACHMENT_ACCESS_DENIED','EMAIL_ACCESS_DENIED'].includes(code))return c.json({code:'EMAIL_ATTACHMENT_ACCESS_DENIED'},403);
  if(code==='EMAIL_DRAFT_NOT_FOUND')return c.json({code},404);
  return c.json({code:'EMAIL_ATTACHMENT_UNAVAILABLE'},503);
 };
 routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');c.header('Pragma','no-cache');await next();});
 routes.put(base,async c=>{
  const session=await verify(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search)return c.json({code:'EMAIL_ATTACHMENT_INVALID'},400);
  try{const {actor,scope,draftId,fileId}=identity(c,session);
   const revision=z.string().regex(/^[1-9][0-9]{0,9}$/u).transform(Number).pipe(z.number().int().max(2147483645)).parse(c.req.header('x-email-draft-revision'));
   const filename=decodeURIComponent(z.string().min(1).max(4096).parse(c.req.header('x-email-filename')));
   const media_type=z.string().regex(/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/u).parse(c.req.header('content-type'));
   const service=await dependencies.files(actor),result=await consume(JSON.stringify([session.org_id,session.id]),c.req.raw,
    bytes=>service.upload(actor,scope,draftId,revision,fileId,{filename,media_type},bytes,c.req.raw.signal));
   c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return failure(c,error);}
 });
 routes.post(base+'/detach',bodyLimit({maxSize:1024,onError:c=>c.json({code:'EMAIL_ATTACHMENT_INVALID'},413)}),async c=>{
  const session=await verify(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_ATTACHMENT_INVALID'},400);
  try{const {actor,scope,draftId,fileId}=identity(c,session);let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_ATTACHMENT_INVALID'},400);}
   const {expected_revision}=z.strictObject({expected_revision:z.number().int().min(1).max(2147483645)}).parse(body);
   const result=await(await dependencies.files(actor)).detach(actor,scope,draftId,expected_revision,fileId,c.req.raw.signal);
   c.req.raw.signal.throwIfAborted();return c.json(result);
  }catch(error){return failure(c,error);}
 });
 routes.get(base,async c=>{
  const session=await verify(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
  if(new URL(c.req.url).search)return c.json({code:'EMAIL_ATTACHMENT_INVALID'},400);let bytes:Uint8Array|undefined;
  try{const {actor,scope,draftId,fileId}=identity(c,session),file=await(await dependencies.files(actor)).read(actor,scope,draftId,fileId,undefined,c.req.raw.signal);
   bytes=file.bytes;c.req.raw.signal.throwIfAborted();
   const name=encodeURIComponent(file.filename).replace(/['()*]/gu,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
   return new Response(new Uint8Array(bytes),{headers:{'Content-Type':file.media_type,'Content-Disposition':"attachment; filename=\"attachment\"; filename*=UTF-8''"+name,
    'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
  }catch(error){return failure(c,error);}finally{bytes?.fill(0);}
 });
 return routes;
}
