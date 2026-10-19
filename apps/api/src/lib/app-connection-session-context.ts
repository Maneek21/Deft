import {and,desc,eq,sql} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {AppConnectionSessionViewSchema,AppConnectionReattachAnyReviewViewSchema} from '@deft/app-kit';
import {appConnectionSessions} from '@deft/db/schema';
import {currentConnectionBindingLocators} from './app-connection-current-locators.js';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import {currentAppConnectionMetadataAuthority} from './app-connection-session-authority.js';
import {AppConnectionSessionRecordSchema,type AppConnectionSessionAuthority,type AppConnectionSessionRecord} from './app-connection-session-service.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';

/** Same closed public projection as status, without invoking the runtime. */
export function currentConnectionContextView(record:AppConnectionSessionRecord|null,current:AppConnectionSessionAuthority){
 if(!record||!isDeepStrictEqual(record.scope,current.scope)||!isDeepStrictEqual(record.profile,current.profile))return null;
 return AppConnectionSessionViewSchema.parse({schema_version:'deft.app_connection_session.v1',session_id:record.session_id,
  state:record.credential_repair&&!record.credential_repair.reservation_closed&&record.state==='connected'?'indeterminate':
   ['starting','connecting','checking','disconnecting','reattach_reviewed','reattaching','reattach_checking','upgrade_reviewed','upgrade_starting','upgrade_checking','repair_reviewed','repair_starting','repair_checking'].includes(record.state)?'indeterminate':record.state,
  scope:record.scope,account:record.account,
  expires_at:['starting','awaiting_callback','connecting'].includes(record.state)?record.callback_expires_at:record.scope.consent_expires_at});
}

/** Historical metadata nominates custody only; no historical authority/ref. */
export function currentConnectionReattachmentContext(record:AppConnectionSessionRecord|null,previous:AppConnectionSessionRecord|null,current:AppConnectionSessionAuthority){
 const pending=record?.reattachment&&!record.reattachment.receipt&&!['connected','not_connected','disconnected'].includes(record.state)?{
  session_id:record.session_id,state:record.state,activation_started:record.callback_consumed,
  review:record.state==='reattach_reviewed'&&!record.callback_consumed&&record.reattachment.review?
   AppConnectionReattachAnyReviewViewSchema.parse({schema_version:record.action_consents!==undefined?'deft.app_connection_reattach_review.v2':'deft.app_connection_reattach_review.v1',
    ...(record.action_consents!==undefined?{action_consents:record.action_consents}:{}),session_id:record.session_id,
    source_session_id:record.reattachment.source.session_id,source_revision:record.reattachment.source.session_revision,
    scope:record.scope,account:record.reattachment.review.account,custody_generation:record.reattachment.review.custody_generation,
    review_digest:record.reattachment.review.digest,expires_at:record.reattachment.review_expires_at}):null}:null;
 const scope=current.scope,old=previous?.scope;
 const blocked=record&&!['not_connected','disconnected'].includes(record.state)
  &&!(['starting','awaiting_callback'].includes(record.state)&&!record.callback_consumed&&!record.account&&Date.parse(record.callback_expires_at)<=Date.now());
 const candidate=!blocked&&previous?.state==='connected'&&previous.account&&previous.runtime_session_ref&&old
  &&['org_id','owner_user_id','installation_id','target_key','resource_key','operator_user_id','profile_digest'].every(key=>old[key as keyof typeof old]===scope[key as keyof typeof scope])
  &&old.app_version_id!==scope.app_version_id&&old.grant_snapshot_id!==scope.grant_snapshot_id
  &&old.lifecycle_epoch<scope.lifecycle_epoch&&old.grant_epoch<scope.grant_epoch&&isDeepStrictEqual(previous.profile,current.profile)
  &&isDeepStrictEqual(previous.action_consents?.map(consent=>consent.action_key),current.action_consents?.map(consent=>consent.action_key))?
   {source_session_id:previous.session_id,source_revision:previous.revision,account:previous.account}:null;
 return {candidate,pending};
}

