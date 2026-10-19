import {and,desc,eq,sql} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {AppConnectionUpgradeContextSchema,AppConnectionUpgradeReviewViewSchema,AppConnectionCredentialRepairReviewViewSchema} from '@deft/app-kit';
import {appConnectionSessions} from '@deft/db/schema';
import {db} from './db.js';
import {AppError} from './app-errors.js';
import {currentConnectionBindingLocators} from './app-connection-current-locators.js';
import {currentAppConnectionMetadataAuthority,currentAppConnectionSessionV2Authority} from './app-connection-session-authority.js';
import {AppConnectionSessionRecordSchema,type AppConnectionSessionRecord,type AppConnectionSessionAuthority} from './app-connection-session-service.js';
import {currentConnectionContextView,currentConnectionReattachmentContext} from './app-connection-session-context.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';
import type {ExperienceCaller} from './app-experience-service.js';
import type {WebAuthorityGuard} from './app-resource-sync-web-authority.js';

export function currentConnectionUpgradeNomination(record:AppConnectionSessionRecord|null,source:AppConnectionSessionRecord|null,
 current:AppConnectionSessionAuthority){
 const data=record?.upgrade;
 const pending=record&&data&&!data.receipt&&!['connected','not_connected','disconnected'].includes(record.state)?{
  session_id:record.session_id,state:record.state,begin_consumed:data.begin_consumed,callback_consumed:record.callback_consumed,
  review:record.state==='upgrade_reviewed'&&!data.begin_consumed&&!record.callback_consumed&&data.review?
   AppConnectionUpgradeReviewViewSchema.parse({schema_version:'deft.app_connection_upgrade_review.v1',session_id:record.session_id,
    source_session_id:data.source.session_id,source_revision:data.source.session_revision,scope:record.scope,account:data.review.account,
    custody_generation:data.review.custody_generation,action_consents:record.action_consents,review_digest:data.review.digest,
    expires_at:data.review_expires_at}):null}:null;
 const startupExpired=record&&['starting','awaiting_callback'].includes(record.state)&&!record.callback_consumed&&!record.account
  &&!record.upgrade?.begin_consumed&&Date.parse(record.callback_expires_at)<=Date.now();
 const blocked=record&&!['connected','not_connected','disconnected'].includes(record.state)&&!startupExpired;
 const compatible=source?.state==='connected'&&source.account&&source.runtime_session_ref
  &&['org_id','owner_user_id','installation_id','target_key','resource_key','operator_user_id'].every(field=>
    source.scope[field as keyof typeof source.scope]===current.scope[field as keyof typeof current.scope])
  &&['provider_id','credential_custody','runtime_requirement_key','resource_key','operator_user_id'].every(field=>
    source.profile[field as keyof typeof source.profile]===current.profile[field as keyof typeof current.profile]);
 return {candidate:!pending&&!blocked&&compatible?{source_session_id:source!.session_id,source_revision:source!.revision,account:source!.account!}:null,pending};
}
export function currentCredentialRepairNomination(record:AppConnectionSessionRecord|null,source:AppConnectionSessionRecord|null,current:AppConnectionSessionAuthority){
 const data=record?.credential_repair;
 const pending=record&&data&&!data.reservation_closed?{session_id:record.session_id,state:record.state,
  begin_consumed:data.begin_consumed,callback_consumed:record.callback_consumed,
  review:record.state==='repair_reviewed'&&!data.begin_consumed&&!record.callback_consumed&&data.review?
   AppConnectionCredentialRepairReviewViewSchema.parse({schema_version:'deft.app_connection_credential_repair_review.v1',session_id:record.session_id,
    source_session_id:data.source.session_id,source_revision:data.source.session_revision,scope:record.scope,account:data.review.account,
    custody_generation:data.review.custody_generation,fence:data.review.fence,action_consents:record.action_consents,review_digest:data.review.digest,expires_at:data.review_expires_at}):null}:null;
 const compatible=source?.state==='connected'&&source.account&&source.runtime_session_ref&&isDeepStrictEqual(source.scope,current.scope)
  &&isDeepStrictEqual(source.profile,current.profile)&&isDeepStrictEqual(source.action_consents,current.action_consents);
 return {candidate:!pending&&compatible?{source_session_id:source!.session_id,source_revision:source!.revision,account:source!.account!}:null,pending};
}

/** Current owner metadata only; the candidate cannot authorize OAuth/custody.
 * Eligibility/client/generation are reviewed by the independent runtime. */
