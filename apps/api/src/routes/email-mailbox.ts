import {EmailConversationError,type EmailMailboxConversationService} from '../lib/email-mailbox-conversation.js';
import type {HttpBindings,Http2Bindings} from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { EmailMailboxError, type EmailActor, type EmailMailboxService } from '../lib/email-mailbox-service.js';
import type {EmailReadingPreference,EmailReadingPreferenceUpdate} from '../lib/email-reading-preferences.js';
import type {EmailRefreshResult} from '../lib/email-mailbox-refresh.js';
import {EmailUnifiedMailboxError,type EmailMailboxUnifiedService} from '../lib/email-mailbox-unified.js';
import {EmailMessageContentError,type EmailMessageContentService} from '../lib/email-message-content.js';
import {NativeEmailIncomingLimits} from '../lib/app-connection-contract.js';
import {acquireEmailIncomingBinaryResponse,EmailIncomingReadBusyError} from '../lib/email-incoming-read-budget.js';
import type {EmailAccountCatalogService} from '../lib/email-account-catalog.js';
import {EmailMailboxSearchError,type EmailMailboxSearchService} from '../lib/email-mailbox-search.js';
import {EmailNativeFolderError,type EmailNativeFolderService} from '../lib/email-native-folders.js';
import {EmailFolderManageRequestSchema,EmailFolderManageError} from '../lib/email-folder-management-contract.js';
import {performance} from 'node:perf_hooks';
import {emailSearchDiagnostics,profileEmailSearchPhase,noteEmailSearchResult} from '../lib/email-search-diagnostics.js';

type VerifiedSession = { id: string; org_id: string; sid: string; exp: number };
type Dependencies = {
  verify: (token: string) => Promise<VerifiedSession>;
  service: (actor: EmailActor) => Promise<Pick<EmailMailboxService, 'list'>>;
  enroll?: (actor: EmailActor, orgId: string, input: {account_id:string;resource_binding_id:string}, signal?: AbortSignal) =>
    Promise<{account_id:string;provider:string;state:'active';authority_revision:number}>;
  readingPreferences?: {
    get(actor:EmailActor,orgId:string,accountId:string,signal?:AbortSignal):Promise<EmailReadingPreference>;
    update(actor:EmailActor,orgId:string,accountId:string,input:EmailReadingPreferenceUpdate,signal?:AbortSignal):Promise<EmailReadingPreference>;
  };
  now?: () => number;
  refresh?: (actor:EmailActor,orgId:string,accountId:string,signal?:AbortSignal)=>Promise<EmailRefreshResult>;
  unified?: (actor:EmailActor)=>Promise<Pick<EmailMailboxUnifiedService,'list'>>;
  content?: (actor:EmailActor)=>Promise<Pick<EmailMessageContentService,'readSource'> & Partial<Pick<EmailMessageContentService,'readPresentation'|'readFile'|'readImage'>>>;
  accounts?: (actor:EmailActor)=>Promise<Pick<EmailAccountCatalogService,'list'>>;
  search?: (actor:EmailActor)=>Promise<Pick<EmailMailboxSearchService,'search'>>;
  conversation?:(actor:EmailActor)=>Promise<Pick<EmailMailboxConversationService,'read'>>;
  folders?: (actor:EmailActor)=>Promise<Pick<EmailNativeFolderService,'list'> & Partial<Pick<EmailNativeFolderService,'manage'|'status'|'recent'>>>;
};
const querySchema = z.strictObject({ folder: z.string().min(1).max(256).default('inbox'),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(100)).default(50),
  cursor: z.string().min(1).max(8192).optional(),
  include_total: z.enum(['true','false']).transform(value=>value==='true').optional() });

/** Native reads derive org/owner solely from a verified human web session.
 * No provider credentials, Experience disclosure handles or sync cursor cross
 * this boundary. Account enrollment and native sync remain separate operations. */
