import {z} from 'zod';
const id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const digest=z.string().regex(/^[a-f0-9]{64}$/u);
export const NativeEmailDraftSyncPlanSchema=z.strictObject({schema_version:z.literal('deft.email_draft_sync_plan.v1'),operation_id:z.string().uuid(),scope:z.strictObject({org_id:id,owner_user_id:id,account_id:id}),provider:z.literal('microsoft'),provider_draft_ref:id,binding_digest:digest,baseline_digest:digest,baseline_version:id,desired_digest:digest,initial_content_digest:digest,desired_content_digest:digest,digest,
 steps:z.array(z.strictObject({step_id:digest,kind:z.enum(['patch','delete_attachment','add_attachment']),after_content_digest:digest,target_id:id.optional(),desired_index:z.number().int().min(0).max(31).optional()})).max(65)}).superRefine((value,ctx)=>{
 if(new Set(value.steps.map(step=>step.step_id)).size!==value.steps.length||value.steps.filter(step=>step.kind==='patch').length>1||value.steps.filter(step=>step.kind==='delete_attachment').length>32||value.steps.filter(step=>step.kind==='add_attachment').length>32||value.steps.some(step=>(step.kind==='delete_attachment')!==Boolean(step.target_id)||(step.kind==='add_attachment')!==(step.desired_index!==undefined)))ctx.addIssue({code:'custom',message:'Invalid draft sync plan steps'});
});
export type NativeEmailDraftSyncPlan=z.infer<typeof NativeEmailDraftSyncPlanSchema>;
export const NativeEmailDraftSyncValueSchema=z.strictObject({plan:NativeEmailDraftSyncPlanSchema,steps:z.array(z.strictObject({step_id:digest,state:z.enum(['prepared','started','applied','unknown','conflict']),observed_content_digest:digest.optional(),observed_version:id.optional()})).max(65)}).superRefine((value,ctx)=>{
 if(value.steps.length!==value.plan.steps.length||value.steps.some((step,index)=>step.step_id!==value.plan.steps[index]?.step_id||step.state==='applied'&&(step.observed_content_digest!==value.plan.steps[index]?.after_content_digest||!step.observed_version)))ctx.addIssue({code:'custom',message:'Invalid draft sync value steps'});
 let active=false;for(const step of value.steps){if(active&&step.state!=='prepared')ctx.addIssue({code:'custom',message:'Draft sync steps must be sequential'});if(step.state!=='applied')active=true;}
});
export type NativeEmailDraftSyncValue=z.infer<typeof NativeEmailDraftSyncValueSchema>;
export type NativeEmailDraftSyncJournal=Readonly<{
 create(plan:NativeEmailDraftSyncPlan):Promise<NativeEmailDraftSyncValue>;
 load(scope:NativeEmailDraftSyncPlan['scope'],operationId:string):Promise<NativeEmailDraftSyncValue|null>;
 change<T>(scope:NativeEmailDraftSyncPlan['scope'],operationId:string,callback:(value:NativeEmailDraftSyncValue|null,write:(next:NativeEmailDraftSyncValue)=>Promise<void>)=>Promise<T>|T):Promise<T>;
}>;
