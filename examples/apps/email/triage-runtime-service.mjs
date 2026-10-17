import {createAppRuntimeClient,parseRuntimeObjectInput} from '@deft/app-kit';
import {createEmailTriageService} from './triage-service.mjs';
import {LogicalMailIndex} from './logical-mail-index.mjs';
import {resolveProviderSource} from './providers/provider-browser.mjs';
import {EMAIL_METADATA_RECORD_SCHEMA,EMAIL_METADATA_VERSION} from './metadata-resource.mjs';
import {sameEmailScope} from './account-registry.mjs';
import {validateTriageBinding,validateTriageOperation,sameTriageState,exact} from './providers/triage-contract.mjs';
import {validateOAuthBinding,sameOAuthBinding} from './providers/oauth-contract.mjs';
import {validateOAuthClient,oauthClientFingerprint} from './providers/oauth-provider.mjs';
import {createEmailOAuth} from './providers/oauth-account.mjs';
import {createGmailTriageAdapter} from './providers/triage-gmail.mjs';
import {createMicrosoftTriageAdapter} from './providers/triage-microsoft.mjs';
import {fail,text} from './providers/contract.mjs';

export const EMAIL_TRIAGE_RUNTIME_WALL_MS=300000;
const uuid=value=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value??''))fail('EMAIL_TRIAGE_RUNTIME_INPUT_INVALID');return value.toLowerCase();};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
function csv(value,{max=16,ids=false}={}){if(typeof value!=='string'||value.length>(ids?925:4096))fail('EMAIL_TRIAGE_RUNTIME_INPUT_INVALID');const rows=value===''?[]:value.split(',');if(rows.length>max||new Set(rows).size!==rows.length||rows.some(row=>!row||row!==row.trim()))fail('EMAIL_TRIAGE_RUNTIME_INPUT_INVALID');return rows.map(row=>ids?uuid(row):text(row,256));}
export function parseTriageRuntimeInput(input){
 exact(input,['record_ids','operation','destination','add_labels','remove_labels']);if(Object.keys(input).length!==5||typeof input.destination!=='string'||input.destination.length>256)fail('EMAIL_TRIAGE_RUNTIME_INPUT_INVALID');
 const record_ids=csv(input.record_ids,{max:25,ids:true});if(!record_ids.length||new Set(record_ids).size!==record_ids.length)fail('EMAIL_TRIAGE_RUNTIME_INPUT_INVALID');
 if(input.operation==='undo'){
  if(input.add_labels!==''||input.remove_labels!=='')fail('EMAIL_TRIAGE_RUNTIME_INPUT_INVALID');
  return {record_ids,undo_of:uuid(input.destination)};
 }
 const operation={kind:input.operation};if(input.destination)operation.destination=text(input.destination,256);
 const add=csv(input.add_labels),remove=csv(input.remove_labels);if(input.operation==='labels'){operation.add_labels=add;operation.remove_labels=remove;}else if(add.length||remove.length)fail('EMAIL_TRIAGE_RUNTIME_INPUT_INVALID');
 return {record_ids,operation:validateTriageOperation(operation)};
}
export function validateTriageRuntimeConfig(value){
 exact(value,['schema_version','channel_url','credential','expected_run_id','binding','runtime_pin','oauth_binding','clients','resource_key','expires_at']);if(Object.keys(value).length!==10||value.schema_version!=='deft.email_triage_runtime.v1')fail('EMAIL_TRIAGE_RUNTIME_CONFIG_INVALID');
 const binding=validateTriageBinding(value.binding),oauth_binding=validateOAuthBinding(value.oauth_binding),pin=value.runtime_pin;uuid(binding.scope.owner_id);uuid(binding.account.resource_binding_id);uuid(binding.action_binding_id);
 const pinKeys=['org_id','app_installation_id','app_version_id','grant_snapshot_id','lifecycle_epoch','grant_epoch','runtime_registration_id','runtime_binding_id','runtime_epoch','session_id','session_epoch','audience','operation_name'];exact(pin,pinKeys);if(Object.keys(pin).length!==pinKeys.length||pin.audience!=='app_runtime'||!['triage_message','permanent_delete_message'].includes(pin.operation_name)||pin.org_id!==binding.scope.org_id||pin.app_installation_id!==binding.scope.installation_id||pin.runtime_binding_id!==binding.action_binding_id)fail('EMAIL_TRIAGE_RUNTIME_CONFIG_INVALID');
 for(const key of ['org_id','app_installation_id','app_version_id','grant_snapshot_id','runtime_registration_id','runtime_binding_id','session_id'])uuid(pin[key]);for(const key of ['lifecycle_epoch','grant_epoch','runtime_epoch','session_epoch'])if(!Number.isSafeInteger(pin[key])||pin[key]<0)fail('EMAIL_TRIAGE_RUNTIME_CONFIG_INVALID');
 exact(value.credential,['session_id','session_token']);if(value.credential.session_id!==pin.session_id||!/^[A-Za-z0-9_-]{32,512}$/.test(value.credential.session_token??''))fail('EMAIL_TRIAGE_RUNTIME_CONFIG_INVALID');
 if(!sameEmailScope(oauth_binding.scope,binding.scope)||['account_id','provider','connection_target','resource_binding_id','action_binding_id','authority_epoch'].some(key=>oauth_binding[key]!==binding.account[key])||binding.account.health!=='connected'||!['gmail','microsoft'].includes(binding.account.provider))fail('EMAIL_TRIAGE_RUNTIME_ACCOUNT_MISMATCH');
 exact(value.clients,['gmail','microsoft']);const clients=Object.fromEntries(Object.entries(value.clients).map(([provider,client])=>[provider,validateOAuthClient(provider,client)]));if(!clients[binding.account.provider])fail('EMAIL_TRIAGE_RUNTIME_CONFIG_INVALID');
 if(!/^[a-z][a-z0-9_]{0,47}$/.test(value.resource_key??'')||!Number.isFinite(Date.parse(value.expires_at)))fail('EMAIL_TRIAGE_RUNTIME_CONFIG_INVALID');
 return freeze(structuredClone({...value,expected_run_id:uuid(value.expected_run_id),binding,oauth_binding,clients}));
}

