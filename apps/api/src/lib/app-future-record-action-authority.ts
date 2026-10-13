import {z} from 'zod';
import {and,eq,sql} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {AppConnectionSessionScopeSchema,AppConnectionActionConsentSchema,AppDataConnectionSchema,
 AppDataConsentSnapshotSchema,AppFutureRecordActionDeclarationSchema,parseAttachmentAppManifest} from '@deft/app-kit';
import {appDataConsents} from '@deft/db/schema';
import type {AppRunTransaction} from './app-run-repository.js';
import {resourceObservationBindingAuthority,loadObservationConnection} from './app-resource-observation-authority.js';
import {appDataDigest,appDataDenied} from './app-data-authority.js';
import {digestAppGrantValue} from './app-grant-service.js';
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u),id=z.string().uuid();
/** Private captured review, never a portable Worker-nominated grant. The
 * release row is the dedicated future-effect consent; read/job grants alone
 * cannot construct or admit this authority. */
export const ReviewedFutureRecordActionAuthoritySchema=z.strictObject({
 schema_version:z.literal('deft.reviewed_future_record_action_authority.v1'),scope:AppConnectionSessionScopeSchema,
 review_session_id:id,
 purpose_identity:z.strictObject({consent_grant_id:id.nullable(),consent_epoch:z.number().int().min(0).nullable(),exposure_id:id,exposure_epoch:z.number().int().min(0)}),
 connection:AppDataConnectionSchema,store_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
 data_consent_id:id,data_consent_digest:digest,data_policy_digest:digest,
 data_consent_expires_at:z.iso.datetime(),policy:AppFutureRecordActionDeclarationSchema,policy_digest:digest,
 action_consents:z.array(AppConnectionActionConsentSchema).min(1).max(9)
  .refine(rows=>new Set(rows.map(row=>row.action_key)).size===rows.length&&rows.every((row,i)=>i===0||rows[i-1]!.action_key<row.action_key)),
 custody_generation:z.number().int().min(1).max(2147483646).nullable(),custody_receipt_digest:digest.nullable(),
 authority_expires_at:z.iso.datetime(),
}).refine(row=>row.action_consents.some(consent=>consent.action_key===row.policy.action_key)
 &&row.action_consents.every(consent=>Date.parse(consent.expires_at)>=Date.parse(row.authority_expires_at))
 &&Date.parse(row.authority_expires_at)<=Math.min(Date.parse(row.scope.consent_expires_at),Date.parse(row.data_consent_expires_at))
 &&(row.custody_generation===null)===(row.custody_receipt_digest===null));
export type ReviewedFutureRecordActionAuthority=z.infer<typeof ReviewedFutureRecordActionAuthoritySchema>;
/** Shared live readers check owner membership, installed version/grant,
 * deployment admission, resource purpose and connected account. No browser
 * session, observation consent or local-job execution authority is borrowed. */
