import {z} from 'zod';
const accountRef=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);

const id=z.string().uuid(),key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u)
  .refine(value=>!['constructor','prototype','__proto__'].includes(value));
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const label=z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f<>]+$/u);
export const AppResourceActionSourceSchema=z.strictObject({resource_key:key,record_id:id,content_digest:digest});
export const AppResourceActionSourcesSchema=z.array(AppResourceActionSourceSchema).min(1).max(25)
  .refine(rows=>new Set(rows.map(row=>row.record_id)).size===rows.length,'Resource action sources must be unique');
export const AppResourceActionRecordReferenceSchema=z.strictObject({store_key:key,record_id:id,expected_revision:z.number().int().min(1).max(2147483646),expected_content_digest:digest});
const plan=z.strictObject({store_key:key,resource_key:key,action_key:key,operation_key:key,
  sources:z.array(AppResourceActionSourceSchema).max(25).refine(rows=>new Set(rows.map(row=>row.record_id)).size===rows.length),
  record_sources:z.array(AppResourceActionRecordReferenceSchema).min(1).max(25).refine(rows=>new Set(rows.map(row=>JSON.stringify([row.store_key,row.record_id]))).size===rows.length).optional(),
  parameters:z.record(key,z.string().max(8192)).refine(row=>Object.keys(row).length<=16).optional(),
  destination:AppResourceActionRecordReferenceSchema.optional(),
  labels:z.strictObject({add:z.array(AppResourceActionRecordReferenceSchema).max(16),remove:z.array(AppResourceActionRecordReferenceSchema).max(16)})
    .refine(row=>row.add.length+row.remove.length>0&&row.add.length+row.remove.length<=16&&new Set([...row.add,...row.remove].map(ref=>JSON.stringify([ref.store_key,ref.record_id]))).size===row.add.length+row.remove.length).optional(),
  undo:z.strictObject({snapshot_id:id,snapshot_digest:digest}).optional(),
  prepare_expires_at:z.iso.datetime().optional()});
const sameResource=(row:{resource_key:string;sources:{resource_key:string}[];record_sources?:{record_id:string}[]})=>row.sources.every(source=>source.resource_key===row.resource_key)&&row.sources.length+(row.record_sources?.length??0)>=1&&row.sources.length+(row.record_sources?.length??0)<=25;
export const AppResourceActionPlanInputSchema=plan.refine(sameResource,'Sources must belong to the nominated resource');
export const AppResourceActionReadInputSchema=z.strictObject({store_key:key,resource_key:key,snapshot_id:id,snapshot_digest:digest});
export const AppResourceActionPrepareSchema=plan.omit({action_key:true,prepare_expires_at:true})
  .extend({connection_session_id:id,idempotency_key:id}).refine(sameResource);
export const AppResourceActionDialogInputSchema=plan.omit({prepare_expires_at:true}).refine(sameResource);
export const AppResourceActionRuntimeInputSchema=z.strictObject({snapshot_id:id,account_ref:accountRef,operation_key:key,
  source_manifest_digest:digest,item_count:z.number().int().min(1).max(25),plan_digest:digest});
export const AppDataPreparedResourceActionSchema=z.strictObject({schema_version:z.literal('deft.app_prepared_resource_action.v1'),
  snapshot_id:id,snapshot_digest:digest,account_ref:accountRef,action_key:key,operation_key:key,resource_key:key,
  source_manifest_digest:digest,item_count:z.number().int().min(1).max(25),input:AppResourceActionRuntimeInputSchema,
  record_refs:z.array(AppResourceActionRecordReferenceSchema).max(42).optional(),
  preview:z.strictObject({title:label,count:z.number().int().min(1).max(25),
    items:z.array(z.strictObject({record_id:id,label,before:label,after:label})).min(1).max(25)}),expires_at:z.iso.datetime()})
  .refine(row=>row.input.snapshot_id===row.snapshot_id&&row.input.account_ref===row.account_ref
    &&row.input.operation_key===row.operation_key&&row.input.source_manifest_digest===row.source_manifest_digest
    &&row.input.plan_digest===row.snapshot_digest&&row.input.item_count===row.item_count&&row.preview.count===row.item_count&&row.preview.items.length===row.item_count
    &&new Set(row.preview.items.map(item=>item.record_id)).size===row.item_count,'Prepared plan pins and preview must agree');
export const AppResourceActionReleasedInputSchema=AppResourceActionRuntimeInputSchema.extend({
  resource_action_version:z.literal('deft.app_prepared_resource_action.v1'),resource_store_key:key,
  connection_session_id:id,connection_revision:z.number().int().min(1).max(2147483646),
  data_consent_id:id,data_consent_digest:digest,prepared_digest:digest});
export const AppResourceActionReviewSchema=z.strictObject({schema_version:z.literal('deft.app_resource_action_review.v1'),
  prepared:AppDataPreparedResourceActionSchema,input:AppResourceActionReleasedInputSchema,ticket:z.string().min(1).max(131072),
  input_digest:digest,expires_at:z.iso.datetime()}).refine(row=>row.input.snapshot_id===row.prepared.snapshot_id
    &&row.input.prepared_digest===row.prepared.snapshot_digest&&row.input.account_ref===row.prepared.account_ref
    &&row.input.operation_key===row.prepared.input.operation_key&&row.input.source_manifest_digest===row.prepared.input.source_manifest_digest
    &&row.input.item_count===row.prepared.input.item_count&&row.input.plan_digest===row.prepared.input.plan_digest
    &&Date.parse(row.expires_at)<=Date.parse(row.prepared.expires_at));
export type AppDataPreparedResourceAction=z.infer<typeof AppDataPreparedResourceActionSchema>;
export type AppResourceActionPrepare=z.infer<typeof AppResourceActionPrepareSchema>;
export type AppResourceActionReview=z.infer<typeof AppResourceActionReviewSchema>;
export type AppResourceActionDialogInput=z.infer<typeof AppResourceActionDialogInputSchema>;
