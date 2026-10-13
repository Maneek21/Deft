import {z} from 'zod';
import {AppDataSourceReferenceSchema} from './app-data.js';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).refine(x=>!['constructor','prototype','__proto__'].includes(x));
const id=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),label=z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f<>]+$/u);
export const DeftExperienceLocalJobScheduleNodeSchema=z.strictObject({kind:z.literal('local_job_schedule'),id,label,store_key:key,operation_key:key,resource:AppDataSourceReferenceSchema,
 profile:z.strictObject({schema_version:z.literal('deft.local_job_form.v1'),note_field:key.refine(value=>value!=='schedule'),note_label:label,max_note_characters:z.number().int().min(1).max(2048)}),disabled:z.boolean().optional()});
export const DeftExperienceLocalJobListNodeSchema=z.strictObject({kind:z.literal('local_job_list'),id,label,store_key:key,resource_key:key,operation_keys:z.array(key).min(1).max(8).refine(keys=>keys.every((value,i)=>!i||keys[i-1]!<value))});
export type DeftExperienceLocalJobScheduleNode=z.infer<typeof DeftExperienceLocalJobScheduleNodeSchema>;
export type DeftExperienceLocalJobListNode=z.infer<typeof DeftExperienceLocalJobListNodeSchema>;
