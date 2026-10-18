import {EmailAccountRegistry,validateEmailScope} from '../account-registry.mjs';
import {LogicalMailIndex} from '../logical-mail-index.mjs';
import {createGmailAdapter} from './gmail.mjs';
import {createMicrosoftAdapter} from './microsoft.mjs';
import {createImapAdapter} from './imap.mjs';
import {createConversationReconciliation} from './conversation-reconciliation.mjs';
import {createMetadataResetReader,runMetadataReset} from './conversation-reset.mjs';
import {fail,digest,pageLimit} from './contract.mjs';

// Caller supplies a trusted reviewed deployment map and current host authority,
// never an owner bearer or authority inferred from provider/account labels.
export function createEmailAccountRuntime({scope,accounts,authorize,custody,fetch:fetchImpl=globalThis.fetch,indexState=null}){
 scope=validateEmailScope(scope);if(!Array.isArray(accounts)||accounts.length<1||accounts.length>32||!custody)fail('EMAIL_PROVIDER_RUNTIME_CONFIG_INVALID');
 const registry=new EmailAccountRegistry({scope,authorize}),index=new LogicalMailIndex(scope,{state:indexState});for(const account of accounts)registry.register(scope,account);
 async function adapter(account_id,operation){
  const account=await registry.resolve(scope,account_id,operation);
  const assertAuthority=async request=>{try{const current=await registry.resolve(scope,request.account_id,request.operation);return current.account_id===account.account_id&&current.authority_epoch===account.authority_epoch&&current.connection_target===account.connection_target&&current.resource_binding_id===account.resource_binding_id&&current.action_binding_id===account.action_binding_id;}catch{return false;}};
  if(account.provider==='imap_smtp')return createImapAdapter({account,scope,assertAuthority,connect:request=>{if(typeof custody.connectImap!=='function')fail('EMAIL_PROVIDER_CUSTODY_UNAVAILABLE');return custody.connectImap({scope,account,...request});},configuredFolders:custody.configuredFolders?.(account)});
  const options={account,fetch:fetchImpl,assertAuthority,getAccessToken:request=>{if(typeof custody.getAccessToken!=='function')fail('EMAIL_PROVIDER_CUSTODY_UNAVAILABLE');return custody.getAccessToken({scope,account,...request});},reserveSend:request=>{if(typeof custody.reserveSend!=='function')fail('EMAIL_PROVIDER_SEND_RESERVATION_REQUIRED');return custody.reserveSend({scope,account,...request});}};
  return {...(account.provider==='gmail'?createGmailAdapter(options):createMicrosoftAdapter(options)),...createConversationReconciliation(options),...createMetadataResetReader(options)};
 }
 function ingest(account_id,page){if(page.account_id!==account_id||page.messages.some(message=>message.account_id!==account_id))fail('EMAIL_PROVIDER_ACCOUNT_MISMATCH');return {...page,messages:page.messages.map(message=>index.upsert(scope,message)).filter(record=>!record.deletion)};}
 return Object.freeze({
  listAccounts:()=>registry.list(scope),
  revokeAccount:account_id=>registry.revoke(scope,account_id),
  async listMessages(account_id,request){return ingest(account_id,await(await adapter(account_id,'read')).listMessages(request));},
  async listMetadataMessages(account_id,request){const selected=await adapter(account_id,'read');return ingest(account_id,await(selected.listMetadataMessages??selected.listMessages)(request));},
  async searchMessages(account_id,request){return ingest(account_id,await(await adapter(account_id,'search')).searchMessages(request));},
  async readConversation(account_id,request){return ingest(account_id,await(await adapter(account_id,'thread')).readConversation(request));},
  // Private provider helper only. A host must independently govern the resource
  // and exact selected logical identity before exposing this bounded facet.
  async readConversationCoverage(account_id,{logical_message_id}){
   const account=await registry.resolve(scope,account_id,'thread');const record=index.get(scope,account_id,logical_message_id),page=index.conversationPage(scope,{account_id,conversation_id:record.conversation_id,limit:1});
   const reset_required=index.hasDeletionGap(scope,account_id),observed_at=page.coverage.observed_at,validObservation=typeof observed_at==='string'&&observed_at.length===24&&Number.isFinite(Date.parse(observed_at))&&new Date(observed_at).toISOString()===observed_at&&Date.parse(observed_at)<=Date.now(),coverage={complete:page.coverage.complete&&validObservation&&page.coverage.authority_epoch===account.authority_epoch&&page.coverage.resource_binding_id===account.resource_binding_id,covers_folders:[...new Set(page.coverage.covers_folders)],observed_at:validObservation?new Date(observed_at).toISOString():null};await registry.resolve(scope,account_id,'thread');return {schema_version:'deft.email_conversation_coverage.v1',account_id,logical_message_id,conversation_id:record.conversation_id,state:record.deletion?(record.deletion.kind==='provider_mailbox_deleted'?'deleted':'gone'):coverage.complete?'complete':'partial',reason:record.deletion?(record.deletion.kind==='provider_mailbox_deleted'?'provider_deleted':'current_mailbox_absent'):reset_required?'history_reset_required':null,coverage,count:{indexed:page.count.indexed,exact_total:coverage.complete?page.count.exact_total:null},reset_required};
  },
  async resetMetadataCoverage(account_id,request={}){if(!request||Array.isArray(request)||Object.keys(request).some(key=>!['limit','cursor','folder_ids'].includes(key)))fail('EMAIL_PROVIDER_INPUT_INVALID');const account=await registry.resolve(scope,account_id,'read'),resolve=async()=>{const current=await registry.resolve(scope,account_id,'read');if(account.provider==='microsoft'&&(typeof custody.authorizeMetadataResetScope!=='function'||await custody.authorizeMetadataResetScope({scope:{...scope},account:current,folder_ids:structuredClone(request.folder_ids)})!==true))fail('EMAIL_PROVIDER_RESET_SCOPE_DENIED');return current;};return runMetadataReset({...request,scope,account,index,resolve,adapter:()=>adapter(account_id,'read')});},
  async syncProviderDeletions(account_id,{limit=25,cursor=null,folder_id=null}={}){
   limit=pageLimit(limit);const account=await registry.resolve(scope,account_id,'read');if(!['gmail','microsoft'].includes(account.provider))fail('EMAIL_PROVIDER_OPERATION_UNSUPPORTED');
   if(account.provider==='gmail'&&folder_id!==null||account.provider==='microsoft'&&(typeof folder_id!=='string'||!folder_id||folder_id.length>2048||/[\r\n\0]/.test(folder_id)))fail('EMAIL_PROVIDER_INPUT_INVALID');
   const binding=digest({scope,account_id,provider:account.provider,epoch:account.authority_epoch,target:account.connection_target,resource_binding_id:account.resource_binding_id,folder_id,limit}),prior=index.takeDeletionHistory(scope,{account_id,folder_id,binding,cursor});
   let state=prior??{account_id,folder_id,binding,checkpoint:null,next_checkpoint:null,pending:[],provider_cursor:null,reset_required:false,token:null};let baseline_only=false;
   if(!state.pending.length){const raw=await(await adapter(account_id,'read')).readDeletionHistory({limit,folder_id,checkpoint:state.checkpoint,cursor:state.provider_cursor});state={...state,pending:raw.deletions,provider_cursor:raw.next_cursor,next_checkpoint:raw.checkpoint,reset_required:state.reset_required||raw.reset_required};baseline_only=raw.baseline_only;if(raw.reset_required)index.restartScan(scope,account_id);}
   const events=state.pending.slice(0,limit),remaining=state.pending.slice(limit),tombstones=new Map();await registry.resolve(scope,account_id,'read');
   for(const event of events){if(event.provider!==account.provider||event.authority_epoch!==account.authority_epoch)fail('EMAIL_PROVIDER_ACCOUNT_MISMATCH');const tombstone=index.recordProviderDeletion(scope,{account_id,provider:event.provider,provider_message_id:event.provider_message_id,provider_conversation_id:event.provider_conversation_id,evidence:{kind:event.kind,event_id:event.event_id,authority_epoch:event.authority_epoch,observed_at:new Date().toISOString()}});if(tombstone)tombstones.set(tombstone.id,tombstone);}
   state.pending=remaining;if(!remaining.length&&state.provider_cursor===null){state.checkpoint=state.next_checkpoint;state.next_checkpoint=null;}
   await registry.resolve(scope,account_id,'read');const next_cursor=index.saveDeletionHistory(scope,state);
   return {account_id,messages:[],failures:[],tombstones:[...tombstones.values()],next_cursor,has_more:next_cursor!==null,complete:false,reset_required:state.reset_required,baseline_only,observed_at:new Date().toISOString()};
  },
  // Trusted operator selects an existing logical identity; provider identifiers
  // and scope never come from a sync request or an untrusted message.
  async syncConversation(account_id,{logical_message_id,limit=25,cursor=null}){
   limit=pageLimit(limit);const account=await registry.resolve(scope,account_id,'thread'),record=index.get(scope,account_id,logical_message_id),locator=record.locator;
   if(record.deletion)fail('EMAIL_LOGICAL_MESSAGE_DELETED');
   if(!['gmail','microsoft'].includes(locator.kind))fail('EMAIL_PROVIDER_OPERATION_UNSUPPORTED');
   const binding=digest({scope,account_id,epoch:account.authority_epoch,target:account.connection_target,resource_binding_id:account.resource_binding_id,logical_message_id,conversation_id:record.conversation_id,limit}),state=index.takeConversationScan(scope,{account_id,conversation_id:record.conversation_id,binding,cursor});
   const observed_at=state?.observed_at??new Date().toISOString();
   const request={limit,cursor:state?.provider_cursor??null,...(locator.kind==='gmail'?{thread_id:locator.thread_id}:{conversation_id:locator.conversation_id})};
   const raw=await(await adapter(account_id,'thread')).readConversation(request);
   const native=locator.kind==='gmail'?locator.thread_id:locator.conversation_id;
   if(raw.provider_conversation_id!==native||raw.messages.some(message=>message.locator.kind!==locator.kind||(locator.kind==='gmail'?message.locator.thread_id:message.locator.conversation_id)!==native))fail('EMAIL_PROVIDER_RESPONSE_INVALID');
   const page=ingest(account_id,raw),folders=[...new Set([...(state?.folders??[]),...page.messages.flatMap(row=>row.summary.folders??[])])].sort(),count=(state?.count??0)+page.messages.length,failed=(state?.failed??false)||raw.failures.length>0;
   const pages=(state?.pages??0)+1;
   if(folders.length>100||count>10000||pages>10000)fail('EMAIL_PROVIDER_CURSOR_LIMIT');
   // A bounded multiset fingerprint prevents retained stale indexed messages or
   // replayed duplicate pages from making an exact coverage claim. No deletion
   // is inferred when a provider member is absent from this read.
   const modulus=1n<<256n,add=(sum,id)=>(sum+BigInt('0x'+digest(id)))%modulus;
   const sum=page.messages.reduce((sum,row)=>add(sum,row.logical_message_id),BigInt('0x'+(state?.sum??'0'.repeat(64))));
   const indexed=index.conversationPage(scope,{account_id,conversation_id:record.conversation_id,limit:100});
   const all=index.exportState(scope).records.filter(row=>!row.deletion&&row.account_id===account_id&&row.conversation_id===record.conversation_id);
   const matches=count===indexed.count.indexed&&sum===all.reduce((sum,row)=>add(sum,row.logical_message_id),0n);
   const complete=raw.complete===true&&!failed&&matches;
   await registry.resolve(scope,account_id,'thread');
   index.markCoverage(scope,{account_id,conversation_id:record.conversation_id,complete,covers_folders:folders,observed_at,authority_epoch:account.authority_epoch,resource_binding_id:account.resource_binding_id});
   const next_cursor=raw.has_more?index.saveConversationScan(scope,{account_id,conversation_id:record.conversation_id,binding,provider_cursor:raw.next_cursor,count,pages,failed,folders,observed_at,sum:sum.toString(16).padStart(64,'0')}):null;
   return {...page,next_cursor,has_more:next_cursor!==null,complete,coverage:index.conversationPage(scope,{account_id,conversation_id:record.conversation_id,limit:100}).coverage};
  },
  async readMessage(account_id,logical_message_id){const selected=await adapter(account_id,'read'),record=index.get(scope,account_id,logical_message_id);if(record.deletion)fail('EMAIL_LOGICAL_MESSAGE_DELETED');if(selected.provider==='imap_smtp'){if(typeof custody.resolveImapResourceId!=='function')fail('EMAIL_PROVIDER_OPERATION_UNSUPPORTED');const account=await registry.resolve(scope,account_id,'read');return selected.readMessage({locator:record.locator,resource_id:await custody.resolveImapResourceId({scope,account,locator:record.locator})});}return selected.readMessage(record.locator);},
  async send(account_id,snapshot){return(await adapter(account_id,'send')).send(snapshot);},
  conversationPage:request=>index.conversationPage(scope,request),
  recordMove:result=>index.recordMove(scope,result),
  restartScan:account_id=>index.restartScan(scope,account_id),
  exportIndex:()=>index.exportState(scope),
 });
}
