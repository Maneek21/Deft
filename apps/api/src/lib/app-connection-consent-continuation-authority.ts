import {appConsentDeadline} from '@deft/app-kit/core';
import {and,eq,sql,desc} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {AppConnectionConsentContinuationAuthorityRequestSchema,AppConnectionConsentContinuationAuthorityResultSchema,
 appConnectionConsentContinuationPins} from '@deft/app-kit/core';
import {appConnectionSessions,appConnectionConsentContinuations as journals} from '@deft/db/schema';
import {db} from './db.js';
import {getAppConnectionSessionRegistry,connectionProfileDigest} from './app-connection-session-registry.js';
import {retainedWebGuard,currentConsentContinuationAuthority} from './app-connection-session-authority.js';
import {currentConnectionBindingLocators} from './app-connection-current-locators.js';
import {loadConsentContinuationBindingIdentity} from './app-attachment-sync-authority.js';
import {assertOwnerConnectionRegistration} from './app-owner-connection-authority.js';
import {AppConnectionSessionRecordSchema} from './app-connection-session-service.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';
import {PostgresConsentContinuationStore,ConsentContinuationRecordSchema,continuationDenied,type ConsentContinuationRecord} from './app-connection-consent-continuation-store.js';
import {assertFreshContinuation,assertContinuationClosureIdentity,continuationRequest,continuationReviewView} from './app-connection-consent-continuation-service.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';
import {AppError} from './app-errors.js';
export function appConnectionConsentContinuationRuntimePhaseAllowed(r:Pick<ConsentContinuationRecord,'state'|'activation_started'>,input:{operation:'prepare'|'activate'|'status';review?:unknown|null}){
 if(input.operation==='prepare')return r.state==='preparing';
 if(input.operation==='activate')return r.activation_started&&['activating','indeterminate'].includes(r.state);
 return !['connected','not_connected','committing'].includes(r.state)&&(r.activation_started?input.review!==null:input.review===null);
}
export async function appConnectionConsentContinuationRuntimeAuthority(raw:unknown,authorization:string|undefined){
 const input=AppConnectionConsentContinuationAuthorityRequestSchema.parse(raw),registry=await getAppConnectionSessionRegistry();registry.authenticate(input.scope,authorization);
 const store=new PostgresConsentContinuationStore(),q={org_id:input.scope.org_id,owner_user_id:input.scope.owner_user_id,session_id:input.session_id},before=await store.metadata(q);
 if(!before)throw continuationDenied();const r=before.record;
 if(before.authority_operation!==input.operation||Date.parse(input.expires_at)!==before.authority_expires_at.getTime()||before.authority_expires_at.getTime()<=Date.now())throw continuationDenied();
 if(!appConnectionConsentContinuationRuntimePhaseAllowed(r,input)
  ||!isDeepStrictEqual(appConnectionConsentContinuationPins(input),appConnectionConsentContinuationPins(continuationRequest(r,'status',Date.parse(r.review_expires_at))))
  ||('review' in input&&!isDeepStrictEqual(input.review,r.review)))throw continuationDenied();
 const caller={org_id:q.org_id,user_id:q.owner_user_id,sid:before.web_session_id,access_expires_at:before.access_expires_at.getTime()},guard=retainedWebGuard(caller);
 const current=await db.transaction(tx=>assertFreshContinuation(tx,caller,guard,r));
 const deadline=Math.min(Date.parse(input.expires_at),current.expires_at,appConsentDeadline(r.scope.consent_expires_at, r.scope.consent_lifetime),input.operation==='status'?Infinity:Date.parse(r.review_expires_at),input.operation==='status'?Infinity:Math.min(...r.action_consents.map(a=>appConsentDeadline(a.expires_at, a.consent_lifetime))));
 const after=await store.metadata(q);if(!after||after.revision!==before.revision||deadline<=Date.now())throw continuationDenied();
 (await getAppConnectionSessionRegistry()).authenticate(current.scope,authorization);
 return AppConnectionConsentContinuationAuthorityResultSchema.parse({...input,allowed:true,expires_at:new Date(deadline).toISOString()});
}
/** Bounded metadata discovery under fresh owner/SID/admission. Expired source
 * sessions nominate identity only and never grant operational authority. */
