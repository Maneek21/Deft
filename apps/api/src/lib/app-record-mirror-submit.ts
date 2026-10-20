import {discloseRecordMirrorRead} from './app-record-mirror-read-deadline.js';
import {assertPreparedRecordCleanupSource} from './app-prepared-record-action-receipt.js';
import {z} from 'zod';
import {and,eq,sql} from 'drizzle-orm';
import {appRuns} from '@deft/db/schema';
import {safeRunSelection} from './app-run-repository.js';
import {AppPreparedMirrorInputSchema, type AppConnectionSessionScope} from '@deft/app-kit/core';
import type {AppRunSafeView,AppRunTransaction} from './app-run-repository.js';
import {appDataDenied,appDataDigest} from './app-data-authority.js';
import {PostgresRecordMirrorStore} from './app-record-mirror-store.js';
import {currentRecordMirrorAuthority,currentRecordMirrorReadAuthority} from './app-record-mirror-authority.js';
import {releaseRecordMirrorRun} from './app-record-mirror-run.js';

/** Internal authenticated Runtime intake. Caller scope comes exclusively from
 * the selected registration's credential, never from the submitted object.
 * The caller must verify its immutable private snapshot before entering here. */
export async function submitRecordMirrorRun(tx:AppRunTransaction,scope:AppConnectionSessionScope,requestId:string,raw:unknown,clock=()=>new Date()):Promise<{run:AppRunSafeView;recovered:boolean}>{
 const request=z.string().uuid().parse(requestId),input=AppPreparedMirrorInputSchema.parse(raw);
 const runtime=await (await import('./app-run-runtime.js')).getAppRunRuntime(),store=new PostgresRecordMirrorStore();
 const prior=await tx.execute(sql`SELECT m.run_id,m.input_digest,a.reviewed_authority FROM app_record_mirror_runs m JOIN app_record_mirror_authorities a ON a.org_id=m.org_id AND a.receipt_id=m.receipt_id WHERE m.org_id=${scope.org_id} AND a.owner_user_id=${scope.owner_user_id} AND a.receipt_id=${input.mirror_receipt_id} AND m.request_id=${request}`);
 const previous=prior.rows[0];
 if(previous){
  const readable=await currentRecordMirrorReadAuthority(tx,previous.reviewed_authority,clock);if(appDataDigest(readable.scope)!==appDataDigest(scope))throw appDataDenied();
  const previousRunId=previous.run_id;if(previous.input_digest!==appDataDigest(input)||typeof previousRunId!=='string')throw appDataDenied();
  return discloseRecordMirrorRead(readable,async()=>{
  const [run]=await tx.select(safeRunSelection).from(appRuns).where(and(eq(appRuns.org_id,scope.org_id),eq(appRuns.id,previousRunId)));if(!run||run.initiating_actor_id!==scope.owner_user_id||run.operation_name!==readable.policy.action_key)throw appDataDenied();
  // Status only. No re-release, new budget debit, preparation or scheduling.
  return {run,recovered:true};
  },clock);
 }
 const row=await store.read(tx,scope.org_id,scope.owner_user_id,input.mirror_receipt_id,true);
 if(!row||row.state!=='enabled'||row.revision!==input.mirror_receipt_revision||row.policy_digest!==input.mirror_policy_digest||row.store_key!==input.record_store_key)throw appDataDenied();
 // Recheck after acquiring the authority lock: a concurrent original UUID may
 // have committed while this transaction waited.
 const committed=await tx.execute(sql`SELECT 1 FROM app_record_mirror_runs WHERE org_id=${scope.org_id} AND receipt_id=${row.receipt_id} AND request_id=${request}`);
 if(committed.rows[0])return submitRecordMirrorRun(tx,scope,request,input,clock);
 const guard=async()=>{
  const pins=await currentRecordMirrorAuthority(tx,row.reviewed_authority);
  if(appDataDigest(pins.scope)!==appDataDigest(scope)||pins.policy_digest!==row.policy_digest||row.authority_digest!==appDataDigest(pins)||row.expires_at<=new Date())throw appDataDenied();
  if(input.mirror_operation==='delete')await assertPreparedRecordCleanupSource(tx,pins,input);
  return pins;
 };
 const pins=await guard();if(await store.remaining(tx,row,new Date())<1)throw appDataDenied();
 const expiry=new Date(Math.min(Date.now()+300000,row.expires_at.getTime()));
 const run=await runtime.service.submitReviewedRuntime({org_id:scope.org_id,user_id:scope.owner_user_id},{runtime_binding_id:pins.action_consents[0]!.action_binding_id,input,idempotency_key:`record-mirror:${row.receipt_id}:${request}`},undefined,async()=>{await guard();},tx,expiry);
 if(run.state!=='pending_approval'||run.execution_release_kind)throw appDataDenied();
 const internal=await tx.execute(sql`SELECT input_fingerprint FROM app_runs WHERE org_id=${scope.org_id} AND id=${run.id}`),fingerprint=internal.rows[0]?.input_fingerprint;
 if(typeof fingerprint!=='string')throw appDataDenied();
 await store.reserve(tx,row,{request_id:request,run_id:run.id,input_digest:appDataDigest(input),run_input_fingerprint:fingerprint,input,record_id:input.record_id,record_revision:input.record_revision,snapshot_digest:input.snapshot_digest,operation:input.mirror_operation},new Date());
 await guard();return {run:await releaseRecordMirrorRun(tx,run,row.receipt_id),recovered:false};
}
