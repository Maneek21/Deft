import {appConsentDeadline,AppConsentExpirySchema,AppConsentLifetimeSchema,appConsentExpiryValid} from '@deft/app-kit/core';
import {discloseRecordMirrorRead} from './app-record-mirror-read-deadline.js';
import {z} from 'zod';
import {and,eq,sql} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {AppConnectionSessionScopeSchema,AppConnectionActionConsentSchema,AppDataConnectionSchema,
 AppDataConsentSnapshotSchema,AppRecordMirrorDeclarationSchema,parseAttachmentAppManifest} from '@deft/app-kit/core';
import {appDataConsents} from '@deft/db/schema';
import type {AppRunTransaction} from './app-run-repository.js';
import {resourceObservationBindingAuthority,loadObservationConnection} from './app-resource-observation-authority.js';
import {appDataDigest,appDataDenied,type CurrentAppDataAuthority} from './app-data-authority.js';
import {digestAppGrantValue} from './app-grant-service.js';
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u),id=z.string().uuid();
/** Private captured recurring Modify review, never a Worker-nominated grant. The
 * mirror receipt is the dedicated recurring Modify consent; read/job grants alone
 * cannot construct or admit this authority. */
export const ReviewedRecordMirrorAuthoritySchema=z.strictObject({
 schema_version:z.literal('deft.reviewed_record_mirror_authority.v1'),scope:AppConnectionSessionScopeSchema,
 review_session_id:id,
 purpose_identity:z.strictObject({consent_grant_id:id.nullable(),consent_epoch:z.number().int().min(0).nullable(),exposure_id:id,exposure_epoch:z.number().int().min(0)}),
 connection:AppDataConnectionSchema,store_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
 data_consent_id:id,data_consent_digest:digest,data_policy_digest:digest,
 data_consent_expires_at:AppConsentExpirySchema,consent_lifetime:AppConsentLifetimeSchema.optional(),policy:AppRecordMirrorDeclarationSchema,policy_digest:digest,
 action_consents:z.array(AppConnectionActionConsentSchema).length(1)
  .refine(rows=>new Set(rows.map(row=>row.action_key)).size===rows.length&&rows.every((row,i)=>i===0||rows[i-1]!.action_key<row.action_key)),
 custody_generation:z.number().int().min(1).max(2147483646).nullable(),custody_receipt_digest:digest.nullable(),
 authority_expires_at:z.iso.datetime(),
}).refine(row=>appConsentExpiryValid(row.data_consent_expires_at,row.consent_lifetime)&&row.action_consents.some(consent=>consent.action_key===row.policy.action_key)
 &&row.action_consents.every(consent=>appConsentDeadline(consent.expires_at,consent.consent_lifetime)>=Date.parse(row.authority_expires_at))
 &&Date.parse(row.authority_expires_at)<=Math.min(appConsentDeadline(row.scope.consent_expires_at, row.scope.consent_lifetime),appConsentDeadline(row.data_consent_expires_at,row.consent_lifetime))
 &&(row.custody_generation===null)===(row.custody_receipt_digest===null));
export type ReviewedRecordMirrorAuthority=z.infer<typeof ReviewedRecordMirrorAuthoritySchema>;
/** Shared live readers check owner membership, installed version/grant,
 * deployment admission, resource purpose and connected account. No browser
 * session, observation consent or local-job execution authority is borrowed. */