export async function appConnectionConsentContinuationContext(caller:ExperienceCaller,installation_id:string,guard:WebAuthorityGuard){
 const bindings=await currentConnectionBindingLocators(db,caller,{installation_id}).limit(33);if(bindings.length>32)throw new AppError('Connection context exceeds bound','APP_PROVIDER_UNAVAILABLE',503);
 const targets=[];
 for(const target_key of [...new Set(bindings.map(b=>b.target_key))].sort()){
  try{
   const target=await db.transaction(async tx=>{
    const located=bindings.filter(b=>b.target_key===target_key);if(located.length!==1)throw continuationDenied();
    const identity=await loadConsentContinuationBindingIdentity(tx,{org_id:caller.org_id,resource_binding_id:located[0]!.id,clock:()=>new Date()});
    if(!identity||identity.binding.owner_user_id!==caller.user_id)throw continuationDenied();
    const admission=await assertOwnerConnectionRegistration(tx,identity.registration,{owner_user_id:caller.user_id,resource_key:identity.binding.resource_key,lockedReviewed:identity});
    const max_consent_expires_at=new Date(Date.now()+admission.policy.max_consent_seconds*1000).toISOString();
    const rows=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,caller.org_id),eq(appConnectionSessions.owner_user_id,caller.user_id),
      sql`${appConnectionSessions.record}->'scope'->>'resource_binding_id'=${identity.binding.id}`,sql`${appConnectionSessions.record}->>'state'='connected'`,
      sql`${appConnectionSessions.record}->'scope'->>'consent_expires_at'=${(identity.binding.consent_expires_at?.toISOString()??null)}`)).orderBy(desc(appConnectionSessions.created_at)).limit(2);
    if(rows.length!==1)throw continuationDenied();const old=AppConnectionSessionRecordSchema.parse(rows[0]!.record);
    if(!old.account||!old.runtime_session_ref||!old.action_consents||old.revision<1)throw continuationDenied();
    const [pendingRow]=await tx.select().from(journals).where(and(eq(journals.org_id,caller.org_id),eq(journals.owner_user_id,caller.user_id),eq(journals.source_session_id,old.session_id),sql`${journals.record}->>'state' NOT IN ('connected','not_connected')`)).limit(1);
    let pending=pendingRow?ConsentContinuationRecordSchema.parse(pendingRow.record):null;
    if(!await appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,owner_user_id:caller.user_id,session_id:old.session_id,continuation_session_id:pending?.session_id}))throw continuationDenied();
    // Metadata GET may safely close only an unstarted expired owner review.
    if(pending&&!pending.activation_started&&Date.parse(pending.review_expires_at)<=Date.now()){
      await assertContinuationClosureIdentity(tx,caller,guard,pending);
      const store=new PostgresConsentContinuationStore(),q={org_id:caller.org_id,owner_user_id:caller.user_id,session_id:pending.session_id};
      const locked=await store.metadata(q,tx,true);if(!locked||locked.revision!==pending.revision||locked.record.activation_started)throw continuationDenied();
      await store.cas(tx,q,pending,{...pending,state:'not_connected',revision:pending.revision+1,updated_at:new Date().toISOString()});pending=null;
    }
    const proposal=pending?pending.scope.consent_expires_at:max_consent_expires_at;
    const proposalLifetime=pending?.scope.consent_lifetime;
    const current=await currentConsentContinuationAuthority(caller,{installation_id,target_key},guard,proposal===null?null:new Date(proposal),tx,proposalLifetime);
    if(!isDeepStrictEqual({...old.scope,consent_expires_at:proposal,...(proposalLifetime?{consent_lifetime:proposalLifetime}:{})},current.scope)||!isDeepStrictEqual(old.profile,current.profile))throw continuationDenied();
    return {target_key,source:{session_id:old.session_id,session_revision:old.revision,scope:old.scope,runtime_session_ref:old.runtime_session_ref,account_ref:old.account.account_ref,action_consents:old.action_consents},
      account:old.account,max_consent_expires_at,...(admission.policy.allow_until_revoked?{allow_until_revoked:true}:{}),runtime_ready:current.runtime_ready,pending:pending?{session_id:pending.session_id,state:pending.state,activation_started:pending.activation_started,
       consent_expires_at:pending.scope.consent_expires_at,...(pending.scope.consent_lifetime?{consent_lifetime:pending.scope.consent_lifetime}:{}),review:pending.review?continuationReviewView(pending):null}:null};
   });targets.push(target);
  }catch(error){if(error instanceof AppError&&error.code==='APP_ACCESS_DENIED')continue;throw error;}
 }
 await db.transaction(tx=>guard(tx));return {schema_version:'deft.app_connection_consent_continuation_context.v1',installation_id,org_id:caller.org_id,owner_user_id:caller.user_id,targets};
}
