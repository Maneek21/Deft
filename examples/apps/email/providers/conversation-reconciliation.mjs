import {createApiTransport,PROVIDER_LIMITS,fail,text,pathId,pageLimit,digest,encodeCursor,decodeCursor} from './contract.mjs';

const gmail='https://gmail.googleapis.com/gmail/v1/users/me';
const graph='https://graph.microsoft.com/v1.0/me';
const historyId=value=>{if(typeof value!=='string'||!/^\d{1,30}$/.test(value))fail('EMAIL_PROVIDER_RESPONSE_INVALID');return value;};
const boundedLink=(value,path)=>{text(value,PROVIDER_LIMITS.cursor_bytes);let url;try{url=new URL(value);}catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}if(url.origin!=='https://graph.microsoft.com'||url.pathname!==new URL(path).pathname||url.username||url.password||url.hash)fail('EMAIL_PROVIDER_CURSOR_INVALID');return url.href;};

// Trusted provider-only primitive. Native tokens remain in private index state;
// the browser never supplies history IDs, folder IDs or deletion evidence.
export function createConversationReconciliation(options){
 const provider=options.account.provider;
 if(!['gmail','microsoft'].includes(provider))fail('EMAIL_PROVIDER_OPERATION_UNSUPPORTED');
 const api=createApiTransport(options,provider==='gmail'?'https://gmail.googleapis.com':'https://graph.microsoft.com'),{account}=api;
 async function readDeletionHistory({limit=25,checkpoint=null,cursor=null,folder_id=null}={}){
  limit=pageLimit(limit);const observed_at=new Date().toISOString(),binding=digest({account_id:account.account_id,epoch:account.authority_epoch,provider,folder_id,limit,checkpoint}),inner=decodeCursor(cursor,binding);
  const event=(id,event_id,thread_id=null)=>({provider,provider_message_id:text(id),provider_conversation_id:thread_id,authority_epoch:account.authority_epoch,kind:provider==='gmail'?'provider_mailbox_deleted':'provider_mailbox_absent',event_id:text(event_id)});
  if(provider==='gmail'){
   if(folder_id!==null)fail('EMAIL_PROVIDER_INPUT_INVALID');
   if(checkpoint===null){const profile=await api.request(`${gmail}/profile`);return {deletions:[],next_cursor:null,checkpoint:historyId(profile.historyId),reset_required:false,baseline_only:true,observed_at};}
   historyId(checkpoint);if(inner!==null)text(inner,PROVIDER_LIMITS.cursor_bytes);
   const url=new URL(`${gmail}/history`);url.searchParams.set('startHistoryId',checkpoint);url.searchParams.set('maxResults',String(limit));url.searchParams.set('historyTypes','messageDeleted');if(inner!==null)url.searchParams.set('pageToken',inner);
   let page;try{page=await api.request(url.href);}catch(error){if(error.code!=='EMAIL_PROVIDER_NOT_FOUND'&&error.code!=='EMAIL_PROVIDER_CURSOR_EXPIRED')throw error;await api.authority('read');return {deletions:[],next_cursor:null,checkpoint:null,reset_required:true,baseline_only:false,observed_at};}
   const rows=page.history??[];if(!Array.isArray(rows)||rows.length>limit)fail('EMAIL_PROVIDER_RESPONSE_INVALID');historyId(page.historyId);
   const deletions=[];for(const row of rows){const sequence=historyId(row.id);if(BigInt(sequence)<=BigInt(checkpoint)||BigInt(sequence)>BigInt(page.historyId))fail('EMAIL_PROVIDER_RESPONSE_INVALID');const deleted=row.messagesDeleted??[];if(!Array.isArray(deleted)||deleted.length>10000||deletions.length+deleted.length>10000)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');for(const item of deleted){const message=item?.message;if(!message||typeof message!=='object'||Array.isArray(message))fail('EMAIL_PROVIDER_RESPONSE_INVALID');deletions.push(event(message.id,sequence,message.threadId===undefined?null:text(message.threadId)));}}
   const next_cursor=page.nextPageToken===undefined?null:encodeCursor(binding,text(page.nextPageToken,PROVIDER_LIMITS.cursor_bytes));if(next_cursor!==null&&next_cursor===cursor)fail('EMAIL_PROVIDER_PAGINATION_STALLED');
   await api.authority('read');return {deletions,next_cursor,checkpoint:next_cursor===null?page.historyId:checkpoint,reset_required:false,baseline_only:false,observed_at};
  }
  text(folder_id);const path=`${graph}/mailFolders/${pathId(folder_id)}/messages/delta`;
  let url;if(inner!==null)url=new URL(boundedLink(inner,path));else if(checkpoint!==null)url=new URL(boundedLink(checkpoint,path));else{url=new URL(path);url.searchParams.set('$select','id');}
  const budget={remaining:PROVIDER_LIMITS.metadata_bytes,deadline:Date.now()+PROVIDER_LIMITS.timeout_ms};let page;
  try{page=await api.request(url.href,{headers:{Prefer:`IdType="ImmutableId", odata.maxpagesize=${limit}`},budget});}catch(error){if(error.code!=='EMAIL_PROVIDER_CURSOR_EXPIRED')throw error;await api.authority('read');return {deletions:[],next_cursor:null,checkpoint:null,reset_required:true,baseline_only:false,observed_at};}
  if(!Array.isArray(page.value)||page.value.length>limit||(page['@odata.nextLink']===undefined)===(page['@odata.deltaLink']===undefined))fail('EMAIL_PROVIDER_RESPONSE_INVALID');
  const deletions=[];for(const row of page.value){const id=text(row?.id);if(row['@removed']===undefined)continue;if(row['@removed']?.reason!=='deleted')fail('EMAIL_PROVIDER_RESPONSE_INVALID');
   // Delta removal is folder-scoped and may be a move. Only a current immutable
   // ID lookup returning 404 can confirm disappearance from this mailbox.
   try{const current=await api.request(`${graph}/messages/${pathId(id)}?$select=id`,{headers:{Prefer:'IdType="ImmutableId"'},budget});if(current.id!==id)fail('EMAIL_PROVIDER_RESPONSE_INVALID');}catch(error){if(error.code!=='EMAIL_PROVIDER_NOT_FOUND')throw error;await api.authority('read');deletions.push(event(id,digest({folder_id,id,round:url.href})));}
  }
  const next_cursor=page['@odata.nextLink']===undefined?null:encodeCursor(binding,boundedLink(page['@odata.nextLink'],path));if(next_cursor!==null&&next_cursor===cursor)fail('EMAIL_PROVIDER_PAGINATION_STALLED');
  await api.authority('read');return {deletions,next_cursor,checkpoint:next_cursor===null?boundedLink(page['@odata.deltaLink'],path):checkpoint,reset_required:false,baseline_only:checkpoint===null,observed_at};
 }
 return {readDeletionHistory};
}
