import {parseNativeSafeComposeHtml} from '../../../../packages/app-kit/src/safe-compose-html';
import type {ExperienceRecordValue,ExperienceRecordRow} from './app-experience-record-writer';
import type {DeftExperienceRecordFormNode} from '../../../../packages/app-kit/src/app-data';

export type RecordFormProfile=DeftExperienceRecordFormNode['profile'];
export type RecordFormFile={file_id:string;filename:string;media_type:string;size_bytes:number;sha256:string};
export type RecordFormIdentity={address:string;label:string};
/** Status is returned by the trusted scoped read; author flags grant no editing. */
export function experienceRecordFormMode(node:DeftExperienceRecordFormNode,record:ExperienceRecordRow):'readonly'|'editable'{
 if(record.record_id!==node.record_id||!['draft','submitted','archived'].includes(record.status))throw Error('Record identity changed');
 validateRecordFormValue(record.value,node.profile);
 if(record.status!=='draft')return 'readonly';
 if(node.seed&&node.expected_revision===0)return 'editable';
 if(record.revision!==node.expected_revision||record.content_digest!==node.content_digest)throw Error('Draft revision changed');
 return 'editable';
}
export const recordFormString=(value:ExperienceRecordValue,field:string)=>{const text=value[field];if(typeof text!=='string')throw Error('Record field unavailable');return text;};
export function recordFormFiles(value:ExperienceRecordValue,profile:RecordFormProfile):RecordFormFile[]{
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
 const files=recordFormFiles(value,profile),html=recordFormString(value,profile.richtext.html_field),plain=recordFormString(value,profile.richtext.plain_field);
 if(html.length>profile.richtext.max_characters||plain.length>profile.richtext.max_characters||!plain.isWellFormed()||/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(plain))throw Error('Record body unavailable');
 if(html&&parseNativeSafeComposeHtml(html,{maxCharacters:profile.richtext.max_characters,inlineAttachments:profile.richtext.inline_images==='host_files'?files:[]}).plainText!==plain)throw Error('Record body pair changed');
 for(const field of profile.addresses){const text=recordFormString(value,field.field);if(text.length>2048||/[\r\n\0]/u.test(text))throw Error('Record address limit');}
 const subject=recordFormString(value,profile.subject.field);if(subject.length>profile.subject.max_characters||/[\r\n\0]/u.test(subject))throw Error('Record subject limit');
 if(profile.identity){const identity=value[profile.identity.field];if(identity!==undefined&&(!identity||typeof identity!=='object'||Array.isArray(identity)||typeof (identity as Record<string,unknown>)[profile.identity.address_field]!=='string'))throw Error('Record identity unavailable');}
}
export async function prepareRecordFormFile(file:File,profile:RecordFormProfile,existing:readonly RecordFormFile[]):Promise<RecordFormFile>{
 if(existing.length>=profile.files.max_files||file.size>profile.files.max_file_bytes||existing.reduce((sum,row)=>sum+row.size_bytes,0)+file.size>profile.files.max_total_bytes)throw Error('File limit');
 const bytes=await file.arrayBuffer();try{const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const result={file_id:crypto.randomUUID(),filename:file.name,media_type:file.type||'application/octet-stream',size_bytes:file.size,sha256:Array.from(hash,byte=>byte.toString(16).padStart(2,'0')).join('')};
  recordFormFiles({[profile.files.field]:[...existing,result]},profile);return result;
 }finally{new Uint8Array(bytes).fill(0);}
}
