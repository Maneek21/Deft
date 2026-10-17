import {createApiTransport,PROVIDER_LIMITS,fail,text,pathId,pageLimit,digest,encodeCursor,decodeCursor} from './contract.mjs';
import {gmailMetadataSummary} from './gmail.mjs';
import {microsoftMetadataSummary} from './microsoft.mjs';

const gmail='https://gmail.googleapis.com/gmail/v1/users/me',graph='https://graph.microsoft.com/v1.0/me';
const graphFields='id,conversationId,parentFolderId,from,toRecipients,ccRecipients,subject,receivedDateTime,sentDateTime,isRead,flag,hasAttachments,internetMessageId';
const sequence=value=>{if(typeof value!=='string'||!/^\d{1,30}$/.test(value))fail('EMAIL_PROVIDER_RESPONSE_INVALID');return value;};
function graphLink(value,path){text(value,2048);let url;try{url=new URL(value);}catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}if(url.origin!=='https://graph.microsoft.com'||url.pathname!==new URL(path).pathname||url.username||url.password||url.hash)fail('EMAIL_PROVIDER_CURSOR_INVALID');return url.href;}

export function createMetadataResetReader(options){
 const provider=options.account.provider,api=createApiTransport(options,provider==='gmail'?'https://gmail.googleapis.com':'https://graph.microsoft.com'),{account}=api;
 return {
  async resetStartCheckpoint(){if(provider!=='gmail')return null;return sequence((await api.request(`${gmail}/profile`)).historyId);},
  async resetReadMetadata(id){
   text(id);const url=new URL(`${provider==='gmail'?gmail:graph}/messages/${pathId(id)}`);if(provider==='gmail')url.searchParams.set('format','metadata');else url.searchParams.set('$select',graphFields);
   try{const data=await api.request(url.href,{headers:provider==='microsoft'?{Prefer:'IdType="ImmutableId"'}:{}});if(data.id!==id)fail('EMAIL_PROVIDER_RESPONSE_INVALID');return provider==='gmail'?gmailMetadataSummary(account,data):microsoftMetadataSummary(account,data);}catch(error){if(error.code!=='EMAIL_PROVIDER_NOT_FOUND')throw error;await api.authority('read');return null;}
  },
  async resetReadChanges({checkpoint,cursor=null,folder_id=null,limit=25}){
   limit=pageLimit(limit);const binding=digest({provider,account_id:account.account_id,epoch:account.authority_epoch,checkpoint,folder_id,limit}),inner=decodeCursor(cursor,binding);
   if(provider==='gmail'){
    sequence(checkpoint);const url=new URL(`${gmail}/history`);url.searchParams.set('startHistoryId',checkpoint);url.searchParams.set('maxResults',String(limit));if(inner!==null)url.searchParams.set('pageToken',text(inner));
    let page;try{page=await api.request(url.href);}catch(error){if(!['EMAIL_PROVIDER_NOT_FOUND','EMAIL_PROVIDER_CURSOR_EXPIRED'].includes(error.code))throw error;await api.authority('read');return {expired:true};}
    const rows=page.history??[];if(!Array.isArray(rows)||rows.length>limit)fail('EMAIL_PROVIDER_RESPONSE_INVALID');sequence(page.historyId);const changes=new Map();
    for(const row of rows){const event_id=sequence(row.id);if(BigInt(event_id)<=BigInt(checkpoint)||BigInt(event_id)>BigInt(page.historyId))fail('EMAIL_PROVIDER_RESPONSE_INVALID');for(const key of ['messages','messagesAdded','labelsAdded','labelsRemoved','messagesDeleted']){const entries=row[key]??[];if(!Array.isArray(entries)||entries.length>10000)fail('EMAIL_PROVIDER_RESPONSE_INVALID');for(const item of entries){const message=key==='messages'?item:item?.message,id=text(message?.id);changes.set(id,{id,event_id,kind:key==='messagesDeleted'?'deleted':'check',thread_id:key==='messagesDeleted'&&message.threadId!==undefined?text(message.threadId):null});if(changes.size>10000)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');}}}
    const next_cursor=page.nextPageToken===undefined?null:encodeCursor(binding,text(page.nextPageToken));if(next_cursor!==null&&next_cursor===cursor)fail('EMAIL_PROVIDER_PAGINATION_STALLED');
    return {messages:[],changes:[...changes.values()],next_cursor,checkpoint:next_cursor===null?page.historyId:checkpoint,expired:false};
   }
   text(folder_id);const path=`${graph}/mailFolders/${pathId(folder_id)}/messages/delta`,url=new URL(inner!==null?graphLink(inner,path):checkpoint!==null?graphLink(checkpoint,path):path);if(inner===null&&checkpoint===null)url.searchParams.set('$select',graphFields);
   let page;try{page=await api.request(url.href,{headers:{Prefer:`IdType="ImmutableId", odata.maxpagesize=${limit}`}});}catch(error){if(error.code!=='EMAIL_PROVIDER_CURSOR_EXPIRED')throw error;await api.authority('read');return {expired:true};}
   if(!Array.isArray(page.value)||page.value.length>limit||(page['@odata.nextLink']===undefined)===(page['@odata.deltaLink']===undefined))fail('EMAIL_PROVIDER_RESPONSE_INVALID');const messages=[],changes=[];
   for(const row of page.value){if(row['@removed']!==undefined){if(row['@removed']?.reason!=='deleted')fail('EMAIL_PROVIDER_RESPONSE_INVALID');changes.push({id:text(row.id),kind:'check',thread_id:null,event_id:digest({folder_id,id:row.id,round:url.href})});}else{if(row.parentFolderId!==folder_id)fail('EMAIL_PROVIDER_RESPONSE_INVALID');messages.push(microsoftMetadataSummary(account,row));}}
   const next_cursor=page['@odata.nextLink']===undefined?null:encodeCursor(binding,graphLink(page['@odata.nextLink'],path));if(next_cursor!==null&&next_cursor===cursor)fail('EMAIL_PROVIDER_PAGINATION_STALLED');return {messages,changes,next_cursor,checkpoint:next_cursor===null?graphLink(page['@odata.deltaLink'],path):checkpoint,expired:false};
  },
 };
}

// All accumulators/checkpoints stay in the private v2 index. The only host
// continuation is a consumed opaque token; no Worker completeness is accepted.
export async function runMetadataReset({scope,account,index,resolve,adapter,limit=25,cursor=null,folder_ids=null}){
 limit=pageLimit(limit);if(!['gmail','microsoft'].includes(account.provider))fail('EMAIL_PROVIDER_OPERATION_UNSUPPORTED');
 const folders=account.provider==='gmail'?[null]:folder_ids;if(account.provider==='gmail'&&folder_ids!==null||!Array.isArray(folders)||!folders.length||folders.length>100||new Set(folders).size!==folders.length||account.provider==='microsoft'&&[...folders].some(id=>typeof id!=='string'||!id||id.length>2048||/[\r\n\0]/.test(id)))fail('EMAIL_PROVIDER_INPUT_INVALID');
 const binding=digest({scope,account_id:account.account_id,provider:account.provider,epoch:account.authority_epoch,target:account.connection_target,resource_binding_id:account.resource_binding_id,limit,folders}),prior=index.takeMetadataReset(scope,{account_id:account.account_id,binding,cursor});
 let state=prior??{phase:'metadata',folder:0,checkpoint:null,cursor:null,checkpoints:[],seen:[],pending:[],after_pending:null,steps:0};
 if(!['metadata','verify','catchup'].includes(state.phase)||!Number.isSafeInteger(state.folder)||state.folder<0||state.folder>=folders.length||!Number.isSafeInteger(state.steps)||state.steps<0||state.steps>=10000||!Array.isArray(state.seen)||state.seen.length>10000||!Array.isArray(state.pending)||state.pending.length>10000||!Array.isArray(state.checkpoints)||state.checkpoints.length>100)fail('EMAIL_LOGICAL_RESET_INVALID');
 await resolve();const selected=await adapter();if(!prior){index.beginMetadataReset(scope,{account_id:account.account_id,binding,folder_ids:folders});state.checkpoint=await selected.resetStartCheckpoint();}
 const messages=[],tombstones=new Map(),seen=new Set(state.seen);let expired=false,done=false;state.steps++;
 const ingest=rows=>{for(const row of rows){if(row.account_id!==account.account_id)fail('EMAIL_PROVIDER_ACCOUNT_MISMATCH');const record=index.restoreProviderPresence(scope,row);if(!record.deletion){seen.add(record.logical_message_id);messages.push(record);}}};
 const remove=event=>{const tombstone=index.recordProviderDeletion(scope,{account_id:account.account_id,provider:account.provider,provider_message_id:event.id,provider_conversation_id:event.thread_id,evidence:{kind:event.kind==='deleted'?'provider_mailbox_deleted':'provider_mailbox_absent',event_id:event.event_id,authority_epoch:account.authority_epoch,observed_at:new Date().toISOString()}});if(tombstone)tombstones.set(tombstone.id,tombstone);};
 if(state.pending.length){const batch=state.pending.splice(0,limit);for(const event of batch){if(event.kind==='deleted')remove(event);else{const row=await selected.resetReadMetadata(event.id);if(row)ingest([row]);else remove(event);}}if(!state.pending.length&&state.after_pending){Object.assign(state,state.after_pending);state.after_pending=null;}}
 else if(state.phase==='metadata'){
  const page=account.provider==='gmail'?await(selected.listMetadataMessages??selected.listMessages)({limit,cursor:state.cursor,include_spam_trash:true}):await selected.resetReadChanges({limit,cursor:state.cursor,checkpoint:null,folder_id:folders[state.folder]});
  if(page.expired)expired=true;else{if(page.failures?.length)fail('EMAIL_PROVIDER_SYNC_PARTIAL_FAILURE');ingest(page.messages);state.cursor=page.next_cursor;if(account.provider==='microsoft'){state.pending=page.changes;const next={cursor:page.next_cursor};if(page.next_cursor===null){state.checkpoints.push({folder_id:folders[state.folder],checkpoint:page.checkpoint});next.folder=state.folder+1;next.cursor=null;if(next.folder===folders.length){next.folder=0;next.phase='verify';}}if(state.pending.length)state.after_pending=next;else Object.assign(state,next);}else if(page.next_cursor===null)state.phase='verify';}
 }
 else if(state.phase==='verify'){
  // Only after the full scoped baseline, confirm retained unseen identities by
  // current authenticated metadata GET. Partial-list absence never tombstones.
  state.pending=index.exportState(scope).records.filter(row=>row.account_id===account.account_id&&!row.deletion&&!seen.has(row.logical_message_id)&&(account.provider==='gmail'||folders.includes(row.locator.folder_id))).map(row=>({id:row.locator.message_id,thread_id:null,kind:'check',event_id:digest({binding,id:row.logical_message_id,phase:'verify'})}));
  state.after_pending={phase:'catchup',folder:0,cursor:null,checkpoint:account.provider==='gmail'?state.checkpoint:state.checkpoints[0].checkpoint};if(!state.pending.length){Object.assign(state,state.after_pending);state.after_pending=null;}
 }
 else{
  const page=await selected.resetReadChanges({limit,checkpoint:state.checkpoint,cursor:state.cursor,folder_id:folders[state.folder]});if(page.expired)expired=true;else{ingest(page.messages);state.pending=page.changes;const next={cursor:page.next_cursor};if(page.next_cursor===null){if(account.provider==='gmail'){next.checkpoint=page.checkpoint;if(!page.changes.length&&!page.messages.length){state.checkpoints=[{folder_id:null,checkpoint:page.checkpoint}];done=true;}}else{state.checkpoints[state.folder]={folder_id:folders[state.folder],checkpoint:page.checkpoint};next.folder=state.folder+1;next.cursor=null;if(next.folder===folders.length){next.folder=0;if(!state.pending.length&&!messages.length)done=true;}next.checkpoint=state.checkpoints[next.folder].checkpoint;}}if(state.pending.length)state.after_pending=next;else Object.assign(state,next);}
 }
 await resolve();if(expired)return {account_id:account.account_id,messages:[],failures:[],tombstones:[],next_cursor:null,has_more:false,reset_required:true,mailbox_reset_complete:false,covers_folders:folders.filter(Boolean),expired:true};
 if(done){index.finishMetadataReset(scope,{account_id:account.account_id,checkpoints:state.checkpoints});return {account_id:account.account_id,messages,failures:[],tombstones:[...tombstones.values()],next_cursor:null,has_more:false,reset_required:index.hasDeletionGap(scope,account.account_id),mailbox_reset_complete:true,covers_folders:account.provider==='gmail'?['ALL_MAIL_INCLUDING_SPAM_TRASH']:folders};}
 state.seen=[...seen];const next_cursor=index.saveMetadataReset(scope,{account_id:account.account_id,binding,value:state});return {account_id:account.account_id,messages,failures:[],tombstones:[...tombstones.values()],next_cursor,has_more:true,reset_required:true,mailbox_reset_complete:false,covers_folders:account.provider==='gmail'?['ALL_MAIL_INCLUDING_SPAM_TRASH']:folders};
}
