import {z} from 'zod';
import {RuntimeObjectSchema,parseRuntimeObjectInput} from './runtime-authoring.js';
import {canonicalAppDataJson} from './app-data-json.js';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).refine(value=>!['constructor','prototype','__proto__'].includes(value));
const version=z.string().min(1).max(96).regex(/^[a-z][a-z0-9_.-]*$/u);
const id=z.string().uuid(),hash=z.string().regex(/^sha256:[a-f0-9]{64}$/u),account=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
export const AppPreparedEffectDeclarationSchema=z.strictObject({key,action_key:key,version,details_schema:RuntimeObjectSchema});
export const AppPreparedEffectDeclarationsSchema=z.array(AppPreparedEffectDeclarationSchema).min(1).max(4)
 .refine(rows=>new Set(rows.map(row=>row.action_key)).size===rows.length&&rows.every((row,i)=>i===0||rows[i-1]!.key<row.key),'One declared supplemental effect per action; keys must be sorted');
export const AppPreparedEffectSchema=z.strictObject({schema_version:z.literal('deft.app_prepared_effect.v1'),effect_key:key,version,
 account_ref:account,custody_generation:z.number().int().min(1).max(2147483646),action_binding_id:id,
 content_digest:hash,content_bytes:z.number().int().min(1).max(35*1024*1024),
 details:z.record(key,z.union([z.string().max(16384),z.number().finite(),z.boolean()]))
  .refine(details=>Object.keys(details).length<=32&&new TextEncoder().encode(canonicalAppDataJson(details)).byteLength<=16384),plan_digest:hash});
export type AppPreparedEffect=Readonly<z.infer<typeof AppPreparedEffectSchema>>;
export type AppPreparedEffectDeclaration=Readonly<z.infer<typeof AppPreparedEffectDeclarationSchema>>;
/** The declaration is package-reviewed; details never nominate a validator or executable. */
export function parseAppPreparedEffectDetails(declarationInput:unknown,effectInput:unknown):AppPreparedEffect{
 const declaration=AppPreparedEffectDeclarationSchema.parse(declarationInput),effect=AppPreparedEffectSchema.parse(effectInput);
 if(effect.effect_key!==declaration.key||effect.version!==declaration.version)throw new TypeError('Prepared effect declaration mismatch');
 parseRuntimeObjectInput(declaration.details_schema,effect.details);return effect;
}
/** SHA256 this UTF-8 string; plan_digest itself is excluded. */
export function canonicalAppPreparedEffectJson(input:unknown):string{
 const {plan_digest,...value}=AppPreparedEffectSchema.parse(input);return canonicalAppDataJson(value);
}
export const AppPreparedEffectInputSchema=z.strictObject({effect_version:version,effect_key:key,effect_plan_digest:hash,effect_content_digest:hash,effect_custody_generation:z.number().int().min(1).max(2147483646)});
export const AppPreparedEffectReceiptSchema=z.strictObject({schema_version:z.literal('deft.app_prepared_effect_receipt.v1'),operation_id:id,run_id:id,attempt_id:id,
 effect_key:key,version,account_ref:account,custody_generation:z.number().int().min(1).max(2147483646),action_binding_id:id,
 snapshot_digest:hash,plan_digest:hash,content_digest:hash,
 primary_outcome:z.enum(['accepted','rejected','unknown']),effect_outcome:z.enum(['not_attempted','provider_managed','completed','failed','unknown']),automatic_retry:z.literal(false)})
 .refine(value=>value.primary_outcome==='accepted'||value.effect_outcome==='not_attempted','Supplemental effect requires durable primary acceptance');
export type AppPreparedEffectReceipt=Readonly<z.infer<typeof AppPreparedEffectReceiptSchema>>;
