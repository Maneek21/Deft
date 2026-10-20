import {sql} from 'drizzle-orm';
import {AppPreparedActionLifecycleInputSchema,AppPreparedActionLifecycleReceiptSchema,type AppDataPreparedRecordAction} from '@deft/app-kit/core';
import type {AppRunTransaction} from './app-run-repository.js';
import {PostgresFutureRecordActionStore,type FutureReleaseRow} from './app-future-record-action-store.js';
import {appDataDenied,appDataDigest,type CurrentAppDataAuthority} from './app-data-authority.js';
import {currentFutureRecordActionAuthority} from './app-future-record-action-authority.js';
const source=(row:FutureReleaseRow)=>row.prepared as unknown as Omit<AppDataPreparedRecordAction,'preview'|'input'>&{record_content_digest:string};
export function futureRecordActionLocalInput(row:FutureReleaseRow,phase:'commit'|'restore'){
 const prepared=source(row),frozen=row.local_receipt?.record as {revision:number}|undefined;
 return AppPreparedActionLifecycleInputSchema.parse({store_key:row.reviewed_authority.store_key,record_id:prepared.record_id,
  release_id:row.release_id,run_id:row.run_id,original_request_id:row.request_id,snapshot_id:prepared.snapshot_id,snapshot_digest:prepared.snapshot_digest,
  expected_revision:phase==='restore'?(frozen?.revision??prepared.revision+1):prepared.revision,expected_content_digest:prepared.record_content_digest});
}
export async function assertFutureRecordActionLocalRequest(tx:AppRunTransaction,current:CurrentAppDataAuthority,
 requestId:string,operation:string,raw:unknown){
 const input=AppPreparedActionLifecycleInputSchema.parse(raw),row=await new PostgresFutureRecordActionStore().lock(tx,current.scope.org_id,input.run_id);
 const phase=operation==='prepared_action_commit'?'commit':'restore';
 if(!row||row.owner_user_id!==current.scope.owner_user_id||appDataDigest(raw)!==appDataDigest(futureRecordActionLocalInput(row,phase))
 ||requestId!==(phase==='commit'?row.freeze_request_id:row.restore_request_id)
 ||phase==='commit'&&(row.state!=='pending_local_commit'||row.local_state!=='pending')
 ||phase==='restore'&&(row.state!=='cancelled'||row.local_state!=='restore_pending')
 ||phase==='commit'&&(appDataDigest(current.scope)!==appDataDigest(row.reviewed_authority.scope)||current.connection.runtime_session_ref!==(row.reviewed_authority.connection as {runtime_session_ref:string}).runtime_session_ref)
 ||phase==='restore'&&['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','target_key','resource_key','resource_binding_id'].some(key=>(current.scope as unknown as Record<string,unknown>)[key]!== (row.reviewed_authority.scope as Record<string,unknown>)[key])
 ||current.connection.account_ref!==(row.reviewed_authority.connection as {account_ref:string}).account_ref)throw appDataDenied();
 if(phase==='commit')await currentFutureRecordActionAuthority(tx,row.reviewed_authority);
 return row;
}
/** A lost local response can supply this exact durable receipt through the
 * original phase request's read-only status. This never repeats a mutation. */
export async function acknowledgeFutureRecordActionLocal(tx:AppRunTransaction,org:string,owner:string,raw:unknown){
 const receipt=AppPreparedActionLifecycleReceiptSchema.parse(raw),store=new PostgresFutureRecordActionStore();
 const row=await store.lock(tx,org,receipt.run_id);if(!row||row.owner_user_id!==owner)throw appDataDenied();
 const expected=futureRecordActionLocalInput(row,receipt.phase),request=receipt.phase==='commit'?row.freeze_request_id:row.restore_request_id;
 if(receipt.request_id!==request||receipt.release_id!==row.release_id||receipt.original_request_id!==row.request_id
 ||receipt.snapshot_id!==expected.snapshot_id||receipt.snapshot_digest!==expected.snapshot_digest
 ||receipt.record&&(receipt.record.record_id!==expected.record_id||receipt.record.content_digest!==expected.expected_content_digest))throw appDataDenied();
 if(row.local_receipt&&appDataDigest(row.local_receipt)===appDataDigest(receipt))return row;
 if(receipt.outcome==='indeterminate')return row;
 if(receipt.phase==='commit'){
  if(row.state!=='pending_local_commit'||row.local_state!=='pending')return row;
  if(receipt.outcome==='completed'&&(receipt.record?.status!=='submitted'||receipt.record.revision!==expected.expected_revision+1))throw appDataDenied();
  const completed=receipt.outcome==='completed';
  await tx.execute(sql`UPDATE app_future_record_action_releases SET state=${completed?'queued':'paused'},local_state=${completed?'committed':'conflict'},local_receipt=${JSON.stringify(receipt)}::jsonb,pause_reason=${completed?null:'local_conflict'},revision=revision+1,updated_at=clock_timestamp() WHERE org_id=${org} AND release_id=${row.release_id} AND revision=${row.revision}`);
 }else{
  if(row.state!=='cancelled'||row.local_state!=='restore_pending')return row;
  if(receipt.outcome==='completed'&&(receipt.record?.status!=='draft'||receipt.record.revision!==expected.expected_revision+1))throw appDataDenied();
  await tx.execute(sql`UPDATE app_future_record_action_releases SET local_state=${receipt.outcome==='completed'?'restored':'conflict'},local_receipt=${JSON.stringify(receipt)}::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE org_id=${org} AND release_id=${row.release_id} AND revision=${row.revision}`);
 }
 const updated=(await store.lock(tx,org,receipt.run_id))!;
 if(updated.state==='queued'&&updated.local_state==='committed'){
  const {getAppRunRuntime}=await import('./app-run-runtime.js'),runtime=await getAppRunRuntime();
  const run=await runtime.repository.lockRun(tx,org,receipt.run_id);if(run)await runtime.attemptRunner.scheduleInTransaction(tx,run,new Date());
 }
 return updated;
}
