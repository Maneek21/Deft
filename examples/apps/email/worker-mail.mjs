import {mapEmailMetadataRecord,emailMetadataInFolder,emailMetadataRelated,EMAIL_METADATA_SEARCH_FIELDS} from './metadata-ui.mjs';
export {emailMetadataInFolder,emailMetadataRelated,EMAIL_METADATA_SEARCH_FIELDS};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail=()=>{throw Error('EMAIL_CURRENT_METADATA_REQUIRED');};
export function currentWorkerMail(item,recordId){
 if(!uuid.test(recordId)||item?.record_id!==recordId)fail();
 const data=item.data,mail=mapEmailMetadataRecord(data);
 if(!/^mail_[a-f0-9]{64}$/.test(mail.logical_message_id)||!/^conversation_[a-f0-9]{64}$/.test(mail.conversation_id)
  ||!['gmail','microsoft','imap_smtp'].includes(data.provider)||typeof data.headers_complete!=='boolean')fail();
 // A logical index identity is never a provider action reference. Retain only
 // the explicit resource reference furnished by an authoritative legacy record.
 const resource_id=typeof data.resource_id==='string'&&data.resource_id.length<=200&&!/[\r\n\0]/.test(data.resource_id)?data.resource_id:'';
 const source_revision=typeof item.revision==='string'&&item.revision.length>0&&item.revision.length<=256&&!/[\r\n\0]/.test(item.revision)?item.revision:Number.isSafeInteger(item.revision)&&item.revision>0?String(item.revision):null;
 return {...mail,resource_id,source_revision,uidvalidity:typeof data.uidvalidity==='string'?data.uidvalidity:'',record_id:recordId,headers_complete:false,message_id:data.message_id,references:data.references,in_reply_to:data.in_reply_to,subject_preview_truncated:data.subject_preview_truncated,document:null};
}
export const EMAIL_DOCUMENT_METADATA_FIELDS={account_id:200,primary_address:256,verified_sender_identities:8192,reply_from:2048,reply_to:2048,reply_to_list:2048,reply_cc:2048,subject:200,message_id:200,references:1000,conversation_id:96,conversation_coverage_state:16,conversation_indexed_count:5,conversation_exact_count:5,conversation_observed_at:24,conversation_drained:5,mailbox_reset_required:5};
export function currentWorkerDocument(value,mail){
 const metadata=value?.metadata;
 if(!['plain','html'].includes(value?.format)||typeof value.content!=='string'||value.content.length>16384||typeof value.truncated!=='boolean'
  ||(value.format==='html'&&(typeof value.plain_text!=='string'||value.plain_text.length>16384||value.plain_text.includes('\0')))||!metadata||Object.keys(metadata).sort().join(',')!==Object.keys(EMAIL_DOCUMENT_METADATA_FIELDS).sort().join(',')
  ||Object.entries(EMAIL_DOCUMENT_METADATA_FIELDS).some(([key,max])=>typeof metadata[key]!=='string'||metadata[key].length>max||/[\r\n\0]/.test(metadata[key]))||metadata.account_id!==mail.account_id)fail();
 if(metadata.conversation_id!==mail.conversation_id||!/^conversation_[a-f0-9]{64}$/.test(metadata.conversation_id)
  ||!['unknown','partial','complete','stale','reset_required'].includes(metadata.conversation_coverage_state)
  ||![metadata.conversation_indexed_count,...(metadata.conversation_exact_count? [metadata.conversation_exact_count]:[])].every(value=>/^(0|[1-9][0-9]{0,4})$/.test(value)&&Number(value)<=10000)
  ||!['true','false'].includes(metadata.conversation_drained)||!['true','false'].includes(metadata.mailbox_reset_required)
  ||metadata.conversation_observed_at!==''&&(!Number.isFinite(Date.parse(metadata.conversation_observed_at))||new Date(metadata.conversation_observed_at).toISOString()!==metadata.conversation_observed_at))fail();
 let identities;try{identities=JSON.parse(metadata.verified_sender_identities);}catch{fail();}
 if(!Array.isArray(identities)||!identities.length||identities.length>32||identities.some(row=>typeof row!=='string'||!row||row.length>256||/[\r\n\0]/.test(row)))fail();
 const reply_context={from:metadata.reply_from,reply_to:metadata.reply_to,to:metadata.reply_to_list,cc:metadata.reply_cc,subject:metadata.subject,message_id:metadata.message_id,references:metadata.references};
 if(reply_context.message_id!==''&&(!reply_context.from||!/^<[^<>\s@]+@[^<>\s@]+>$/.test(reply_context.message_id)||reply_context.references.split(' ').filter(Boolean).length>32||reply_context.references.split(' ').filter(Boolean).some(id=>id.length>200||!/^<[^<>\s@]+@[^<>\s@]+>$/.test(id))))fail();
 return {...value,forward_context:{from:metadata.reply_from,reply_to:metadata.reply_to,to:metadata.reply_to_list,cc:metadata.reply_cc,subject:metadata.subject},plain_text:value.format==='plain'?value.content:value.plain_text,reply_context:reply_context.message_id?reply_context:null,coverage:{state:metadata.conversation_coverage_state,indexed_count:Number(metadata.conversation_indexed_count),exact_count:metadata.conversation_exact_count===''?null:Number(metadata.conversation_exact_count),observed_at:metadata.conversation_observed_at,drained:metadata.conversation_drained==='true',mailbox_reset_required:metadata.mailbox_reset_required==='true'},account:{account_id:metadata.account_id,primary_address:metadata.primary_address,verified_sender_identities:identities}};
}
export function workerConversationCoverage(coverage,{count,complete,failed=false,limited=false},now=Date.now()){
 const observed=Date.parse(coverage?.observed_at||'');
 const authentic=Number.isFinite(observed)&&observed<=now;
 const confirmed=coverage?.state==='complete'&&coverage.drained&&authentic&&coverage.exact_count!==null&&coverage.exact_count===count&&coverage.indexed_count===count&&complete&&!failed&&!limited;
 let notice=confirmed?`Complete conversation · ${count} messages · as of ${coverage.observed_at}`: `${count} loaded messages · conversation coverage unconfirmed`;
 if(limited)notice+=' · header limit reached';
 else if(failed)notice+=' · some messages unavailable';
 else if(!complete)notice+=' · more headers may be available';
 if(coverage?.state==='partial')notice+=' · provider coverage partial';
 if(coverage?.state==='stale')notice+=' · coverage authority is stale';
 if(coverage?.state==='reset_required')notice+=' · conversation coverage reset required';
 return {confirmed,notice,mailbox_notice:coverage?.mailbox_reset_required?'Mailbox coverage reset pending. This conversation is checked independently.':''};
}
export function workerComposeParent(mail,mode='reply'){
 const context=mode==='forward'?mail?.document?.forward_context:mail?.document?.reply_context;
 if(!context||mail.document.truncated||typeof mail.document.plain_text!=='string'||mode!=='forward'&&!mail.document.plain_text)throw Error('EMAIL_COMPLETE_MESSAGE_REQUIRED');
 const parent=context;return {account_id:mail.account_id,record_id:mail.record_id,from:parent.from,reply_to:parent.reply_to,to:parent.to,cc:parent.cc,subject:parent.subject,plain_text:mail.document.plain_text,truncated:false};
}
