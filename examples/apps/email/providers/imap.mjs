import {validateEmailAccount,validateEmailScope} from '../account-registry.mjs';
import {loadMessageByLocator} from '../mailbox-sync.mjs';
import {readMailboxLifecyclePage} from '../mailbox-lifecycle.mjs';
import {readImapMetadataPage} from './imap-metadata.mjs';
import {validateProviderLocator} from '../logical-mail-index.mjs';
import {MailProviderError,fail,text,pageLimit,digest,encodeCursor,decodeCursor,resultPage} from './contract.mjs';

// The injected connector owns credential custody and verified TLS. Existing
// bounded IMAP read helpers remain authoritative; no owner session is retained.
export function createImapAdapter({account:input,scope,connect,assertAuthority,configuredFolders}){
 const account=validateEmailAccount(input);validateEmailScope(scope);if(account.provider!=='imap_smtp'||typeof connect!=='function'||typeof assertAuthority!=='function')fail('EMAIL_PROVIDER_AUTHORITY_REQUIRED');
 const binding=digest({scope,account_id:account.account_id,target:account.connection_target,epoch:account.authority_epoch});
 async function authority(){let allowed=false;try{allowed=await assertAuthority({account_id:account.account_id,operation:'read',authority_epoch:account.authority_epoch});}catch{}if(allowed!==true||account.health!=='connected'||!account.capabilities.includes('read'))fail('EMAIL_ACCOUNT_REVOKED');}
 async function withClient(fn){await authority();let client;try{client=await connect({account_id:account.account_id,authority_epoch:account.authority_epoch});await authority();const result=await fn(client);await authority();return result;}catch(error){if(error instanceof MailProviderError)throw error;if(error?.message==='STALE_MAIL_PARENT')fail('EMAIL_PROVIDER_LOCATOR_INVALID');fail('EMAIL_PROVIDER_IMAP_READ_FAILED',{retryable:true});}finally{if(client){try{await client.logout();}catch{try{client.close?.();}catch{}}}}}
 async function listMessages({limit=25,cursor=null,inventory_path,attachments,onProgress}={}){
  pageLimit(limit);text(inventory_path,4096);const inner=decodeCursor(cursor,binding);if(inner!==null&&typeof inner!=='string')fail('EMAIL_PROVIDER_CURSOR_INVALID');let page;
  try{return await withClient(async client=>{
   page=await readMailboxLifecyclePage(client,{request:{max_items:limit,cursor:inner,attachments},inventoryPath:inventory_path,cacheScope:binding,configuredFolders,onProgress:async signal=>{await authority();await onProgress?.(signal);}});
   const messages=page.upserts.map(row=>{const parts=/^(inbox|sent|archive):(\d{1,30}):([1-9]\d{0,9})$/.exec(row.id);if(!parts)fail('EMAIL_PROVIDER_RESPONSE_INVALID');const data=row.data;return {account_id:account.account_id,provider:'imap_smtp',locator:{kind:'imap_smtp',mailbox:data.mailbox,uidvalidity:parts[2],uid:Number(parts[3])},subject:data.subject,sender:data.sender,recipients:data.recipients,date:data.date||null,folders:[data.mailbox],flags:{seen:data.seen,flagged:data.flagged,answered:data.answered},message_id:data.message_id,references:data.references,in_reply_to:data.in_reply_to,body_status:data.body_status,files_status:data.attachment_count?'lazy':'none'};});
   const next=page.has_more?encodeCursor(binding,page.next_cursor):null;
   return {...resultPage(account,messages,[],next,{complete:false,coverage:'sync_window'}),checkpoint_cursor:encodeCursor(binding,page.next_cursor),legacy_tombstones:page.tombstones,commit:async()=>{try{await authority();page.commit();}catch(error){page.close();throw error;}},close:()=>page.close()};
  });}catch(error){page?.close();throw error;}
 }
 async function readMessage({locator,resource_id}){
  const expected=validateProviderLocator(locator);if(expected.kind!=='imap_smtp')fail('EMAIL_PROVIDER_LOCATOR_INVALID');text(resource_id,200);
  return withClient(async client=>{const message=await loadMessageByLocator(client,resource_id,configuredFolders);if(message.mailbox!==expected.mailbox||message.uidvalidity!==expected.uidvalidity||message.uid!==expected.uid)fail('EMAIL_PROVIDER_LOCATOR_INVALID');return {account_id:account.account_id,locator:expected,reply_evidence:message,body:{format:null,available:false,reason:'existing_locator_helper_returns_headers_only'}};});
 }
 async function listMetadataMessages({limit=25,cursor=null,onProgress}={}){
  pageLimit(limit);const metadataBinding=digest({binding,kind:'imap_metadata_v1'}),inner=decodeCursor(cursor,metadataBinding);
  return withClient(async client=>{
   const page=await readImapMetadataPage(client,{account_id:account.account_id,limit,cursor:inner,configuredFolders,onProgress:async signal=>{await authority();await onProgress?.(signal);}}),checkpoint=encodeCursor(metadataBinding,page.next_state);
   return {...resultPage(account,page.messages,[],page.has_more?checkpoint:null,{complete:false,coverage:'metadata_sync_window'}),checkpoint_cursor:checkpoint,folder_map:page.folder_map};
  });
 }
 const unsupported=async()=>fail('EMAIL_PROVIDER_OPERATION_UNSUPPORTED');
 return Object.freeze({provider:'imap_smtp',listMessages,listMetadataMessages,readMessage,searchMessages:unsupported,readConversation:unsupported,send:unsupported});
}
