import {z} from 'zod';
import {AppPreparedFutureReleaseSchema,type AppDataPreparedRecordAction} from '@deft/app-kit/core';
import {ReviewedFutureRecordActionAuthoritySchema,currentFutureRecordActionAuthority} from './app-future-record-action-authority.js';
import type {CurrentAppDataAuthority} from './app-data-authority.js';
import {appDataDigest,appDataDenied} from './app-data-authority.js';
import type {AppRunTransaction} from './app-run-repository.js';
import {sql} from 'drizzle-orm';
import {resolveFutureRecordActionSchedule} from './app-future-record-action-schedule.js';
export const ReviewedFutureRecordActionTicketSchema=z.strictObject({
 release_id:z.string().uuid(),authority:ReviewedFutureRecordActionAuthoritySchema,
 prepared_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/u),future_release:AppPreparedFutureReleaseSchema,
}).refine(row=>row.authority.policy_digest===row.future_release.policy_digest
 &&row.authority.authority_expires_at===row.future_release.authority_expires_at);
export type ReviewedFutureRecordActionTicket=z.infer<typeof ReviewedFutureRecordActionTicketSchema>;
/** Called only after the ordinary real-human target/preview fences. The
 * subsequent sealed ticket binds this dedicated purpose and absolute expiry. */
export async function captureFutureRecordActionReview(tx:AppRunTransaction,current:CurrentAppDataAuthority,
 prepared:AppDataPreparedRecordAction,releaseId:string,reviewSessionId:string,purposeIdentity:{consent_grant_id:string|null;consent_epoch:number|null;exposure_id:string;exposure_epoch:number}){
 const future=prepared.future_release,policy=current.store.future_record_actions?.find(row=>row.action_key===prepared.action_key);
 if(!future||!policy||!current.consent||future.policy_digest!==appDataDigest(policy))throw appDataDenied();
 const actionConsents=[...(current.action_consents??(current.action_consent?[current.action_consent]:[]))]
  .filter(row=>row.action_key===prepared.action_key||prepared.required_action_consents?.some(extra=>extra.action_key===row.action_key))
  .sort((a,b)=>a.action_key<b.action_key?-1:1);
 if(actionConsents.length!==1+(prepared.required_action_consents?.length??0)
 ||prepared.required_action_consents?.some(extra=>!actionConsents.some(row=>appDataDigest(row)===appDataDigest(extra))))throw appDataDenied();
 const {resourceObservationBindingAuthority,loadObservationConnection}=await import('./app-resource-observation-authority.js');
 const binding=await resourceObservationBindingAuthority(tx,current.scope.org_id,current.scope.resource_binding_id,()=>new Date());
 const connection=await loadObservationConnection(tx,binding,current.connection.session_id);
 const authority=ReviewedFutureRecordActionAuthoritySchema.parse({
  schema_version:'deft.reviewed_future_record_action_authority.v1',review_session_id:reviewSessionId,purpose_identity:purposeIdentity,scope:current.scope,connection:current.connection,store_key:current.store.key,
  data_consent_id:current.consent.consent_id,data_consent_digest:current.consent.consent_digest,data_policy_digest:current.data_policy_digest,
  data_consent_expires_at:current.consent.expires_at?.toISOString()??null,...(current.consent.consent_lifetime?{consent_lifetime:current.consent.consent_lifetime}:{}),policy,policy_digest:appDataDigest(policy),action_consents:actionConsents,
  custody_generation:connection.connection_receipt?.custody_generation??null,custody_receipt_digest:connection.connection_receipt?.receipt_digest??null,
  authority_expires_at:future.authority_expires_at,
 });
 const window=future.execution_window;
 if(window.undo_delay_seconds>policy.max_undo_delay_seconds||future.max_dispatch_lifetime_seconds!==policy.max_dispatch_lifetime_seconds
 ||window.schedule&&!policy.missed_policies.includes(window.schedule.missed_policy)
 ||future.schedule&&Date.parse(future.schedule.instant)>Date.now()+policy.max_schedule_horizon_seconds*1000)throw appDataDenied();
 if(window.schedule){const resolved=resolveFutureRecordActionSchedule(window.schedule,Date.now(),policy.max_schedule_horizon_seconds);
  if(!future.schedule||resolved.instant!==future.schedule.instant||resolved.zone!==future.schedule.zone)throw appDataDenied();}
 await currentFutureRecordActionAuthority(tx,authority);
 return ReviewedFutureRecordActionTicketSchema.parse({release_id:releaseId,authority,prepared_digest:prepared.snapshot_digest,future_release:future});
}
export async function assertFutureRecordActionPurposeDeadline(tx:AppRunTransaction,org:string,owner:string,
 identity:{consent_grant_id:string|null;consent_epoch:number|null;exposure_id:string;exposure_epoch:number},deadline:string){
 if(identity.consent_grant_id){
  const result=await tx.execute(sql<{current:boolean}>`SELECT revoked_at IS NULL AND epoch=${identity.consent_epoch} AS current FROM app_experience_consent_grants WHERE org_id=${org} AND owner_user_id=${owner} AND id=${identity.consent_grant_id} FOR SHARE`);
  if(result.rows[0]?.current!==true)throw appDataDenied();
 }else{
  const result=await tx.execute(sql<{current:boolean}>`SELECT revoked_at IS NULL AND exposure_epoch=${identity.exposure_epoch} AND expires_at>clock_timestamp() AS current FROM app_experience_resource_exposures WHERE org_id=${org} AND owner_user_id=${owner} AND id=${identity.exposure_id} FOR SHARE`);
  if(result.rows[0]?.current!==true)throw appDataDenied();
 }
}