/** Human-owned admitted targets only. No provider call, runtime reference,
 * authorization URL, callback nonce or retained human credential is projected. */
export async function appConnectionInstallationContext(caller:ExperienceCaller,installationId:string,guard:WebAuthorityGuard){
 const bindings=await currentConnectionBindingLocators(db,caller,{installation_id:installationId}).limit(33);
 if(bindings.length>32)throw new AppError('Connection context exceeds bound','APP_PROVIDER_UNAVAILABLE',503);
 const targets=[];
 for(const target_key of [...new Set(bindings.map(row=>row.target_key))].sort()){
  try{
   const nomination={installation_id:installationId,target_key};
   const current=await currentAppConnectionMetadataAuthority(caller,nomination,guard);
   // Independently reviewed v2 targets use the separate upgrade context.
   // This retained v1 audience never nominates a broader protocol.
   if(current.connection_protocol!=='v1')continue;
   const [row]=await db.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,caller.org_id),
    eq(appConnectionSessions.owner_user_id,caller.user_id),sql`${appConnectionSessions.record}->'scope'->>'installation_id'=${installationId}`,
    sql`${appConnectionSessions.record}->'scope'->>'target_key'=${target_key}`,
    sql`${appConnectionSessions.record}->'scope'=${JSON.stringify(current.scope)}::jsonb`))
    .orderBy(desc(appConnectionSessions.created_at),desc(appConnectionSessions.session_id)).limit(1);
   const record=row?AppConnectionSessionRecordSchema.parse(row.record):null;
   if(record&&record.revision!==row!.revision)throw new AppError('Connection revision unavailable','APP_ACCESS_DENIED',403);
   const [historical]=await db.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,caller.org_id),
    eq(appConnectionSessions.owner_user_id,caller.user_id),sql`${appConnectionSessions.record}->>'state'='connected'`,
    sql`${appConnectionSessions.record}->'scope'->>'installation_id'=${installationId}`,
    sql`${appConnectionSessions.record}->'scope'->>'target_key'=${target_key}`,
    sql`${appConnectionSessions.record}->'scope'->>'resource_key'=${current.scope.resource_key}`,
    sql`${appConnectionSessions.record}->'scope'->>'operator_user_id'=${current.scope.operator_user_id}`,
    sql`${appConnectionSessions.record}->'scope'->>'profile_digest'=${current.scope.profile_digest}`,
    sql`${appConnectionSessions.record}->'profile'=${JSON.stringify(current.profile)}::jsonb`,
    sql`(${appConnectionSessions.record}->'scope'->>'lifecycle_epoch')::integer<${current.scope.lifecycle_epoch}`,
    sql`(${appConnectionSessions.record}->'scope'->>'grant_epoch')::integer<${current.scope.grant_epoch}`))
    .orderBy(desc(appConnectionSessions.created_at),desc(appConnectionSessions.session_id)).limit(1);
   const previous=historical?AppConnectionSessionRecordSchema.parse(historical.record):null;
   if(previous&&previous.revision!==historical!.revision)throw new AppError('Historical connection revision unavailable','APP_ACCESS_DENIED',403);
   const after=await currentAppConnectionMetadataAuthority(caller,nomination,guard);
   if(!isDeepStrictEqual(current.scope,after.scope)||!isDeepStrictEqual(current.profile,after.profile))continue;
   targets.push({target_key,profile:{key:after.profile.key,label:after.profile.provider_id,authorization_origin:after.profile.authorization_origin},scope:after.scope,runtime_ready:after.runtime_ready,
    session:currentConnectionContextView(record,after),reattachment:currentConnectionReattachmentContext(record,previous,after)});
  }catch(error){if(error instanceof AppError&&error.code==='APP_ACCESS_DENIED')continue;throw error;}
 }
 // Recheck current SID even for an empty/foreign-owner target catalog.
 await db.transaction(async tx=>{await guard(tx);});
 return {schema_version:'deft.app_connection_context.v1' as const,installation_id:installationId,org_id:caller.org_id,owner_user_id:caller.user_id,targets};
}
