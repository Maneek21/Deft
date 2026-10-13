import {readFileSync,existsSync,openSync,writeSync,fsyncSync,closeSync,renameSync,unlinkSync,realpathSync} from 'node:fs';
import {resolve,dirname,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createDeftResourceSyncClientV3,parseSyncPageV2} from '@deft/app-kit';
import {validateEmailScope,validateEmailAccount} from '../account-registry.mjs';
import {LOGICAL_MAIL_LIMITS} from '../logical-mail-index.mjs';
import {createEmailAccountRuntime} from './account-runtime.mjs';
import {fail,text} from './contract.mjs';
import {projectEmailMetadata,EMAIL_METADATA_RECORD_SCHEMA,assertEmailMetadataDescriptor,validateMetadataFolderMap} from '../metadata-resource.mjs';

function deploymentMap(input){
 if(!Array.isArray(input)||input.length<1||input.length>32)fail('EMAIL_PROVIDER_DEPLOYMENT_MAP_INVALID');
 const map=input.map(value=>{if(!value||Object.keys(value).some(key=>!['account','resource_binding_id','runtime_registration_id','scope','session_id','folder_map','conversation','reconciliation','search'].includes(key))||['account','resource_binding_id','runtime_registration_id','scope','session_id'].some(key=>!Object.hasOwn(value,key)))fail('EMAIL_PROVIDER_DEPLOYMENT_MAP_INVALID');if(value.conversation!==undefined&&(!value.conversation||Array.isArray(value.conversation)||Object.keys(value.conversation).join(',')!=='logical_message_id'||typeof value.conversation.logical_message_id!=='string'||!/^mail_[a-f0-9]{64}$/.test(value.conversation.logical_message_id)))fail('EMAIL_PROVIDER_DEPLOYMENT_MAP_INVALID');if(value.reconciliation!==undefined&&(!value.reconciliation||Array.isArray(value.reconciliation)||Object.keys(value.reconciliation).some(key=>!['kind','folder_id','folder_ids'].includes(key))||!['provider_deletions','metadata_reset'].includes(value.reconciliation.kind)||value.reconciliation.kind==='provider_deletions'&&value.reconciliation.folder_ids!==undefined||value.reconciliation.kind==='metadata_reset'&&value.reconciliation.folder_id!==undefined||value.reconciliation.folder_ids!==undefined&&(!Array.isArray(value.reconciliation.folder_ids)||!value.reconciliation.folder_ids.length||value.reconciliation.folder_ids.length>100||[...value.reconciliation.folder_ids].some(id=>typeof id!=='string'||!id||id.length>2048||/[\r\n\0]/.test(id)))||value.conversation!==undefined||value.reconciliation.folder_id!==undefined&&(typeof value.reconciliation.folder_id!=='string'||!value.reconciliation.folder_id||value.reconciliation.folder_id.length>2048||/[\r\n\0]/.test(value.reconciliation.folder_id))))fail('EMAIL_PROVIDER_DEPLOYMENT_MAP_INVALID');if(value.search!==undefined&&(!value.search||Array.isArray(value.search)||Object.keys(value.search).join(',')!=='query'||typeof value.search.query!=='string'||!value.search.query.trim()||value.search.query.length>256||/[\r\n\0]/.test(value.search.query)||value.conversation!==undefined||value.reconciliation!==undefined))fail('EMAIL_PROVIDER_DEPLOYMENT_MAP_INVALID');const scope=validateEmailScope(value.scope),account=validateEmailAccount(value.account);for(const key of ['session_id','runtime_registration_id','resource_binding_id'])text(value[key],256);if(account.resource_binding_id!==value.resource_binding_id)fail('EMAIL_PROVIDER_DEPLOYMENT_MAP_INVALID');return {...value,scope,account,folder_map:validateMetadataFolderMap(value.folder_map)};});
 if(new Set(map.map(row=>JSON.stringify([row.session_id,row.runtime_registration_id,row.resource_binding_id]))).size!==map.length)fail('EMAIL_PROVIDER_DEPLOYMENT_MAP_INVALID');return map;
}
export const projectLogicalMessage=projectEmailMetadata;
export const EMAIL_LOGICAL_RECORD_SCHEMA=EMAIL_METADATA_RECORD_SCHEMA;

