import {nativeOwnerCapabilities,narrowNativeAccount} from './native-owner-consent.mjs';
import {createEmailOAuth} from './oauth-account.mjs';
import {createHash} from 'node:crypto';
import {createGmailAdapter} from './gmail.mjs';
import {createMicrosoftAdapter} from './microsoft.mjs';
import {LogicalMailIndex} from '../logical-mail-index.mjs';
import {projectEmailMetadata} from '../metadata-resource.mjs';
import {providerSourceForParent,resolveProviderSource} from './provider-browser.mjs';
import {createGmailSourceAdapter,createMicrosoftSourceAdapter} from './source-read.mjs';
import {inspectEmailSourceFiles} from './incoming-source-files.mjs';
import {fetchPublicMessageImage} from './remote-image-proxy.mjs';
import {oauthFail,oauthObject,oauthText,sameOAuthBinding,validateOAuthBinding} from './oauth-contract.mjs';
import {sameEmailScope} from '../account-registry.mjs';
import {readNativeGmailPage} from './native-gmail.mjs';
import {readNativeMicrosoftPage,NATIVE_MICROSOFT_STATE_KEY} from './native-microsoft.mjs';
import {compileEmailQuery} from '../email-query-language.mjs';
import {digest as providerDigest,NATIVE_INCOMING_LIMITS} from './contract.mjs';
import {createNativeEmailTriageBridge} from './native-triage.mjs';
import {createNativeEmailFoldersBridge} from './native-folders.mjs';
import {gmailMessageFolders as gmailFolders,microsoftFolderId} from './native-folder-identity.mjs';
import {createNativeEmailSendBridge} from './native-send.mjs';
import {createOutgoingSnapshotService,serializeNativeDraft} from '../outgoing-snapshot.mjs';
import {createNativeEmailConversationBridge} from './native-conversation.mjs';
import {createNativeEmailDraftSyncBridge} from './native-draft-sync.mjs';

const fields=['org_id','owner_user_id','account_id','installation_id','resource_binding_id','authority_version','expires_at','recheck','signal','provider_state','owner_capabilities','lifecycle_inspect'];
const accountFingerprint=({account,binding,connection_revision,principal_digest})=>JSON.stringify({binding,connection_revision,principal_digest,health:account.health,capabilities:account.capabilities});

/** Reuses the registered deployment's actual custody and installation namespace.
 * Host recheck MUST be a fresh SQL-only guard: OAuth calls it inside the custody
 * lock. The service separately checks decorated custody authority before/after
 * provider I/O; adapter authority checks inspect custody outside that lock. */