export async function currentRecordMirrorAuthority(tx:AppRunTransaction,raw:unknown,clock=()=>new Date()){
 const pins=ReviewedRecordMirrorAuthoritySchema.parse(raw),now=clock();
 if(!Number.isFinite(now.getTime())||Date.parse(pins.authority_expires_at)<=now.getTime()||appDataDigest(pins.policy)!==pins.policy_digest)throw appDataDenied();
 const identity=pins.purpose_identity;
 const purpose=identity.consent_grant_id?await tx.execute(sql<{current:boolean}>`SELECT revoked_at IS NULL AND epoch=${identity.consent_epoch} AND app_installation_id=${pins.scope.installation_id} AND app_version_id=${pins.scope.app_version_id} AS current FROM app_experience_consent_grants WHERE org_id=${pins.scope.org_id} AND owner_user_id=${pins.scope.owner_user_id} AND id=${identity.consent_grant_id} FOR SHARE`):await tx.execute(sql<{current:boolean}>`SELECT revoked_at IS NULL AND exposure_epoch=${identity.exposure_epoch} AS current FROM app_experience_resource_exposures WHERE org_id=${pins.scope.org_id} AND owner_user_id=${pins.scope.owner_user_id} AND id=${identity.exposure_id} FOR SHARE`);
 if(purpose.rows[0]?.current!==true)throw appDataDenied();
 // The review session is audit provenance after confirmation. Review/confirm
 // enforce its live authority through withHumanAction and the final guard;
 // recurring work is fenced by the durable purpose and current grants below.
 await currentRecordMirrorReadAuthority(tx,pins,clock);
 const runtime=await import('./app-run-runtime.js'),authorizer=(await runtime.getAppRunRuntime()).liveAuthorization;
 for(const consent of pins.action_consents){
  const reviewed=await authorizer.captureReviewedRuntimeInTransaction(tx,{org_id:pins.scope.org_id,user_id:pins.scope.owner_user_id,runtime_binding_id:consent.action_binding_id});
  if(reviewed.protocol_version!=='7'||reviewed.binding.action_key!==consent.action_key
  ||reviewed.binding.owner_resource_binding_id!==pins.scope.resource_binding_id||reviewed.operator_user_id!==pins.scope.operator_user_id
  ||reviewed.registration.runtime_epoch!==consent.authority_epoch||digestAppGrantValue(reviewed.authorization_snapshot)!==consent.consent_digest
  ||reviewed.owner_target_consent_lifetime!=='until_revoked'&&(!reviewed.owner_target_consent_expires_at||reviewed.owner_target_consent_expires_at.getTime()<Date.parse(pins.authority_expires_at)))throw appDataDenied();
 }
 if(clock().getTime()>=Date.parse(pins.authority_expires_at))throw appDataDenied();
 return pins;
}