export async function appConnectionUpgradeInstallationContext(caller:ExperienceCaller,installationId:string,guard:WebAuthorityGuard){
 const bindings=await currentConnectionBindingLocators(db,caller,{installation_id:installationId}).limit(33);
 if(bindings.length>32)throw new AppError('Connection context exceeds bound','APP_PROVIDER_UNAVAILABLE',503);
 const targets=[];
 for(const target_key of [...new Set(bindings.map(row=>row.target_key))].sort()){
  try{
   const nomination={installation_id:installationId,target_key},current=await currentAppConnectionMetadataAuthority(caller,nomination,guard);
   if(current.connection_protocol!=='v2')continue;
   const scopeWhere=and(eq(appConnectionSessions.org_id,caller.org_id),eq(appConnectionSessions.owner_user_id,caller.user_id),
    sql`${appConnectionSessions.record}->'scope'->>'installation_id'=${installationId}`,
    sql`${appConnectionSessions.record}->'scope'->>'target_key'=${target_key}`);
   const [row]=await db.select().from(appConnectionSessions).where(and(scopeWhere,
    sql`${appConnectionSessions.record}->'scope'=${JSON.stringify(current.scope)}::jsonb`))
    .orderBy(desc(appConnectionSessions.created_at),desc(appConnectionSessions.session_id)).limit(1);
   const record=row?AppConnectionSessionRecordSchema.parse(row.record):null;
   if(record&&record.revision!==row!.revision)throw new AppError('Connection revision unavailable','APP_ACCESS_DENIED',403);
   const [previous]=await db.select().from(appConnectionSessions).where(and(scopeWhere,
    sql`${appConnectionSessions.record}->>'state'='connected'`,
    sql`${appConnectionSessions.record}->'scope'->>'resource_key'=${current.scope.resource_key}`,
    sql`${appConnectionSessions.record}->'scope'->>'operator_user_id'=${current.scope.operator_user_id}`))
    .orderBy(desc(appConnectionSessions.created_at),desc(appConnectionSessions.session_id)).limit(1);
   let source=previous?AppConnectionSessionRecordSchema.parse(previous.record):null;
   if(source&&source.revision!==previous!.revision)throw new AppError('Source revision unavailable','APP_ACCESS_DENIED',403);
   if(source&&!await db.transaction(tx=>appConnectionUpgradeSourceIsAvailable(tx,{org_id:caller.org_id,owner_user_id:caller.user_id,session_id:source!.session_id})))source=null;
   const after=await currentAppConnectionMetadataAuthority(caller,nomination,guard);
   if(after.connection_protocol!=='v2'||!isDeepStrictEqual(current.scope,after.scope)||!isDeepStrictEqual(current.profile,after.profile))continue;
   // Metadata intentionally omits action purposes. Repair nomination must use
   // the exact current operational set, never infer or renew saved purposes.
   let repairAuthority:AppConnectionSessionAuthority|null=null;
   if(after.runtime_ready)try{
    const operational=await currentAppConnectionSessionV2Authority(caller,nomination,guard);
    if(isDeepStrictEqual(after.scope,operational.scope)&&isDeepStrictEqual(after.profile,operational.profile))repairAuthority=operational;
   }catch(error){if(!(error instanceof AppError)||error.code!=='APP_ACCESS_DENIED')throw error;}
   targets.push({target_key,scope:after.scope,profile:{key:after.profile.key,label:after.profile.provider_id,
     authorization_origin:after.profile.authorization_origin},runtime_ready:after.runtime_ready,
    session:currentConnectionContextView(record?.credential_repair?.reservation_closed&&record.state==='not_connected'?source:record,after),
    credential_repair:currentCredentialRepairNomination(record,repairAuthority?source:null,repairAuthority??after),upgrade:currentConnectionUpgradeNomination(record,source,after),
    reattachment:currentConnectionReattachmentContext(record,repairAuthority&&source?.action_consents!==undefined?source:null,repairAuthority??after)});
  }catch(error){if(error instanceof AppError&&error.code==='APP_ACCESS_DENIED')continue;throw error;}
 }
 await db.transaction(tx=>guard(tx));
 const result=AppConnectionUpgradeContextSchema.parse({schema_version:'deft.app_connection_upgrade_context.v1',
  installation_id:installationId,org_id:caller.org_id,owner_user_id:caller.user_id,targets});
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>262144)throw new AppError('Connection context exceeds bound','APP_PROVIDER_UNAVAILABLE',503);
 return result;
}
