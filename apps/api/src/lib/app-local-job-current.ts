import {and,eq} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {AppDataConsentSnapshotSchema,parseAttachmentAppManifest} from '@deft/app-kit';
import {appDataConsents,appVersions,appGrantSnapshots} from '@deft/db/schema';
import {AppError} from './app-errors.js';
import {appDataDigest} from './app-data-authority.js';
import {resourceObservationBindingAuthority,loadObservationConnection} from './app-resource-observation-authority.js';
import type {AppRunTransaction} from './app-run-repository.js';
import type {AppLocalJobSnapshot} from '../../../../packages/app-kit/src/local-job.js';
import type {AppConnectionSessionScope} from '@deft/app-kit';
export const localJobDenied=()=>new AppError('Local job authority ended','APP_ACCESS_DENIED',403);
/** Reuses only the live resource/connected-account readers. Observation
 * consent, channel credential, human SID and effect grants are not reused. */
export async function currentLocalJobConnection(tx:AppRunTransaction,scope:AppConnectionSessionScope,pins:{session_id:string;runtime_session_ref:string;account_ref:string},clock=()=>new Date()){
 const authority=await resourceObservationBindingAuthority(tx,scope.org_id,scope.resource_binding_id,clock),connection=await loadObservationConnection(tx,authority,pins.session_id);
 if(!isDeepStrictEqual(connection.scope,scope)||connection.runtime_session_ref!==pins.runtime_session_ref||connection.account!.account_ref!==pins.account_ref)throw localJobDenied();return connection;
}
export async function currentLocalJobSchedule(tx:AppRunTransaction,snapshot:AppLocalJobSnapshot,clock=()=>new Date()){
 const connection=await currentLocalJobConnection(tx,snapshot.scope,snapshot.connection,clock),receipt=connection.connection_receipt??connection.credential_repair?.receipt??connection.upgrade?.receipt??connection.reattachment?.receipt;
 if(receipt&&receipt.custody_generation!==snapshot.job.custody_generation)throw localJobDenied();
 if(!isDeepStrictEqual(connection.scope,snapshot.scope)||connection.runtime_session_ref!==snapshot.connection.runtime_session_ref||connection.account!.account_ref!==snapshot.connection.account_ref
  ||receipt&&receipt.custody_generation!==snapshot.job.custody_generation)throw localJobDenied();
 const [version]=await tx.select().from(appVersions).where(and(eq(appVersions.org_id,snapshot.scope.org_id),eq(appVersions.id,snapshot.scope.app_version_id))).limit(1);
 const [grant]=await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id,snapshot.scope.org_id),eq(appGrantSnapshots.id,snapshot.scope.grant_snapshot_id))).limit(1);
 if(!version||!grant)throw localJobDenied();const stores=parseAttachmentAppManifest(version.manifest).record_stores??[];
 if(!isDeepStrictEqual(stores,(grant.canonical_snapshot as {record_stores?:unknown}).record_stores??[]))throw localJobDenied();
 const store=stores.find(row=>row.key===snapshot.store_key),policy=parseAttachmentAppManifest(version.manifest).owner_connections?.find(row=>row.resource_key===snapshot.scope.resource_key&&row.provider_profile_key===connection.profile.key&&row.runtime_requirement_key===connection.profile.runtime_requirement_key);
 if(!store||!policy||store.resource_key!==snapshot.scope.resource_key||store.runtime_requirement_key!==connection.profile.runtime_requirement_key
  ||!store.local_job_operations?.some(row=>row.key===snapshot.operation_key&&row.local_only===true)||appDataDigest(store)!==snapshot.record_authority.data_policy_digest)throw localJobDenied();
 const rows=await tx.select().from(appDataConsents).where(and(eq(appDataConsents.org_id,snapshot.scope.org_id),eq(appDataConsents.owner_user_id,snapshot.scope.owner_user_id),eq(appDataConsents.consent_id,snapshot.record_authority.consent_id),eq(appDataConsents.state,'active'))).limit(2).for('share');
 if(rows.length!==1)throw localJobDenied();const row=rows[0]!,proof=AppDataConsentSnapshotSchema.parse(row.snapshot),now=clock().getTime();
 if(!Number.isFinite(now)||row.consent_digest!==snapshot.record_authority.consent_digest||appDataDigest(proof)!==row.consent_digest||row.expires_at.getTime()<=now
  ||row.expires_at.toISOString()!==snapshot.record_authority.consent_expires_at||!isDeepStrictEqual(proof.scope,snapshot.scope)||!isDeepStrictEqual(proof.store,store)
  ||proof.connection.session_id!==snapshot.connection.session_id||proof.connection.runtime_session_ref!==snapshot.connection.runtime_session_ref||proof.connection.account_ref!==snapshot.connection.account_ref
  ||row.expires_at.getTime()>row.created_at.getTime()+policy.max_consent_seconds*1000||Date.parse(snapshot.job.expires_at)>Math.min(row.expires_at.getTime(),Date.parse(snapshot.scope.consent_expires_at))||Date.parse(snapshot.job.expires_at)<=now)throw localJobDenied();
 return Math.min(row.expires_at.getTime(),Date.parse(snapshot.scope.consent_expires_at),Date.parse(snapshot.job.expires_at));
}