/** Read-only recovery uses current owner data/account visibility, never the paused or expired recurring Modify authority. */
export async function currentRecordMirrorReadAuthority(tx:AppRunTransaction,raw:unknown,clock=()=>new Date()){
 return validateRecordMirrorReadAuthority(tx,ReviewedRecordMirrorAuthoritySchema.parse(raw),clock);
}
type RecordMirrorReadPins=Pick<ReviewedRecordMirrorAuthority,'scope'|'connection'|'store_key'|'data_consent_id'|'data_consent_digest'|'data_policy_digest'|'data_consent_expires_at'|'consent_lifetime'|'policy'|'policy_digest'|'custody_generation'|'custody_receipt_digest'>;
async function validateRecordMirrorReadAuthority<T extends RecordMirrorReadPins>(tx:AppRunTransaction,pins:T,clock:()=>Date){
 const now=clock();
 if(!Number.isFinite(now.getTime())||appConsentDeadline(pins.data_consent_expires_at,pins.consent_lifetime)<=now.getTime()||appDataDigest(pins.policy)!==pins.policy_digest)throw appDataDenied();
 return discloseRecordMirrorRead(pins,async()=>{
 const binding=await resourceObservationBindingAuthority(tx,pins.scope.org_id,pins.scope.resource_binding_id,clock);
 const connection=await loadObservationConnection(tx,binding,pins.connection.session_id);
 if(!isDeepStrictEqual(connection.scope,pins.scope)
 ||connection.runtime_session_ref!==pins.connection.runtime_session_ref||connection.account?.account_ref!==pins.connection.account_ref
 ||(connection.connection_receipt?.custody_generation??null)!==pins.custody_generation
 ||(connection.connection_receipt?.receipt_digest??null)!==pins.custody_receipt_digest)throw appDataDenied();
 const stores=parseAttachmentAppManifest(binding.version.manifest).record_stores??[];
 if(!isDeepStrictEqual(stores,(binding.grant.canonical_snapshot as {record_stores?:unknown}).record_stores??[]))throw appDataDenied();
 const store=stores.find(row=>row.key===pins.store_key),policy=store?.record_mirrors?.find(row=>row.key===pins.policy.key);
 if(!store||store.resource_key!==pins.scope.resource_key||store.runtime_requirement_key!==connection.profile.runtime_requirement_key
 ||appDataDigest(store)!==pins.data_policy_digest||!isDeepStrictEqual(policy,pins.policy))throw appDataDenied();
 const [consent]=await tx.select().from(appDataConsents).where(and(eq(appDataConsents.org_id,pins.scope.org_id),
 eq(appDataConsents.owner_user_id,pins.scope.owner_user_id),eq(appDataConsents.consent_id,pins.data_consent_id),eq(appDataConsents.state,'active'))).for('share');
 if(!consent||(consent.expires_at?.toISOString()??null)!==pins.data_consent_expires_at||consent.consent_digest!==pins.data_consent_digest
 ||appConsentDeadline(consent.expires_at,AppDataConsentSnapshotSchema.parse(consent.snapshot).consent_lifetime)<=now.getTime()||appDataDigest(consent.snapshot)!==pins.data_consent_digest)throw appDataDenied();
 const data=AppDataConsentSnapshotSchema.parse(consent.snapshot);
 if(!isDeepStrictEqual(data.scope,pins.scope)||!isDeepStrictEqual(data.store,store)
 ||data.connection.session_id!==pins.connection.session_id||data.connection.runtime_session_ref!==pins.connection.runtime_session_ref
 ||data.connection.account_ref!==pins.connection.account_ref||data.data_policy_digest!==pins.data_policy_digest)throw appDataDenied();
 return pins;
 },clock);
}

/** Browser status alone may use independently renewed read consent. Historical
 * recurring-write pins and Runtime readers never pass through this entrance. */
