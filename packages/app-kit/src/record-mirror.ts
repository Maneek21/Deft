import {z} from 'zod';
const accountRef=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).refine(value=>!['constructor','prototype','__proto__'].includes(value)),id=z.string().uuid(),digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const AppRecordMirrorDeclarationSchema=z.strictObject({
 schema_version:z.literal('deft.app_record_mirror.v1'),key,action_key:key,
 max_authority_seconds:z.number().int().min(60).max(90*86400),
 max_attempts_per_day:z.number().int().min(1).max(1000),
 max_mime_bytes:z.number().int().min(1).max(35*1024*1024),
 operations:z.tuple([z.literal('create'),z.literal('update'),z.literal('inspect'),z.literal('delete')]),
 cleanup:z.literal('matching_accepted_submission'),
 cleanup_action_keys:z.array(key).min(1).max(4).optional(),
}).refine(row=>!row.cleanup_action_keys||new Set(row.cleanup_action_keys).size===row.cleanup_action_keys.length&&row.cleanup_action_keys.every((value,i)=>value!==row.action_key&&(i===0||row.cleanup_action_keys![i-1]!<value)));
export type AppRecordMirrorDeclaration=z.infer<typeof AppRecordMirrorDeclarationSchema>;
export const AppRecordMirrorDeclarationsSchema=z.array(AppRecordMirrorDeclarationSchema).min(1).max(4)
 .refine(rows=>new Set(rows.map(row=>row.key)).size===rows.length&&new Set(rows.map(row=>row.action_key)).size===rows.length&&rows.every((row,i)=>i===0||rows[i-1]!.key<row.key));
export const AppRecordMirrorReviewRequestSchema=z.strictObject({connection_session_id:id,store_key:key,mirror_key:key,
 request_id:id,expected_revision:z.number().int().min(0).max(2147483646),
 expires_at:z.iso.datetime(),max_attempts_per_day:z.number().int().min(1).max(1000)});
export const AppRecordMirrorStatusSchema=z.strictObject({schema_version:z.literal('deft.app_record_mirror_status.v1'),
 receipt_id:id,request_id:id,store_key:key,mirror_key:key,account_ref:accountRef,
 revision:z.number().int().min(1).max(2147483646),state:z.enum(['enabled','paused','revoked','expired']),
 policy_digest:digest,expires_at:z.iso.datetime(),max_attempts_per_day:z.number().int().min(1).max(1000),
 attempts_remaining:z.number().int().min(0).max(1000),
 activity:z.strictObject({run_id:id,record_id:id,record_revision:z.number().int().min(1).max(2147483646),mirror_state:z.enum(['queued','running','synced','cleaned','conflict','unknown','unsupported','failed','cancelled','expired']),automatic_retry:z.literal(false)}).nullable().optional(),
});
export const AppRecordMirrorControlRequestSchema=z.strictObject({request_id:id,receipt_id:id,expected_revision:z.number().int().min(1).max(2147483646)});
export const AppPreparedMirrorInputSchema=z.strictObject({mirror_receipt_id:id,mirror_receipt_revision:z.number().int().min(1).max(2147483646),
 mirror_policy_digest:digest,record_store_key:key,record_id:id,record_revision:z.number().int().min(1).max(2147483646),
 content_digest:digest,snapshot_id:id,snapshot_digest:digest,
 mirror_operation:z.enum(['create','update','inspect','delete']),
 accepted_submission_id:z.union([id,z.literal('')]),accepted_snapshot_id:z.union([id,z.literal('')]),accepted_snapshot_digest:z.union([digest,z.literal('')]),
}).refine(row=>row.mirror_operation==='delete'?(row.accepted_submission_id!==''&&row.accepted_snapshot_id!==''&&row.accepted_snapshot_digest!==''):(row.accepted_submission_id===''&&row.accepted_snapshot_id===''&&row.accepted_snapshot_digest===''));
export type AppPreparedMirrorInput=z.infer<typeof AppPreparedMirrorInputSchema>;
