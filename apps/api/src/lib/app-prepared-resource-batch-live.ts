import {sql} from 'drizzle-orm';
import {samplePrivateAccessClock} from './app-private-access-clock.js';
import type {AppRunSafeView,AppRunTransaction} from './app-run-repository.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {knownPreparedResourceBatchReceipt} from './app-prepared-resource-batch-receipt.js';
/** Approval may atomically queue the complete exact group. Queue membership is
 * not claim/effect authority: those phases require every predecessor receipt. */
export async function preparedResourceBatchReleaseIsCurrent(tx:AppRunTransaction,run:AppRunSafeView,approvalPhase=false){
 const clock=await samplePrivateAccessClock(tx,()=>new Date()),now=clock.current();
 const current=await tx.execute(sql<{batch_id:string;ordinal:number;operation_key:string;expected_child_count:number;execution_expires_at:Date;valid:boolean}>`SELECT b.id AS batch_id,i.ordinal,b.operation_key,b.expected_child_count,b.execution_expires_at,
 b.release_mode='prepared_resource_sequential' AND b.state='approved' AND b.cancelled_at IS NULL AND b.approved_at IS NOT NULL AND b.approved_at<=b.review_expires_at AND b.execution_expires_at>${now} AND b.source='defty' AND b.employee_id IS NULL AND b.token_id IS NULL
 AND g.revoked_at IS NULL AND g.epoch=b.consent_epoch AND g.owner_user_id=b.owner_user_id AND g.app_installation_id=r.origin_app_installation_id AND g.app_version_id=r.origin_app_version_id
 AND r.origin_runtime_binding_id=b.runtime_binding_id AND binding.action_key=b.action_key AND binding.operation_name=r.operation_name AND r.execution_actor_type='human' AND r.execution_actor_id=b.owner_user_id
 AND b.expected_child_count BETWEEN 1 AND 4 AND (SELECT count(*) FROM app_action_batch_items child WHERE child.org_id=b.org_id AND child.batch_id=b.id)=b.expected_child_count
 AND (SELECT min(ordinal) FROM app_action_batch_items child WHERE child.org_id=b.org_id AND child.batch_id=b.id)=0
 AND (SELECT max(ordinal) FROM app_action_batch_items child WHERE child.org_id=b.org_id AND child.batch_id=b.id)=b.expected_child_count-1 AS valid
 FROM app_action_batch_items i JOIN app_action_batches b ON b.org_id=i.org_id AND b.id=i.batch_id JOIN app_runs r ON r.org_id=i.org_id AND r.id=i.run_id JOIN app_runtime_bindings binding ON binding.org_id=r.org_id AND binding.id=r.origin_runtime_binding_id JOIN app_experience_consent_grants g ON g.org_id=b.org_id AND g.id=b.consent_grant_id
 WHERE i.org_id=${run.org_id} AND i.run_id=${run.id} FOR SHARE OF b,g`);
 const membership=current.rows[0] as {batch_id:string;ordinal:number;operation_key:string;expected_child_count:number;execution_expires_at:Date;valid:boolean}|undefined;if(membership?.valid!==true)return false;
 // The existing human approval transaction validates the entire aggregate and
 // every original ticket. Effects cannot run in pending_approval state.
 if(approvalPhase&&run.state==='pending_approval')return true;
 const previous=await tx.execute(sql<{run_id:string;state:string;source_refs:unknown;attempt_id:string;attempt_state:string;safe_outcome:Record<string,unknown>|null;runtime_result_hmac:string|null;provider_call_finished_at:Date|null}>`SELECT i.run_id,r.state,i.source_refs,a.id AS attempt_id,a.state AS attempt_state,a.safe_outcome,a.runtime_result_hmac,a.provider_call_finished_at
 FROM app_action_batch_items i JOIN app_runs r ON r.org_id=i.org_id AND r.id=i.run_id LEFT JOIN LATERAL (SELECT * FROM app_run_attempts a WHERE a.org_id=r.org_id AND a.run_id=r.id ORDER BY a.attempt_number DESC LIMIT 1) a ON true
 WHERE i.org_id=${run.org_id} AND i.batch_id=${membership.batch_id} AND i.ordinal<${membership.ordinal} ORDER BY i.ordinal FOR SHARE OF r`);
 if(previous.rows.length!==membership.ordinal)return false;
 const runtime=await getAppRunRuntime();for(const child of previous.rows as {run_id:string;state:string;source_refs:unknown;attempt_id:string;attempt_state:string;safe_outcome:Record<string,unknown>|null;runtime_result_hmac:string|null;provider_call_finished_at:Date|null}[]){if(!['succeeded','failed'].includes(child.state)||child.attempt_state!==child.state||!child.attempt_id||!child.runtime_result_hmac||!child.provider_call_finished_at||child.safe_outcome?.result_status!=='retained')return false;const retained=await runtime.secretRepository.readRetainedOutput(run.org_id,child.run_id,child.attempt_id,clock.current,tx);if(!retained||retained.expires_at<=now)return false;const value=retained.value as {schema_version?:unknown;output?:unknown};if(value?.schema_version!=='deft.app_run_provider_result.v1'||!knownPreparedResourceBatchReceipt(value.output,child.run_id,membership.operation_key,child.source_refs))return false;}
 return new Date(membership.execution_expires_at).getTime()>clock.current().getTime();
}
