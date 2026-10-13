import {createHash,randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {and,eq,sql} from 'drizzle-orm';
import {AppConnectionConsentContinuationReviewRequestSchema,AppConnectionConsentContinuationActivateRequestSchema,
 AppConnectionConsentContinuationStatusRequestSchema,AppConnectionConsentContinuationReviewViewSchema,
 AppConnectionConsentContinuationRuntimeRequestSchema,AppConnectionSessionViewSchema,
 appConnectionConsentContinuationPins,appConnectionConsentContinuationReviewValue,appConnectionConsentContinuationReceiptValue,
 canonicalConnectionConsentContinuationJson,validateAppConnectionConsentContinuationResult,
 type AppConnectionConsentContinuationRuntimeRequest} from '@deft/app-kit';
import {appConnectionSessions,appResourceBindings} from '@deft/db/schema';
import {db} from './db.js';
import {PostgresConsentContinuationStore,ConsentContinuationRecordSchema,continuationDenied,
 assertContinuationSource,lockContinuationTarget,type ConsentContinuationRecord,type ContinuationLocator} from './app-connection-consent-continuation-store.js';
import {currentConsentContinuationAuthority,currentAppConnectionReadAuthority} from './app-connection-session-authority.js';
import {loadConsentContinuationBindingIdentity} from './app-attachment-sync-authority.js';
import {assertOwnerConnectionRegistration} from './app-owner-connection-authority.js';
import {attachmentSyncConsentReview} from './app-attachment-sync-consent.js';
import {digestAppGrantValue} from './app-grant-service.js';
import {getAppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {AppConnectionSessionRecordSchema} from './app-connection-session-service.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';
import type {AppRunTransaction} from './app-run-repository.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
import {AppError} from './app-errors.js';
export const continuationDigest=(value:unknown)=>'sha256:'+createHash('sha256').update(canonicalConnectionConsentContinuationJson(value)).digest('hex');
export function continuationRequest(r:ConsentContinuationRecord,operation:'prepare'|'activate'|'status',deadline:number):AppConnectionConsentContinuationRuntimeRequest{
 return AppConnectionConsentContinuationRuntimeRequestSchema.parse({schema_version:'deft.app_connection_consent_continuation_runtime.v1',session_id:r.session_id,
  scope:r.scope,source:r.source,action_consents:r.action_consents,transport_digest:r.transport_digest,review_expires_at:r.review_expires_at,
  expires_at:new Date(deadline).toISOString(),operation,...(operation==='prepare'?{}:{review:r.review})});
}
export function continuationReviewView(r:ConsentContinuationRecord){
 if(!r.review)throw continuationDenied();return AppConnectionConsentContinuationReviewViewSchema.parse({schema_version:'deft.app_connection_consent_continuation_review.v1',session_id:r.session_id,
 source_session_id:r.source.session_id,source_revision:r.source.session_revision,scope:r.scope,action_consents:r.action_consents,
 account:r.review.account,custody_generation:r.review.custody_generation,review_digest:r.review.digest,expires_at:r.review_expires_at});
}
export function continuationSessionView(r:ConsentContinuationRecord){
 return AppConnectionSessionViewSchema.parse({schema_version:'deft.app_connection_session.v1',session_id:r.session_id,state:r.state==='connected'?'connected':r.state==='not_connected'?'not_connected':'indeterminate',
 scope:r.scope,account:r.state==='connected'&&r.result?.state==='connected'?r.result.account:null,expires_at:r.scope.consent_expires_at});
}
export async function assertFreshContinuation(tx:AppRunTransaction,caller:ExperienceCaller,guard:WebAuthorityGuard,r:ConsentContinuationRecord){
 const current=await currentConsentContinuationAuthority(caller,{installation_id:r.scope.installation_id,target_key:r.scope.target_key},guard,new Date(r.scope.consent_expires_at),tx);
 if(!isDeepStrictEqual(current.scope,r.scope)||!isDeepStrictEqual(current.profile,r.profile)||!isDeepStrictEqual(current.action_consents,r.action_consents))throw continuationDenied();
 const registry=await getAppConnectionSessionRegistry();if(registry.transportDigest(r.scope.org_id,r.scope.installation_id,r.profile)!==r.transport_digest)throw continuationDenied();
 await assertContinuationSource(tx,r);
 const snapshot=await tx.execute(sql`SELECT to_jsonb(b) AS snapshot FROM app_resource_bindings b WHERE b.org_id=${r.scope.org_id} AND b.id=${r.scope.resource_binding_id}`);
 if(!isDeepStrictEqual(snapshot.rows[0]?.snapshot,r.binding_before))throw continuationDenied();return current;
}
/** Closing an unstarted expired review grants no authority. Recheck current
 * owner, SID and all same-binding identities with a fresh bounded nomination;
 * discard its deadlines/digests, and never send it to Runtime. */
export async function assertContinuationClosureIdentity(tx:AppRunTransaction,caller:ExperienceCaller,guard:WebAuthorityGuard,r:ConsentContinuationRecord){
 if(r.activation_started)throw continuationDenied();
 const nominationExpiry=new Date(Math.max(Date.now()+10000,Date.parse(r.source.scope.consent_expires_at)+1000));
 const current=await currentConsentContinuationAuthority(caller,{installation_id:r.scope.installation_id,target_key:r.scope.target_key},guard,nominationExpiry,tx);
 const identities=(actions:typeof r.action_consents)=>actions.map(({consent_digest,expires_at,...pins})=>pins);
 if(!isDeepStrictEqual({...current.scope,consent_expires_at:r.scope.consent_expires_at},r.scope)||!isDeepStrictEqual(current.profile,r.profile)
   ||!isDeepStrictEqual(identities(current.action_consents),identities(r.action_consents)))throw continuationDenied();
 if((await getAppConnectionSessionRegistry()).transportDigest(r.scope.org_id,r.scope.installation_id,r.profile)!==r.transport_digest)throw continuationDenied();
 await assertContinuationSource(tx,r);
 const snapshot=await tx.execute(sql`SELECT to_jsonb(b) AS snapshot FROM app_resource_bindings b WHERE b.org_id=${r.scope.org_id} AND b.id=${r.scope.resource_binding_id}`);
 if(!isDeepStrictEqual(snapshot.rows[0]?.snapshot,r.binding_before))throw continuationDenied();
}
/** Independent, time-only owner review. Old consent is never authority and
 * no provider call, OAuth callback or credential write is part of this lane. */
export class AppConnectionConsentContinuationService{
 private store=new PostgresConsentContinuationStore();
 constructor(private caller:ExperienceCaller,private guard:WebAuthorityGuard){}
 private locator(session_id:string):ContinuationLocator{return {org_id:this.caller.org_id,owner_user_id:this.caller.user_id,session_id};}
 private async row(session_id:string){const row=await this.store.metadata(this.locator(session_id));if(!row)throw continuationDenied();return row;}
 private async retainFreshOwner(r:ConsentContinuationRecord,operation:'prepare'|'activate'|'status'){
  return db.transaction(async tx=>{const q=this.locator(r.session_id),row=await this.store.metadata(q,tx,true);if(!row||row.revision!==r.revision)throw continuationDenied();
   const current=await assertFreshContinuation(tx,this.caller,this.guard,r);
   let deadline=Math.min(Date.now()+30000,current.expires_at,Date.parse(r.scope.consent_expires_at),operation==='status'?Infinity:Date.parse(r.review_expires_at),operation==='status'?Infinity:Math.min(...r.action_consents.map(a=>Date.parse(a.expires_at))));
   // Concurrent requests in one still-live phase window get distinct,
   // decreasing deadlines. Once it expires, no old callback can borrow a new
   // window. This also handles a deadline clamped to a fixed target/Web expiry.
   if(row.authority_operation===operation&&row.authority_expires_at.getTime()>Date.now())deadline=Math.min(deadline,row.authority_expires_at.getTime()-1);
   if(deadline<=Date.now())throw continuationDenied();return this.store.retainFreshOwner(tx,q,r,this.caller,operation,deadline);
  });
 }
 private async invoke(r:ConsentContinuationRecord,operation:'prepare'|'activate'|'status'){
  const current=await db.transaction(tx=>assertFreshContinuation(tx,this.caller,this.guard,r));
  const phase=await this.store.metadata(this.locator(r.session_id));if(!phase||phase.revision!==r.revision||phase.web_session_id!==this.caller.sid||phase.authority_operation!==operation)throw continuationDenied();
  const deadline=phase.authority_expires_at.getTime(),currentBound=Math.min(current.expires_at,Date.parse(r.scope.consent_expires_at),operation==='status'?Infinity:Date.parse(r.review_expires_at),
   operation==='status'?Infinity:Math.min(...r.action_consents.map(a=>Date.parse(a.expires_at))));
  if(deadline>currentBound)throw continuationDenied();
  if(deadline<=Date.now())throw continuationDenied();const request=continuationRequest(r,operation,deadline),registry=await getAppConnectionSessionRegistry();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
  try{const runtime=registry.consentContinuationRuntime(r.scope,r.profile);const result=validateAppConnectionConsentContinuationResult(request,await runtime.request(request,controller.signal));
   controller.signal.throwIfAborted();if(Date.now()>=deadline)throw continuationDenied();
   return {request,result};
  }finally{clearTimeout(timer);}
 }
 async review(raw:unknown){
  const input=AppConnectionConsentContinuationReviewRequestSchema.parse(raw),q=this.locator(input.request_id),existing=await this.store.metadata(q);
  if(existing){if(existing.record.source.session_id!==input.source_session_id||existing.record.scope.installation_id!==input.installation_id
    ||existing.record.scope.target_key!==input.target_key||existing.record.scope.consent_expires_at!==input.consent_expires_at)throw continuationDenied();
    if(existing.record.state==='reviewed'&&Date.parse(existing.record.review_expires_at)>Date.now())return continuationReviewView(await this.retainFreshOwner(existing.record,'prepare'));
    throw new AppError('Inspect the original consent review','APP_STALE',409);}
  let r=await db.transaction(async tx=>{
   const collision=await tx.select({session_id:appConnectionSessions.session_id}).from(appConnectionSessions).where(eq(appConnectionSessions.session_id,input.request_id)).limit(1);
   if(collision.length)throw continuationDenied();
   const fresh=await currentConsentContinuationAuthority(this.caller,input,this.guard,new Date(input.consent_expires_at),tx);
   if(!fresh.action_consents)throw continuationDenied();
   const [sourceRow]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,this.caller.org_id),eq(appConnectionSessions.owner_user_id,this.caller.user_id),eq(appConnectionSessions.session_id,input.source_session_id))).for('share');
   if(!sourceRow)throw continuationDenied();const old=AppConnectionSessionRecordSchema.parse(sourceRow.record);
   if(old.state!=='connected'||!old.account||!old.runtime_session_ref||!old.action_consents||old.revision<1||!isDeepStrictEqual(old.profile,fresh.profile)
    ||!isDeepStrictEqual({...old.scope,consent_expires_at:input.consent_expires_at},fresh.scope)
    ||!await appConnectionUpgradeSourceIsAvailable(tx,{org_id:this.caller.org_id,owner_user_id:this.caller.user_id,session_id:old.session_id}))throw continuationDenied();
   await lockContinuationTarget(tx,fresh.scope);
   const identity=await loadConsentContinuationBindingIdentity(tx,{org_id:this.caller.org_id,resource_binding_id:fresh.scope.resource_binding_id,clock:()=>new Date(),binding_lock:'update'});
   if(!identity||identity.binding.consent_expires_at?.toISOString()!==old.scope.consent_expires_at)throw continuationDenied();
   const admission=await assertOwnerConnectionRegistration(tx,identity.registration,{owner_user_id:this.caller.user_id,resource_key:identity.binding.resource_key,lockedReviewed:identity});
   const attachment_consent_digest=digestAppGrantValue({...attachmentSyncConsentReview({org_id:this.caller.org_id,owner_user_id:this.caller.user_id,operator_user_id:identity.registration.operator_user_id,
    reviewed:identity,consent_expires_at:new Date(input.consent_expires_at),limits:identity.binding,attachment_policy:identity.binding.attachment_policy,owner_connection_admission:admission.reference}),
    ...(fresh.scope.target_key==='primary'?{}:{target_key:fresh.scope.target_key})});
   const snapshot=await tx.execute(sql`SELECT to_jsonb(b) AS snapshot FROM app_resource_bindings b WHERE b.org_id=${this.caller.org_id} AND b.id=${fresh.scope.resource_binding_id}`);
   const reviewedAt=Date.now(),now=new Date(reviewedAt).toISOString(),review_expires_at=new Date(Math.min(reviewedAt+120000,fresh.expires_at,Date.parse(input.consent_expires_at))).toISOString();
   const next=ConsentContinuationRecordSchema.parse({session_id:input.request_id,revision:0,state:'preparing',activation_started:false,scope:fresh.scope,profile:fresh.profile,
    source:{session_id:old.session_id,session_revision:old.revision,scope:old.scope,runtime_session_ref:old.runtime_session_ref,account_ref:old.account.account_ref,action_consents:old.action_consents},
    action_consents:fresh.action_consents,transport_digest:(await getAppConnectionSessionRegistry()).transportDigest(fresh.scope.org_id,fresh.scope.installation_id,fresh.profile),review_expires_at,
    reviewed_at:now,binding_before:snapshot.rows[0]!.snapshot,attachment_consent_digest,review:null,result:null,created_at:now,updated_at:now});
   continuationRequest(next,'prepare',Math.min(Date.now()+30000,Date.parse(review_expires_at)));
   return this.store.create(tx,this.caller,next,Math.min(Date.now()+30000,fresh.expires_at,Date.parse(review_expires_at),...fresh.action_consents.map(a=>Date.parse(a.expires_at))));
  });
  try{const response=await this.invoke(r,'prepare');
   r=await this.finish(q,r,response.request,response.result);if(r.state==='reviewed')return continuationReviewView(r);
  }catch{await this.markIndeterminate(q,r);}
  throw new AppError('Inspect the original consent review','APP_PROVIDER_UNAVAILABLE',503);
 }
 private async markIndeterminate(q:ContinuationLocator,previous:ConsentContinuationRecord){
  return db.transaction(async tx=>{const row=await this.store.metadata(q,tx,true);if(!row||row.revision!==previous.revision||['connected','not_connected'].includes(row.record.state))return;
   await this.store.cas(tx,q,row.record,{...row.record,state:'indeterminate',revision:row.revision+1,updated_at:new Date().toISOString()});});
 }
 async activate(raw:unknown){
  const input=AppConnectionConsentContinuationActivateRequestSchema.parse(raw),q=this.locator(input.session_id);let row=await this.row(input.session_id),r=row.record;
  if(r.state==='connected')return this.status({session_id:input.session_id});
  if(!r.review||r.review.digest!==input.review_digest||r.state!=='reviewed'||r.activation_started||Date.parse(r.review_expires_at)<=Date.now())throw continuationDenied();
  r=await this.retainFreshOwner(r,'activate');
  r=await db.transaction(async tx=>{const locked=await this.store.metadata(q,tx,true);if(!locked||locked.revision!==r.revision)throw continuationDenied();
   await assertFreshContinuation(tx,this.caller,this.guard,r);
   await tx.execute(sql`SELECT id FROM app_resource_bindings WHERE org_id=${q.org_id} AND id=${r.scope.resource_binding_id} FOR UPDATE`);
   await assertContinuationSource(tx,r);return this.store.cas(tx,q,r,{...r,state:'activating',activation_started:true,revision:r.revision+1,updated_at:new Date().toISOString()});});
  try{const response=await this.invoke(r,'activate');return continuationSessionView(await this.finish(q,r,response.request,response.result));}
  catch{await this.markIndeterminate(q,r);return continuationSessionView((await this.row(input.session_id)).record);}
 }
 private async finish(q:ContinuationLocator,previous:ConsentContinuationRecord,request:AppConnectionConsentContinuationRuntimeRequest,result:ReturnType<typeof validateAppConnectionConsentContinuationResult>){
  return db.transaction(async tx=>{const row=await this.store.metadata(q,tx,true);if(!row||row.revision!==previous.revision)throw continuationDenied();let r=row.record;
   await assertFreshContinuation(tx,this.caller,this.guard,r);
   if(result.state==='eligible'){
    if(r.activation_started)throw continuationDenied();
    const eligibility={account:result.account,custody_generation:result.custody_generation,custody_digest:result.custody_digest};
    const review={...eligibility,digest:continuationDigest(appConnectionConsentContinuationReviewValue(request,eligibility))};
    if(r.review&&!isDeepStrictEqual(r.review,review))throw continuationDenied();
    return this.store.cas(tx,q,r,{...r,review,state:'reviewed',revision:r.revision+1,updated_at:new Date().toISOString()});
   }
   if(result.state==='indeterminate')return this.store.cas(tx,q,r,{...r,state:'indeterminate',revision:r.revision+1,updated_at:new Date().toISOString()});
   if(!r.activation_started||!r.review||result.receipt_digest!==continuationDigest(appConnectionConsentContinuationReceiptValue(request,r.review,result.runtime_session_ref)))throw continuationDenied();
   r=await this.store.cas(tx,q,r,{...r,result,state:'committing',revision:r.revision+1,updated_at:new Date().toISOString()});
   const session=AppConnectionSessionRecordSchema.parse({session_id:r.session_id,revision:1,state:'connected',scope:r.scope,profile:r.profile,action_consents:r.action_consents,
    callback_state_hash:randomBytes(32).toString('hex'),callback_consumed:true,callback_expires_at:r.review_expires_at,account:result.account,runtime_session_ref:result.runtime_session_ref,created_at:r.created_at,updated_at:new Date().toISOString()});
   return this.store.publish(tx,q,r,session);
  });
 }
 async status(raw:unknown){
  const input=AppConnectionConsentContinuationStatusRequestSchema.parse(raw),q=this.locator(input.session_id),row=await this.row(input.session_id);let r=row.record;
  if(r.state==='connected'){
   const current=await currentAppConnectionReadAuthority(this.caller,{installation_id:r.scope.installation_id,target_key:r.scope.target_key},this.guard);
   if(!isDeepStrictEqual(current.scope,r.scope))throw continuationDenied();return continuationSessionView(r);
  }
  if(r.state==='not_connected'){await db.transaction(tx=>this.guard(tx));return continuationSessionView(r);}
  if(!r.activation_started&&Date.parse(r.review_expires_at)<=Date.now()){
   r=await db.transaction(async tx=>{const locked=await this.store.metadata(q,tx,true);if(!locked||locked.revision!==r.revision||locked.record.activation_started)throw continuationDenied();
    await assertContinuationClosureIdentity(tx,this.caller,this.guard,r);return this.store.cas(tx,q,r,{...r,state:'not_connected',revision:r.revision+1,updated_at:new Date().toISOString()});});
   return continuationSessionView(r);
  }
  r=await this.retainFreshOwner(r,'status');
  try{const response=await this.invoke(r,'status');r=await this.finish(q,r,response.request,response.result);}
  catch{await this.markIndeterminate(q,r);r=(await this.row(input.session_id)).record;}
  return continuationSessionView(r);
 }
}