// Actual Sync v3 journey: claim -> exact reviewed map -> start -> heartbeat ->
// selected adapter/index -> descriptor validation -> durable stage -> host result.
export async function runEmailAccountSync({sdk,mappings,custody,stateStore,fetch:fetchImpl=globalThis.fetch,expectedRunId=null}){
 const map=deploymentMap(mappings);if(!sdk||!stateStore||typeof stateStore.load!=='function'||typeof stateStore.stage!=='function'||typeof stateStore.commit!=='function'||typeof stateStore.hasPending!=='function')fail('EMAIL_PROVIDER_SYNC_CONFIG_INVALID');
 if(await stateStore.hasPending())fail('EMAIL_PROVIDER_SYNC_RECOVERY_REQUIRED');
 const claim=await sdk.claim();if(!claim)return {state:'idle'};if(expectedRunId!==null&&claim.run_id!==expectedRunId)fail('EMAIL_PROVIDER_SYNC_CLAIM_MISMATCH');
 const matches=map.filter(row=>row.session_id===claim.session_id&&row.runtime_registration_id===claim.runtime_registration_id&&row.resource_binding_id===claim.resource_binding_id&&row.scope.org_id===claim.org_id&&row.scope.installation_id===claim.app_installation_id);
 if(matches.length!==1)fail('EMAIL_PROVIDER_TARGET_MAPPING_DENIED');const selected=matches[0],started=await sdk.start(claim);
 if(started.resource_binding_id!==selected.resource_binding_id||started.run_id!==claim.run_id||started.attempt_id!==claim.attempt_id||started.descriptor_digest!==claim.descriptor_digest||started.sequence!==claim.sequence)fail('EMAIL_PROVIDER_TARGET_MAPPING_DENIED');
 await assertEmailMetadataDescriptor(started.descriptor,started.descriptor_digest);
 try{parseSyncPageV2(started.descriptor,started.input,{schema_version:'deft.app_sync_page.v2',upserts:[],tombstones:[],next_cursor:null,has_more:false});}catch{fail('EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED');}
 const authorize=async({scope,account,operation})=>{if(!['read','search','thread'].includes(operation)||scope.org_id!==selected.scope.org_id||scope.owner_id!==selected.scope.owner_id||scope.installation_id!==selected.scope.installation_id||account.account_id!==selected.account.account_id||account.resource_binding_id!==selected.resource_binding_id||account.connection_target!==selected.account.connection_target||account.authority_epoch!==selected.account.authority_epoch)return false;try{const lease=await sdk.heartbeat(claim);return typeof lease==='string'&&Date.parse(lease)>Date.now();}catch{return false;}};
 const priorIndex=await stateStore.load(selected.scope);if(priorIndex!==null&&(!Array.isArray(priorIndex.records)||priorIndex.records.some(row=>row.account_id!==selected.account.account_id)||(priorIndex.deletion_history??[]).some(row=>row.account_id!==selected.account.account_id)))fail('EMAIL_PROVIDER_STATE_ACCOUNT_MISMATCH');
 const runtime=createEmailAccountRuntime({scope:selected.scope,accounts:[selected.account],authorize,custody,fetch:fetchImpl,indexState:priorIndex});let providerPage;
 try{
  const request={limit:started.input.max_items,cursor:started.input.cursor};
  const readPage=request=>selected.reconciliation?(selected.reconciliation.kind==='metadata_reset'?runtime.resetMetadataCoverage(selected.account.account_id,{...request,folder_ids:selected.reconciliation.folder_ids??null}):runtime.syncProviderDeletions(selected.account.account_id,{...request,folder_id:selected.reconciliation.folder_id??null})):selected.conversation?runtime.syncConversation(selected.account.account_id,{...request,...selected.conversation}):selected.search?runtime.searchMessages(selected.account.account_id,{...request,query:selected.search.query}):runtime.listMetadataMessages(selected.account.account_id,request);
  try{providerPage=await readPage(request);}catch(error){if(selected.reconciliation||error.code!=='EMAIL_PROVIDER_CURSOR_EXPIRED')throw error;runtime.restartScan(selected.account.account_id);providerPage=await readPage({...request,cursor:null});}
  if(providerPage.failures.length&&!selected.conversation)fail('EMAIL_PROVIDER_SYNC_PARTIAL_FAILURE');
  const cursor=providerPage.checkpoint_cursor??providerPage.next_cursor;if(cursor!==null&&Buffer.byteLength(cursor)>2048)fail('EMAIL_PROVIDER_SYNC_CURSOR_UNSUPPORTED');
  const folder_map=selected.folder_map??providerPage.folder_map??null;
  const candidate={schema_version:'deft.app_sync_page.v2',upserts:providerPage.messages.map(record=>projectEmailMetadata(record,{folder_map})),tombstones:providerPage.tombstones??[],next_cursor:cursor,has_more:providerPage.has_more};let page;
  try{page=parseSyncPageV2(started.descriptor,started.input,candidate);}catch{fail('EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED');}
  // New metadata sync does not assert deletions from a partial scan. In particular
  // raw IMAP tombstones cannot erase logical links without alias-aware evidence.
  await stateStore.stage({claim,started,page,index_state:runtime.exportIndex()});await sdk.result(claim,started,{status:'returned',provider_succeeded:true,page});
  await providerPage.commit?.();await stateStore.commit();return {state:'sync_settled',run_id:claim.run_id,account_id:selected.account.account_id,record_count:page.upserts.length,has_more:page.has_more,...(selected.reconciliation?{tombstone_count:page.tombstones.length,reset_required:providerPage.reset_required,baseline_only:providerPage.baseline_only??false,...(selected.reconciliation.kind==='metadata_reset'?{mailbox_reset_complete:providerPage.mailbox_reset_complete,covers_folders:providerPage.covers_folders}:{})}:{})};
 }finally{providerPage?.close?.();}
}

