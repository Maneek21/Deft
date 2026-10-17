import {createApiTransport,pathId,fail,pageLimit} from './contract.mjs';
import {oauthObject} from './oauth-contract.mjs';
import {LogicalMailIndex} from '../logical-mail-index.mjs';
import {projectEmailMetadata} from '../metadata-resource.mjs';
import {resolveProviderSource,providerSourceForParent} from './provider-browser.mjs';
import {gmailMessageFolders,microsoftFolderId} from './native-folder-identity.mjs';
import {NATIVE_MICROSOFT_STATE_KEY} from './native-microsoft.mjs';

/** A trusted cached anchor nominates the provider conversation. Account-wide
 * metadata reads include Sent/Archive rather than reducing a thread to Inbox. */
export function createNativeEmailConversationBridge({runtime,now=Date.now}){
 return Object.freeze({async nativeEmailConversation(input,context){
  oauthObject(input,['source','cursor','limit'],'EMAIL_NATIVE_CONVERSATION_INPUT_INVALID');pageLimit(input.limit);
  if(!Object.hasOwn(input,'cursor')||input.cursor!==null&&(typeof input.cursor!=='string'||input.cursor.length>8192))fail('EMAIL_NATIVE_CONVERSATION_INPUT_INVALID');
  const value=await runtime(context);await value.check();const parent=resolveProviderSource({scope:value.scope,account:value.account,source:input.source});let systems={};
  if(value.account.provider==='microsoft'){
   const api=createApiTransport(value.adapterOptions,'https://graph.microsoft.com'),anchor=await api.request(`https://graph.microsoft.com/v1.0/me/messages/${pathId(parent.locator.message_id)}?$select=id,conversationId`,{headers:{Prefer:'IdType="ImmutableId"'}});
   if(anchor.id!==parent.locator.message_id||anchor.conversationId!==parent.locator.conversation_id)fail('EMAIL_NATIVE_CONVERSATION_SOURCE_STALE');
   if(context.provider_state){await value.check();const row=await context.provider_state.read(NATIVE_MICROSOFT_STATE_KEY);await value.check();
    const map=row?.value?.system_folders;if(map&&typeof map==='object'&&!Array.isArray(map)&&Object.keys(map).length<=6&&Object.entries(map).every(([id,role])=>id.length<=256&&['inbox','sent','spam','trash','drafts','archive'].includes(role)))systems=map;
   }
  }
  const conversation=value.account.provider==='gmail'?parent.locator.thread_id:parent.locator.conversation_id;
  const page=await value.adapter.readConversation({cursor:input.cursor,limit:input.limit,...(value.account.provider==='gmail'?{thread_id:conversation,anchor_message_id:parent.locator.message_id}:{conversation_id:conversation})},'read');
  await value.check();if(page.account_id!==value.account.account_id||page.provider_conversation_id!==conversation||!Array.isArray(page.messages)||page.messages.length>input.limit
    ||!Array.isArray(page.failures)||page.failures.length>10000||page.next_cursor!==null&&(typeof page.next_cursor!=='string'||page.next_cursor.length>8192))fail('EMAIL_NATIVE_CONVERSATION_RESPONSE_INVALID');
  const index=new LogicalMailIndex(value.scope),items=page.messages.map(message=>{
   if(message.account_id!==value.account.account_id||message.provider!==value.account.provider
     ||value.account.provider==='gmail'&&message.locator.thread_id!==conversation||value.account.provider==='microsoft'&&message.locator.conversation_id!==conversation)fail('EMAIL_NATIVE_CONVERSATION_RESPONSE_INVALID');
   const current=index.upsert(value.scope,message),metadata=projectEmailMetadata(current);
   return {account_id:value.account.account_id,logical_message_id:current.logical_message_id,revision:metadata.revision,received_at:metadata.data.date||null,
    folders:value.account.provider==='gmail'?gmailMessageFolders(current.summary.folders??[]):[microsoftFolderId(current.locator.folder_id,systems)],
    flags:{seen:current.summary.flags?.seen??false,flagged:current.summary.flags?.flagged??false,answered:current.summary.flags?.answered??false},data:metadata.data,provider_source:providerSourceForParent(value.account,current)};
  });
  if(new Set(items.map(item=>item.logical_message_id)).size!==items.length)fail('EMAIL_NATIVE_CONVERSATION_RESPONSE_INVALID');await value.check();
  return {schema_version:'deft.email_conversation_page.v1',account_id:value.account.account_id,provider:value.account.provider,anchor_logical_message_id:parent.logical_message_id,
   items,next_cursor:page.next_cursor,has_more:page.next_cursor!==null,observed_at:new Date(now()).toISOString(),failure_count:page.failures.length,
   complete:page.complete===true&&page.next_cursor===null&&page.failures.length===0};
 }});
}
