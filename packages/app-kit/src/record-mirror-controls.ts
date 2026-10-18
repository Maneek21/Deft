import {z} from 'zod';
const accountRef=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
import {AppRecordMirrorStatusSchema} from './record-mirror.js';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).refine(value=>!['constructor','prototype','__proto__'].includes(value));
export const DeftExperienceRecordMirrorControlNodeSchema=z.strictObject({
 kind:z.literal('record_mirror_control'),id:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
 label:z.string().min(1).max(100).regex(/^[^\u0000-\u001f\u007f<>]+$/u),store_key:key,mirror_key:key,
});
export type DeftExperienceRecordMirrorControlNode=z.infer<typeof DeftExperienceRecordMirrorControlNodeSchema>;
export const AppRecordMirrorReviewResultSchema=z.strictObject({schema_version:z.literal('deft.app_record_mirror_review.v1'),ticket:z.string().min(1).max(32768),authority_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/u),
 account_ref:accountRef,store_key:key,mirror_key:key,expires_at:z.iso.datetime(),max_attempts_per_day:z.number().int().min(1).max(1000),
 operations:z.tuple([z.literal('create'),z.literal('update'),z.literal('inspect'),z.literal('delete')]),cleanup:z.literal('matching_accepted_submission'),max_mime_bytes:z.number().int().min(1).max(35*1024*1024),review_expires_at:z.iso.datetime()});
export const AppRecordMirrorLookupResultSchema=z.strictObject({schema_version:z.literal('deft.app_record_mirror_lookup.v1'),mirror:AppRecordMirrorStatusSchema.nullable()});
