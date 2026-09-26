import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { APP_LIMITS } from '@deft/app-kit';
import { AppError } from '../lib/app-errors.js';
import { assertAttachmentBrokerEnabled } from '../lib/app-attachment-authority.js';
import { getAppAttachmentRuntime } from '../lib/app-attachment-runtime.js';
import { resourceSyncWebAuthority,ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { stageAppPackage } from '../lib/app-service.js';
import { getAttachmentAppReviewContext,prepareAttachmentAppReview,activateAttachmentApp } from '../lib/app-attachment-review.js';
const READ_DEADLINE_MS=10_000;
const id=z.string().uuid();
function query(c:Context){const entries=[...new URL(c.req.url).searchParams.entries()];
  if(new Set(entries.map(([key])=>key)).size!==entries.length)throw new SyntaxError('Duplicate query');return Object.fromEntries(entries);}
function noQuery(c:Context){z.strictObject({}).parse(query(c));}
async function body(c: Context, maxBytes=16_384, rawText=false): Promise<unknown> {
  if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new AppError('JSON request required', 'APP_ACTION_INVALID', 400);
  }
  const declared = Number(c.req.header('content-length') ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
    throw new AppError('Private sync request too large', 'APP_ACTION_INVALID', 413);
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) {

    throw new AppError('JSON request required', 'APP_ACTION_INVALID', 400);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + READ_DEADLINE_MS;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError('Private sync request timed out', 'APP_ACTION_INVALID', 400);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AppError('Private sync request timed out', 'APP_ACTION_INVALID', 400)), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        throw new AppError('Private sync request too large', 'APP_ACTION_INVALID', 413);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  return rawText?text:JSON.parse(text) as unknown;
}

function failure(c:Context,error:unknown){
  if(error instanceof AppError||error instanceof ResourceSyncWebAuthenticationError)return c.json({error:error.message,code:error.code},error.status);
  if(error instanceof z.ZodError||error instanceof SyntaxError||error instanceof TypeError)return c.json({error:'Invalid attachment request',code:'VALIDATION_ERROR'},400);
  console.error('[app-attachments] failure metadata', {name:error instanceof Error?error.name:'UNKNOWN',cause_code:(error as {cause?:{code?:string}})?.cause?.code,constraint:(error as {cause?:{constraint?:string}})?.cause?.constraint});
  return c.json({error:'Attachment request failed',code:'INTERNAL_ERROR'},500);
}
export const appAttachmentRoutes=new Hono();
export const appAttachmentOwnerRoutes=new Hono();
appAttachmentOwnerRoutes.use('*',async(c,next)=>{
  c.header('Cache-Control','no-store');c.header('Pragma','no-cache');
  try{assertAttachmentBrokerEnabled();await resourceSyncWebAuthority(c.req.header('authorization'));}
  catch(error){return failure(c,error);}await next();
});
appAttachmentRoutes.use('*',async(c,next)=>{
  c.header('Cache-Control','no-store');c.header('Pragma','no-cache');
  try{assertAttachmentBrokerEnabled();await resourceSyncWebAuthority(c.req.header('authorization'));}
  catch(error){return failure(c,error);}await next();
});
appAttachmentRoutes.post('/stage',async c=>{
  try{noQuery(c);const input=await body(c,APP_LIMITS.package_bytes,true);
    const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({app:await stageAppPackage(actor,input as string,{attachmentStage:true,guard})},201);
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.get('/:installationId/context',async c=>{
  try{const q=z.strictObject({app_version_id:id}).parse(query(c));const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await getAttachmentAppReviewContext(actor,id.parse(c.req.param('installationId')),q.app_version_id,{guard}));
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/:installationId/review',async c=>{
  try{noQuery(c);const input=await body(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({review:await prepareAttachmentAppReview(actor,id.parse(c.req.param('installationId')),input,{guard})});
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/:installationId/activate',async c=>{
  try{noQuery(c);const input=await body(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({app:await activateAttachmentApp(actor,id.parse(c.req.param('installationId')),input,{guard})});
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.get('/sync/setup',async c=>{
  try{const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({setup:await (await getAppAttachmentRuntime()).management.setupContext(actor,query(c),guard)});
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/sync/reviews/prepare',async c=>{
  try{noQuery(c);const input=await body(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({review:await (await getAppAttachmentRuntime()).management.prepareConsent(actor,input,guard)});
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/sync/bindings/activate',async c=>{
  try{noQuery(c);const input=await body(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({binding:await (await getAppAttachmentRuntime()).management.activateConsent(actor,input,guard)},201);
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/sync/bindings/:bindingId/sessions',async c=>{
  try{noQuery(c);z.strictObject({}).parse(await body(c));const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({session:await (await getAppAttachmentRuntime()).management.issueOperatorSession(actor,id.parse(c.req.param('bindingId')),guard)},201);
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/sync/bindings/:bindingId/sync',async c=>{
  try{noQuery(c);z.strictObject({}).parse(await body(c));const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await (await getAppAttachmentRuntime()).admission.admitDue({org_id:actor.org_id,resource_binding_id:id.parse(c.req.param('bindingId'))},
      undefined,{owner_user_id:actor.actor_id,guard}));
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/sync/bindings/:bindingId/revoke',async c=>{
  try{noQuery(c);z.strictObject({}).parse(await body(c));const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await (await getAppAttachmentRuntime()).management.revokeConsent(actor,id.parse(c.req.param('bindingId')),guard));
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/sync/sessions/:sessionId/revoke',async c=>{
  try{noQuery(c);z.strictObject({}).parse(await body(c));const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await (await getAppAttachmentRuntime()).management.revokeOperatorSession(actor,id.parse(c.req.param('sessionId')),guard));
  }catch(error){return failure(c,error);}
});

appAttachmentOwnerRoutes.get('/bindings/:bindingId/records/:projectionId/attachments',async c=>{
  try{noQuery(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await (await getAppAttachmentRuntime()).owner.list({org_id:actor.org_id,user_id:actor.actor_id,guard},
      {binding_id:id.parse(c.req.param('bindingId')),projection_id:id.parse(c.req.param('projectionId'))},c.req.raw.signal));
  }catch(error){return failure(c,error);}
});
appAttachmentOwnerRoutes.get('/bindings/:bindingId/records/:projectionId/attachments/:attachmentId/content',async c=>{
  try{noQuery(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    const value=await (await getAppAttachmentRuntime()).owner.content({org_id:actor.org_id,user_id:actor.actor_id,guard},
      {binding_id:id.parse(c.req.param('bindingId')),projection_id:id.parse(c.req.param('projectionId')),attachment_id:id.parse(c.req.param('attachmentId'))},c.req.raw.signal);
    c.header('Content-Type','application/octet-stream');c.header('X-Content-Type-Options','nosniff');
    c.header('Content-Disposition',`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(value.filename).replace(/[!'()*]/gu,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())}`);
    return c.body(new Uint8Array(value.bytes));
  }catch(error){return failure(c,error);}
});
