import {appConsentDeadline} from '@deft/app-kit/core';
import {validateContinuationCarrier} from './app-connection-consent-continuation-fence.js';
import {validateStoredFormConnection} from './app-connection-form-fence.js';
import {and,eq,sql} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {effectiveObservationRepair} from './app-resource-observation-repair.js';
import {appConnectionSessions,appAttachmentStages} from '@deft/db/schema';
import {appResourceObservationConsents,appResourceObservationRuns} from '../../../../packages/db/src/resource-observation-schema.js';
import {ResourceObservationSnapshotSchema,type ResourceObservationSnapshot} from '../../../../packages/app-kit/src/resource-observation.js';
import {AppConnectionSessionRecordSchema,type AppConnectionSessionRecord} from './app-connection-session-service.js';
import {loadLiveAttachmentSyncBindingAuthority,type LiveAttachmentSyncBindingAuthority} from './app-attachment-sync-authority.js';
import {getAppConnectionSessionRegistry,type AppConnectionSessionRegistry} from './app-connection-session-registry.js';
import {digestAppGrantValue} from './app-grant-service.js';
import {AppError} from './app-errors.js';
import {isAppOwnerConnectionsEnabled} from './env.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';
import type {AppRunTransaction} from './app-run-repository.js';
import type {AppRunAuthorizationSnapshot} from '@deft/shared';

export function hasResourceObservationPin(raw:unknown,bindingId:string){
 const refs=(raw as {authority_refs?:unknown[]}|null)?.authority_refs;
 return Array.isArray(refs)&&refs.some(ref=>{const value=ref as {authority_kind?:string;authority_id?:string};
  return value?.authority_kind==='policy'&&value.authority_id!==bindingId;});
}

export function assertResourceObservationEnabled(){if(process.env.DEFT_APPS_ENABLED!=='true'||!isAppOwnerConnectionsEnabled())throw new AppError('Resource observation is disabled','APP_FEATURE_DISABLED',503);}
export const observationDenied=()=>new AppError('Resource observation access ended','APP_ACCESS_DENIED',403);
export async function observationPolicyDigest(authority:LiveAttachmentSyncBindingAuthority){
 const {buildAttachmentSyncAuthorizationSnapshot}=await import('./app-attachment-sync-run.js');
 return digestAppGrantValue(buildAttachmentSyncAuthorizationSnapshot(authority).authority_refs.filter(ref=>ref.authority_kind==='policy'));
}
/** The immutable session reference replaces mutable status revisions. The
 * runtime additionally fences actual custody generation in its Run journal. */
export async function loadObservationConnection(tx:AppRunTransaction,authority:LiveAttachmentSyncBindingAuthority,sessionId:string){
 assertResourceObservationEnabled();
 if(!await appConnectionUpgradeSourceIsAvailable(tx,{org_id:authority.binding.org_id,owner_user_id:authority.binding.owner_user_id,session_id:sessionId}))throw observationDenied();
 const {binding,registration,installation,version,grant}=authority;
 const [row]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,binding.org_id),
  eq(appConnectionSessions.owner_user_id,binding.owner_user_id),eq(appConnectionSessions.session_id,sessionId))).limit(1).for('share');
 if(!row)throw observationDenied();
 const record=AppConnectionSessionRecordSchema.parse(row.record),scope=record.scope;
 if(record.state!=='connected'||!record.account||!record.runtime_session_ref||scope.resource_binding_id!==binding.id
  ||scope.installation_id!==installation.id||scope.app_version_id!==version.id||scope.grant_snapshot_id!==grant.id
  ||scope.package_digest!==version.package_digest||scope.grant_snapshot_digest!==grant.snapshot_digest
  ||scope.lifecycle_epoch!==installation.lifecycle_epoch||scope.grant_epoch!==installation.grant_epoch
  ||scope.runtime_registration_id!==registration.id||scope.runtime_epoch!==registration.runtime_epoch
  ||scope.operator_user_id!==registration.operator_user_id||scope.target_key!==binding.target_key||scope.resource_key!==binding.resource_key
  ||scope.consent_expires_at!==(binding.consent_expires_at?.toISOString()??null)||scope.consent_lifetime!==(binding.consent_lifetime??undefined))throw observationDenied();
 const registry=await getAppConnectionSessionRegistry(tx);registry.assertReady(scope,record.profile);
 const connection_receipt=await resolveObservationConnectionReceipt(tx,record,registry);
 return {...record,connection_receipt};
}
/** Resolve retained custody proof without granting execution or reading payloads.
 * Current observation and historical closure share the same strict protocols. */
