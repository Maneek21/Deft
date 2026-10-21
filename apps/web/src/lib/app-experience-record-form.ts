import {parseTrustedRichtextHtml} from '../../../../packages/app-kit/src/safe-rich-text';
import type {ExperienceRecordValue,ExperienceRecordRow} from './app-experience-record-writer';
import type {DeftExperienceRecordFormNode,DeftExperienceRecordFormV3Node,DeftExperienceRecordFormV3Profile} from '../../../../packages/app-kit/src/app-data';

export type RecordFormNode=DeftExperienceRecordFormNode|DeftExperienceRecordFormV3Node;
export type RecordFormProfile=RecordFormNode['profile'];
export function recordFormFields(profile:RecordFormProfile):DeftExperienceRecordFormV3Profile['fields'] {
 if(profile.schema_version==='deft.record_form_profile.v3')return profile.fields;
 return [...(profile.identity?[{kind:'verified_identity' as const,field:profile.identity.field,label:profile.identity.label,editable:false as const,identity_field:profile.identity.address_field}]:[]),...profile.addresses.map(field=>({kind:'text' as const,...field,format:'mailbox_list' as const,presentation:'pills' as const,max_characters:2048,required:false})),{kind:'text',...profile.subject,required:false}];
}
export function recordFormIdentity(value:ExperienceRecordValue,field:Extract<DeftExperienceRecordFormV3Profile['fields'][number],{kind:'verified_identity'}>):string {const saved=value[field.field];if(field.identity_field)return saved&&typeof saved==='object'&&!Array.isArray(saved)&&typeof (saved as Record<string,unknown>)[field.identity_field]==='string'?(saved as Record<string,string>)[field.identity_field]:'';return typeof saved==='string'?saved:'';}
export function recordFormLabels(profile:RecordFormProfile){return {save:'Save',review:'Review action',submitted:'Submission accepted. Check Activity for its status.',readonly:'Read-only record',scheduled:'Manage scheduled action',initial_change_unavailable:'Optional default unavailable.',...(profile.schema_version==='deft.record_form_profile.v3'?profile.labels:{})};}
/** Every reviewed scalar must have an author-declared caption; no hidden effect fields. */
export function recordFormEffectFields(profile:RecordFormProfile,details:Record<string,string|number|boolean>){
 const declared=profile.schema_version==='deft.record_form_profile.v3'?profile.review?.supplemental_effect:undefined;
 if(!declared||Object.keys(details).some(key=>!declared.fields.some(field=>field.field===key)))throw Error('Supplemental effect presentation unavailable');
 return {label:declared.label,fields:declared.fields.filter(field=>Object.hasOwn(details,field.field)).map(field=>({label:field.label,value:String(details[field.field])}))};
}

export type RecordFormFile={file_id:string;filename:string;media_type:string;size_bytes:number;sha256:string};
export type RecordFormIdentity={address:string;label:string};
/** Status is returned by the trusted scoped read; author flags grant no editing. */
export function experienceRecordFormMode(node:RecordFormNode,record:ExperienceRecordRow):'readonly'|'editable'{
 if(record.record_id!==node.record_id||!['draft','submitted','archived'].includes(record.status))throw Error('Record identity changed');
 validateRecordFormValue(record.value,node.profile);
 if(record.status!=='draft')return 'readonly';
 if(node.seed&&node.expected_revision===0)return 'editable';
 if(record.revision!==node.expected_revision||record.content_digest!==node.content_digest)throw Error('Draft revision changed');
 return 'editable';
}
export const recordFormString=(value:ExperienceRecordValue,field:string)=>{const text=value[field];if(typeof text!=='string')throw Error('Record field unavailable');return text;};
export function recordFormFiles(value:ExperienceRecordValue,profile:RecordFormProfile):RecordFormFile[]{
 if(!profile.files)return [];
 const files=value[profile.files.field];if(!Array.isArray(files)||files.length>profile.files.max_files)throw Error('Record files unavailable');
 const seen=new Set<string>();let bytes=0;
 for(const file of files){if(!file||typeof file!=='object'||Object.keys(file).sort().join(',')!=='file_id,filename,media_type,sha256,size_bytes'
  ||typeof file.file_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(file.file_id)||seen.has(file.file_id)
  ||typeof file.filename!=='string'||!file.filename||file.filename.length>255||/[\/\\\u0000-\u001f\u007f]/u.test(file.filename)
  ||typeof file.media_type!=='string'||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/u.test(file.media_type)
  ||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(file.sha256)||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0||file.size_bytes>profile.files.max_file_bytes)throw Error('Record file unavailable');
  seen.add(file.file_id);bytes+=file.size_bytes;
 }if(bytes>profile.files.max_total_bytes)throw Error('Record file limit');return files as RecordFormFile[];
}
/** Validation derives only a view. Opening/saving never normalizes whitespace,
 * folds recipient text, removes unknown schema fields or rewrites HTML. */