export class EmailSyncFileStateStore {
 constructor({index_path,recovery_path,inventory_path}){for(const path of [index_path,recovery_path])if(!isAbsolute(path))fail('EMAIL_PROVIDER_PRIVATE_PATH_REQUIRED');this.indexPath=index_path;this.recoveryPath=recovery_path;this.inventory=inventory_path;}
 async hasPending(){return existsSync(this.recoveryPath);}
 async load(){if(!existsSync(this.indexPath))return null;const bytes=readFileSync(this.indexPath);if(bytes.length>LOGICAL_MAIL_LIMITS.state_bytes)fail('EMAIL_PROVIDER_STATE_LIMIT');try{return JSON.parse(bytes.toString());}catch{fail('EMAIL_PROVIDER_STATE_INVALID');}}
 inventoryPath(){if(!isAbsolute(this.inventory??''))fail('EMAIL_PROVIDER_PRIVATE_PATH_REQUIRED');return this.inventory;}
 async stage(value){const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>LOGICAL_MAIL_LIMITS.state_bytes+1048576)fail('EMAIL_PROVIDER_STATE_LIMIT');const fd=openSync(this.recoveryPath,'wx',0o600);try{writeSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
 async commit(){const staged=JSON.parse(readFileSync(this.recoveryPath,'utf8')),pending=`${this.indexPath}.pending-${randomUUID()}`,fd=openSync(pending,'wx',0o600);try{writeSync(fd,JSON.stringify(staged.index_state));fsyncSync(fd);}finally{closeSync(fd);}renameSync(pending,this.indexPath);unlinkSync(this.recoveryPath);}
}

export async function runEmailAccountSyncCli(args){
 const [mode,configPath]=args;if(mode!=='sync'||!configPath||!isAbsolute(configPath))fail('EMAIL_PROVIDER_CONFIG_INVALID');
 const root=realpathSync(resolve(fileURLToPath(new URL('..',import.meta.url)))),publicRoots=[root];for(let directory=root;dirname(directory)!==directory;directory=dirname(directory))if(existsSync(resolve(directory,'.git'))){publicRoots.push(directory);break;}
 const privatePath=path=>{const absolute=resolve(dirname(configPath),path);const real=realpathSync(existsSync(absolute)?absolute:dirname(absolute));if(publicRoots.some(directory=>real===directory||real.startsWith(directory+sep)))fail('EMAIL_PROVIDER_PRIVATE_PATH_REQUIRED');return absolute;};
 privatePath(configPath);const bytes=readFileSync(configPath);if(bytes.length>65536)fail('EMAIL_PROVIDER_CONFIG_INVALID');const config=JSON.parse(bytes.toString());
 if(Object.keys(config).some(key=>!['schema_version','channel_url','credential','mappings','custody_module','index_path','recovery_path','inventory_path','expected_run_id'].includes(key))||config.schema_version!=='deft.email_account_service.v1'||typeof config.custody_module!=='string')fail('EMAIL_PROVIDER_CONFIG_INVALID');
 const sdk=createDeftResourceSyncClientV3({channel_url:config.channel_url,credential:config.credential}),store=new EmailSyncFileStateStore({index_path:privatePath(config.index_path),recovery_path:privatePath(config.recovery_path),...(config.inventory_path?{inventory_path:privatePath(config.inventory_path)}:{})}),module=await import(pathToFileURL(privatePath(config.custody_module)).href);if(typeof module.createEmailCustody!=='function')fail('EMAIL_PROVIDER_CUSTODY_UNAVAILABLE');
 const custody=await module.createEmailCustody();return runEmailAccountSync({sdk,mappings:config.mappings,custody,stateStore:store,expectedRunId:config.expected_run_id??null});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await runEmailAccountSyncCli(process.argv.slice(2))));}catch(error){const code=/^EMAIL_(PROVIDER|ACCOUNT|LOGICAL)_[A-Z_]+$/.test(error?.code??error?.message)?error.code??error.message:'EMAIL_PROVIDER_SYNC_UNCONFIRMED';console.error(JSON.stringify({state:'stopped',code,automatic_retry:false}));process.exitCode=1;}
}
