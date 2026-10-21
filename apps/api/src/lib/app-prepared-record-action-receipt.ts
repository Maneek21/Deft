import {sql} from 'drizzle-orm';
import type {AppDataPreparedRecordAction} from '@deft/app-kit/core';
import type {AppRunTransaction} from './app-run-repository.js';
import type {ExperienceCaller} from './app-experience-service.js';
import {appDataDenied,appDataDigest,type CurrentAppDataAuthority} from './app-data-authority.js';
import type {AppPreparedMirrorInput} from '@deft/app-kit/core';
import type {ReviewedRecordMirrorAuthority} from './app-record-mirror-authority.js';

import {preparedRecordCleanupMatches} from './app-prepared-record-cleanup-match.js';
export {preparedRecordCleanupMatches} from './app-prepared-record-cleanup-match.js';

export async function assertPreparedRecordCleanupSource(tx:AppRunTransaction,pins:ReviewedRecordMirrorAuthority,input:AppPreparedMirrorInput){
 const result=await tx.execute(sql`SELECT p.receipt,p.receipt_digest,r.state,r.safe_outcome,r.initiating_actor_type,r.initiating_actor_id,r.provider_kind,r.origin_kind,r.operation_name,r.input_fingerprint,r.origin_app_installation_id,r.origin_app_version_id,r.origin_app_grant_snapshot_id FROM app_prepared_record_action_receipts p JOIN app_runs r ON r.org_id=p.org_id AND r.id=p.run_id WHERE p.org_id=${pins.scope.org_id} AND p.run_id=${input.accepted_submission_id} AND p.owner_user_id=${pins.scope.owner_user_id} AND p.expires_at>clock_timestamp() FOR SHARE OF p,r`),row=result.rows[0];
 if(!row||!row.receipt||typeof row.receipt!=='object'||appDataDigest(row.receipt)!==row.receipt_digest||!preparedRecordCleanupMatches(pins,input,row.receipt as Record<string,unknown>,row))throw appDataDenied();
}

/** Metadata custody only. This grants no provider or cancellation authority.
 * The native immutable preparation supplies the content digest explicitly;
 * an older preparation without it cannot authorize mirror cleanup. */
export async function retainPreparedRecordActionReceipt(tx:AppRunTransaction,caller:ExperienceCaller,runId:string,authority:CurrentAppDataAuthority,prepared:AppDataPreparedRecordAction){
 if(!prepared.record_content_digest||!authority.store.record_mirrors?.some(policy=>policy.cleanup_action_keys?.includes(prepared.action_key)))return;
 const result=await tx.execute(sql`SELECT origin_app_installation_id,origin_app_version_id,origin_app_grant_snapshot_id,initiating_actor_id,operation_name,input_fingerprint,result_expires_at FROM app_runs WHERE org_id=${caller.org_id} AND id=${runId} AND provider_kind='app_runtime' AND origin_kind='app' AND initiating_actor_type='human' FOR SHARE`),run=result.rows[0];
 if(!run||run.initiating_actor_id!==caller.user_id||run.origin_app_installation_id!==authority.scope.installation_id||run.origin_app_version_id!==authority.scope.app_version_id||run.origin_app_grant_snapshot_id!==authority.scope.grant_snapshot_id||run.operation_name!==prepared.action_key||typeof run.input_fingerprint!=='string')throw appDataDenied();
 const value={schema_version:'deft.prepared_record_action_receipt.v1',scope:authority.scope,store_key:authority.store.key,record_id:prepared.record_id,record_revision:prepared.revision,content_digest:prepared.record_content_digest,snapshot_id:prepared.snapshot_id,snapshot_digest:prepared.snapshot_digest,account_ref:authority.connection.account_ref,connection:authority.connection,action_key:prepared.action_key,run_input_fingerprint:run.input_fingerprint};
 const digest=appDataDigest(value);
 await tx.execute(sql`INSERT INTO app_prepared_record_action_receipts(org_id,run_id,owner_user_id,receipt,receipt_digest,expires_at) VALUES(${caller.org_id},${runId},${caller.user_id},${JSON.stringify(value)}::jsonb,${digest},${run.result_expires_at}) ON CONFLICT(org_id,run_id) DO NOTHING`);
 const retained=await tx.execute(sql`SELECT receipt_digest FROM app_prepared_record_action_receipts WHERE org_id=${caller.org_id} AND run_id=${runId} FOR SHARE`);if(retained.rows[0]?.receipt_digest!==digest)throw appDataDenied();
}
