import {z} from 'zod';
import {DeftExperienceRecordFormProfileSchema,canonicalAppDataJson} from './app-data.js';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u).refine(value=>!['constructor','prototype','__proto__'].includes(value));
/** A signed blank record suggestion, never account, Send or mutation authority. */
export const DeftExperienceRecordIntakeSchema=z.strictObject({
 key,store_key:key,format:z.literal('mailto'),profile:DeftExperienceRecordFormProfileSchema,
 seed:z.record(z.string(),z.unknown()).refine(value=>{try{return new TextEncoder().encode(canonicalAppDataJson(value)).length<=16384;}catch{return false;}}),
 fields:z.strictObject({to:key,cc:key,bcc:key,subject:key,plain:key,html:key}),
}).refine(value=>{
 const f=value.fields,p=value.profile,names=Object.values(f);
 return new Set(names).size===6&&names.every(name=>value.seed[name]==='')
  &&p.addresses.length===3&&[f.to,f.cc,f.bcc].every(name=>p.addresses.some(field=>field.field===name))
  &&p.subject?.field===f.subject&&p.richtext.plain_field===f.plain&&p.richtext.html_field===f.html
  &&(!p.files||Array.isArray(value.seed[p.files.field])&&(value.seed[p.files.field] as unknown[]).length===0)
  &&(!p.identity||value.seed[p.identity.field]===undefined);
},'Intake must map distinct empty fields in the signed form profile');
export type DeftExperienceRecordIntake=z.infer<typeof DeftExperienceRecordIntakeSchema>;
