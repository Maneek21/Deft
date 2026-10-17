import {z} from 'zod';
const accountRef=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const id=z.string().uuid(),hash=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
/** A declaration is immutable reviewed content, never reusable authority.
 * The executor still requires fresh exact released action authority after
 * durable known transport acceptance and before the scoped copy effect. */
export const AppPreparedCopyEffectSchema=z.strictObject({schema_version:z.literal('deft.app_prepared_copy_effect.v1'),effect_key:z.literal('sent_copy'),
 account_ref:accountRef,custody_generation:z.number().int().min(1).max(2147483646),action_binding_id:id,
 content_digest:hash,content_bytes:z.number().int().min(1).max(35*1024*1024),message_id:z.string().min(3).max(256).regex(/^<[^<>\s\u0000-\u001f\u007f]+>$/u),
 mode:z.enum(['server_managed','append_exact']),destination:z.strictObject({mailbox:z.string().min(1).max(2048).regex(/^[^\u0000-\u001f\u007f]+$/u),uidvalidity:z.string().regex(/^[1-9]\d{0,29}$/u)}).nullable(),
 plan_digest:hash}).refine(v=>(v.mode==='append_exact')===(v.destination!==null),{message:'Copy mode requires its exact sealed destination'});
export type AppPreparedCopyEffect=Readonly<z.infer<typeof AppPreparedCopyEffectSchema>>;
export const AppPreparedCopyEffectInputSchema=z.strictObject({sent_copy_version:z.literal('deft.app_prepared_copy_effect.v1'),sent_copy_mode:z.enum(['server_managed','append_exact']),sent_copy_plan_digest:hash});
export type AppPreparedCopyEffectInput=Readonly<z.infer<typeof AppPreparedCopyEffectInputSchema>>;
export const AppCompoundSendReceiptSchema=z.strictObject({schema_version:z.literal('deft.app_compound_send_receipt.v1'),operation_id:id,run_id:id,attempt_id:id,
 account_ref:accountRef,custody_generation:z.number().int().min(1).max(2147483646),snapshot_digest:hash,copy_plan_digest:hash,content_digest:hash,
 transport_outcome:z.enum(['accepted','rejected','unknown']),copy_outcome:z.enum(['not_attempted','server_managed','copied','failed','unknown']),automatic_retry:z.literal(false)})
 .refine(v=>v.transport_outcome==='accepted'||v.copy_outcome==='not_attempted',{message:'Copy requires durable known transport acceptance'});
export type AppCompoundSendReceipt=Readonly<z.infer<typeof AppCompoundSendReceiptSchema>>;