/** Machine-owned configuration plus authenticated SDK release are the only
 * authority. Host record UUIDs resolve through readActionResources; provider
 * locators resolve through the exact encrypted private logical index. */
export async function runEmailTriage({config:raw,indexStore,oauthCustody,journal,sdk:trustedSdk,fetch:fetchImpl=globalThis.fetch,now=Date.now}){
 const config=validateTriageRuntimeConfig(raw);if(typeof indexStore?.load!=='function'||typeof oauthCustody?.withAccount!=='function'||['create','load','change'].some(key=>typeof journal?.[key]!=='function'))fail('EMAIL_TRIAGE_RUNTIME_CUSTODY_REQUIRED');
 // The technical session expiry comes from trusted supervisor embedding.
 // This local wall cap is independent of the renewable attempt lease; every
 // boundary still renews/checks exact host authority through heartbeat.
 const expires=Math.min(Date.parse(config.expires_at),now()+EMAIL_TRIAGE_RUNTIME_WALL_MS);if(now()>=expires)fail('EMAIL_TRIAGE_RUNTIME_AUTHORITY_STALE');
 // Only trusted process embedding may inject the already-claimed SDK. JSON
 // configuration remains closed and can never supply a client or authority.
 const sdk=trustedSdk??createAppRuntimeClient({channel_url:config.channel_url,credential:config.credential,fetch:fetchImpl,action_resources_version:'deft.app_action_resources.v1'});
 if(typeof sdk.readActionResources!=='function')fail('EMAIL_TRIAGE_RUNTIME_HOST_PORT_REQUIRED');
 const claim=await sdk.claim();if(!claim)return {state:'idle',automatic_retry:false};
 if(claim.schema_version!=='deft.app_runtime_channel.v1'||claim.run_id!==config.expected_run_id||claim.initiating_actor_type!=='human'||claim.initiating_actor_id!==config.binding.scope.owner_id||Object.entries(config.runtime_pin).some(([key,value])=>claim[key]!==value)||!Number.isFinite(Date.parse(claim.lease_expires_at))||now()>=Date.parse(claim.lease_expires_at))fail('EMAIL_TRIAGE_RUNTIME_CLAIM_DENIED');uuid(claim.attempt_id);uuid(claim.claim_token);
 let started=false;
 try{
  const release=await sdk.start(claim);started=true;if(release.run_id!==claim.run_id||release.attempt_id!==claim.attempt_id||release.schema_version!==claim.schema_version||release.snapshot_ref!==undefined||!Number.isFinite(Date.parse(release.lease_expires_at))||now()>=Date.parse(release.lease_expires_at))fail('EMAIL_TRIAGE_RUNTIME_RELEASE_DENIED');
  const input=parseTriageRuntimeInput(release.input);
  const check=async()=>{if(now()>=expires||await sdk.heartbeat(claim)!==true||now()>=expires)fail('EMAIL_TRIAGE_RUNTIME_AUTHORITY_STALE');return true;};
  let original;
  if(input.undo_of){
   if(claim.operation_name!=='triage_message'||input.undo_of===claim.run_id)fail('EMAIL_TRIAGE_RUNTIME_UNDO_DENIED');
   await check();original=await journal.load(config.binding.scope,input.undo_of);await check();
   if(!original?.plan||original.plan.undo_of||!sameTriageState(original.plan.binding,config.binding))fail('EMAIL_TRIAGE_RUNTIME_UNDO_DENIED');
   input.operation=validateTriageOperation(original.plan.operation);
  }
  const permanent=input.operation.kind==='permanent_delete';if(permanent!==(claim.operation_name==='permanent_delete_message')||!config.binding.operations.includes(input.operation.kind))fail('EMAIL_TRIAGE_RUNTIME_CAPABILITY_DENIED');
  const providerCapability=permanent?'permanent_delete':'modify';
  if(!config.oauth_binding.capabilities.includes(providerCapability)||!config.binding.account.capabilities.includes(providerCapability))fail('EMAIL_TRIAGE_RUNTIME_PROVIDER_ACCESS_REQUIRED');
  await check();const records=await sdk.readActionResources(claim,{input_key:'record_ids'});await check();
  if(records.schema_version!=='deft.app_action_resources.v1'||records.input_key!=='record_ids'||records.resource_key!==config.resource_key||records.resource_binding_id!==config.binding.account.resource_binding_id||!sameEmailScope(records.scope,config.binding.scope)||records.records.length!==input.record_ids.length||!sameTriageState(records.records.map(row=>uuid(row.record_id)).sort(),[...input.record_ids].sort()))fail('EMAIL_TRIAGE_RUNTIME_RESOURCES_DENIED');
  await check();const needsIndex=records.records.some(row=>!row.provider_source),state=needsIndex?await indexStore.load(config.binding.scope):null;await check();if(needsIndex&&state===null)fail('EMAIL_TRIAGE_RUNTIME_INDEX_REQUIRED');const index=needsIndex?new LogicalMailIndex(config.binding.scope,{state}):null,resolved=new Map();
  for(const row of records.records){try{parseRuntimeObjectInput(EMAIL_METADATA_RECORD_SCHEMA,row.data);}catch{fail('EMAIL_TRIAGE_RUNTIME_RESOURCES_DENIED');}const data=row.data;if(data.metadata_version!==EMAIL_METADATA_VERSION||data.account_id!==config.binding.account.account_id||data.provider!==config.binding.account.provider||resolved.has(data.logical_message_id))fail('EMAIL_TRIAGE_RUNTIME_RESOURCES_DENIED');const record=row.provider_source?resolveProviderSource({scope:config.binding.scope,account:config.binding.account,source:row.provider_source}):index.get(config.binding.scope,data.account_id,data.logical_message_id);if(record.logical_message_id!==data.logical_message_id||record.conversation_id!==data.conversation_id)fail('EMAIL_TRIAGE_RUNTIME_RESOURCES_DENIED');resolved.set(data.logical_message_id,{record_id:uuid(row.record_id),locator:record.locator});}
  const logical_ids=input.record_ids.map(id=>[...resolved].find(([,row])=>row.record_id===id)?.[0]);if(logical_ids.some(value=>!value))fail('EMAIL_TRIAGE_RUNTIME_RESOURCES_DENIED');
  if(original&&!sameTriageState([...logical_ids].sort(),original.plan.items.map(item=>item.logical_id).sort()))fail('EMAIL_TRIAGE_RUNTIME_UNDO_DENIED');
  const oauth=createEmailOAuth({clients:config.clients,custody:oauthCustody,fetch:fetchImpl,now,host:{
   async resolveAccount({scope,account_id,purpose}){if(!sameEmailScope(scope,config.binding.scope)||account_id!==config.binding.account.account_id||purpose!==providerCapability)fail('EMAIL_TRIAGE_RUNTIME_ACCOUNT_MISMATCH');await check();return config.oauth_binding;},
   async assertAuthority({binding,purpose}){if(!sameOAuthBinding(binding,config.oauth_binding)||purpose!==providerCapability)fail('EMAIL_TRIAGE_RUNTIME_ACCOUNT_MISMATCH');await check();return {allowed:true,expires_at:expires};}
  }});
  const adapterOptions={binding:config.binding,fetch:fetchImpl,now,assertAuthority:async({binding,operation})=>{if(!sameTriageState(binding,config.binding)||operation!==input.operation.kind)return false;return check();},getAccessToken:async({binding,operation})=>{
   if(!sameTriageState(binding,config.binding)||operation!==input.operation.kind)fail('EMAIL_TRIAGE_RUNTIME_ACCOUNT_MISMATCH');await check();
   const token=await oauth.getAccessToken({scope:config.binding.scope,account:config.binding.account,account_id:config.binding.account.account_id,authority_epoch:config.binding.account.authority_epoch,operation:providerCapability});await check();
   const credential=await oauthCustody.withAccount(config.oauth_binding,async tx=>{const current=tx.read(),secret=current?.secret;if(!current||current.health!=='connected'||!sameOAuthBinding(current.binding,config.oauth_binding)||!current.binding.capabilities.includes(providerCapability)||!secret||typeof secret.access_token!=='string'||secret.access_token!==token||!Array.isArray(secret.scopes)||!Number.isSafeInteger(secret.expires_at)||secret.expires_at<=now()||secret.client_fingerprint!==oauthClientFingerprint(config.binding.account.provider,config.clients[config.binding.account.provider])||secret.identity?.primary_address?.toLowerCase()!==config.binding.account.primary_address.toLowerCase())fail('EMAIL_TRIAGE_RUNTIME_PROVIDER_ACCESS_REQUIRED');return {token:secret.access_token,granted_scopes:[...secret.scopes]};});await check();return credential;
  }};
  const adapter=config.binding.account.provider==='gmail'?createGmailTriageAdapter(adapterOptions):createMicrosoftTriageAdapter(adapterOptions);
  const service=createEmailTriageService({journal,now,adapterFor:async binding=>{if(!sameTriageState(binding,config.binding))fail('EMAIL_TRIAGE_RUNTIME_ACCOUNT_MISMATCH');return adapter;},resolveAuthority:async({scope,account_id,operation,review_digest})=>{if(!sameEmailScope(scope,config.binding.scope)||account_id!==config.binding.account.account_id||operation!==input.operation.kind)fail('EMAIL_TRIAGE_RUNTIME_ACCOUNT_MISMATCH');await check();return {binding:config.binding,actor:{kind:'human',user_id:claim.initiating_actor_id},expires_at:expires,...(permanent?{destructive_confirmation:{accepted:true,review_digest}}:{})};},resolveMessage:async({scope,account_id,logical_id})=>{await check();const row=resolved.get(logical_id);if(!row||!sameEmailScope(scope,config.binding.scope)||account_id!==config.binding.account.account_id)fail('EMAIL_TRIAGE_RUNTIME_RESOURCES_DENIED');return {scope,account_id,locator:row.locator};}});
  const plan=input.undo_of
   ? await service.prepareUndo({scope:config.binding.scope,operation_id:input.undo_of,expected_digest:original.plan.digest,undo_operation_id:claim.run_id})
   : await service.prepare({scope:config.binding.scope,account_id:config.binding.account.account_id,operation_id:claim.run_id,operation:input.operation,logical_ids});
  const outcome=await service.execute({scope:config.binding.scope,operation_id:claim.run_id,expected_digest:plan.digest});await check();
  const items=outcome.items.map(item=>({record_id:resolved.get(item.logical_id).record_id,state:item.state,...(item.code?{code:item.code}:{}),undo_supported:item.undo_supported}));
  const unknown=items.some(item=>['unknown','prepared'].includes(item.state));
  const output={operation_id:claim.run_id,succeeded_count:items.filter(item=>item.state==='succeeded').length,failed_count:items.filter(item=>item.state==='failed').length,unknown_count:items.filter(item=>['unknown','prepared'].includes(item.state)).length,undo_available:items.some(item=>item.undo_supported),automatic_retry:false,items:items.map(item=>`${item.record_id}: ${item.state}${item.code?' ('+item.code+')':''}`).join('\n')};if(output.items.length>4096)fail('EMAIL_TRIAGE_RUNTIME_RESULT_LIMIT');
  const acknowledged=await sdk.result(claim,unknown?{status:'indeterminate'}:{status:'returned',provider_succeeded:output.failed_count===0,output});
  if(acknowledged?.id!==claim.run_id||acknowledged.state!==(unknown?'unknown_outcome':output.failed_count===0?'succeeded':'failed'))fail('EMAIL_TRIAGE_RUNTIME_ACKNOWLEDGEMENT_UNKNOWN');
  return {state:unknown?'outcome_unknown':'triage_settled',run_id:claim.run_id,...output};
 }catch{if(started)try{await sdk.result(claim,{status:'indeterminate'});}catch{}return {state:'outcome_unknown',run_id:claim.run_id,automatic_retry:false};}
}