export function validateRecordFormValue(value:ExperienceRecordValue,profile:RecordFormProfile){
 if(!value||typeof value!=='object'||Array.isArray(value)||new TextEncoder().encode(JSON.stringify(value)).byteLength>profile.max_record_bytes)throw Error('Record limit');
 const files=recordFormFiles(value,profile),rich=profile.richtext;
 if(rich){const html=recordFormString(value,rich.html_field),plain=recordFormString(value,rich.plain_field);
  if(html.length>rich.max_characters||plain.length>rich.max_characters||!plain.isWellFormed()||/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(plain))throw Error('Record text unavailable');
  if(html&&parseTrustedRichtextHtml(html,{maxCharacters:rich.max_characters,inlineAttachments:rich.inline_images==='host_files'?files:[]}).plainText!==plain)throw Error('Record text pair changed');
 }
 for(const field of recordFormFields(profile)){const saved=value[field.field];
  if(field.kind==='text'&&(typeof saved!=='string'||!saved.isWellFormed()||saved.length>field.max_characters||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(saved)||field.format==='mailbox_list'&&/[\r\n]/u.test(saved)||field.required&&!saved.trim()))throw Error('Record field needs correction');
  if(field.kind==='boolean'&&typeof saved!=='boolean')throw Error('Record field unavailable');
  if(field.kind==='choice'&&!field.options.some(option=>option.value===saved))throw Error('Record choice unavailable');
  if(field.kind==='choice'&&field.activation){const marker=value[field.activation.field];if(marker!==undefined&&(!marker||typeof marker!=='object'||Array.isArray(marker)||Object.keys(marker).sort().join(',')!=='enabled,schema_version'||(marker as Record<string,unknown>).schema_version!==field.activation.schema_version||typeof (marker as Record<string,unknown>).enabled!=='boolean'))throw Error('Saved placement changed');}
  if(field.kind==='verified_identity'&&saved!==undefined){const identity=recordFormIdentity(value,field);if(!identity||identity.length>320||/[\u0000-\u001f\u007f-\u009f]/u.test(identity))throw Error('Record identity unavailable');}
 }
}
export async function prepareRecordFormFile(file:File,profile:RecordFormProfile,existing:readonly RecordFormFile[]):Promise<RecordFormFile>{
 if(!profile.files)throw Error('Files not declared');
 if(existing.length>=profile.files.max_files||file.size>profile.files.max_file_bytes||existing.reduce((sum,row)=>sum+row.size_bytes,0)+file.size>profile.files.max_total_bytes)throw Error('File limit');
 const bytes=await file.arrayBuffer();try{const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const result={file_id:crypto.randomUUID(),filename:file.name,media_type:file.type||'application/octet-stream',size_bytes:file.size,sha256:Array.from(hash,byte=>byte.toString(16).padStart(2,'0')).join('')};
  recordFormFiles({[profile.files.field]:[...existing,result]},profile);return result;
 }finally{new Uint8Array(bytes).fill(0);}
}
