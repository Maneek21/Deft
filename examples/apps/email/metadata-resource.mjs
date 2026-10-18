import {createHash} from 'node:crypto';
import {SyncDescriptorV2Schema,parseRuntimeObjectInput,digestResourceSyncDescriptorV2} from '@deft/app-kit';
import {validateProviderLocator} from './logical-mail-index.mjs';

export const EMAIL_METADATA_VERSION='deft.email_message_metadata.v1';
export const EMAIL_METADATA_LIMITS=Object.freeze({fields:25,record_bytes:16384,folder_ids:100});
const string=maxLength=>({type:'string',maxLength});
const fields={metadata_version:string(40),account_id:string(256),logical_message_id:string(96),conversation_id:string(96),provider:string(16),label:string(200),subject:string(1000),subject_preview_truncated:{type:'boolean'},sender:string(1000),recipients:string(1000),cc:string(1000),date:string(64),in_inbox:{type:'boolean'},in_sent:{type:'boolean'},in_archive:{type:'boolean'},folder_membership_complete:{type:'boolean'},seen:{type:'boolean'},flagged:{type:'boolean'},answered:{type:'boolean'},message_id:string(1000),references:string(1000),in_reply_to:string(1000),headers_complete:{type:'boolean'},body_status:string(24),files_status:string(24)};
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const EMAIL_METADATA_RECORD_SCHEMA=freeze({type:'object',properties:fields,required:Object.keys(fields),additionalProperties:false});
// Sync v2 requires an attachment policy even when no handles are published. This
// deliberately minimal policy grants no bytes by itself: every row has [] links.
export const EMAIL_METADATA_DESCRIPTOR=freeze(SyncDescriptorV2Schema.parse({schema_version:'deft.app_sync_descriptor.v2',key:'mail_index',runtime_requirement_key:'sync_provider',resource_type:'mail_message_metadata',requested_visibility:'user_private',label_field:'label',record_schema:EMAIL_METADATA_RECORD_SCHEMA,attachments:{max_attachment_bytes:1,max_attachments_per_record:1,max_attachments_per_run:1,max_attachment_bytes_per_run:1,retention_days:1,allowed_media_types:['text/plain']}}));
const invalid=code=>{throw Object.assign(new Error(code),{code});};
export function validateMetadataFolderMap(value){
 if(value===undefined||value===null)return null;
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['inbox','sent','archive'].includes(key)))invalid('EMAIL_PROVIDER_FOLDER_MAP_INVALID');
 const map={inbox:[],sent:[],archive:[]},seen=new Set();
 for(const key of Object.keys(map)){const ids=value[key]??[];if(!Array.isArray(ids)||ids.length>EMAIL_METADATA_LIMITS.folder_ids)invalid('EMAIL_PROVIDER_FOLDER_MAP_INVALID');for(const id of ids){if(typeof id!=='string'||!id||id.length>2048||/[\r\n\0]/.test(id)||seen.has(id))invalid('EMAIL_PROVIDER_FOLDER_MAP_INVALID');seen.add(id);}map[key]=[...ids];}
 return map;
}
function memberships(locator,map){
 if(locator.kind==='gmail'){
  const labels=locator.label_ids;return {in_inbox:labels.includes('INBOX'),in_sent:labels.includes('SENT'),in_archive:!labels.some(label=>['INBOX','SENT','DRAFT','TRASH','SPAM'].includes(label)),folder_membership_complete:true};
 }
 const folder=locator.kind==='microsoft'?locator.folder_id:locator.mailbox;
 const matched=map!==null&&Object.values(map).some(ids=>ids.includes(folder));
 return {in_inbox:map?.inbox.includes(folder)??false,in_sent:map?.sent.includes(folder)??false,in_archive:map?.archive.includes(folder)??false,folder_membership_complete:matched};
}
export function projectEmailMetadata(record,{folder_map=null}={}){
 const locator=validateProviderLocator(record?.locator),summary=record.summary;
 if(!summary||record.account_id!==summary.account_id||summary.provider!==locator.kind)invalid('EMAIL_PROVIDER_METADATA_INVALID');
 const subject=summary.subject??'',data={metadata_version:EMAIL_METADATA_VERSION,account_id:record.account_id,logical_message_id:record.logical_message_id,conversation_id:record.conversation_id,provider:summary.provider,label:subject.slice(0,200),subject,subject_preview_truncated:subject.length>200,sender:summary.sender??'',recipients:summary.recipients??'',cc:summary.cc??'',date:summary.date??'',...memberships(locator,validateMetadataFolderMap(folder_map)),seen:summary.flags?.seen??false,flagged:summary.flags?.flagged??false,answered:summary.flags?.answered??false,message_id:summary.message_id??'',references:summary.references??'',in_reply_to:summary.in_reply_to??'',headers_complete:false,body_status:'lazy',files_status:['none','lazy'].includes(summary.files_status)?summary.files_status:'unknown'};
 try{parseRuntimeObjectInput(EMAIL_METADATA_RECORD_SCHEMA,data);}catch{invalid('EMAIL_PROVIDER_METADATA_INVALID');}
 if(Buffer.byteLength(JSON.stringify(data))>EMAIL_METADATA_LIMITS.record_bytes)invalid('EMAIL_PROVIDER_METADATA_LIMIT');
 // Only account-scoped logical identities leave the private index. Native API
 // IDs, IMAP locators, raw headers, MIME, tokens and file bytes do not.
 return {id:record.logical_message_id,revision:createHash('sha256').update(JSON.stringify({domain:EMAIL_METADATA_VERSION,data})).digest('hex'),data,attachments:[]};
}
export async function assertEmailMetadataDescriptor(value,digest){
 // Only these operator-reviewed resource names are compatible. The host's
 // attested digest must still name the exact descriptor received at Start.
 try{if(!['inbox','mail_index'].includes(value?.key))invalid('EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED');const actual=await digestResourceSyncDescriptorV2(value),expected=await digestResourceSyncDescriptorV2({...EMAIL_METADATA_DESCRIPTOR,key:value.key});if(actual!==expected||digest!==actual)invalid('EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED');}catch{invalid('EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED');}
}
