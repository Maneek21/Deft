import {appConsentDeadline} from '@deft/app-kit/core';
import {and,eq,inArray,notInArray,or,ne} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {AppConnectionCredentialRepairAuthorityRequestSchema,AppConnectionCredentialRepairAuthorityResultSchema,canonicalConnectionReattachmentJson} from '@deft/app-kit/core';
import {appRuns,appRunAttempts,appRuntimeBindings,appConnectionSessions} from '@deft/db/schema';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import {isAppOwnerConnectionsEnabled} from './env.js';
import {currentAppConnectionSessionV2Authority,retainedWebGuard} from './app-connection-session-authority.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {PostgresAppConnectionSessionStore,connectionSessionAdmissionFence} from './app-connection-session-store.js';
import {AppConnectionSessionRecordSchema,type AppConnectionSessionRecord,type AppConnectionSessionAuthority} from './app-connection-session-service.js';
import type {AppConnectionCredentialRepairPorts} from './app-connection-credential-repair-service.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
const denied=()=>new AppError('Account upgrade access ended','APP_ACCESS_DENIED',403);
const enabled=()=>{if(process.env.DEFT_APPS_ENABLED!=='true'||!isAppOwnerConnectionsEnabled())throw denied();};
export async function credentialRepairReviewPins(source:AppConnectionSessionRecord){
 return db.transaction(async tx=>{
  const bindings=await tx.select({id:appRuntimeBindings.id}).from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id,source.scope.org_id),
   eq(appRuntimeBindings.app_installation_id,source.scope.installation_id),eq(appRuntimeBindings.owner_resource_binding_id,source.scope.resource_binding_id)));
  const domain=and(eq(appRuns.org_id,source.scope.org_id),eq(appRuns.origin_app_installation_id,source.scope.installation_id),
   or(eq(appRuns.origin_resource_binding_id,source.scope.resource_binding_id),bindings.length?inArray(appRuns.origin_runtime_binding_id,bindings.map(v=>v.id)):undefined));
  const runs=await tx.select({id:appRuns.id}).from(appRuns).where(and(domain,eq(appRuns.state,'unknown_outcome'))).limit(65);
  const rows=await tx.select({run_id:appRuns.id,attempt_id:appRunAttempts.id,run_state:appRuns.state,attempt_state:appRunAttempts.state,
   authorization_snapshot:appRuns.authorization_snapshot,input_fingerprint:appRuns.input_fingerprint}).from(appRuns).innerJoin(appRunAttempts,
   and(eq(appRunAttempts.org_id,appRuns.org_id),eq(appRunAttempts.run_id,appRuns.id)))
   .where(and(domain,eq(appRuns.state,'unknown_outcome'))).orderBy(appRuns.id,appRunAttempts.id).limit(65);
  if(rows.length>64||runs.some(run=>!rows.some(row=>row.run_id===run.id)))throw denied();
  return {historical_attempts:rows.map(row=>({run_id:row.run_id,attempt_id:row.attempt_id,
   attempt_digest:'sha256:'+createHash('sha256').update(canonicalConnectionReattachmentJson(row)).digest('hex')}))};
 });
}
export async function assertNoActiveConnectionCredentialRepairEffects(source:AppConnectionSessionRecord,target:AppConnectionSessionAuthority,sessionId?:string){
 enabled();await db.transaction(async tx=>{
  const [competing]=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
   connectionSessionAdmissionFence(target.scope,new Date(),sessionId),ne(appConnectionSessions.session_id,source.session_id))).limit(1);
  const resources=[source.scope.resource_binding_id,target.scope.resource_binding_id];
  const bindings=await tx.select({id:appRuntimeBindings.id}).from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id,target.scope.org_id),
   eq(appRuntimeBindings.app_installation_id,target.scope.installation_id),inArray(appRuntimeBindings.owner_resource_binding_id,resources)));
  const where=and(eq(appRuns.org_id,target.scope.org_id),eq(appRuns.origin_app_installation_id,target.scope.installation_id),
   or(inArray(appRuns.origin_resource_binding_id,resources),bindings.length?inArray(appRuns.origin_runtime_binding_id,bindings.map(row=>row.id)):undefined));
  const [run]=await tx.select({id:appRuns.id}).from(appRuns).where(and(where,inArray(appRuns.state,['pending','pending_approval','running','waiting_external']))).limit(1);
  const [attempt]=await tx.select({id:appRunAttempts.id}).from(appRunAttempts).innerJoin(appRuns,and(eq(appRuns.org_id,appRunAttempts.org_id),eq(appRuns.id,appRunAttempts.run_id)))
   .where(and(where,notInArray(appRuns.state,['succeeded','failed','cancelled','expired']),inArray(appRunAttempts.state,['pending','claimed','provider_call_started']))).limit(1);
  if(competing||run||attempt)throw denied();
 });
}
export function productionAppConnectionCredentialRepairPorts(caller:ExperienceCaller,guard:WebAuthorityGuard):AppConnectionCredentialRepairPorts{
 return {store:new PostgresAppConnectionSessionStore(db,caller),currentAuthority:async(activeCaller,nomination)=>{
   enabled();const current=await currentAppConnectionSessionV2Authority(activeCaller,nomination,guard);enabled();return current;},
  transportDigest:async record=>(await getAppConnectionSessionRegistry()).transportDigest(record.scope.org_id,record.scope.installation_id,record.profile),
  reviewPins:credentialRepairReviewPins,
  requestRuntime:async(record,input,signal)=>(await getAppConnectionSessionRegistry()).credentialRepairRuntime(record.scope,record.profile).request(input,signal),
  assertNoActiveEffects:assertNoActiveConnectionCredentialRepairEffects};
}
export async function appConnectionCredentialRepairRuntimeAuthority(raw:unknown,authorization:string|undefined){
 enabled();const input=AppConnectionCredentialRepairAuthorityRequestSchema.parse(raw),registry=await getAppConnectionSessionRegistry();registry.authenticate(input.scope,authorization);
 const store=new PostgresAppConnectionSessionStore(),locator={org_id:input.scope.org_id,owner_user_id:input.scope.owner_user_id,session_id:input.session_id};
 const row=await store.metadata(locator);if(!row)throw denied();
 const record=AppConnectionSessionRecordSchema.parse(row.record),data=record.credential_repair;
 const states={prepare:'starting',begin:'repair_starting',callback:'connecting',status:'repair_checking'};
 if(!data||record.revision!==row.revision||record.state!==states[input.operation]||!isDeepStrictEqual(record.scope,input.scope)
  ||!isDeepStrictEqual(data.source,input.source)||data.transport_digest!==input.transport_digest||data.review_expires_at!==input.review_expires_at
  ||!isDeepStrictEqual(record.action_consents,input.action_consents)||input.operation!=='prepare'&&!isDeepStrictEqual(data.review,input.review)
  ||['begin','callback'].includes(input.operation)&&!data.begin_consumed||input.operation==='callback'&&!record.callback_consumed)throw denied();
 if(!isDeepStrictEqual(input.historical_attempts,data.historical_attempts)||input.publication_continuity_digest!==null
  ||!isDeepStrictEqual((await credentialRepairReviewPins(record)).historical_attempts,data.historical_attempts))throw denied();
 if(input.operation==='status'&&input.acknowledged_receipt&&(!data.receipt||input.acknowledged_receipt.session_id!==record.session_id
  ||input.acknowledged_receipt.session_revision!==record.revision||input.acknowledged_receipt.receipt_digest!==data.receipt.receipt_digest))throw denied();
 if(input.operation==='status'&&input.acknowledged_closure&&(!data.closure||input.acknowledged_closure.session_id!==record.session_id
  ||input.acknowledged_closure.session_revision!==record.revision||input.acknowledged_closure.receipt_digest!==data.closure.receipt_digest))throw denied();
 if(input.operation==='status'&&input.close_uncertain&&(!data.begin_consumed||!record.callback_consumed||!data.review||!record.runtime_session_ref||data.receipt||data.closure
  ||Date.parse(data.review_expires_at)>Date.now()))throw denied();
 if(input.operation==='status'&&input.close_prepared&&(data.begin_consumed||record.callback_consumed||data.receipt||data.closure||record.runtime_session_ref!==null))throw denied();
 if(input.operation==='status'&&input.close_expired&&(!data.begin_consumed||record.callback_consumed||!data.review||data.receipt||data.closure
  ||Date.parse(record.callback_expires_at)>Date.now()))throw denied();
 if(input.operation==='begin'&&createHash('sha256').update(input.callback_state).digest('hex')!==record.callback_state_hash
  ||(input.operation==='callback'||input.operation==='status')&&input.runtime_session_ref!==record.runtime_session_ref)throw denied();
 const caller={org_id:locator.org_id,user_id:locator.owner_user_id,sid:row.web_session_id,access_expires_at:row.access_expires_at.getTime()};
 const current=await productionAppConnectionCredentialRepairPorts(caller,retainedWebGuard(caller)).currentAuthority(caller,{installation_id:record.scope.installation_id,target_key:record.scope.target_key});
 if(!isDeepStrictEqual(current.scope,record.scope)||!isDeepStrictEqual(current.profile,record.profile)
  ||!isDeepStrictEqual(current.action_consents,record.action_consents)
  ||registry.transportDigest(record.scope.org_id,record.scope.installation_id,record.profile)!==data.transport_digest)throw denied();
 const source=await store.read({org_id:locator.org_id,owner_user_id:locator.owner_user_id,session_id:data.source.session_id});
 if(!source||source.state!=='connected'||source.revision!==data.source.session_revision||!isDeepStrictEqual(source.scope,data.source.scope)
  ||source.runtime_session_ref!==data.source.runtime_session_ref||source.account?.account_ref!==data.source.account_ref
  ||registry.transportDigest(source.scope.org_id,source.scope.installation_id,source.profile)!==data.transport_digest)throw denied();
 await assertNoActiveConnectionCredentialRepairEffects(source,current,record.session_id);
 const expiry=Math.min(Date.parse(input.expires_at),current.expires_at,appConsentDeadline(record.scope.consent_expires_at, record.scope.consent_lifetime),
  input.operation==='status'||input.operation==='callback'?Infinity:Date.parse(data.review_expires_at),...(input.operation==='status'?[]:input.action_consents.map(item=>appConsentDeadline(item.expires_at,item.consent_lifetime))));
 const after=await store.metadata(locator),sourceAfter=await store.metadata({org_id:locator.org_id,owner_user_id:locator.owner_user_id,session_id:source.session_id});
 if(expiry<=Date.now()||after?.revision!==row.revision||sourceAfter?.revision!==source.revision)throw denied();enabled();
 registry.authenticate(current.scope,authorization);return AppConnectionCredentialRepairAuthorityResultSchema.parse({...input,allowed:true,expires_at:new Date(expiry).toISOString()});
}
