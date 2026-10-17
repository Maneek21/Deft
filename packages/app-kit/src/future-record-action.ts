import {z} from 'zod';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).refine(v=>!['constructor','prototype','__proto__'].includes(v));
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u),id=z.string().uuid();
const instant=z.iso.datetime(),revision=z.number().int().min(1).max(2147483646);
export const AppFutureMissedPolicySchema=z.enum(['send_when_available','pause_if_late']);
export const AppFutureRecordActionDeclarationSchema=z.strictObject({
 schema_version:z.literal('deft.app_future_record_action.v1'),action_key:key,
 max_undo_delay_seconds:z.number().int().min(0).max(120),
 max_schedule_horizon_seconds:z.number().int().min(0).max(2*366*86400),
 max_dispatch_lifetime_seconds:z.number().int().min(1).max(300),
 missed_policies:z.array(AppFutureMissedPolicySchema).min(1).max(2).refine(rows=>new Set(rows).size===rows.length),
});
export const AppFutureRecordActionDeclarationsSchema=z.array(AppFutureRecordActionDeclarationSchema).min(1).max(8)
 .refine(rows=>new Set(rows.map(row=>row.action_key)).size===rows.length&&rows.every((row,i)=>i===0||rows[i-1]!.action_key<row.action_key));
export const AppFutureScheduleInputSchema=z.strictObject({
 wall_time:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u),zone:z.string().min(1).max(128),
 ambiguity:z.enum(['earlier','later','reject']),missed_policy:AppFutureMissedPolicySchema,
});
export const AppFutureExecutionWindowSchema=z.strictObject({
 undo_delay_seconds:z.number().int().min(0).max(120),schedule:AppFutureScheduleInputSchema.nullable(),dispatch_expires_at:instant,
}).refine(row=>row.undo_delay_seconds>0||row.schedule!==null,'Future execution requires a reviewed delay or schedule');
export const AppPreparedFutureReleaseSchema=z.strictObject({
 schema_version:z.literal('deft.app_prepared_future_release.v1'),policy_digest:digest,
 execution_window:AppFutureExecutionWindowSchema,
 schedule:AppFutureScheduleInputSchema.extend({instant,rules_version:z.string().min(1).max(256)}).nullable(),
 authority_expires_at:instant,max_dispatch_lifetime_seconds:z.number().int().min(1).max(300),
}).refine(row=>Date.parse(row.execution_window.dispatch_expires_at)<=Date.parse(row.authority_expires_at)
 &&(row.execution_window.schedule===null?row.schedule===null:row.schedule!==null
 &&row.execution_window.schedule.wall_time===row.schedule.wall_time
 &&row.execution_window.schedule.ambiguity===row.schedule.ambiguity
 &&row.execution_window.schedule.missed_policy===row.schedule.missed_policy
 &&Date.parse(row.schedule.instant)<Date.parse(row.execution_window.dispatch_expires_at)));
export const AppFutureRecordActionStatusSchema=z.strictObject({
 schema_version:z.literal('deft.app_future_record_action_status.v1'),release_id:id,request_id:id,run_id:id,revision,
 state:z.enum(['pending_local_commit','queued','paused','dispatching','accepted','unknown','cancelled','expired']),
 not_before:instant,undo_until:instant,dispatch_expires_at:instant,authority_expires_at:instant,
 pause_reason:z.enum(['authority_changed','missed_time','runtime_unavailable','local_conflict']).nullable(),
 local_state:z.enum(['pending','committed','restore_pending','restored','conflict']),
 local_record:z.strictObject({record_id:id,revision,content_digest:digest,status:z.enum(['draft','submitted'])}).nullable(),
}).refine(row=>Date.parse(row.undo_until)<=Date.parse(row.not_before)
 &&Date.parse(row.not_before)<Date.parse(row.dispatch_expires_at)
 &&Date.parse(row.dispatch_expires_at)<=Date.parse(row.authority_expires_at)
 &&(row.pause_reason===null||row.state==='paused'));
export const AppFutureRecordActionLookupSchema=z.strictObject({request_id:id,run_id:id.optional()});
export const AppFutureRecordActionCancelSchema=z.strictObject({request_id:id,run_id:id,expected_revision:revision});
/** Host-only local preparation lifecycle. These references convey no provider
 * plan or dispatch authority and require an online exact release-row check. */
export const AppPreparedActionLifecycleInputSchema=z.strictObject({store_key:key,record_id:id,
 release_id:id,run_id:id,original_request_id:id,snapshot_id:id,snapshot_digest:digest,
 expected_revision:revision,expected_content_digest:digest});
export const AppPreparedActionLifecycleReceiptSchema=z.strictObject({
 schema_version:z.literal('deft.app_prepared_action_lifecycle_receipt.v1'),request_id:id,
 release_id:id,run_id:id,original_request_id:id,snapshot_id:id,snapshot_digest:digest,
 phase:z.enum(['commit','restore']),outcome:z.enum(['completed','conflict','indeterminate']),
 record:z.strictObject({record_id:id,revision,content_digest:digest,status:z.enum(['draft','submitted'])}).nullable(),
}).refine(row=>row.outcome!=='completed'||row.record!==null);
export type AppFutureExecutionWindow=z.infer<typeof AppFutureExecutionWindowSchema>;
export type AppPreparedFutureRelease=z.infer<typeof AppPreparedFutureReleaseSchema>;
export type AppFutureRecordActionStatus=z.infer<typeof AppFutureRecordActionStatusSchema>;
export type AppFutureRecordActionDeclaration=z.infer<typeof AppFutureRecordActionDeclarationSchema>;