export async function currentOwnerRecordMirrorReadAuthority(tx:AppRunTransaction,raw:unknown,current:CurrentAppDataAuthority,clock=()=>new Date()){
 const reviewed=ReviewedRecordMirrorAuthoritySchema.parse(raw),policy=current.store.record_mirrors?.find(row=>row.key===reviewed.policy.key);
 if(!current.consent||!isDeepStrictEqual({...reviewed.scope,consent_expires_at:current.scope.consent_expires_at},current.scope)
  ||reviewed.store_key!==current.store.key||reviewed.connection.account_ref!==current.connection.account_ref
  ||reviewed.data_policy_digest!==current.data_policy_digest||!isDeepStrictEqual(policy,reviewed.policy))throw appDataDenied();
 const binding=await resourceObservationBindingAuthority(tx,current.scope.org_id,current.scope.resource_binding_id,clock);
 const connection=await loadObservationConnection(tx,binding,current.connection.session_id),custody=connection.connection_receipt;
 if(!isDeepStrictEqual(connection.scope,current.scope)||connection.runtime_session_ref!==current.connection.runtime_session_ref
  ||connection.account?.account_ref!==current.connection.account_ref)throw appDataDenied();
 if(current.connection.session_id===reviewed.connection.session_id){
  if(connection.runtime_session_ref!==reviewed.connection.runtime_session_ref
   ||(custody?.custody_generation??null)!==reviewed.custody_generation
   ||(custody?.receipt_digest??null)!==reviewed.custody_receipt_digest)throw appDataDenied();
 }else{
  // Account labels are not continuity evidence. Traverse only committed Host
  // renewal receipts back to the exact old carrier, preserving credential custody.
  const [{PostgresConsentContinuationStore},{validateContinuationCarrier},{AppConnectionSessionRecordSchema},{appConnectionSessions},{validateStoredFormConnection}]=await Promise.all([
   import('./app-connection-consent-continuation-store.js'),import('./app-connection-consent-continuation-fence.js'),
   import('./app-connection-session-service.js'),import('@deft/db/schema'),import('./app-connection-form-fence.js')]);
  let carrier:ReturnType<typeof AppConnectionSessionRecordSchema.parse>=connection;const seen=new Set<string>(),journals=new PostgresConsentContinuationStore();
  while(carrier.session_id!==reviewed.connection.session_id){
   if(seen.has(carrier.session_id)||seen.size>=64)throw appDataDenied();seen.add(carrier.session_id);
   const receipt=await validateContinuationCarrier(tx,carrier,true);
   if(!receipt||receipt.custody_generation!==custody?.custody_generation)throw appDataDenied();
   const journal=await journals.metadata({org_id:current.scope.org_id,owner_user_id:current.scope.owner_user_id,session_id:carrier.session_id},tx);
   if(!journal||journal.record.state!=='connected')throw appDataDenied();const source=journal.record.source;
   const [row]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,current.scope.org_id),
    eq(appConnectionSessions.owner_user_id,current.scope.owner_user_id),eq(appConnectionSessions.session_id,source.session_id))).for('share');
   if(!row)throw appDataDenied();carrier=AppConnectionSessionRecordSchema.parse(row.record);
   if(carrier.state!=='connected'||carrier.revision!==source.session_revision||!isDeepStrictEqual(carrier.scope,source.scope)
    ||carrier.runtime_session_ref!==source.runtime_session_ref||carrier.account?.account_ref!==source.account_ref
    ||!isDeepStrictEqual(carrier.action_consents,source.action_consents))throw appDataDenied();
  }
  const form=await validateStoredFormConnection(tx,{org_id:current.scope.org_id,owner_user_id:current.scope.owner_user_id,session_id:carrier.session_id},carrier);
  const sourceCustody=await validateContinuationCarrier(tx,carrier,false)??(form?.receipt?{custody_generation:form.receipt.custody_generation,receipt_digest:form.receipt.digest}:carrier.credential_repair?.receipt??carrier.upgrade?.receipt??carrier.reattachment?.receipt);
  if((sourceCustody?.custody_generation??null)!==reviewed.custody_generation||(sourceCustody?.receipt_digest??null)!==reviewed.custody_receipt_digest)throw appDataDenied();
  if(!isDeepStrictEqual(carrier.scope,reviewed.scope)||carrier.runtime_session_ref!==reviewed.connection.runtime_session_ref
   ||carrier.account?.account_ref!==reviewed.connection.account_ref
   ||reviewed.custody_generation!==null&&reviewed.custody_generation!==custody?.custody_generation)throw appDataDenied();
 }
 const readable=await validateRecordMirrorReadAuthority(tx,{scope:current.scope,connection:current.connection,store_key:current.store.key,
  data_consent_id:current.consent.consent_id,data_consent_digest:current.consent.consent_digest,data_policy_digest:current.data_policy_digest,
  data_consent_expires_at:current.consent.expires_at?.toISOString()??null,...(current.consent.consent_lifetime?{consent_lifetime:current.consent.consent_lifetime}:{}),policy:reviewed.policy,policy_digest:reviewed.policy_digest,
  custody_generation:custody?.custody_generation??null,custody_receipt_digest:custody?.receipt_digest??null},clock);
 // Return only visibility deadlines, never a constructed recurring-write grant.
 return {scope:readable.scope,data_consent_expires_at:new Date(Math.min(current.expires_at,appConsentDeadline(readable.data_consent_expires_at,readable.consent_lifetime))).toISOString()};
}
