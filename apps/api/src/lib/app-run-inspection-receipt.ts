import {AppPreparedEffectInputSchema,AppPreparedEffectReceiptSchema,type RecordStoreDeclaration} from '@deft/app-kit/core';

/** Inspection can report only the already accepted, exact original effect.
 * It cannot infer provider behavior or nominate a replacement execution. */
export function verifiedInspectionReceipt(raw:unknown,original:{run_id:string;attempt_id:string;runtime_binding_id:string;action_key:string;original_input:Record<string,string|number|boolean>},store:Pick<RecordStoreDeclaration,'supplemental_effects'>){
 const input=original.original_input;
 const pins=AppPreparedEffectInputSchema.parse({effect_version:input.effect_version,effect_key:input.effect_key,
  effect_plan_digest:input.effect_plan_digest,effect_content_digest:input.effect_content_digest,effect_custody_generation:input.effect_custody_generation});
 const declaration=store.supplemental_effects?.find(row=>row.action_key===original.action_key&&row.key===pins.effect_key&&row.version===pins.effect_version);
 const receipt=AppPreparedEffectReceiptSchema.parse(raw);
 if(!declaration||receipt.primary_outcome!=='accepted'||receipt.run_id!==original.run_id||receipt.operation_id!==original.run_id
  ||receipt.attempt_id!==original.attempt_id||receipt.action_binding_id!==original.runtime_binding_id
  ||receipt.account_ref!==input.account_ref||receipt.snapshot_digest!==input.prepared_digest
  ||receipt.effect_key!==pins.effect_key||receipt.version!==pins.effect_version||receipt.plan_digest!==pins.effect_plan_digest
  ||receipt.content_digest!==pins.effect_content_digest||receipt.custody_generation!==input.effect_custody_generation)
  throw new Error('APP_RUN_INSPECTION_RECEIPT_MISMATCH');
 return {operation_id:original.run_id,primary_outcome:receipt.primary_outcome,effect_outcome:receipt.effect_outcome,
  inspection_available:receipt.effect_outcome==='unknown'};
}