export async function resolveObservationConnectionReceipt(tx:AppRunTransaction,record:AppConnectionSessionRecord,registry:AppConnectionSessionRegistry){
 const {scope}=record;
 const form=await validateStoredFormConnection(tx,{org_id:scope.org_id,owner_user_id:scope.owner_user_id,session_id:record.session_id},record);
 const continuation=!form?await validateContinuationCarrier(tx,record,registry.protocol(scope,record.profile)==='credential_form.v1'):null;
 if(form&&registry.protocol(scope,record.profile)!=='credential_form.v1')throw observationDenied();
 return continuation??(form?.receipt?{custody_generation:form.receipt.custody_generation,receipt_digest:form.receipt.digest}:record.credential_repair?.receipt??record.upgrade?.receipt??record.reattachment?.receipt);
}
export async function observationSnapshotIsCurrent(tx:AppRunTransaction,snapshot:ResourceObservationSnapshot,
 authority:LiveAttachmentSyncBindingAuthority,clock:()=>Date){
 if(!Number.isFinite(clock().getTime())||appConsentDeadline(snapshot.expires_at,snapshot.consent_lifetime)<=clock().getTime()
  ||snapshot.scope.org_id!==authority.binding.org_id||snapshot.scope.owner_user_id!==authority.binding.owner_user_id
  ||snapshot.scope.resource_binding_id!==authority.binding.id||snapshot.interval_seconds<authority.binding.min_interval_seconds
  ||snapshot.resource_policy_digest!==await observationPolicyDigest(authority))throw observationDenied();
 await assertObservationMetadataCatalogAbsent(tx,authority.binding.org_id,authority.binding.id);
 const effective=await repairObservationSnapshot(tx,snapshot);
 const record=await loadObservationConnection(tx,authority,effective.connection.session_id);
 const receipt=effective.connection.session_id===snapshot.connection.session_id&&!isDeepStrictEqual(effective.connection,snapshot.connection)
  ?{custody_generation:effective.connection.expected_custody_generation,receipt_digest:effective.connection.receipt_digest}:record.connection_receipt;
 snapshot=effective;
 if(!isDeepStrictEqual(record.scope,snapshot.scope)||record.runtime_session_ref!==snapshot.connection.runtime_session_ref
  ||record.account!.account_ref!==snapshot.connection.account_ref
  ||snapshot.connection.expected_custody_generation!==(receipt?.custody_generation??null)
  ||snapshot.connection.receipt_digest!==(receipt?.receipt_digest??null))throw observationDenied();
 return record;
}
export async function repairObservationSnapshot(tx:AppRunTransaction,snapshot:ResourceObservationSnapshot,runId?:string){
 const rows=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,snapshot.scope.org_id),
  eq(appConnectionSessions.owner_user_id,snapshot.scope.owner_user_id),
  sql`${appConnectionSessions.record}->'credential_repair'->>'reservation_closed' = 'true'`))
  .orderBy(appConnectionSessions.created_at,appConnectionSessions.session_id).for('share');
 try{return effectiveObservationRepair(snapshot,rows.map(row=>AppConnectionSessionRecordSchema.parse(row.record)),runId);}
 catch{throw observationDenied();}
}
export async function activeResourceObservation(tx:AppRunTransaction,authority:LiveAttachmentSyncBindingAuthority,clock:()=>Date){
 const rows=await tx.select().from(appResourceObservationConsents).where(and(eq(appResourceObservationConsents.org_id,authority.binding.org_id),
  eq(appResourceObservationConsents.resource_binding_id,authority.binding.id),eq(appResourceObservationConsents.state,'active'))).limit(2).for('share');
 if(rows.length!==1)return null;
 const row=rows[0]!,snapshot=ResourceObservationSnapshotSchema.parse(row.snapshot);
 if(row.consent_digest!==digestAppGrantValue(snapshot)||row.owner_user_id!==authority.binding.owner_user_id)throw observationDenied();
 await observationSnapshotIsCurrent(tx,snapshot,authority,clock);
 return {row,snapshot:await repairObservationSnapshot(tx,snapshot)};
}
export function observedResourceAuthorization(base:AppRunAuthorizationSnapshot,consent:{consent_id:string;consent_digest:string}){
 return {...base,authority_refs:[...base.authority_refs,{authority_kind:'policy' as const,authority_id:consent.consent_id,version:consent.consent_digest}]};
}
/** No link means an unchanged manually admitted/legacy Run. A linked Run must
 * retain its exact consent even if another consent later becomes active. */
