import {createApiTransport,PROVIDER_LIMITS,fail,text,pathId,pageLimit,display,date,digest,encodeCursor,decodeCursor,resultPage} from './contract.mjs';

const base='https://graph.microsoft.com/v1.0/me';
const prefer={Prefer:'IdType="ImmutableId"'};
const fields='id,conversationId,parentFolderId,from,toRecipients,ccRecipients,subject,receivedDateTime,sentDateTime,isRead,flag,hasAttachments,internetMessageId';
function addresses(rows){if(!Array.isArray(rows)||rows.length>500)fail('EMAIL_PROVIDER_RESPONSE_INVALID');return display(rows.map(row=>row.emailAddress?.name?`${row.emailAddress.name} <${row.emailAddress.address}>`:row.emailAddress?.address??'').join(', '));}
export function microsoftMetadataSummary(account,value){
 // hasAttachments excludes inline attachments. False cannot establish an empty
 // file inventory before the separately authorized attachment read exists.
 return {account_id:account.account_id,provider:'microsoft',locator:{kind:'microsoft',message_id:text(value.id),id_type:'immutable',conversation_id:text(value.conversationId),folder_id:text(value.parentFolderId)},sender:addresses(value.from?[value.from]:[]),recipients:addresses(value.toRecipients??[]),cc:addresses(value.ccRecipients??[]),subject:display(value.subject),date:date(value.receivedDateTime??value.sentDateTime),folders:[value.parentFolderId],flags:{seen:value.isRead===true,flagged:value.flag?.flagStatus==='flagged'},message_id:display(value.internetMessageId),body_status:'lazy',files_status:value.hasAttachments?'lazy':'unknown'};
}
const summary=microsoftMetadataSummary;
export function createMicrosoftAdapter(options){
 const bodyFormat=options.body_format??'text';if(!['text','html'].includes(bodyFormat))fail('EMAIL_PROVIDER_INPUT_INVALID');
 const api=createApiTransport(options,'https://graph.microsoft.com'),{account}=api;if(account.provider!=='microsoft')fail('EMAIL_PROVIDER_ACCOUNT_MISMATCH');
 async function collection({limit=25,cursor=null,folder_id=null,query='',conversation_id=null}={},operation='read'){
  limit=pageLimit(limit);if(query!=='')text(query,2048);if(folder_id!==null)text(folder_id);if(conversation_id!==null)text(conversation_id);
  const path=folder_id===null?`${base}/messages`:`${base}/mailFolders/${pathId(folder_id)}/messages`,binding=digest({account_id:account.account_id,epoch:account.authority_epoch,operation,limit,folder_id,query,conversation_id}),nextLink=decodeCursor(cursor,binding);let url;try{url=new URL(nextLink??path);}catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}
  // Provider nextLink is opaque, but it cannot carry this account's bearer to
  // another host, user, collection or URI credentials.
  if(url.origin!=='https://graph.microsoft.com'||url.pathname!==new URL(path).pathname||url.username||url.password||url.hash)fail('EMAIL_PROVIDER_CURSOR_INVALID');
  if(nextLink===null){url.searchParams.set('$top',String(limit));url.searchParams.set('$select',fields);if(query)url.searchParams.set('$search',JSON.stringify(query));if(conversation_id)url.searchParams.set('$filter',`conversationId eq '${conversation_id.replaceAll("'","''")}'`);}
  const page=await api.request(url.href,{operation,headers:prefer}),rows=page.value;if(!Array.isArray(rows)||rows.length>limit)fail('EMAIL_PROVIDER_RESPONSE_INVALID');const messages=[],failures=[];
  for(const row of rows){try{messages.push(summary(account,row));}catch(error){failures.push({provider_message_id:display(row?.id),code:error.code??'EMAIL_PROVIDER_RESPONSE_INVALID'});}}
  const next=page['@odata.nextLink']===undefined?null:encodeCursor(binding,text(page['@odata.nextLink'],6000));if(next!==null&&next===cursor)fail('EMAIL_PROVIDER_PAGINATION_STALLED');
  return resultPage(account,messages,failures,next,{complete:query==='',coverage:conversation_id?'conversation':query?'query':folder_id?'folder':'mailbox',providerCap:query?1000:null});
 }
 async function readMessage(locator){if(locator?.kind!=='microsoft'||locator.id_type!=='immutable')fail('EMAIL_PROVIDER_LOCATOR_INVALID');const url=new URL(`${base}/messages/${pathId(locator.message_id)}`);url.searchParams.set('$select',`${fields},body,internetMessageHeaders,replyTo`);const data=await api.request(url.href,{headers:{...prefer,Prefer:prefer.Prefer+`, outlook.body-content-type="${bodyFormat}"`},maxBytes:PROVIDER_LIMITS.detail_bytes});if(data.id!==locator.message_id||!['html','text'].includes(data.body?.contentType)||typeof data.body.content!=='string')fail('EMAIL_PROVIDER_RESPONSE_INVALID');return {message:summary(account,data),body:{format:data.body.contentType,content:data.body.content,untrusted:true},headers:data.internetMessageHeaders??[]};}
 async function send(input){const bytes=await api.outgoing(input);try{await api.request(`${base}/sendMail`,{operation:'send',method:'POST',headers:{...prefer,'Content-Type':'text/plain'},body:bytes.toString('base64'),acceptedStatus:202});return {account_id:account.account_id,operation_id:input.operation_id,provider_message_id:null,transport_outcome:'provider_accepted',sent_copy_outcome:'pending',delivery_status:'unknown'};}finally{bytes.fill(0);}}
 return Object.freeze({provider:'microsoft',listMessages:request=>collection(request),searchMessages:request=>collection({...request,query:text(request?.query,2048)},'search'),readMessage,readConversation:async(request,operation='thread')=>{if(!['read','thread'].includes(operation))fail('EMAIL_PROVIDER_INPUT_INVALID');await api.authority(operation);return {...await collection({...request,conversation_id:text(request?.conversation_id)},'read'),provider_conversation_id:request.conversation_id};},send});
}
