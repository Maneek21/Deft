// Browser-only opt-in reader. Authority remains in the existing Experience SDK
// session and host resource route; this module owns no provider credentials.
export const EMAIL_METADATA_SEARCH_FIELDS=Object.freeze(['subject','sender','recipients','cc']);
const invalid=()=>{throw new Error('EMAIL_METADATA_RECORD_UNAVAILABLE');};
export function mapEmailMetadataRecord(data){
 if(!data||data.metadata_version!=='deft.email_message_metadata.v1'||typeof data.account_id!=='string'||!data.account_id||data.account_id.length>256||typeof data.logical_message_id!=='string'||!data.logical_message_id||data.logical_message_id.length>96||typeof data.conversation_id!=='string'||!data.conversation_id||data.conversation_id.length>96||data.body_status!=='lazy'||!['none','lazy','unknown'].includes(data.files_status)||['in_inbox','in_sent','in_archive','folder_membership_complete','seen','flagged','answered'].some(key=>typeof data[key]!=='boolean'))invalid();
 for(const key of ['label','subject','sender','recipients','cc','date'])if(typeof data[key]!=='string'||data[key].length>1000)invalid();
 return Object.freeze({account_id:data.account_id,logical_message_id:data.logical_message_id,conversation_id:data.conversation_id,subject:data.subject,sender:data.sender,recipients:data.recipients,cc:data.cc,date:data.date,seen:data.seen,answered:data.answered,flagged:data.flagged,in_inbox:data.in_inbox,in_sent:data.in_sent,in_archive:data.in_archive,folders:Object.freeze(['inbox','sent','archive'].filter(folder=>data[`in_${folder}`])),folder_membership_complete:data.folder_membership_complete,folder:data.in_sent?'sent':data.in_inbox?'inbox':data.in_archive?'archive':'unknown',body:'',body_status:'lazy',body_notice:'Message text has not been loaded. Body access is unavailable in this indexed preview.',files_status:data.files_status,files_notice:data.files_status==='none'?'No attachments reported by the provider.':'Files have not been loaded. File access is unavailable in this indexed preview.',attachment_metadata_complete:data.files_status==='none',attachment_count:0,downloadable_attachment_count:0,skipped_attachment_count:0,body_truncated:false,full_body_status:'unavailable',resource_id:'',message_id:'',in_reply_to:'',references:''});
}
export const normalizeMetadataRecord=mapEmailMetadataRecord;
export function emailMetadataInFolder(mail,folder){if(!['inbox','sent','archive'].includes(folder))invalid();return mail?.[`in_${folder}`]===true;}
export function emailMetadataRelated(mail,candidates){return candidates.filter(other=>other&&other.account_id===mail.account_id&&other.conversation_id===mail.conversation_id);}
export function createEmailMetadataReader(sdk,{resource_key='mail_index',account_id=null}={}){
 if(!sdk||typeof sdk.readResourceRecord!=='function'||resource_key!=='mail_index'||account_id!==null&&(typeof account_id!=='string'||!account_id))invalid();
 return Object.freeze({async read(record_id){const result=await sdk.readResourceRecord(resource_key,record_id);if(result?.item?.record_id!==record_id)invalid();const mail=mapEmailMetadataRecord(result.item.data);if(account_id!==null&&mail.account_id!==account_id)invalid();return mail;}});
}
