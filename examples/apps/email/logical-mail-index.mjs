import {createHash,randomUUID} from 'node:crypto';
import {validateEmailScope,sameEmailScope} from './account-registry.mjs';

export const LOGICAL_MAIL_LIMITS=Object.freeze({messages:10000,record_bytes:16384,page_items:100,aliases_per_message:32,state_bytes:33554432,cursor_bytes:2048});
const fail=code=>{throw Error(code);};
const text=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\r\n\0]/.test(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateProviderLocator(locator){
 if(!locator||typeof locator!=='object'||Array.isArray(locator))fail('EMAIL_LOGICAL_LOCATOR_INVALID');
 if(locator.kind==='gmail'){
  if(!text(locator.message_id)||!text(locator.thread_id)||!Array.isArray(locator.label_ids)||locator.label_ids.length>100||locator.label_ids.some(label=>!text(label)))fail('EMAIL_LOGICAL_LOCATOR_INVALID');
  return {kind:'gmail',message_id:locator.message_id,thread_id:locator.thread_id,label_ids:[...locator.label_ids]};
 }
 if(locator.kind==='microsoft'){
  if(!text(locator.message_id)||!text(locator.conversation_id)||!text(locator.folder_id)||locator.id_type!=='immutable')fail('EMAIL_LOGICAL_LOCATOR_INVALID');
  return {kind:'microsoft',message_id:locator.message_id,conversation_id:locator.conversation_id,folder_id:locator.folder_id,id_type:'immutable'};
 }
 if(locator.kind==='imap_smtp'){
  if(!text(locator.mailbox)||!/^\d{1,30}$/.test(locator.uidvalidity??'')||!Number.isSafeInteger(locator.uid)||locator.uid<1||locator.uid>4294967295)fail('EMAIL_LOGICAL_LOCATOR_INVALID');
  return {kind:'imap_smtp',mailbox:locator.mailbox,uidvalidity:locator.uidvalidity,uid:locator.uid};
 }
 fail('EMAIL_LOGICAL_LOCATOR_INVALID');
}
const locatorKey=(account,locator)=>JSON.stringify([account,locator.kind,locator.kind==='imap_smtp'?[locator.mailbox,locator.uidvalidity,locator.uid]:locator.message_id]);

// Provider-wide IDs remain stable across folders. Authenticated absence can
// identify a tombstone without fabricating message/thread metadata.
export function logicalMailIdForProviderMessage(scope,account_id,provider,message_id){
 const canonicalScope=validateEmailScope(scope);if(!text(account_id)||!['gmail','microsoft'].includes(provider)||!text(message_id))fail('EMAIL_LOGICAL_LOCATOR_INVALID');
 return `mail_${hash([canonicalScope,account_id,locatorKey(account_id,{kind:provider,message_id})])}`;
}

// Private Email state; the host must resolve current account authority before
// invoking it and persist exportState through governed account-owned resources.
export class LogicalMailIndex {
 #scope;#records=new Map();#aliases=new Map();#coverage=new Map();#scans=new Map();#history=new Map();#resets=new Map();#generation=0;
 constructor(scope,{state=null}={}){
  this.#scope=validateEmailScope(scope);
  if(state!==null){
   if(!['deft.email_logical_index.v1','deft.email_logical_index.v2'].includes(state.schema_version)||!sameEmailScope(state.scope,this.#scope)||!Number.isSafeInteger(state.generation)||state.generation<0||!Array.isArray(state.records)||state.records.length>LOGICAL_MAIL_LIMITS.messages||!Array.isArray(state.coverage)||state.coverage.length>LOGICAL_MAIL_LIMITS.messages||Buffer.byteLength(JSON.stringify(state))>LOGICAL_MAIL_LIMITS.state_bytes)fail('EMAIL_LOGICAL_STATE_INVALID');
   for(const row of state.records){if(!text(row.logical_message_id)||!text(row.conversation_id)||!text(row.account_id)||!Array.isArray(row.historical_locators)||row.historical_locators.length>LOGICAL_MAIL_LIMITS.aliases_per_message||this.#records.has(row.logical_message_id)||row.summary?.account_id!==row.account_id)fail('EMAIL_LOGICAL_STATE_INVALID');const current=validateProviderLocator(row.locator),history=row.historical_locators.map(validateProviderLocator);this.#validateMessage({...row.summary,locator:current});if(history.some(locator=>locator.kind!==current.kind))fail('EMAIL_LOGICAL_STATE_INVALID');for(const locator of [current,...history]){const key=locatorKey(row.account_id,locator);if(this.#aliases.has(key)&&this.#aliases.get(key)!==row.logical_message_id)fail('EMAIL_LOGICAL_STATE_INVALID');this.#aliases.set(key,row.logical_message_id);}this.#records.set(row.logical_message_id,structuredClone({...row,locator:current,historical_locators:history}));}
   for(const item of state.coverage){this.markCoverage(this.#scope,item);}
   if(state.conversation_scans!==undefined&&(!Array.isArray(state.conversation_scans)||state.conversation_scans.length>LOGICAL_MAIL_LIMITS.messages))fail('EMAIL_LOGICAL_STATE_INVALID');
   for(const scan of state.conversation_scans??[]){this.#validateScan(scan);const key=JSON.stringify([scan.account_id,scan.conversation_id]);if(this.#scans.has(key))fail('EMAIL_LOGICAL_STATE_INVALID');this.#scans.set(key,structuredClone(scan));}
   if(state.deletion_history!==undefined&&(!Array.isArray(state.deletion_history)||state.deletion_history.length>1024))fail('EMAIL_LOGICAL_STATE_INVALID');
   for(const scan of state.deletion_history??[]){this.#validateHistory(scan);const key=JSON.stringify([scan.account_id,scan.folder_id]);if(this.#history.has(key))fail('EMAIL_LOGICAL_STATE_INVALID');this.#history.set(key,structuredClone(scan));}
   for(const row of this.#records.values()){if(row.deletion!==undefined)this.#validateDeletion(row.deletion);if(row.last_absence!==undefined)this.#validateDeletion(row.last_absence);}
   if(state.metadata_resets!==undefined&&(!Array.isArray(state.metadata_resets)||state.metadata_resets.length>32))fail('EMAIL_LOGICAL_STATE_INVALID');
   for(const scan of state.metadata_resets??[]){this.#validateReset(scan);if(this.#resets.has(scan.account_id))fail('EMAIL_LOGICAL_STATE_INVALID');this.#resets.set(scan.account_id,structuredClone(scan));}
   this.#generation=state.generation;
  }
 }
 #check(scope){if(!sameEmailScope(scope,this.#scope))fail('EMAIL_LOGICAL_SCOPE_DENIED');}
 #validateScan(scan){
  if(!scan||Array.isArray(scan)||Object.keys(scan).sort().join(',')!=='account_id,binding,conversation_id,count,failed,folders,observed_at,pages,provider_cursor,sum,token'||!text(scan.account_id)||!text(scan.conversation_id)||!/^([a-f0-9]{64})$/.test(scan.binding)||!/^([a-f0-9]{64})$/.test(scan.sum)||!/^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(scan.token)||!Number.isSafeInteger(scan.count)||scan.count<0||scan.count>10000||!Number.isSafeInteger(scan.pages)||scan.pages<1||scan.pages>=10000||typeof scan.failed!=='boolean'||!Array.isArray(scan.folders)||scan.folders.length>100||new Set(scan.folders).size!==scan.folders.length||scan.folders.some(folder=>!text(folder))||typeof scan.observed_at!=='string'||scan.observed_at.length!==24||Number.isNaN(Date.parse(scan.observed_at))||Date.parse(scan.observed_at)>Date.now()||!text(scan.provider_cursor)||Buffer.byteLength(scan.provider_cursor)>LOGICAL_MAIL_LIMITS.cursor_bytes)fail('EMAIL_LOGICAL_SCAN_INVALID');
  if(![...this.#records.values()].some(row=>row.account_id===scan.account_id&&row.conversation_id===scan.conversation_id))fail('EMAIL_LOGICAL_NOT_FOUND');
 }
 // Only the opaque token crosses the host cursor boundary. Accumulated proof
 // remains in private persisted state and each continuation is consumed once.
 takeConversationScan(scope,{account_id,conversation_id,binding,cursor}){
  this.#check(scope);const key=JSON.stringify([account_id,conversation_id]),scan=this.#scans.get(key);
  if(cursor===null){this.#scans.delete(key);return null;}
  if(typeof cursor!=='string'||Buffer.byteLength(cursor)>LOGICAL_MAIL_LIMITS.cursor_bytes||!scan||scan.token!==cursor||scan.binding!==binding)fail('EMAIL_PROVIDER_CURSOR_INVALID');
  this.#scans.delete(key);return structuredClone(scan);
 }
 saveConversationScan(scope,scan){
  this.#check(scope);const value={...scan,token:randomUUID()};this.#validateScan(value);this.#scans.set(JSON.stringify([value.account_id,value.conversation_id]),structuredClone(value));return value.token;
 }
 #validateDeletion(evidence){
  if(!evidence||Object.keys(evidence).sort().join(',')!=='authority_epoch,event_id,kind,observed_at'||!['provider_mailbox_deleted','provider_mailbox_absent'].includes(evidence.kind)||!text(evidence.event_id)||!Number.isSafeInteger(evidence.authority_epoch)||evidence.authority_epoch<1||typeof evidence.observed_at!=='string'||evidence.observed_at.length!==24||Number.isNaN(Date.parse(evidence.observed_at))||Date.parse(evidence.observed_at)>Date.now())fail('EMAIL_LOGICAL_DELETION_INVALID');
 }
 #validateHistory(scan){
  if(!scan||Object.keys(scan).sort().join(',')!=='account_id,binding,checkpoint,folder_id,next_checkpoint,pending,provider_cursor,reset_required,token'||!text(scan.account_id)||!/^([a-f0-9]{64})$/.test(scan.binding)||scan.folder_id!==null&&!text(scan.folder_id)||['checkpoint','next_checkpoint','provider_cursor','token'].some(key=>scan[key]!==null&&(!text(scan[key])||Buffer.byteLength(scan[key])>LOGICAL_MAIL_LIMITS.cursor_bytes))||typeof scan.reset_required!=='boolean'||!Array.isArray(scan.pending)||scan.pending.length>10000||scan.pending.some(event=>!event||Object.keys(event).sort().join(',')!=='authority_epoch,event_id,kind,provider,provider_conversation_id,provider_message_id'||!['gmail','microsoft'].includes(event.provider)||event.kind!==(event.provider==='gmail'?'provider_mailbox_deleted':'provider_mailbox_absent')||!text(event.provider_message_id)||!text(event.event_id)||event.provider_conversation_id!==null&&!text(event.provider_conversation_id)||!Number.isSafeInteger(event.authority_epoch)||event.authority_epoch<1))fail('EMAIL_LOGICAL_HISTORY_INVALID');
  if((scan.token!==null)!==(scan.pending.length>0||scan.provider_cursor!==null))fail('EMAIL_LOGICAL_HISTORY_INVALID');
 }
 takeDeletionHistory(scope,{account_id,folder_id,binding,cursor}){
  this.#check(scope);const key=JSON.stringify([account_id,folder_id]),scan=this.#history.get(key);
  if(cursor!==null){if(typeof cursor!=='string'||!scan||scan.token!==cursor||scan.binding!==binding)fail('EMAIL_PROVIDER_CURSOR_INVALID');this.#history.delete(key);return structuredClone(scan);}
  if(scan?.binding===binding&&scan.token!==null)fail('EMAIL_PROVIDER_SYNC_RECOVERY_REQUIRED');
  this.#history.delete(key);return scan?.binding===binding?structuredClone(scan):scan?.reset_required?{...structuredClone(scan),binding,checkpoint:null,next_checkpoint:null,pending:[],provider_cursor:null,token:null}:null;
 }
 saveDeletionHistory(scope,scan){
  this.#check(scope);const value={...scan,token:scan.pending.length||scan.provider_cursor!==null?randomUUID():null};this.#validateHistory(value);const key=JSON.stringify([scan.account_id,scan.folder_id]);if(!this.#history.has(key)&&this.#history.size>=1024)fail('EMAIL_LOGICAL_HISTORY_LIMIT');this.#history.set(key,structuredClone(value));return value.token;
 }
 hasDeletionGap(scope,account_id){this.#check(scope);return [...this.#history.values()].some(scan=>scan.account_id===account_id&&scan.reset_required);}
 #validateReset(scan){if(!scan||Object.keys(scan).sort().join(',')!=='account_id,binding,token,value'||!text(scan.account_id)||!/^([a-f0-9]{64})$/.test(scan.binding)||!text(scan.token)||!scan.value||typeof scan.value!=='object'||Array.isArray(scan.value)||Buffer.byteLength(JSON.stringify(scan.value))>2097152)fail('EMAIL_LOGICAL_RESET_INVALID');}
 takeMetadataReset(scope,{account_id,binding,cursor}){this.#check(scope);const scan=this.#resets.get(account_id);if(cursor===null){this.#resets.delete(account_id);return null;}if(typeof cursor!=='string'||!scan||scan.token!==cursor||scan.binding!==binding)fail('EMAIL_PROVIDER_CURSOR_INVALID');this.#resets.delete(account_id);return structuredClone(scan.value);}
 saveMetadataReset(scope,{account_id,binding,value}){this.#check(scope);const scan={account_id,binding,value,token:randomUUID()};this.#validateReset(scan);if(!this.#resets.has(account_id)&&this.#resets.size>=32)fail('EMAIL_LOGICAL_RESET_LIMIT');this.#resets.set(account_id,structuredClone(scan));return scan.token;}
 beginMetadataReset(scope,{account_id,binding,folder_ids}){this.#check(scope);this.restartScan(scope,account_id);for(const folder_id of folder_ids){const key=JSON.stringify([account_id,folder_id]),prior=this.#history.get(key);this.#history.set(key,{account_id,binding:prior?.binding??binding,folder_id,checkpoint:prior?.checkpoint??null,next_checkpoint:null,pending:[],provider_cursor:null,token:null,reset_required:true});}}
 finishMetadataReset(scope,{account_id,checkpoints}){this.#check(scope);for(const {folder_id,checkpoint} of checkpoints){if(!text(checkpoint))fail('EMAIL_LOGICAL_RESET_INVALID');const key=JSON.stringify([account_id,folder_id]),scan=this.#history.get(key);if(!scan)fail('EMAIL_LOGICAL_RESET_INVALID');this.#history.set(key,{...scan,checkpoint,next_checkpoint:null,pending:[],provider_cursor:null,token:null,reset_required:false});}this.#resets.delete(account_id);}
 recordProviderDeletion(scope,{account_id,provider,provider_message_id,provider_conversation_id=null,evidence}){
  this.#check(scope);this.#validateDeletion(evidence);if(!text(account_id)||!['gmail','microsoft'].includes(provider)||provider==='microsoft'&&evidence.kind!=='provider_mailbox_absent'||!text(provider_message_id))fail('EMAIL_LOGICAL_DELETION_INVALID');
  const id=this.#aliases.get(JSON.stringify([account_id,provider,provider_message_id]));if(!id)return null;const record=this.#records.get(id);
  if(record.locator.kind!==provider||provider==='gmail'&&provider_conversation_id!==null&&provider_conversation_id!==record.locator.thread_id)fail('EMAIL_LOGICAL_DELETION_INVALID');
  if(!record.deletion){record.deletion=structuredClone(evidence);this.#coverage.delete(JSON.stringify([account_id,record.conversation_id]));this.#scans.delete(JSON.stringify([account_id,record.conversation_id]));this.#generation++;}
  return {id:record.logical_message_id,revision:hash({domain:'deft.email_provider_deletion.v1',account_id,id:record.logical_message_id,deletion:record.deletion})};
 }
 restoreProviderPresence(scope,message){this.#check(scope);const locator=this.#validateMessage(message),id=this.#aliases.get(locatorKey(message.account_id,locator)),record=id?this.#records.get(id):null;if(record?.deletion?.kind==='provider_mailbox_absent'){record.last_absence=structuredClone(record.deletion);delete record.deletion;}return this.upsert(scope,message);}
 #validateMessage(message){
  const keys=['account_id','provider','locator','subject','sender','recipients','cc','date','folders','flags','message_id','references','in_reply_to','body_status','files_status','failure'];
  if(!message||!text(message.account_id)||Object.keys(message).some(key=>!keys.includes(key))||Buffer.byteLength(JSON.stringify(message))>LOGICAL_MAIL_LIMITS.record_bytes)fail('EMAIL_LOGICAL_MESSAGE_INVALID');
  const locator=validateProviderLocator(message.locator);if(message.provider!==locator.kind||['subject','sender','recipients','cc','message_id','references','in_reply_to'].some(key=>message[key]!==undefined&&(typeof message[key]!=='string'||message[key].length>1000||/[\r\n\0]/.test(message[key])))||message.date!==undefined&&message.date!==null&&(typeof message.date!=='string'||message.date.length>64||Number.isNaN(Date.parse(message.date))))fail('EMAIL_LOGICAL_MESSAGE_INVALID');
  if(message.folders!==undefined&&(!Array.isArray(message.folders)||message.folders.length>100||message.folders.some(folder=>!text(folder))))fail('EMAIL_LOGICAL_MESSAGE_INVALID');
  if(message.flags!==undefined&&(!message.flags||typeof message.flags!=='object'||Array.isArray(message.flags)||Object.entries(message.flags).some(([key,value])=>!['seen','flagged','answered'].includes(key)||typeof value!=='boolean')))fail('EMAIL_LOGICAL_MESSAGE_INVALID');
  for(const key of ['body_status','files_status'])if(message[key]!==undefined&&!['lazy','available','oversize','unavailable','truncated','none','unknown'].includes(message[key]))fail('EMAIL_LOGICAL_MESSAGE_INVALID');
  if(message.failure!==undefined&&(!message.failure||Object.keys(message.failure).join(',')!=='code'||typeof message.failure.code!=='string'||!/^[A-Z0-9_]{1,100}$/.test(message.failure.code)))fail('EMAIL_LOGICAL_MESSAGE_INVALID');return locator;
 }
 upsert(scope,message){
  this.#check(scope);const locator=this.#validateMessage(message),key=locatorKey(message.account_id,locator),existingId=this.#aliases.get(key),existing=existingId?this.#records.get(existingId):null;
  // Historical locations remain resolvable, but stale page replay cannot undo
  // an authoritative move or resurrect the old folder membership.
  if(existing?.deletion)return structuredClone(existing);
  if(existing&&locatorKey(existing.account_id,existing.locator)!==key)return structuredClone(existing);
  if(!existing&&this.#records.size>=LOGICAL_MAIL_LIMITS.messages)fail('EMAIL_LOGICAL_MESSAGE_LIMIT');
  const logical_message_id=existingId??`mail_${hash([this.#scope,message.account_id,key])}`,nativeConversation=locator.kind==='gmail'?locator.thread_id:locator.kind==='microsoft'?locator.conversation_id:null;
  const conversation_id=existing?.conversation_id??`conversation_${hash([this.#scope,message.account_id,locator.kind,nativeConversation??logical_message_id])}`;
  const summary=structuredClone(message);delete summary.locator;
  const record={logical_message_id,account_id:message.account_id,conversation_id,locator,summary,historical_locators:existing?.historical_locators??[],...(existing?.last_absence?{last_absence:structuredClone(existing.last_absence)}:{})};
  this.#records.set(logical_message_id,record);this.#aliases.set(key,logical_message_id);this.#generation++;this.#coverage.delete(JSON.stringify([message.account_id,conversation_id]));return structuredClone(record);
 }
 get(scope,account_id,logical_message_id){this.#check(scope);const record=this.#records.get(logical_message_id);if(!record||record.account_id!==account_id)fail('EMAIL_LOGICAL_NOT_FOUND');return structuredClone(record);}
 resolveLocator(scope,account_id,locator){this.#check(scope);const id=this.#aliases.get(locatorKey(account_id,validateProviderLocator(locator)));if(!id)fail('EMAIL_LOGICAL_NOT_FOUND');return this.get(scope,account_id,id);}
 recordMove(scope,{account_id,logical_message_id,from_locator,to_locator,evidence}){
  this.#check(scope);if(evidence?.kind!=='provider_move'||!text(evidence.operation_id))fail('EMAIL_LOGICAL_MOVE_EVIDENCE_REQUIRED');const record=this.get(scope,account_id,logical_message_id),from=validateProviderLocator(from_locator),to=validateProviderLocator(to_locator),fromKey=locatorKey(account_id,from),toKey=locatorKey(account_id,to);
  if(record.locator.kind!==to.kind||fromKey!==locatorKey(account_id,record.locator))fail('EMAIL_LOGICAL_MOVE_STALE');const collision=this.#aliases.get(toKey);if(collision&&collision!==logical_message_id)fail('EMAIL_LOGICAL_MOVE_CONFLICT');
  if(fromKey!==toKey&&record.historical_locators.length>=LOGICAL_MAIL_LIMITS.aliases_per_message)fail('EMAIL_LOGICAL_ALIAS_LIMIT');
  if(fromKey!==toKey)record.historical_locators.push(record.locator);record.locator=to;record.last_move={kind:evidence.kind,operation_id:evidence.operation_id};
  record.summary.folders=to.kind==='gmail'?[...to.label_ids]:to.kind==='microsoft'?[to.folder_id]:[to.mailbox];this.#records.set(logical_message_id,record);this.#aliases.set(toKey,logical_message_id);this.#generation++;this.#coverage.delete(JSON.stringify([account_id,record.conversation_id]));return structuredClone(record);
 }
 markCoverage(scope,{account_id,conversation_id,complete,covers_folders=[],observed_at,authority_epoch=null,resource_binding_id=null}){
  this.#check(scope);if(!text(account_id)||!text(conversation_id)||typeof complete!=='boolean'||!Array.isArray(covers_folders)||covers_folders.length>100||covers_folders.some(folder=>!text(folder))||typeof observed_at!=='string'||Number.isNaN(Date.parse(observed_at)))fail('EMAIL_LOGICAL_COVERAGE_INVALID');
  if((authority_epoch===null)!==(resource_binding_id===null)||authority_epoch!==null&&(!Number.isSafeInteger(authority_epoch)||authority_epoch<1||!text(resource_binding_id)))fail('EMAIL_LOGICAL_COVERAGE_INVALID');
  if(![...this.#records.values()].some(row=>row.account_id===account_id&&row.conversation_id===conversation_id))fail('EMAIL_LOGICAL_NOT_FOUND');
  this.#coverage.set(JSON.stringify([account_id,conversation_id]),{account_id,conversation_id,complete,covers_folders:[...covers_folders],observed_at,...(authority_epoch===null?{}:{authority_epoch,resource_binding_id})});this.#generation++;
 }
 conversationPage(scope,{account_id,conversation_id,limit=25,cursor=null}){
  this.#check(scope);if(!text(account_id)||!text(conversation_id)||!Number.isInteger(limit)||limit<1||limit>LOGICAL_MAIL_LIMITS.page_items)fail('EMAIL_LOGICAL_PAGE_INVALID');let after=null;
  if(cursor!==null){let value;try{if(typeof cursor!=='string'||Buffer.byteLength(cursor)>LOGICAL_MAIL_LIMITS.cursor_bytes)throw Error();value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{fail('EMAIL_LOGICAL_CURSOR_INVALID');}if(value.account_id!==account_id||value.conversation_id!==conversation_id||value.scope!==hash(this.#scope)||!text(value.after))fail('EMAIL_LOGICAL_CURSOR_INVALID');if(value.generation!==this.#generation)fail('EMAIL_LOGICAL_CURSOR_EXPIRED');after=value.after;}
  const all=[...this.#records.values()].filter(row=>!row.deletion&&row.account_id===account_id&&row.conversation_id===conversation_id).sort((a,b)=>(a.summary.date??'').localeCompare(b.summary.date??'')||a.logical_message_id.localeCompare(b.logical_message_id));
  const offset=after===null?0:all.findIndex(row=>row.logical_message_id===after)+1;if(after!==null&&offset===0)fail('EMAIL_LOGICAL_CURSOR_INVALID');const messages=all.slice(offset,offset+limit).map(row=>structuredClone(row)),has_more=offset+limit<all.length;
  const next_cursor=has_more?Buffer.from(JSON.stringify({scope:hash(this.#scope),account_id,conversation_id,generation:this.#generation,after:messages.at(-1).logical_message_id})).toString('base64url'):null;
  const coverage=this.#coverage.get(JSON.stringify([account_id,conversation_id]));return {account_id,conversation_id,messages,next_cursor,has_more,complete:!has_more&&coverage?.complete===true,coverage:coverage??{complete:false,covers_folders:[],observed_at:null},count:{indexed:all.length,exact_total:coverage?.complete?all.length:null}};
 }
 restartScan(scope,account_id){this.#check(scope);if(!text(account_id))fail('EMAIL_LOGICAL_PAGE_INVALID');for(const map of [this.#coverage,this.#scans])for(const [key,value]of map)if(value.account_id===account_id)map.delete(key);this.#generation++;}
 exportState(scope){this.#check(scope);const state={schema_version:'deft.email_logical_index.v2',scope:{...this.#scope},generation:this.#generation,records:[...this.#records.values()].map(row=>structuredClone(row)),coverage:[...this.#coverage.values()].map(row=>structuredClone(row)),conversation_scans:[...this.#scans.values()].map(row=>structuredClone(row)),deletion_history:[...this.#history.values()].map(row=>structuredClone(row)),metadata_resets:[...this.#resets.values()].map(row=>structuredClone(row))};if(Buffer.byteLength(JSON.stringify(state))>LOGICAL_MAIL_LIMITS.state_bytes)fail('EMAIL_LOGICAL_STATE_LIMIT');return state;}
}