export async function currentResourceObservationRun(tx:AppRunTransaction,orgId:string,runId:string,
 authority:LiveAttachmentSyncBindingAuthority,clock:()=>Date,purpose:'effect'|'predecessor_read'='effect'){
 const [link]=await tx.select().from(appResourceObservationRuns).where(and(eq(appResourceObservationRuns.org_id,orgId),eq(appResourceObservationRuns.run_id,runId))).limit(1);
 if(!link)return null;
 const [row]=await tx.select().from(appResourceObservationConsents).where(and(eq(appResourceObservationConsents.org_id,orgId),
  eq(appResourceObservationConsents.consent_id,link.consent_id))).limit(1).for('share');
 if(!row||row.state!=='active'||row.consent_digest!==link.consent_digest||row.resource_binding_id!==authority.binding.id
  ||row.owner_user_id!==authority.binding.owner_user_id)throw observationDenied();
 const snapshot=ResourceObservationSnapshotSchema.parse(row.snapshot);
 if(row.consent_digest!==digestAppGrantValue(snapshot))throw observationDenied();
 await observationSnapshotIsCurrent(tx,snapshot,authority,clock);
 return {row,snapshot:await repairObservationSnapshot(tx,snapshot,purpose==='effect'?runId:undefined)};
}
export async function resourceObservationBindingAuthority(tx:AppRunTransaction,orgId:string,bindingId:string,clock:()=>Date){
 const authority=await loadLiveAttachmentSyncBindingAuthority(tx,{org_id:orgId,resource_binding_id:bindingId,clock});
 if(!authority||!authority.registration.owner_connection_admission_id)throw observationDenied();
 return authority;
}

/** An observation pin without its immutable link cannot fall back to a manual Run. */
export async function requireCurrentResourceObservationRun(tx:AppRunTransaction,orgId:string,runId:string,authority:LiveAttachmentSyncBindingAuthority,clock:()=>Date,purpose:'effect'|'predecessor_read'='effect'){
 const current=await currentResourceObservationRun(tx,orgId,runId,authority,clock,purpose);
 if(!current)throw observationDenied();return current;
}

/** Existing host attachment catalog stays outside scalar-only observation. */
export async function assertObservationMetadataCatalogAbsent(tx:AppRunTransaction,orgId:string,bindingId:string){
 const [catalog]=await tx.select({id:appAttachmentStages.id}).from(appAttachmentStages).where(and(eq(appAttachmentStages.org_id,orgId),
  eq(appAttachmentStages.resource_binding_id,bindingId),sql`${appAttachmentStages.state} IN ('linked','linked_blocked')`)).limit(1);
 if(catalog)throw observationDenied();
}
