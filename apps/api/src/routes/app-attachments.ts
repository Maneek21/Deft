import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { APP_LIMITS } from '@deft/app-kit';
import { AppError } from '../lib/app-errors.js';
import { AppRunError } from '../lib/app-run-errors.js';
import { appHttpFailure } from './app-http-errors.js';
import { assertAttachmentBrokerEnabled } from '../lib/app-attachment-authority.js';
import { attachmentFinalAuthorityIsCurrent } from '../lib/app-attachment-authority.js';
import { and,eq } from 'drizzle-orm';
import { appRuntimeBindings,appRuntimeRegistrations,appVersions } from '@deft/db/schema';
import { isAppV5RuntimeActionsEnabled } from '../lib/env.js';
import { getAppAttachmentRuntime } from '../lib/app-attachment-runtime.js';
import { resourceSyncWebAuthority,ResourceSyncWebAuthenticationError } from '../lib/app-resource-sync-web-authority.js';
import { stageAppPackage } from '../lib/app-service.js';
import { getAttachmentAppReviewContext,prepareAttachmentAppReview,activateAttachmentApp } from '../lib/app-attachment-review.js';
import { stageAttachmentAppUpgrade, getAttachmentUpgradeContext, prepareAttachmentUpgrade, activateAttachmentUpgrade } from '../lib/app-runtime-upgrade.js';
import { listResourceSyncBindings, inspectResourceSyncBinding } from '../lib/app-resource-sync-status.js';
import { listEligibleResourceSyncOperators, listAssignedResourceSyncBindings,
  listOwnResourceSyncSessions } from '../lib/app-resource-sync-operator.js';
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
  if(error instanceof AppRunError)return appHttpFailure(c,error,'App Run','app-runs');
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
appAttachmentRoutes.post('/sync/bindings/:bindingId/resume-observation',async c=>{
  try{noQuery(c);const input=z.strictObject({previous_run_id:z.string().uuid()}).parse(await body(c));const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await (await getAppAttachmentRuntime()).admission.resumeObservation({org_id:actor.org_id,resource_binding_id:id.parse(c.req.param('bindingId')),previous_run_id:input.previous_run_id},{owner_user_id:actor.actor_id,guard}));
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
appAttachmentRoutes.get('/sync/operators',async c=>{
  try{const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await listEligibleResourceSyncOperators(actor,query(c),undefined,{kind:'attachment_v3',guard}));
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.get('/sync/operator/assignments',async c=>{
  try{const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await listAssignedResourceSyncBindings(actor,query(c),undefined,{kind:'attachment_v3',guard}));
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.get('/sync/bindings',async c=>{
  try{const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await listResourceSyncBindings(actor,query(c),undefined,{kind:'attachment_v3',guard}));
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.get('/sync/bindings/:bindingId',async c=>{
  try{noQuery(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await inspectResourceSyncBinding(actor,id.parse(c.req.param('bindingId')),undefined,{kind:'attachment_v3',guard}));
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.get('/sync/bindings/:bindingId/sessions',async c=>{
  try{const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await listOwnResourceSyncSessions(actor,id.parse(c.req.param('bindingId')),query(c),undefined,{kind:'attachment_v3',guard}));
  }catch(error){return failure(c,error);}
});
appAttachmentOwnerRoutes.get('/bindings/:bindingId/attachment-parents',async c=>{
  try{const {actor,guard,web_session}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await (await getAppAttachmentRuntime()).owner.parents({org_id:actor.org_id,user_id:actor.actor_id,guard},
      id.parse(c.req.param('bindingId')),web_session.sid,query(c),c.req.raw.signal));
  }catch(error){return failure(c,error);}
});
appAttachmentOwnerRoutes.get('/bindings/:bindingId/attachment-parents/:projectionId',async c=>{
  try{noQuery(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await (await getAppAttachmentRuntime()).owner.parent({org_id:actor.org_id,user_id:actor.actor_id,guard},
      {binding_id:id.parse(c.req.param('bindingId')),projection_id:id.parse(c.req.param('projectionId'))},c.req.raw.signal));
  }catch(error){return failure(c,error);}
});
// Explicit v2 entry points do not reinterpret the owner-only v1 review.
appAttachmentRoutes.post('/composition/stage',async c=>{
  try{noQuery(c);const input=await body(c,APP_LIMITS.package_bytes,true);
    const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({app:await stageAppPackage(actor,input as string,{attachmentStage:true,attachmentComposition:true,guard})},201);
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.get('/composition/:installationId/context',async c=>{
  try{const q=z.strictObject({app_version_id:id}).parse(query(c));const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await getAttachmentAppReviewContext(actor,id.parse(c.req.param('installationId')),q.app_version_id,{guard,composition:true}));
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/composition/:installationId/review',async c=>{
  try{noQuery(c);const input=await body(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({review:await prepareAttachmentAppReview(actor,id.parse(c.req.param('installationId')),input,{guard,composition:true})});
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/composition/:installationId/activate',async c=>{
  try{noQuery(c);const input=await body(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({app:await activateAttachmentApp(actor,id.parse(c.req.param('installationId')),input,{guard,composition:true})});
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.get('/composition/:installationId/runtime/context',async c=>{
  try{const q=z.strictObject({app_version_id:id}).parse(query(c));const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    const {getRuntimeSetupContext}=await import('../lib/app-runtime-setup.js');
    return c.json(await getRuntimeSetupContext(actor,id.parse(c.req.param('installationId')),q.app_version_id,{guard,signal:c.req.raw.signal}));
  }catch(error){return failure(c,error);}
});

appAttachmentRoutes.post('/composition/:installationId/upgrade/stage', async c => {
  try {
    noQuery(c); const input = await body(c, APP_LIMITS.package_bytes + 16384);
    const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await stageAttachmentAppUpgrade(actor, id.parse(c.req.param('installationId')), input, { guard }), 201);
  } catch (error) { return failure(c, error); }
});
appAttachmentRoutes.get('/composition/:installationId/upgrade/context', async c => {
  try {
    const q = z.strictObject({ app_version_id: id }).parse(query(c));
    const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await getAttachmentUpgradeContext(actor, id.parse(c.req.param('installationId')), q.app_version_id, { guard }));
  } catch (error) { return failure(c, error); }
});
appAttachmentRoutes.post('/composition/:installationId/upgrade/review', async c => {
  try {
    noQuery(c); const input = await body(c);
    const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json({ review: await prepareAttachmentUpgrade(actor, id.parse(c.req.param('installationId')), input, { guard }) });
  } catch (error) { return failure(c, error); }
});
appAttachmentRoutes.post('/composition/:installationId/upgrade/activate', async c => {
  try {
    noQuery(c); const input = await body(c);
    const { actor, guard } = await resourceSyncWebAuthority(c.req.header('authorization'));
    return c.json(await activateAttachmentUpgrade(actor, id.parse(c.req.param('installationId')), input, { guard }));
  } catch (error) { return failure(c, error); }
});
appAttachmentRoutes.post('/composition/runtime/reviews/prepare',async c=>{
  try{noQuery(c);const input=await body(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    const {prepareRuntimeBindingReview}=await import('../lib/app-runtime-management.js');
    return c.json({review:await prepareRuntimeBindingReview(actor,input,{guard})});
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/composition/runtime/bindings/activate',async c=>{
  try{noQuery(c);const input=await body(c);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    const {activateRuntimeBinding}=await import('../lib/app-runtime-management.js');
    return c.json({binding:await activateRuntimeBinding(actor,input,{guard})},201);
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/composition/runtime/bindings/:bindingId/sessions',async c=>{
  try{noQuery(c);z.strictObject({}).parse(await body(c));const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    const {issueRuntimeOperatorSession}=await import('../lib/app-runtime-management.js');
    return c.json({session:await issueRuntimeOperatorSession(actor,id.parse(c.req.param('bindingId')),{guard})},201);
  }catch(error){return failure(c,error);}
});
appAttachmentRoutes.post('/composition/runtime/invoke',async c=>{
  try{noQuery(c);const input=await body(c,65_536);const {actor,guard}=await resourceSyncWebAuthority(c.req.header('authorization'));
    const {ReviewedRuntimeInvokeSchema,appRuntimeActionService}=await import('../lib/app-runtime-action-service.js');
    const request=ReviewedRuntimeInvokeSchema.parse(input);
    const run=await appRuntimeActionService.invokeFromExperience({org_id:actor.org_id,user_id:actor.actor_id},request,
      async()=>{},async tx=>{
        // Capture already locked and revalidated this binding and its complete
        // participant prefix. No new membership/App lock follows the final SID.
        const [current]=await tx.select({operator:appRuntimeRegistrations.operator_user_id,protocol:appVersions.protocol_version})
          .from(appRuntimeBindings).innerJoin(appRuntimeRegistrations,and(eq(appRuntimeRegistrations.org_id,appRuntimeBindings.org_id),
            eq(appRuntimeRegistrations.id,appRuntimeBindings.runtime_registration_id)))
          .innerJoin(appVersions,and(eq(appVersions.org_id,appRuntimeBindings.org_id),eq(appVersions.id,appRuntimeBindings.app_version_id)))
          .where(and(eq(appRuntimeBindings.org_id,actor.org_id),eq(appRuntimeBindings.id,request.runtime_binding_id))).limit(1);
        if(!current||current.protocol!=='7'||!await attachmentFinalAuthorityIsCurrent(tx,[actor.actor_id,current.operator],{guard})
          ||!isAppV5RuntimeActionsEnabled())throw new AppError('Attachment Runtime authority changed','APP_STALE',409);
      });
    return c.json({run});
  }catch(error){return failure(c,error);}
});