export function createNativeEmailBridge({selected,clients,custody,accountFromRecord,fetch:fetchImpl,now=Date.now,monotonic=()=>performance.now(),imageDependencies}){
 function context(value,purpose,inspection){
  nativeOwnerCapabilities(value,{inspection});
  oauthObject(value,purpose==='draft_sync'?[...fields,'draft_sync_before_effect','draft_sync_journal']:purpose==='modify'?[...fields,'triage_journal','triage_before_reserve']:purpose==='prepare_send'?[...fields,'send_prepare_before_effect','send_upload_journal']:purpose==='send'?[...fields,'send_before_reserve','send_upload_journal']:fields,'EMAIL_NATIVE_AUTHORITY_DENIED');
  if(fields.filter(key=>!['signal','recheck','expires_at','provider_state','owner_capabilities','lifecycle_inspect'].includes(key)).some(key=>!oauthText(value[key],256))
   ||value.account_id!==selected.account_id||value.resource_binding_id!==selected.resource_binding_id
   ||!Number.isSafeInteger(value.expires_at)||value.expires_at<=now()||typeof value.recheck!=='function'
   ||value.signal!==undefined&&!(value.signal instanceof AbortSignal)
   ||value.provider_state!==undefined&&(typeof value.provider_state?.read!=='function'||typeof value.provider_state?.stale!=='function'))oauthFail('EMAIL_NATIVE_AUTHORITY_DENIED');
  return Object.freeze({...value});
 }
 async function runtime(raw,purpose='read',inspection=false,{joinPendingCustody=false}={}){
  const host=context(raw,purpose,inspection),receivedAt=monotonic(),checkedAt=now();purpose=purpose==='draft_sync'?'modify':purpose==='prepare_send'?'send':purpose;
  const scope={org_id:host.org_id,owner_id:host.owner_user_id,installation_id:host.installation_id};
  const nominated=validateOAuthBinding({...selected,scope});
  let pendingSql=null,pendingCustody=null;
  const checkDeadline=()=>{host.signal?.throwIfAborted();if(host.expires_at<=Math.max(now(),checkedAt+Math.max(0,monotonic()-receivedAt)))oauthFail('EMAIL_NATIVE_AUTHORITY_DENIED');};
  // Metadata fans out within one operation. Join only an actively running SQL
  // check; settled decisions are never cached, and final output checks stay fresh.
  // This closure is SQL-only, including when OAuth invokes it under custody.
  const checkSql=async()=>{checkDeadline();
   if(!pendingSql)pendingSql=Promise.resolve().then(()=>host.recheck()).finally(()=>{pendingSql=null;});
   await pendingSql;checkDeadline();
  };
  const inspectCustody=()=>custody.withAccount(nominated,tx=>{
    const record=tx.read();
    if(!record||!sameEmailScope(record.binding.scope,scope)||record.binding.account_id!==nominated.account_id
     ||['provider','connection_target','resource_binding_id','action_binding_id','authority_epoch'].some(key=>record.binding[key]!==nominated[key])
     ||record.binding.capabilities.some(capability=>!nominated.capabilities.includes(capability)))oauthFail('EMAIL_NATIVE_AUTHORITY_DENIED');
    const account=narrowNativeAccount(accountFromRecord(record.binding,record),host,{inspection});
    if(!account||!Number.isSafeInteger(record.setup_generation)||record.setup_generation<1||!oauthText(record.secret?.identity?.provider_subject,256))oauthFail('EMAIL_NATIVE_AUTHORITY_DENIED');
    const principal_digest=createHash('sha256').update(JSON.stringify([scope.org_id,scope.owner_id,account.provider,record.secret.identity.provider_subject])).digest('hex');
    return {account,binding:structuredClone(record.binding),connection_revision:record.setup_generation,principal_digest,granted_scopes:[...record.secret.scopes]};
   });
  // Search metadata fan-out may join only this request's still-pending custody
  // inspection. A settled result is discarded; token refresh/CAS stays locked
  // independently, and every caller retains SQL/deadline checks around the read.
  const readCustody=async(fresh=false)=>{
   await checkSql();let work;
   if(joinPendingCustody&&!fresh){
    if(!pendingCustody)pendingCustody=inspectCustody().finally(()=>{pendingCustody=null;});
    work=pendingCustody;
   }else work=inspectCustody();
   const value=await work;
   await checkSql();return value;
  };
  const initial=await readCustody(),fingerprint=accountFingerprint(initial);
  const check=async(fresh=false)=>{const current=await readCustody(fresh);if(accountFingerprint(current)!==fingerprint||current.account.health!=='connected'||!current.account.capabilities.includes(purpose))oauthFail('EMAIL_NATIVE_AUTHORITY_DENIED');};
  const {account,binding}=initial;
  const fetchCurrent=async(url,init={})=>{host.signal?.throwIfAborted();return fetchImpl(url,{...init,...(host.signal?{signal:init.signal?AbortSignal.any([host.signal,init.signal]):host.signal}:{})});};
  const oauth=createEmailOAuth({clients,custody,fetch:fetchCurrent,now,host:{
   async resolveAccount({scope:requested,account_id,purpose:requestedPurpose}){if(requestedPurpose!==purpose||account_id!==binding.account_id||!sameEmailScope(requested,scope))oauthFail('EMAIL_NATIVE_AUTHORITY_DENIED');await checkSql();return binding;},
   async assertAuthority({binding:requested,purpose:requestedPurpose}){if(requestedPurpose!==purpose||!sameOAuthBinding(requested,binding))oauthFail('EMAIL_NATIVE_AUTHORITY_DENIED');await checkSql();return {allowed:true,expires_at:host.expires_at};},
  }});
  const options={account,fetch:fetchCurrent,getAccessToken:request=>oauth.getAccessToken({scope,account,...request}),assertAuthority:async request=>{
   if(request.account_id!==account.account_id||request.authority_epoch!==account.authority_epoch||request.operation!==purpose)return false;
   await check();return true;
  }};
  return {scope,account,binding,connection_revision:initial.connection_revision,principal_digest:initial.principal_digest,check,checkFresh:()=>check(true),
   getModifyCredential:async()=>{if(purpose!=='modify')oauthFail('EMAIL_NATIVE_AUTHORITY_DENIED');await check();
    const token=await oauth.getAccessToken({scope,account,account_id:account.account_id,authority_epoch:account.authority_epoch,operation:'modify'});
    await check();const current=await readCustody();if(accountFingerprint(current)!==fingerprint)oauthFail('EMAIL_NATIVE_AUTHORITY_DENIED');return {token,granted_scopes:current.granted_scopes};},
   adapterOptions:options,adapter:account.provider==='gmail'?createGmailAdapter(options):createMicrosoftAdapter(options)};
 }
 async function inspectNative(input,raw,kind){
  const ref=kind==='file'?'file_ref':'image_ref';
  const whole=kind==='presentation'||kind==='calendar';
  oauthObject(input,whole?['source']:['source','source_digest',ref],'EMAIL_NATIVE_SOURCE_INVALID');
  if(!Object.hasOwn(input,'source')||!whole&&(typeof input.source_digest!=='string'||typeof input[ref]!=='string'||!/^[a-f0-9]{64}$/u.test(input.source_digest)||!/^[a-f0-9]{64}$/u.test(input[ref])))oauthFail('EMAIL_NATIVE_SOURCE_INVALID');
  const value=await runtime(raw);await value.check();
  const parent=resolveProviderSource({scope:value.scope,account:value.account,source:input.source});
  const adapter=(value.account.provider==='gmail'?createGmailSourceAdapter:createMicrosoftSourceAdapter)({...value.adapterOptions,now,sourceMimeLimit:NATIVE_INCOMING_LIMITS.source_bytes});
  let source,result;
  try{
   source=await adapter.readSource(parent.locator,{signal:raw.signal,deadline:raw.expires_at,
    ...(value.account.provider==='gmail'?{expected_thread_id:parent.locator.thread_id}:{})});
   await value.check();
   if(source.account_id!==value.account.account_id||source.provider!==value.account.provider
    ||!whole&&source.digest!==input.source_digest)oauthFail('EMAIL_NATIVE_SOURCE_INVALID');
   result=await inspectEmailSourceFiles(source.mime_bytes,{profile:'native',presentation:kind==='presentation',calendar_parts:kind==='calendar',
    ...(whole?{}:{[ref]:input[ref]}),account:value.account,conversation_id:parent.conversation_id,
    check:value.check,fetchRemote:async({url})=>{
     await value.check();const image=await fetchPublicMessageImage(url,{signal:raw.signal,recheck:async()=>{await value.check();return true;}},imageDependencies);
     try{await value.check();return image;}catch(error){image.bytes?.fill(0);throw error;}
    }});
   await value.check();
   const identity={account_id:value.account.account_id,provider:value.account.provider,logical_message_id:parent.logical_message_id,source_digest:source.digest};
   if(kind==='calendar')return {schema_version:'deft.email_calendar_parts.v1',...identity,receiving_identity:{primary_address:value.account.primary_address,display_label:value.account.display_label},...result.calendar_parts};
   // HTML is untrusted JSON presentation data. Only the existing document
   // renderer may sanitize it; this adapter never emits an HTML response.
   if(kind==='presentation')return {schema_version:'deft.email_presentation.v1',...identity,content_trust:'unsanitized',files:result.files,...(result.omitted_file_count?{omitted_file_count:result.omitted_file_count}:{}),...(result.reply_seed_unavailable?{reply_seed_unavailable:result.reply_seed_unavailable}:{}),presentation:result.presentation};
   if(kind==='file'){
    const file=result.files.find(file=>file.file_ref===input.file_ref);
    if(!file)oauthFail('EMAIL_NATIVE_SOURCE_INVALID');
    return {schema_version:'deft.email_file.v1',...identity,file_ref:input.file_ref,filename:file.filename,media_type:file.media_type,byte_length:result.bytes.byteLength,bytes:result.bytes};
   }
   return {schema_version:'deft.email_image.v1',...identity,image_ref:input.image_ref,media_type:result.media_type,byte_length:result.bytes.byteLength,bytes:result.bytes};
  }catch(error){result?.bytes?.fill(0);throw error;}finally{source?.mime_bytes?.fill(0);}
 }
 return Object.freeze({
  nativeEmailDraftMime:serializeNativeDraft,
  nativeEmailSnapshotFactory(ports){
   oauthObject(ports,['resolve','seal','verify','reserve'],'EMAIL_NATIVE_SNAPSHOT_PORT_INVALID');
   if(['resolve','seal','verify','reserve'].some(key=>typeof ports[key]!=='function'))oauthFail('EMAIL_NATIVE_SNAPSHOT_PORT_INVALID');
   return createOutgoingSnapshotService({...ports,profile:'native'});
  },
  ...createNativeEmailTriageBridge({runtime:raw=>runtime(raw,'modify'),now}),
  ...createNativeEmailFoldersBridge({runtime,now}),
  ...createNativeEmailSendBridge({runtime,now}),
  ...createNativeEmailConversationBridge({runtime,now}),
  ...createNativeEmailDraftSyncBridge({runtime:raw=>runtime(raw,'draft_sync'),now}),
  async nativeEmailSearch(input,raw){
   oauthObject(input,['query','cursor','limit'],'EMAIL_NATIVE_SEARCH_INVALID');
   if(typeof input.query!=='string'||input.query.length>2048||!Object.hasOwn(input,'cursor')
    ||input.cursor!==null&&!oauthText(input.cursor,8192)||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100)oauthFail('EMAIL_NATIVE_SEARCH_INVALID');
   const value=await runtime(raw,'read',false,{joinPendingCustody:true});await value.check();
   const compiled=compileEmailQuery(value.account.provider,input.query),identity={schema_version:'deft.email_search_page.v1',account_id:value.account.account_id,
    provider:value.account.provider,original_query:compiled.original_query,limitations:compiled.limitations,
    provider_result_cap:value.account.provider==='microsoft'?1000:null};
   if(compiled.status==='unsupported'){
    await value.checkFresh();return {...identity,status:'unsupported',items:[],next_cursor:null,has_more:false,query_complete:false,
     observed_at:new Date(now()).toISOString(),failure_count:0,unsupported:compiled.unsupported};
   }
   // Native human mailbox search is a read of the enrolled account. Legacy
   // Experience/AI search admission is separate and never synthesized here.
   const folderRole=compiled.request.folder_role,gmailLabel=folderRole?{inbox:'INBOX',sent:'SENT',drafts:'DRAFT',spam:'SPAM',trash:'TRASH'}[folderRole]:null,graphFolder=folderRole?{inbox:'inbox',sent:'sentitems',drafts:'drafts',spam:'junkemail',trash:'deleteditems'}[folderRole]:null;
   const page=await value.adapter.listMessages({query:compiled.request.query,cursor:input.cursor,limit:input.limit,
    ...(value.account.provider==='gmail'?{include_spam_trash:true,...(gmailLabel?{label_ids:[gmailLabel]}:{})}:graphFolder?{folder_id:graphFolder}:{})});
   await value.checkFresh();
   if(page.account_id!==value.account.account_id||!Array.isArray(page.messages)||page.messages.length>input.limit
    ||!Array.isArray(page.failures)||page.failures.length>input.limit||typeof page.observed_at!=='string'
    ||page.next_cursor!==null&&!oauthText(page.next_cursor,8192))oauthFail('EMAIL_NATIVE_SEARCH_INVALID');
   let systemFolders={};
   if(value.account.provider==='microsoft'&&raw.provider_state){
    await value.check();const state=await raw.provider_state.read(NATIVE_MICROSOFT_STATE_KEY);await value.check();
    const folders=state?.value?.system_folders;
    if(folders!==undefined){
     if(!folders||typeof folders!=='object'||Array.isArray(folders)||Buffer.byteLength(JSON.stringify(folders))>65536
      ||Object.values(folders).some(folder=>!['inbox','sent','drafts','trash','spam','archive'].includes(folder)))oauthFail('EMAIL_NATIVE_SEARCH_INVALID');
     systemFolders=folders;
    }
   }
   // A message may move between provider listing and metadata hydration. Keep
   // healthy scoped hits, but count mismatches as incomplete evidence. Never
   // invent a Graph opaque-folder role when the current map cannot prove it.
   if(page.messages.some(message=>message.account_id!==value.account.account_id))oauthFail('EMAIL_NATIVE_SEARCH_INVALID');
   const scopedMessages=page.messages.filter(message=>!folderRole||(value.account.provider==='gmail'
    ?message.folders?.includes(gmailLabel)
    :!Object.hasOwn(systemFolders,message.locator.folder_id)||systemFolders[message.locator.folder_id]===folderRole));
   const scopeFailures=page.messages.length-scopedMessages.length;
   const index=new LogicalMailIndex(value.scope),items=scopedMessages.map(message=>{
    const parent=index.upsert(value.scope,message),metadata=projectEmailMetadata(parent);
    return {account_id:value.account.account_id,logical_message_id:parent.logical_message_id,revision:metadata.revision,
     received_at:metadata.data.date||null,folders:value.account.provider==='gmail'?gmailFolders(parent.summary.folders??[]):
      [microsoftFolderId(parent.locator.folder_id,systemFolders)],
     flags:{seen:parent.summary.flags?.seen??false,flagged:parent.summary.flags?.flagged??false,answered:parent.summary.flags?.answered??false},
     data:metadata.data,provider_source:providerSourceForParent(value.account,parent)};
   });
   if(new Set(items.map(item=>item.logical_message_id)).size!==items.length)oauthFail('EMAIL_NATIVE_SEARCH_INVALID');
   await value.checkFresh();return {...identity,status:'supported',items,next_cursor:page.next_cursor,has_more:page.next_cursor!==null,
    query_complete:value.account.provider==='gmail'&&page.next_cursor===null&&page.failures.length===0&&scopeFailures===0,
    observed_at:page.observed_at,failure_count:page.failures.length+scopeFailures,unsupported:[]};
  },
  nativeEmailPresentation(input,raw){return inspectNative(input,raw,'presentation');},
  nativeEmailCalendarParts(input,raw){return inspectNative(input,raw,'calendar');},
  nativeEmailFile(input,raw){return inspectNative(input,raw,'file');},
  nativeEmailImage(input,raw){return inspectNative(input,raw,'image');},
  async nativeEmailAccount(raw){
   const value=await runtime(raw,'read',true),{account}=value;
   // A read-only custody health check never renews tokens or calls a provider.
   return {account_id:account.account_id,provider:account.provider,resource_binding_id:account.resource_binding_id,
    authority_epoch:account.authority_epoch,connection_revision:value.connection_revision,principal_digest:value.principal_digest,health:account.health,
    capabilities:[...account.capabilities],primary_address:account.primary_address,display_label:account.display_label};
  },
  async nativeEmailSource(input,raw){
   // Server-only input read from the exact encrypted account cache. The bridge
   // never accepts a provider URL, fabricated projection or browser locator.
   oauthObject(input,['source'],'EMAIL_NATIVE_SOURCE_INVALID');
   if(!Object.hasOwn(input,'source'))oauthFail('EMAIL_NATIVE_SOURCE_INVALID');
   const value=await runtime(raw);await value.check();
   // Epoch rebasing belongs to the host provider after its immutable enrolled
   // principal comparison; this method requires the exact current source epoch.
   const parent=resolveProviderSource({scope:value.scope,account:value.account,source:input.source});
   const adapter=(value.account.provider==='gmail'?createGmailSourceAdapter:createMicrosoftSourceAdapter)({...value.adapterOptions,now,sourceMimeLimit:NATIVE_INCOMING_LIMITS.source_bytes});
   let result;
   try{
    result=await adapter.readSource(parent.locator,{signal:raw.signal,deadline:raw.expires_at,
     ...(value.account.provider==='gmail'?{expected_thread_id:parent.locator.thread_id}:{})});
    await value.check();
    if(result.account_id!==value.account.account_id||result.provider!==value.account.provider)oauthFail('EMAIL_NATIVE_SOURCE_INVALID');
    return result;
   }catch(error){result?.mime_bytes?.fill(0);throw error;}
  },
  async nativeEmailPage(input,raw){
   oauthObject(input,['cursor','limit'],'EMAIL_NATIVE_PAGE_INVALID');
   if(!Object.hasOwn(input,'cursor')||input.cursor!==null&&(!oauthText(input.cursor,8192))||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100)oauthFail('EMAIL_NATIVE_PAGE_INVALID');
   const value=await runtime(raw);await value.check();
   if(raw.provider_state){
    const page=await(value.account.provider==='gmail'?readNativeGmailPage:readNativeMicrosoftPage)({runtime:value,provider_state:raw.provider_state,input});
    const index=new LogicalMailIndex(value.scope),items=page.messages.map(message=>{
     const parent=index.upsert(value.scope,message),metadata=projectEmailMetadata(parent);
     return {account_id:value.account.account_id,logical_message_id:parent.logical_message_id,revision:metadata.revision,
      received_at:metadata.data.date||null,folders:value.account.provider==='gmail'?gmailFolders(parent.summary.folders??[]):page.foldersFor(parent.locator.folder_id),
      flags:{seen:parent.summary.flags?.seen??false,flagged:parent.summary.flags?.flagged??false,answered:parent.summary.flags?.answered??false},
      data:metadata.data,provider_source:providerSourceForParent(value.account,parent),inventory_generation:page.generation};
    });
    await value.check();return {account_id:value.account.account_id,items,next_cursor:page.next_cursor,has_more:page.has_more,
     complete:page.complete,observed_at:new Date(now()).toISOString(),failure_count:page.failures?.length??0,tombstones:page.tombstones,state_updates:page.state_updates};
   }
   const page=await(value.adapter.listMetadataMessages??value.adapter.listMessages)({limit:input.limit,cursor:input.cursor,
    ...(value.account.provider==='gmail'?{include_spam_trash:true}:{} )});
   await value.check();
   if(page.account_id!==value.account.account_id||!Array.isArray(page.messages)||page.messages.length>input.limit
    ||!Array.isArray(page.failures)||page.failures.length>input.limit||typeof page.observed_at!=='string'
    ||page.next_cursor!==null&&!oauthText(page.next_cursor,8192))oauthFail('EMAIL_NATIVE_PAGE_INVALID');
   const index=new LogicalMailIndex(value.scope),items=page.messages.map(message=>{
    if(message.account_id!==value.account.account_id)oauthFail('EMAIL_NATIVE_PAGE_INVALID');
    const parent=index.upsert(value.scope,message),metadata=projectEmailMetadata(parent);
    return {account_id:value.account.account_id,logical_message_id:parent.logical_message_id,revision:metadata.revision,
     received_at:metadata.data.date||null,folders:value.account.provider==='gmail'?gmailFolders(parent.summary.folders??[]):[microsoftFolderId(parent.locator.folder_id)],
     flags:{seen:parent.summary.flags?.seen??false,flagged:parent.summary.flags?.flagged??false,answered:parent.summary.flags?.answered??false},
     data:metadata.data,provider_source:providerSourceForParent(value.account,parent)};
   });
   await value.check();
   // Initial enumeration's final page alone cannot prove inventory convergence
   // or correct deletions. Delta/reset state belongs in durable native storage.
   return {account_id:value.account.account_id,items,next_cursor:page.next_cursor,has_more:page.next_cursor!==null,
    complete:false,observed_at:page.observed_at,failure_count:page.failures.length,tombstones:[],state_updates:[]};
  },
 });
}