export function createEmailMailboxRoutes(dependencies: Dependencies) {
  const routes = new Hono<{Bindings:{outgoing?:(HttpBindings|Http2Bindings)['outgoing'];server?:{outgoing?:(HttpBindings|Http2Bindings)['outgoing']}}}>();
  const verified=async(c:Context)=>{
    const bearer=/^Bearer ([^\s]+)$/.exec(c.req.header('authorization') ?? '');
    if(!bearer)return null;
    try {
      const value=await dependencies.verify(bearer[1]!);
      if(!value.id || !value.org_id || !value.sid || !Number.isFinite(value.exp)
        || value.exp*1000<=(dependencies.now ?? Date.now)())return null;
      return value;
    } catch{return null;}
  };
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    await next();
  });
  routes.get('/accounts',async c=>{
    const session=await verified(c);
    if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    if(!dependencies.accounts)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try{
      const actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000};
      const result=await(await dependencies.accounts(actor)).list(actor,session.org_id,c.req.raw.signal);
      c.req.raw.signal.throwIfAborted();return c.json(result);
    }catch(error){
      if(error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
      return c.json({code:'EMAIL_UNAVAILABLE'},503);
    }
  });
  // POST carries opaque multi-account continuations without URL length or
  // query-log limits. This operation only reads already-enrolled mailboxes.
  routes.post('/messages/query',bodyLimit({maxSize:300*1024,onError:c=>c.json({code:'EMAIL_REQUEST_TOO_LARGE'},413)}),async c=>{
    const session=await verified(c);
    if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    if(!dependencies.unified)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try{
      let raw:unknown;try{raw=await c.req.json();}catch{return c.json({code:'EMAIL_REQUEST_INVALID'},400);}
      const account=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
      const request=z.strictObject({account_ids:z.array(account).min(2).max(16).refine(ids=>new Set(ids).size===ids.length),
        folder:account.default('inbox'),limit:z.number().int().min(1).max(100).default(50),
        cursor:z.string().min(1).max(256*1024).nullable().default(null),include_total:z.boolean().optional()}).parse(raw);
      const actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000};
      const page=await(await dependencies.unified(actor)).list(actor,{org_id:session.org_id,owner_user_id:session.id},request,c.req.raw.signal);
      c.req.raw.signal.throwIfAborted();return c.json(page);
    }catch(error){
      if(error instanceof z.ZodError)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
      if(error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
      if(error instanceof EmailUnifiedMailboxError)return c.json({code:error.code},error.code==='EMAIL_UNIFIED_PAGE_INVALID'?400:409);
      return c.json({code:'EMAIL_UNAVAILABLE'},503);
    }
  });
  routes.get('/accounts/:accountId/messages', async c => {
    const session=await verified(c);
    if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    try {
      const url = new URL(c.req.url);
      for (const key of url.searchParams.keys()) {
        if (url.searchParams.getAll(key).length !== 1) return c.json({code:'EMAIL_REQUEST_INVALID'},400);
      }
      const request = querySchema.parse(Object.fromEntries(url.searchParams));
      const accountId = z.string().min(1).max(256).refine(value => value.trim()===value && !/[\u0000-\u001f\u007f]/u.test(value)).parse(c.req.param('accountId'));
      const actor: EmailActor = {user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000};
      const page = await (await dependencies.service(actor)).list(actor,
        {org_id:session.org_id,owner_user_id:session.id,account_id:accountId},
        {folder:request.folder,limit:request.limit,cursor:request.cursor ?? null,
          ...(request.include_total===undefined?{}:{include_total:request.include_total})},c.req.raw.signal);
      c.req.raw.signal.throwIfAborted();
      return c.json(page);
    } catch (error) {
      if (error instanceof z.ZodError) return c.json({code:'EMAIL_REQUEST_INVALID'},400);
      if (error instanceof EmailMailboxError) {
        const status = error.code==='EMAIL_ACCESS_DENIED' ? 403
          : error.code==='EMAIL_CURSOR_EXPIRED' || error.code==='EMAIL_CHECKPOINT_CONFLICT' ? 409 : 503;
        return c.json({code:error.code},status);
      }
      return c.json({code:'EMAIL_UNAVAILABLE'},503);
    }
  });
  routes.post('/accounts/:accountId/search',bodyLimit({maxSize:16*1024,onError:c=>c.json({code:'EMAIL_REQUEST_TOO_LARGE'},413)}),async c=>{
    const profileStarted=performance.now();
    const session=await verified(c);
    if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    if(!dependencies.search)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try{
      let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_REQUEST_INVALID'},400);}
      const input=z.strictObject({query:z.string().min(1).max(2048),limit:z.number().int().min(1).max(100).default(50),cursor:z.string().min(1).max(8192).nullable().default(null)}).parse(body);
      const account=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value)).parse(c.req.param('accountId'));
      const actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000};
      return await emailSearchDiagnostics.run(account,async()=>{
        const service=await profileEmailSearchPhase('setup',()=>dependencies.search!(actor));
        const result=await profileEmailSearchPhase('search',()=>service.search(actor,{org_id:session.org_id,owner_user_id:session.id,account_id:account},input,c.req.raw.signal));
        c.req.raw.signal.throwIfAborted();noteEmailSearchResult({items:result.items.length,failures:result.failure_count,partial:!result.complete});
        return profileEmailSearchPhase('json_response',async()=>c.json(result));
      },performance.now()-profileStarted);
    }catch(error){
      if(error instanceof z.ZodError)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
      if(error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
      if(error instanceof EmailMailboxSearchError)return c.json({code:error.code},error.code==='EMAIL_ACCESS_DENIED'?403:error.code==='EMAIL_SEARCH_INVALID'?400:error.code==='EMAIL_SEARCH_CURSOR_INVALID'?409:503);
      return c.json({code:'EMAIL_UNAVAILABLE'},503);
    }
  });
  routes.post('/accounts/:accountId/folders/query',bodyLimit({maxSize:270*1024,onError:c=>c.json({code:'EMAIL_REQUEST_TOO_LARGE'},413)}),async c=>{
    const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    if(!dependencies.folders)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try{let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_REQUEST_INVALID'},400);}
      const input=z.strictObject({cursor:z.string().min(1).max(256*1024).nullable().default(null),limit:z.number().int().min(1).max(100).default(50),management:z.literal(true).optional()}).parse(body);
      const account=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value)).parse(c.req.param('accountId'));
      const actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000};
      const result=await(await dependencies.folders(actor)).list(actor,{org_id:session.org_id,owner_user_id:session.id,account_id:account},input,c.req.raw.signal);
      c.req.raw.signal.throwIfAborted();return c.json(result);
    }catch(error){
      if(error instanceof z.ZodError)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
      if(error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
      if(error instanceof EmailNativeFolderError)return c.json({code:error.code},409);
      if(error instanceof EmailFolderManageError)return c.json({code:error.code},error.code==='EMAIL_FOLDER_MANAGEMENT_UNSUPPORTED'?400:409);
      return c.json({code:'EMAIL_UNAVAILABLE'},503);
    }
  });
  const folderFailure=(error:unknown,c:Context)=>{
    if(error instanceof z.ZodError)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    if(error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
    if(error instanceof EmailFolderManageError)return c.json({code:error.code},error.code==='EMAIL_FOLDER_MANAGEMENT_UNSUPPORTED'?400:409);
    return c.json({code:'EMAIL_UNAVAILABLE'},503);
  };
  routes.post('/accounts/:accountId/folders/manage',bodyLimit({maxSize:16*1024,onError:c=>c.json({code:'EMAIL_REQUEST_TOO_LARGE'},413)}),async c=>{
    const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);if(!dependencies.folders)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try{let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_REQUEST_INVALID'},400);}const input=EmailFolderManageRequestSchema.parse(body),account=z.string().min(1).max(256).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v)).parse(c.req.param('accountId'));
      const actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},service=await dependencies.folders(actor);if(!service.manage)return c.json({code:'EMAIL_UNAVAILABLE'},503);
      const result=await service.manage(actor,{org_id:session.org_id,owner_user_id:session.id,account_id:account},input,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);
    }catch(error){return folderFailure(error,c);}
  });
  for(const status of [false,true])routes.get(status?'/accounts/:accountId/folders/operations/:operationId':'/accounts/:accountId/folders/operations',async c=>{
    const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);if(!dependencies.folders)return c.json({code:'EMAIL_UNAVAILABLE'},503);if(new URL(c.req.url).search)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try{const account=z.string().min(1).max(256).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v)).parse(c.req.param('accountId')),operation=status?z.uuid().parse(c.req.param('operationId')):null,actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},service=await dependencies.folders(actor),scope={org_id:session.org_id,owner_user_id:session.id,account_id:account};
      if(status&&!service.status||!status&&!service.recent)return c.json({code:'EMAIL_UNAVAILABLE'},503);
      const result=status?await service.status!(actor,scope,operation!,c.req.raw.signal):await service.recent!(actor,scope,c.req.raw.signal);c.req.raw.signal.throwIfAborted();return c.json(result);
    }catch(error){return folderFailure(error,c);}
  });
  routes.get('/accounts/:accountId/messages/:messageId/source',async c=>{
    const session=await verified(c);
    if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    if(!dependencies.content)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    let bytes:Uint8Array|undefined,lease:Awaited<ReturnType<typeof acquireEmailIncomingBinaryResponse>>|undefined,transferred=false;
    try{
      const account=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value)).parse(c.req.param('accountId'));
      const message=z.string().regex(/^mail_[a-f0-9]{64}$/).parse(c.req.param('messageId'));
      const actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000};
      lease=await acquireEmailIncomingBinaryResponse({signal:c.req.raw.signal,deadline:session.exp*1000,outgoing:c.env?.outgoing??c.env?.server?.outgoing});
      const result=await(await dependencies.content(actor)).readSource(actor,{org_id:session.org_id,owner_user_id:session.id,account_id:account},message,lease.signal);
      bytes=result.mime_bytes;c.req.raw.signal.throwIfAborted();
      if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>NativeEmailIncomingLimits.source_bytes||result.byte_length!==bytes.byteLength||result.media_type!=='message/rfc822')
        throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
      const response=lease.response(bytes,{'Content-Type':'message/rfc822','Content-Disposition':'attachment; filename="message.eml"',
        'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff'});transferred=true;return response;
    }catch(error){
      if(error instanceof z.ZodError)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
      if(error instanceof EmailIncomingReadBusyError||error instanceof EmailMessageContentError&&error.code==='EMAIL_SOURCE_BUSY')return c.json({code:'EMAIL_SOURCE_BUSY'},503,{'Retry-After':'2'});
      if(error instanceof EmailMessageContentError)return c.json({code:error.code},error.code==='EMAIL_ACCESS_DENIED'?403:error.code==='EMAIL_MESSAGE_NOT_FOUND'?404:503);
      return c.json({code:'EMAIL_UNAVAILABLE'},503);
    }finally{if(bytes instanceof Uint8Array)bytes.fill(0);if(!transferred)lease?.dispose();}
  });
  const messagePath='/accounts/:accountId/messages/:messageId';
  const messageIdentity=(c:Context,session:VerifiedSession)=>({
    actor:{user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},
    scope:{org_id:session.org_id,owner_user_id:session.id,account_id:z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value)).parse(c.req.param('accountId'))},
    logicalId:z.string().regex(/^mail_[a-f0-9]{64}$/u).parse(c.req.param('messageId')),
  });
  const contentError=(c:Context,error:unknown)=>{
    if(error instanceof z.ZodError)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    if(error instanceof EmailIncomingReadBusyError||error instanceof EmailMessageContentError&&error.code==='EMAIL_SOURCE_BUSY')return c.json({code:'EMAIL_SOURCE_BUSY'},503,{'Retry-After':'2'});
    if(error instanceof EmailMessageContentError)return c.json({code:error.code},error.code==='EMAIL_ACCESS_DENIED'?403:error.code==='EMAIL_MESSAGE_NOT_FOUND'?404:503);
    return c.json({code:'EMAIL_UNAVAILABLE'},503);
  };
  routes.get(messagePath+'/presentation',async c=>{
    const session=await verified(c);
    if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    if(!dependencies.content)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try{
      const {actor,scope,logicalId}=messageIdentity(c,session),service=await dependencies.content(actor);
      if(!service.readPresentation)return c.json({code:'EMAIL_UNAVAILABLE'},503);
      const result=await service.readPresentation(actor,scope,logicalId,c.req.raw.signal);
      c.req.raw.signal.throwIfAborted();
      // HTML remains data in JSON. The trusted browser renderer sanitizes it.
      c.header('X-Content-Type-Options','nosniff');return c.json(result);
    }catch(error){return contentError(c,error);}
  });
  for(const operation of ['file','image'] as const){
    routes.post(messagePath+'/'+operation,bodyLimit({maxSize:1024,onError:c=>c.json({code:'EMAIL_REQUEST_TOO_LARGE'},413)}),async c=>{
      const session=await verified(c);
      if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
      if(!dependencies.content)return c.json({code:'EMAIL_UNAVAILABLE'},503);
      if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_REQUEST_INVALID'},400);
      let bytes:Uint8Array|undefined,lease:Awaited<ReturnType<typeof acquireEmailIncomingBinaryResponse>>|undefined,transferred=false;
      try{
        let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_REQUEST_INVALID'},400);}
        const digest=z.string().regex(/^[a-f0-9]{64}$/u);
        const input=operation==='file'?z.strictObject({source_digest:digest,file_ref:digest}).parse(body):z.strictObject({source_digest:digest,image_ref:digest}).parse(body);
        const {actor,scope,logicalId}=messageIdentity(c,session);
        if(operation==='file')lease=await acquireEmailIncomingBinaryResponse({signal:c.req.raw.signal,deadline:session.exp*1000,outgoing:c.env?.outgoing??c.env?.server?.outgoing});
        const service=await dependencies.content(actor);
        if(operation==='file'&&!service.readFile||operation==='image'&&!service.readImage)return c.json({code:'EMAIL_UNAVAILABLE'},503);
        const result=operation==='file'
          ?await service.readFile!(actor,scope,logicalId,input as {source_digest:string;file_ref:string},lease!.signal)
          :await service.readImage!(actor,scope,logicalId,input as {source_digest:string;image_ref:string},c.req.raw.signal);
        bytes=result.bytes;c.req.raw.signal.throwIfAborted();
        if(!(bytes instanceof Uint8Array)||bytes.byteLength!==(result.byte_length)||bytes.byteLength>(operation==='file'?NativeEmailIncomingLimits.file_bytes:2097152))
          throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
        const headers:Record<string,string>={'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'none'; sandbox",'Content-Type':result.media_type};
        if(operation==='file'){
          const filename=('filename' in result?result.filename:'attachment').replace(/[\u0000-\u001f\u007f/\\]/gu,'_').slice(0,240)||'attachment';
          headers['Content-Disposition']="attachment; filename=\"attachment\"; filename*=UTF-8''"+encodeURIComponent(filename).replace(/['()*]/gu,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
        }else headers['Content-Disposition']='inline';
        const response=lease?lease.response(bytes,headers):new Response(new Uint8Array(bytes),{headers});transferred=!!lease;return response;
      }catch(error){return contentError(c,error);}finally{if(bytes instanceof Uint8Array)bytes.fill(0);if(!transferred)lease?.dispose();}
    });
  }
  routes.post('/accounts/:accountId/messages/:messageId/conversation',bodyLimit({maxSize:270*1024,onError:c=>c.json({code:'EMAIL_REQUEST_TOO_LARGE'},413)}),async c=>{
    const session=await verified(c);if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    if(!dependencies.conversation)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try{
      let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_REQUEST_INVALID'},400);}
      const input=z.strictObject({cursor:z.string().min(1).max(256*1024).nullable().default(null),limit:z.number().int().min(1).max(100).default(50)}).parse(body);
      const {actor,scope,logicalId}=messageIdentity(c,session);
      const result=await(await dependencies.conversation(actor)).read(actor,scope,{...input,logical_message_id:logicalId},c.req.raw.signal);
      c.req.raw.signal.throwIfAborted();return c.json(result);
    }catch(error){
      if(error instanceof z.ZodError)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
      if(error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
      if(error instanceof EmailConversationError)return c.json({code:error.code},error.code==='EMAIL_CONVERSATION_MESSAGE_NOT_FOUND'?404:error.code==='EMAIL_CONVERSATION_UNAVAILABLE'?503:409);
      return c.json({code:'EMAIL_CONVERSATION_UNAVAILABLE'},503);
    }
  });
  routes.post('/accounts/:accountId/adopt',bodyLimit({maxSize:4096,onError:c=>c.json({code:'EMAIL_REQUEST_TOO_LARGE'},413)}),async c=>{
    const session=await verified(c);
    if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    if(!dependencies.enroll)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search || !/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? ''))
      return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    let body:unknown;
    try{body=await c.req.json();}catch{return c.json({code:'EMAIL_REQUEST_INVALID'},400);}
    const parsed=z.strictObject({resource_binding_id:z.string().uuid()}).safeParse(body);
    const account=z.string().min(1).max(256).refine(value=>value.trim()===value && !/[\u0000-\u001f\u007f]/u.test(value)).safeParse(c.req.param('accountId'));
    if(!parsed.success || !account.success)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try {
      const output=await dependencies.enroll({user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},
        session.org_id,{account_id:account.data,resource_binding_id:parsed.data.resource_binding_id},c.req.raw.signal);
      c.req.raw.signal.throwIfAborted();return c.json(output);
    }catch(error){
      if(error instanceof EmailMailboxError && error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
      return c.json({code:'EMAIL_UNAVAILABLE'},503);
    }
  });
  routes.post('/accounts/:accountId/refresh',bodyLimit({maxSize:1024,onError:c=>c.json({code:'EMAIL_REQUEST_TOO_LARGE'},413)}),async c=>{
    const session=await verified(c);
    if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    if(!dependencies.refresh)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try{
      let body:unknown;try{body=await c.req.json();}catch{return c.json({code:'EMAIL_REQUEST_INVALID'},400);}
      z.strictObject({}).parse(body);
      const account=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value)).parse(c.req.param('accountId'));
      const result=await dependencies.refresh({user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},session.org_id,account,c.req.raw.signal);
      c.req.raw.signal.throwIfAborted();return c.json(result,202);
    }catch(error){
      if(error instanceof z.ZodError)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
      if(error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
      return c.json({code:'EMAIL_UNAVAILABLE'},503);
    }
  });
  const preferencePath='/accounts/:accountId/reading-preferences';
  routes.use(preferencePath,bodyLimit({maxSize:1024,onError:c=>c.json({code:'EMAIL_REQUEST_TOO_LARGE'},413)}));
  routes.on(['GET','PATCH'],preferencePath,async c=>{
    const session=await verified(c);
    if(!session)return c.json({code:'EMAIL_AUTH_REQUIRED'},401);
    if(!dependencies.readingPreferences)return c.json({code:'EMAIL_UNAVAILABLE'},503);
    if(new URL(c.req.url).search)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
    try {
      const account=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value)).parse(c.req.param('accountId'));
      const actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000};
      let output:EmailReadingPreference;
      if(c.req.method==='GET')output=await dependencies.readingPreferences.get(actor,session.org_id,account,c.req.raw.signal);
      else {
        if(!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))return c.json({code:'EMAIL_REQUEST_INVALID'},400);
        let raw:unknown;try{raw=await c.req.json();}catch{return c.json({code:'EMAIL_REQUEST_INVALID'},400);}
        const input=z.strictObject({external_images:z.enum(['ask','always']),expected_revision:z.number().int().min(1).max(2147483646)}).parse(raw);
        output=await dependencies.readingPreferences.update(actor,session.org_id,account,input,c.req.raw.signal);
      }
      c.req.raw.signal.throwIfAborted();return c.json(output);
    }catch(error){
      if(error instanceof z.ZodError)return c.json({code:'EMAIL_REQUEST_INVALID'},400);
      if(error instanceof EmailMailboxError&&error.code==='EMAIL_ACCESS_DENIED')return c.json({code:error.code},403);
      if(error instanceof EmailMailboxError&&error.code==='EMAIL_CHECKPOINT_CONFLICT')return c.json({code:error.code},409);
      return c.json({code:'EMAIL_UNAVAILABLE'},503);
    }
  });
  return routes;
}