export async function currentFutureRecordActionAuthority(tx:AppRunTransaction,raw:unknown,clock=()=>new Date()){
 const pins=ReviewedFutureRecordActionAuthoritySchema.parse(raw),now=clock();
 if(!Number.isFinite(now.getTime())||Date.parse(pins.authority_expires_at)<=now.getTime()||appDataDigest(pins.policy)!==pins.policy_digest)throw appDataDenied();
 const identity=pins.purpose_identity;
 const purpose=identity.consent_grant_id?await tx.execute(sql<{current:boolean}>`SELECT revoked_at IS NULL AND epoch=${identity.consent_epoch} AND app_installation_id=${pins.scope.installation_id} AND app_version_id=${pins.scope.app_version_id} AS current FROM app_experience_consent_grants WHERE org_id=${pins.scope.org_id} AND owner_user_id=${pins.scope.owner_user_id} AND id=${identity.consent_grant_id} FOR SHARE`):await tx.execute(sql<{current:boolean}>`SELECT revoked_at IS NULL AND exposure_epoch=${identity.exposure_epoch} AS current FROM app_experience_resource_exposures WHERE org_id=${pins.scope.org_id} AND owner_user_id=${pins.scope.owner_user_id} AND id=${identity.exposure_id} FOR SHARE`);
 if(purpose.rows[0]?.current!==true)throw appDataDenied();
 const view=await tx.execute(sql<{current:boolean}>`SELECT revoked_at IS NULL AND app_installation_id=${pins.scope.installation_id} AND app_version_id=${pins.scope.app_version_id} AND grant_snapshot_id=${pins.scope.grant_snapshot_id} AS current FROM app_experience_sessions WHERE org_id=${pins.scope.org_id} AND user_id=${pins.scope.owner_user_id} AND id=${pins.review_session_id} FOR SHARE`);if(view.rows[0]?.current!==true)throw appDataDenied();
 const binding=await resourceObservationBindingAuthority(tx,pins.scope.org_id,pins.scope.resource_binding_id,clock);
 const connection=await loadObservationConnection(tx,binding,pins.connection.session_id);
 if(!isDeepStrictEqual(connection.scope,pins.scope)
 ||connection.runtime_session_ref!==pins.connection.runtime_session_ref||connection.account?.account_ref!==pins.connection.account_ref
 ||(connection.connection_receipt?.custody_generation??null)!==pins.custody_generation
 ||(connection.connection_receipt?.receipt_digest??null)!==pins.custody_receipt_digest)throw appDataDenied();
 const stores=parseAttachmentAppManifest(binding.version.manifest).record_stores??[];
 if(!isDeepStrictEqual(stores,(binding.grant.canonical_snapshot as {record_stores?:unknown}).record_stores??[]))throw appDataDenied();
 const store=stores.find(row=>row.key===pins.store_key),policy=store?.future_record_actions?.find(row=>row.action_key===pins.policy.action_key);
 if(!store||store.resource_key!==pins.scope.resource_key||store.runtime_requirement_key!==connection.profile.runtime_requirement_key
 ||appDataDigest(store)!==pins.data_policy_digest||!isDeepStrictEqual(policy,pins.policy))throw appDataDenied();
 const [consent]=await tx.select().from(appDataConsents).where(and(eq(appDataConsents.org_id,pins.scope.org_id),
 eq(appDataConsents.owner_user_id,pins.scope.owner_user_id),eq(appDataConsents.consent_id,pins.data_consent_id),eq(appDataConsents.state,'active'))).for('share');
 if(!consent||consent.expires_at.toISOString()!==pins.data_consent_expires_at||consent.consent_digest!==pins.data_consent_digest
 ||consent.expires_at<=now||appDataDigest(consent.snapshot)!==pins.data_consent_digest)throw appDataDenied();
 const data=AppDataConsentSnapshotSchema.parse(consent.snapshot);
 if(!isDeepStrictEqual(data.scope,pins.scope)||!isDeepStrictEqual(data.store,store)
 ||data.connection.session_id!==pins.connection.session_id||data.connection.runtime_session_ref!==pins.connection.runtime_session_ref
 ||data.connection.account_ref!==pins.connection.account_ref||data.data_policy_digest!==pins.data_policy_digest)throw appDataDenied();
 const runtime=await import('./app-run-runtime.js'),authorizer=(await runtime.getAppRunRuntime()).liveAuthorization;
 for(const consent of pins.action_consents){
  const reviewed=await authorizer.captureReviewedRuntimeInTransaction(tx,{org_id:pins.scope.org_id,user_id:pins.scope.owner_user_id,runtime_binding_id:consent.action_binding_id});
  if(reviewed.protocol_version!=='7'||reviewed.binding.action_key!==consent.action_key
  ||reviewed.binding.owner_resource_binding_id!==pins.scope.resource_binding_id||reviewed.operator_user_id!==pins.scope.operator_user_id
  ||reviewed.registration.runtime_epoch!==consent.authority_epoch||digestAppGrantValue(reviewed.authorization_snapshot)!==consent.consent_digest
  ||!reviewed.owner_target_consent_expires_at||reviewed.owner_target_consent_expires_at.getTime()<Date.parse(pins.authority_expires_at))throw appDataDenied();
 }
 if(clock().getTime()>=Date.parse(pins.authority_expires_at))throw appDataDenied();
 return pins;
}
