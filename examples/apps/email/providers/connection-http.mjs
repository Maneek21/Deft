const TOKEN_PROBE_CODES=new Set(['EMAIL_OAUTH_ACCOUNT_BINDING_DENIED', 'EMAIL_OAUTH_ACCOUNT_IDENTITY_CHANGED', 'EMAIL_OAUTH_ACCOUNT_INVALID', 'EMAIL_OAUTH_AUTHORITY_DENIED', 'EMAIL_OAUTH_BINDING_INVALID', 'EMAIL_OAUTH_BROWSER_BINDING_REQUIRED', 'EMAIL_OAUTH_CLIENT_CHANGED', 'EMAIL_OAUTH_CLIENT_CONFIG_INVALID', 'EMAIL_OAUTH_CUSTODY_BINDING_DENIED', 'EMAIL_OAUTH_CUSTODY_CONFIG_INVALID', 'EMAIL_OAUTH_CUSTODY_CONFLICT', 'EMAIL_OAUTH_CUSTODY_INVALID', 'EMAIL_OAUTH_CUSTODY_KEY_UNAVAILABLE', 'EMAIL_OAUTH_CUSTODY_LIMIT', 'EMAIL_OAUTH_CUSTODY_STORE_INVALID', 'EMAIL_OAUTH_CUSTODY_UNAVAILABLE', 'EMAIL_OAUTH_FILE_STORE_CONFIG_INVALID', 'EMAIL_OAUTH_FILE_STORE_FENCE_LOST', 'EMAIL_OAUTH_FILE_STORE_FILESYSTEM_UNSUPPORTED', 'EMAIL_OAUTH_FILE_STORE_FILE_INVALID', 'EMAIL_OAUTH_FILE_STORE_KEY_INVALID', 'EMAIL_OAUTH_FILE_STORE_LOCK_BUSY', 'EMAIL_OAUTH_FILE_STORE_PATH_INVALID', 'EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID', 'EMAIL_OAUTH_FILE_STORE_PAYLOAD_LIMIT', 'EMAIL_OAUTH_FILE_STORE_PLATFORM_UNSUPPORTED', 'EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE', 'EMAIL_OAUTH_FILE_STORE_STALE_LOCK', 'EMAIL_OAUTH_FILE_STORE_UNAVAILABLE', 'EMAIL_OAUTH_HOST_PORT_REQUIRED', 'EMAIL_OAUTH_IDENTITY_SCOPE_REQUIRED', 'EMAIL_OAUTH_INPUT_INVALID', 'EMAIL_OAUTH_MAILBOX_READ_REQUIRED', 'EMAIL_OAUTH_MAIL_SCOPE_REQUIRED', 'EMAIL_OAUTH_PROVIDER_IDENTITY_DENIED', 'EMAIL_OAUTH_PROVIDER_IDENTITY_INVALID', 'EMAIL_OAUTH_PROVIDER_NOT_CONFIGURED', 'EMAIL_OAUTH_PROVIDER_REQUEST_FAILED', 'EMAIL_OAUTH_PROVIDER_RESPONSE', 'EMAIL_OAUTH_PROVIDER_RESPONSE_INVALID', 'EMAIL_OAUTH_PROVIDER_RESPONSE_LIMIT', 'EMAIL_OAUTH_PROVIDER_SCOPE_DENIED', 'EMAIL_OAUTH_PROVIDER_UNAVAILABLE', 'EMAIL_OAUTH_REAUTH_REQUIRED', 'EMAIL_OAUTH_RECONNECT_IDENTITY_CHANGED', 'EMAIL_OAUTH_REFRESH_TOKEN_REQUIRED', 'EMAIL_OAUTH_SCOPE_DENIED', 'EMAIL_OAUTH_SCOPE_REDUCED', 'EMAIL_OAUTH_SETUP_LIMIT', 'EMAIL_OAUTH_SETUP_SUPERSEDED', 'EMAIL_OAUTH_STATE_AUTHORITY_CHANGED', 'EMAIL_OAUTH_STATE_CONFLICT', 'EMAIL_OAUTH_STATE_DENIED', 'EMAIL_OAUTH_STATE_EXPIRED', 'EMAIL_OAUTH_STATE_INVALID', 'EMAIL_OAUTH_STATE_REPLAY', 'EMAIL_OAUTH_TOKEN_RESPONSE_INVALID']);const tokenProbe=(stage,error,details={})=>{try{console.info(JSON.stringify({event:'email_token_probe',stage,code:TOKEN_PROBE_CODES.has(error?.code)?error.code:'OPAQUE_LOCAL_ERROR',...details}));}catch{}};
import {browseProviderResource,readProviderSource,resolveProviderSource,providerSourceForParent} from './provider-browser.mjs';
import {createGmailAdapter} from './gmail.mjs';
import {createMicrosoftAdapter} from './microsoft.mjs';
import {createNativeEmailBridge} from './native-mailbox.mjs';
import {createRetainedNativeEmailConnectionProfile} from './native-connection-retained.mjs';
import {createGmailSourceAdapter,createMicrosoftSourceAdapter} from './source-read.mjs';
import {inspectEmailSourceFiles} from './incoming-source-files.mjs';
import {loadPrivateMailIndex,resolvePrivateRecord,projectProviderDocument,projectConversationCoverage} from './resource-reader.mjs';
import {createEmailOAuth} from './oauth-account.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {createEmailFileCustodyStore} from './custody-file-store.mjs';
import {grantedOAuthCapabilities} from './oauth-provider.mjs';
import {validateEmailAccount,sameEmailScope} from '../account-registry.mjs';
import {EmailOAuthError,oauthFail,oauthObject,oauthText,sameOAuthBinding,validateOAuthBinding} from './oauth-contract.mjs';

const INTERNAL_ORIGIN='https://deft-connection.invalid';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
const publicView=account=>{const {connection_target,resource_binding_id,action_binding_id,authority_epoch,...view}=account;return view;};
function validOrigin(value){let url;try{url=new URL(value);}catch{oauthFail('EMAIL_CONNECTION_CONFIG_INVALID');}if(url.origin!==value||url.username||url.password||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))oauthFail('EMAIL_CONNECTION_CONFIG_INVALID');return value;}
async function bodyObject(request){
 if(request.headers.get('content-type')&&!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')))oauthFail('EMAIL_CONNECTION_INPUT_INVALID');
 if(Number(request.headers.get('content-length'))>4096)oauthFail('EMAIL_CONNECTION_INPUT_INVALID');
 const reader=request.body?.getReader(),chunks=[];let size=0;
 try{if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();oauthFail('EMAIL_CONNECTION_INPUT_INVALID');}chunks.push(Buffer.from(value));}const text=Buffer.concat(chunks).toString('utf8');let result;try{result=text?JSON.parse(text):{};}catch{oauthFail('EMAIL_CONNECTION_INPUT_INVALID');}oauthObject(result,['operation'],'EMAIL_CONNECTION_INPUT_INVALID');return result;}finally{reader?.releaseLock();}
}
function callbackInput(url){
 const entries=[...url.searchParams];if(entries.length>3||entries.some(([key])=>!['state','code','error'].includes(key))||new Set(entries.map(([key])=>key)).size!==entries.length)oauthFail('EMAIL_CONNECTION_INPUT_INVALID');
 const input=Object.fromEntries(entries);if(!oauthText(input.state,128)||input.state.length<16||Boolean(input.code)===Boolean(input.error)||input.code!==undefined&&!oauthText(input.code,4096)||input.error!==undefined&&!/^[a-zA-Z0-9_.-]{1,128}$/.test(input.error))oauthFail('EMAIL_CONNECTION_INPUT_INVALID');return input;
}
function accountFromRecord(binding,record){
 if(!record?.secret)return null;
 const identity=record.secret.identity;
 const health=record.health==='refresh_pending'||!sameOAuthBinding(record.binding,binding)?'reauth_required':record.health;
 try{return validateEmailAccount({account_id:binding.account_id,provider:binding.provider,display_label:identity.display_label,primary_address:identity.primary_address,verified_sender_identities:[...identity.verified_sender_identities],capabilities:grantedOAuthCapabilities(binding,record.secret.scopes),connection_target:binding.connection_target,resource_binding_id:binding.resource_binding_id,action_binding_id:binding.action_binding_id,authority_epoch:binding.authority_epoch,health});}catch{oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');}
}
/** Server-only authenticated module port. request/context are supplied by the host;
 * body/query values never select the owner, account, provider or reviewed target.
 * resolveSetup returns {binding,browser_binding,expires_at}; assertAuthority returns
 * fresh {allowed:true,expires_at}; publishAccount acknowledges durable custody. */
export function createEmailConnectionHttp({clients,custody,host,origin,fetch:fetchImpl=globalThis.fetch,now=Date.now}){
 origin=validOrigin(origin);
 if(typeof host?.resolveSetup!=='function'||typeof host?.assertAuthority!=='function'||typeof host?.publishAccount!=='function'||typeof custody?.withAccount!=='function'||typeof now!=='function')oauthFail('EMAIL_CONNECTION_HOST_PORT_REQUIRED');
 return Object.freeze({async handle(request,context=null){
  try{
   if(!(request instanceof Request))oauthFail('EMAIL_CONNECTION_INPUT_INVALID');request.signal.throwIfAborted();const url=new URL(request.url);
   if(![INTERNAL_ORIGIN,origin].includes(url.origin)||request.headers.get('origin')!==null&&request.headers.get('origin')!==origin)oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
   const route=url.pathname,callback=route==='/connections/callback';if(!['/connections/begin','/connections/callback','/connections/manage'].includes(route))return json({error:'Connection route unavailable',code:'EMAIL_CONNECTION_ROUTE_UNAVAILABLE'},404);
   if(request.method!==(callback?'GET':'POST'))return json({error:'Connection method unavailable',code:'EMAIL_CONNECTION_METHOD_INVALID'},405);
   const input=callback?callbackInput(url):await bodyObject(request);if(!callback&&url.search)oauthFail('EMAIL_CONNECTION_INPUT_INVALID');
   if(route==='/connections/begin'&&Object.keys(input).length||route==='/connections/manage'&&input.operation!==undefined&&!['status','disconnect'].includes(input.operation))oauthFail('EMAIL_CONNECTION_INPUT_INVALID');
   const purpose=route==='/connections/manage'?(input.operation??'status'):'connect';
   let setup;try{setup=await host.resolveSetup({request,purpose,state:callback?input.state:undefined,context});}catch{oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');}
   oauthObject(setup,['binding','browser_binding','expires_at'],'EMAIL_CONNECTION_AUTHORITY_DENIED');setup={binding:validateOAuthBinding(setup.binding),browser_binding:setup.browser_binding,expires_at:setup.expires_at};
   if(!oauthText(setup.browser_binding,1024)||!Number.isSafeInteger(setup.expires_at)||setup.expires_at<=now())oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
   let deadline=setup.expires_at;
   const check=async()=>{request.signal.throwIfAborted();let result;try{result=await host.assertAuthority({request,setup:structuredClone(setup),purpose,context});}catch{oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');}if(result?.allowed!==true||!Number.isSafeInteger(result.expires_at)||result.expires_at<=now()||deadline<=now())oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');deadline=Math.min(deadline,result.expires_at);return deadline;};
   await check();const binding=setup.binding;
   const oauth=createEmailOAuth({clients,custody,fetch:fetchImpl,now,host:{async resolveAccount({scope,account_id,purpose:oauthPurpose}){if(oauthPurpose!==purpose||account_id!==binding.account_id||!sameEmailScope(scope,binding.scope))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');await check();return binding;},async assertAuthority({binding:requested,purpose:oauthPurpose}){if(oauthPurpose!==purpose||!sameOAuthBinding(requested,binding))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');return {allowed:true,expires_at:await check()};}}});
   const status=async()=>{const account=await custody.withAccount(binding,async tx=>{await check();return accountFromRecord(binding,tx.read());});await check();return {state:account?.health??'not_connected',account:account?publicView(account):null};};
   const publish=async account=>{await check();let durable;try{durable=await host.publishAccount({request,setup:structuredClone(setup),account:structuredClone(account),context});}catch{oauthFail('EMAIL_CONNECTION_PUBLICATION_UNCONFIRMED');}if(durable!==true)oauthFail('EMAIL_CONNECTION_PUBLICATION_UNCONFIRMED');await check();};
   if(route==='/connections/begin'){const result=await oauth.begin({scope:binding.scope,account_id:binding.account_id,browser_binding:setup.browser_binding});await check();return json({...result,expires_at:Math.min(result.expires_at,deadline)});}
   if(callback){
    if(input.error){const pending=await custody.takeState({scope:binding.scope,state:input.state,browser_binding:setup.browser_binding});if(!sameOAuthBinding(pending.binding,binding))oauthFail('EMAIL_OAUTH_STATE_AUTHORITY_CHANGED');await check();oauthFail('EMAIL_CONNECTION_CANCELLED');}
    const account=await oauth.complete({scope:binding.scope,state:input.state,code:input.code,browser_binding:setup.browser_binding});await publish(account);return json({state:'connected',account:publicView(account)});
   }
   if(purpose==='disconnect'){await oauth.disconnect({scope:binding.scope,account_id:binding.account_id});const account=await custody.withAccount(binding,tx=>accountFromRecord(binding,tx.read()));await publish(account??{account_id:binding.account_id,health:'revoked'});}
   return json(await status());
  }catch(error){
   const code=error instanceof EmailOAuthError&&/^[A-Z][A-Z0-9_]{1,99}$/.test(error.code)?error.code:'EMAIL_CONNECTION_UNAVAILABLE';
   const status=code==='EMAIL_CONNECTION_INPUT_INVALID'||code==='EMAIL_CONNECTION_CANCELLED'?400:/(DENIED|CHANGED|EXPIRED|REPLAY|SUPERSEDED)/.test(code)?403:503;
   return json({error:'Account connection needs attention',code},status);
  }
 }});
}

const PROJECTION_FIELDS=['purpose','org_id','owner_user_id','web_session_id','experience_session_id','installation_id','app_version_id','grant_snapshot_id','target_key','resource_key','resource_binding_id','runtime_registration_id','descriptor_digest','action_key','action_binding_id','allowed_operations','lifecycle_epoch','grant_epoch','runtime_epoch','expires_at','checked_at'];
const IMMUTABLE_FIELDS=PROJECTION_FIELDS.filter(key=>!['checked_at','expires_at'].includes(key));
function projection(value,now){
 oauthObject(value,[...PROJECTION_FIELDS,'content_policy','reviewed_action_keys'],'EMAIL_CONNECTION_AUTHORITY_DENIED');
 if(!['connect','status','disconnect','read_document','read_source','triage_options','browse_resource'].includes(value.purpose))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
 if(PROJECTION_FIELDS.some(key=>!Object.hasOwn(value,key))||PROJECTION_FIELDS.filter(key=>!['action_key','action_binding_id','allowed_operations','lifecycle_epoch','grant_epoch','runtime_epoch','expires_at','checked_at'].includes(key)).some(key=>!oauthText(value[key]))||['action_key','action_binding_id'].some(key=>value[key]!==null&&!oauthText(value[key]))||Boolean(value.action_key)!==Boolean(value.action_binding_id)||['lifecycle_epoch','grant_epoch','runtime_epoch'].some(key=>!Number.isSafeInteger(value[key])||value[key]<1)||!Number.isSafeInteger(value.checked_at)||!Number.isSafeInteger(value.expires_at)||value.expires_at<=Math.max(now(),value.checked_at)||!Array.isArray(value.allowed_operations)||value.allowed_operations.length<(['status','disconnect'].includes(value.purpose)?0:1)||value.allowed_operations.length>3||value.allowed_operations.some(op=>!['list_summary','read_one','search'].includes(op))||new Set(value.allowed_operations).size!==value.allowed_operations.length)oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
 if(value.reviewed_action_keys!==undefined&&(!Array.isArray(value.reviewed_action_keys)||value.reviewed_action_keys.length>32||value.reviewed_action_keys.some(key=>typeof key!=='string'||! /^[a-z][a-z0-9_]{0,47}$/.test(key))||new Set(value.reviewed_action_keys).size!==value.reviewed_action_keys.length))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
 return structuredClone(value);
}
const sameProjection=(a,b)=>JSON.stringify([...(a.reviewed_action_keys??[])].sort())===JSON.stringify([...(b.reviewed_action_keys??[])].sort())&&JSON.stringify(a.content_policy??null)===JSON.stringify(b.content_policy??null)&&IMMUTABLE_FIELDS.every(key=>key==='allowed_operations'?a[key].length===b[key].length&&a[key].every(op=>b[key].includes(op)):a[key]===b[key]);
/** Digest-pinned deployment entry point. Account/provider/epoch/client/key/store
 * are operator-owned options; org/owner/session authority comes only from host.
 * custody/fetch/now overrides are trusted test/embedding injection, never JSON. */
export async function createAppConnectionAdapter({host,options,custody:injectedCustody,fetch:fetchImpl=globalThis.fetch,now=Date.now,monotonic=()=>performance.now(),indexStore,imageDependencies}){
 oauthObject(options,['origin','account_id','provider','authority_epoch','connection_target','resource_binding_id','action_binding_id','capabilities','clients','encryption_key_hex','key_id','custody_root','custody_owner_uid','index_path'],'EMAIL_CONNECTION_CONFIG_INVALID');
 if(typeof host?.resolveContext!=='function'||typeof host?.assertCurrent!=='function'||typeof monotonic!=='function')oauthFail('EMAIL_CONNECTION_HOST_PORT_REQUIRED');
 const selected=validateOAuthBinding({scope:{org_id:'configured-by-host',owner_id:'configured-by-host',installation_id:'configured-by-host'},account_id:options.account_id,provider:options.provider,connection_target:options.connection_target,resource_binding_id:options.resource_binding_id,action_binding_id:options.action_binding_id,authority_epoch:options.authority_epoch,capabilities:options.capabilities});
 const clients=structuredClone(options.clients),origin=validOrigin(options.origin),indexPath=options.index_path;
 let custody=injectedCustody;
 if(!custody){if(typeof options.encryption_key_hex!=='string'||!/^[a-fA-F0-9]{64}$/.test(options.encryption_key_hex))oauthFail('EMAIL_CONNECTION_CONFIG_INVALID');const store=await createEmailFileCustodyStore({root:options.custody_root,ownerUid:options.custody_owner_uid??null,now});custody=createEncryptedEmailCustody({encryption_key:Buffer.from(options.encryption_key_hex,'hex'),key_id:options.key_id,store,now});}
 async function currentProvider(context,initial,operation){
  const required=operation==='search'?'search':operation==='list'?'list_summary':'read_one';
  if(initial.target_key!==selected.connection_target||initial.resource_binding_id!==selected.resource_binding_id
   ||initial.action_binding_id!==selected.action_binding_id||!initial.allowed_operations.includes(required))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
  const signal=context?.signal;if(signal!==undefined&&!(signal instanceof AbortSignal))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
  const receivedAt=monotonic(),deadline=initial.expires_at;
  const check=async()=>{signal?.throwIfAborted();const current=projection(await host.assertCurrent(context),now);
   if(!sameProjection(initial,current)||Math.min(deadline,current.expires_at)<=Math.max(now(),initial.checked_at+Math.max(0,monotonic()-receivedAt))){tokenProbe('provider_projection_check',null,{mismatch_fields:IMMUTABLE_FIELDS.filter(key=>JSON.stringify(initial[key])!==JSON.stringify(current[key])),remaining_ms:Math.round(Math.min(deadline,current.expires_at)-Math.max(now(),initial.checked_at+Math.max(0,monotonic()-receivedAt)))});oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');}signal?.throwIfAborted();};
  const binding=validateOAuthBinding({...selected,scope:{org_id:initial.org_id,owner_id:initial.owner_user_id,installation_id:initial.installation_id}});
  await check();const account=await custody.withAccount(binding,async tx=>{await check();return accountFromRecord(binding,tx.read());});await check();
  if(!account||account.health!=='connected'||!account.capabilities.includes(operation==='search'?'search':operation==='conversation'?'thread':'read'))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
  const fetchCurrent=async(url,init={})=>{signal?.throwIfAborted();return fetchImpl(url,{...init,...(signal?{signal:init.signal?AbortSignal.any([signal,init.signal]):signal}:{})});};
  const oauth=createEmailOAuth({clients,custody,fetch:fetchCurrent,now,host:{async resolveAccount({scope,account_id,purpose}){
   if(!['read','search','thread'].includes(purpose)||account_id!==binding.account_id||!sameEmailScope(scope,binding.scope))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');await check();return binding;},
   async assertAuthority({binding:request,purpose}){if(!['read','search','thread'].includes(purpose)||!sameOAuthBinding(request,binding))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');await check();return {allowed:true,expires_at:deadline};}}});
  const adapterOptions={account,fetch:fetchCurrent,getAccessToken:request=>oauth.getAccessToken({scope:binding.scope,account,...request}),
   assertAuthority:async request=>{if(request.account_id!==account.account_id||request.authority_epoch!==account.authority_epoch||!['read','search','thread'].includes(request.operation))return false;await check();return true;}};
  const adapter=account.provider==='gmail'?createGmailAdapter(adapterOptions):createMicrosoftAdapter({...adapterOptions,body_format:initial.purpose==='read_document'&&initial.content_policy?.document.formats?.includes('html')?'html':'text'});
  return {scope:binding.scope,account,adapter,adapterOptions,check,signal,search_fields:context?.search_fields,search_filters:initial.content_policy?.search_filters};
 }
 async function currentTransient(record,context,initial,{document=false,source=false,optionsOnly=false}={}){
  if(!record||typeof record.record_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.record_id)
   ||typeof record.revision!=='string'||!record.revision||document&&initial.purpose!=='read_document'||source&&initial.purpose!=='read_source'||optionsOnly&&initial.purpose!=='triage_options'||!document&&!source&&!optionsOnly&&initial.purpose!=='connect')oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  const max_characters=document?initial.content_policy?.document?.max_characters:16384;
  if(!Number.isSafeInteger(max_characters)||max_characters<1||max_characters>16384)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  const runtime=await currentProvider(context,initial,'document');
  if(record.data?.account_id!==runtime.account.account_id||record.data?.logical_message_id!==record.provider_source?.logical_message_id
   ||record.data?.conversation_id!==record.provider_source?.conversation_id)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  if(optionsOnly){if(!initial.content_policy?.triage_options)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');resolveProviderSource({...runtime,source:record.provider_source});const {readProviderTriageOptions}=await import('./triage-options.mjs');const result=await readProviderTriageOptions(runtime.adapterOptions,initial.content_policy.triage_options);await runtime.check();return result;}
  if(source){const policy=initial.content_policy?.source;if(policy?.media_type!=='message/rfc822'||policy.filename!=='message.eml'||!Number.isInteger(policy.max_bytes)||policy.max_bytes<1||policy.max_bytes>8388608)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');const parent=resolveProviderSource({...runtime,source:record.provider_source}),adapter=runtime.account.provider==='gmail'?createGmailSourceAdapter({...runtime.adapterOptions,now}):createMicrosoftSourceAdapter({...runtime.adapterOptions,now});const result=await adapter.readSource(parent.locator,{signal:runtime.signal,deadline:initial.expires_at});try{await runtime.check();if(result.account_id!==runtime.account.account_id||result.mime_bytes.byteLength>policy.max_bytes)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');return {bytes:result.mime_bytes,media_type:'message/rfc822',filename:'message.eml'};}catch(error){result.mime_bytes.fill(0);throw error;}}
  return readProviderSource({...runtime,source:record.provider_source,max_characters,formats:document?initial.content_policy.document.formats??['plain']:['plain']});
 }
 async function currentParent(record,context,initial,{document=false,source=false,optionsOnly=false}={}){
  if(initial.target_key!==selected.connection_target||initial.resource_binding_id!==selected.resource_binding_id||initial.action_binding_id!==selected.action_binding_id||!initial.allowed_operations.includes('read_one')||source&&initial.purpose!=='read_source'||optionsOnly&&initial.purpose!=='triage_options'||!source&&!optionsOnly&&document&&initial.purpose!=='read_document'||!source&&!optionsOnly&&!document&&initial.purpose!=='connect')oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
  if(optionsOnly&&(!Number.isInteger(initial.content_policy?.triage_options?.max_options)||initial.content_policy.triage_options.max_options<1||initial.content_policy.triage_options.max_options>100))oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  if(source&&(!initial.content_policy?.source||initial.content_policy.source.media_type!=='message/rfc822'||initial.content_policy.source.filename!=='message.eml'||!Number.isSafeInteger(initial.content_policy.source.max_bytes)||initial.content_policy.source.max_bytes<1||initial.content_policy.source.max_bytes>8388608))oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  if(document&&(!Number.isSafeInteger(initial.content_policy?.document?.max_characters)||initial.content_policy.document.max_characters<1||initial.content_policy.document.max_characters>16384))oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  const receivedAt=monotonic(),deadline=initial.expires_at;
  const check=async()=>{const current=projection(await host.assertCurrent(context),now);if(!sameProjection(initial,current)||Math.min(deadline,current.expires_at)<=Math.max(now(),initial.checked_at+Math.max(0,monotonic()-receivedAt)))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');};
  const binding=validateOAuthBinding({...selected,scope:{org_id:initial.org_id,owner_id:initial.owner_user_id,installation_id:initial.installation_id}});
  await check();const account=await custody.withAccount(binding,async tx=>{await check();return accountFromRecord(binding,tx.read());});await check();
  if(!account||account.health!=='connected'||!account.capabilities.includes('read'))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
  const load=()=>indexStore?indexStore.load(binding.scope):loadPrivateMailIndex(indexPath);
  await check();const state=await load();await check();const parent=resolvePrivateRecord({scope:binding.scope,account,state,record});
  const oauth=createEmailOAuth({clients,custody,fetch:fetchImpl,now,host:{async resolveAccount({scope,account_id,purpose}){if(purpose!=='read'||account_id!==binding.account_id||!sameEmailScope(scope,binding.scope))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');await check();return binding;},async assertAuthority({binding:request,purpose}){if(purpose!=='read'||!sameOAuthBinding(request,binding))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');await check();return {allowed:true,expires_at:deadline};}}});
  const adapterOptions={account,fetch:fetchImpl,getAccessToken:request=>oauth.getAccessToken({scope:binding.scope,account,...request}),assertAuthority:async request=>{if(request.account_id!==account.account_id||request.authority_epoch!==account.authority_epoch||request.operation!=='read')return false;await check();return true;}};
  if(optionsOnly){const {readProviderTriageOptions}=await import('./triage-options.mjs');const result=await readProviderTriageOptions(adapterOptions,initial.content_policy.triage_options);await check();const latest=resolvePrivateRecord({scope:binding.scope,account,state:await load(),record});await check();if(JSON.stringify(latest.locator)!==JSON.stringify(parent.locator))oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');return result;}
  if(source){
   const sourceAdapter=account.provider==='gmail'?createGmailSourceAdapter({...adapterOptions,now}):createMicrosoftSourceAdapter({...adapterOptions,now});
   const result=await sourceAdapter.readSource(parent.locator,{signal:context?.signal,deadline});
   try{await check();const latest=resolvePrivateRecord({scope:binding.scope,account,state:await load(),record});await check();if(JSON.stringify(latest.locator)!==JSON.stringify(parent.locator)||result.account_id!==account.account_id||result.provider!==account.provider||result.mime_bytes.byteLength>initial.content_policy.source.max_bytes)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');return {bytes:result.mime_bytes,media_type:'message/rfc822',filename:'message.eml'};}catch(error){result.mime_bytes.fill(0);throw error;}
  }
  const adapter=account.provider==='gmail'?createGmailAdapter(adapterOptions):createMicrosoftAdapter({...adapterOptions,body_format:document&&initial.content_policy.document.formats?.includes('html')?'html':'text'});
  const detail=await adapter.readMessage(parent.locator);await check();
  const latest=resolvePrivateRecord({scope:binding.scope,account,state:await load(),record});await check();
  if(JSON.stringify(latest.locator)!==JSON.stringify(parent.locator)||detail.message.locator.message_id!==parent.locator.message_id)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  const max_characters=document?initial.content_policy?.document?.max_characters:16384;
  const result=await projectProviderDocument({account,logical_message_id:parent.logical_message_id,detail,max_characters,formats:document?initial.content_policy.document.formats??['plain']:['plain']});await check();const finalState=await load();await check();const finalParent=resolvePrivateRecord({scope:binding.scope,account,state:finalState,record});if(JSON.stringify(finalParent.locator)!==JSON.stringify(parent.locator))oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');result.document.metadata={...result.document.metadata,...projectConversationCoverage({scope:binding.scope,account,state:finalState,record:finalParent,detail,now:now()})};await check();return result;
 }
 const native=createNativeEmailBridge({selected,clients,custody,accountFromRecord,fetch:fetchImpl,now,monotonic,imageDependencies});
 return Object.freeze({...native,nativeEmailConnectionProfile:createRetainedNativeEmailConnectionProfile({selected,clients,custody,fetch:fetchImpl,now}),async browseResource(input,context){
  const initial=projection(await host.resolveContext(context),now);if(initial.purpose!=='browse_resource')oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
  const runtime=await currentProvider(context,initial,input?.operation);let trusted=input;
  if(input?.operation==='conversation'){
   const record=input.source;
   if(!record||typeof record.record_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.record_id)
    ||typeof record.revision!=='string'||!record.revision||record.data?.account_id!==runtime.account.account_id)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
   await runtime.check();const parent=record.provider_source?resolveProviderSource({...runtime,source:record.provider_source}):resolvePrivateRecord({...runtime,state:indexStore?await indexStore.load(runtime.scope):await loadPrivateMailIndex(indexPath),record});await runtime.check();
   if(record.data.logical_message_id!==parent.logical_message_id||record.data.conversation_id!==parent.conversation_id)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
   trusted={...input,source:providerSourceForParent(runtime.account,parent)};
  }
  return browseProviderResource({...runtime,input:trusted});
 },async readSourceFiles(input,context){
  if(!input||Object.keys(input).some(key=>!['record','file_ref','presentation','image_ref'].includes(key))||!input.record||input.presentation!==undefined&&input.presentation!==true||input.file_ref!==undefined&&input.image_ref!==undefined)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  const initial=projection(await host.resolveContext(context),now);
  const check=async()=>{context?.signal?.throwIfAborted();const current=projection(await host.assertCurrent(context),now);if(!sameProjection(initial,current)||Math.min(initial.expires_at,current.expires_at)<=now())oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');};
  const source=await (input.record.provider_source?currentTransient:currentParent)(input.record,context,initial,{source:true});
  try{await check();const runtime=input.presentation?await currentProvider(context,initial,'document'):null;return await inspectEmailSourceFiles(source.bytes,{file_ref:input.file_ref,presentation:input.presentation,image_ref:input.image_ref,max_bytes:initial.content_policy.source.max_bytes,account:runtime?.account,conversation_id:input.record.data.conversation_id,check,fetchRemote:async nomination=>{await check();const {fetchPublicMessageImage}=await import('./remote-image-proxy.mjs');const result=await fetchPublicMessageImage(nomination.url,{signal:context?.signal,recheck:async()=>{await check();return true;}});try{await check();return result;}catch(error){result.bytes.fill(0);throw error;}}});}finally{source.bytes.fill(0);}
 },async readTriageOptions(input,context){if(!input||Object.keys(input).join(',')!=='record')oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');const initial=projection(await host.resolveContext(context),now);return (input.record?.provider_source?currentTransient:currentParent)(input.record,context,initial,{optionsOnly:true});},async readSource(input,context){
  if(!input||Object.keys(input).join(',')!=='record')oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  const initial=projection(await host.resolveContext(context),now);return (input.record?.provider_source?currentTransient:currentParent)(input.record,context,initial,{source:true});
 },async readResource(input,context){
  if(!input||Object.keys(input).sort().join(',')!=='operation,record'||input.operation!=='read_document')oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  const initial=projection(await host.resolveContext(context),now);return (await (input.record?.provider_source?currentTransient:currentParent)(input.record,context,initial,{document:true})).document;
 },async buildActionPayload(request,context){
  const initial=projection(await host.resolveContext(context),now);
  if(initial.purpose!=='connect'||initial.target_key!==selected.connection_target||initial.resource_binding_id!==selected.resource_binding_id
    ||initial.action_binding_id!==selected.action_binding_id||initial.action_binding_id!==request.binding.runtime_binding_id||!initial.action_key||initial.action_key!==request.binding.action_key
    ||['org_id','installation_id','app_version_id','grant_snapshot_id'].some(key=>initial[key]!==request.binding[key])
    ||initial.owner_user_id!==request.binding.owner_user_id||initial.target_key!==request.binding.resource_target_key)oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
  const check=async()=>{const current=projection(await host.assertCurrent(context),now);if(!sameProjection(initial,current)
    ||Math.min(initial.expires_at,current.expires_at)<=now())oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');};
  // This reads the already connected custody identity to build MIME. It neither
  // begins OAuth nor admits optional modify/delete operations. Send's exact
  // current pins above and its actual granted capability below remain required.
  const binding=validateOAuthBinding({...selected,scope:{org_id:initial.org_id,owner_id:initial.owner_user_id,installation_id:initial.installation_id}});
  await check();const account=await custody.withAccount(binding,async tx=>{await check();return accountFromRecord(binding,tx.read());});
  if(!account||account.health!=='connected'||!account.capabilities.includes('send'))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
  await check();const {buildEmailActionPayload}=await import('../outgoing-payload-builder.mjs');
  let trustedParent=null;
  if(['reply','reply_all'].includes(request.draft_value?.mode)){
   const sources=request.source_records;if(!sources||Object.keys(sources).join(',')!=='parent_record_id'||!Array.isArray(sources.parent_record_id)||sources.parent_record_id.length!==1)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
   const record=sources.parent_record_id[0];if(record.resource_key!=='inbox'||record.resource_binding_id!==initial.resource_binding_id||record.record_id!==request.input.parent_record_id||record.record_id!==request.draft_value.reply_record_id)oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
   const parentInput={record_id:record.record_id,revision:record.revision,label:record.label,data:record.data,...(record.provider_source?{provider_source:record.provider_source}:{})};const parent=await (record.provider_source?currentTransient:currentParent)(parentInput,context,initial);await check();
   if(!parent.reply)oauthFail('EMAIL_CONNECTION_REPLY_UNAVAILABLE');trustedParent={...parent.reply,account_id:account.account_id,authority_epoch:account.authority_epoch,org_id:initial.org_id,owner_id:initial.owner_user_id,record_id:record.record_id};
  }else if(request.source_records&&!(Object.keys(request.source_records).length===0||Object.keys(request.source_records).join(',')==='parent_record_id'&&Array.isArray(request.source_records.parent_record_id)&&request.source_records.parent_record_id.length===0))oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
  const result=await buildEmailActionPayload(request,account,trustedParent);await check();return result;
 },async handle(request,context){
  let initial,receivedAt,deadline;
  const resolve=async()=>{const value=projection(await host.resolveContext(context),now);if(value.target_key!==selected.connection_target||value.resource_binding_id!==selected.resource_binding_id||value.action_binding_id!==selected.action_binding_id)oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');initial=value;receivedAt=monotonic();deadline=value.expires_at;return value;};
  const current=async()=>{const value=projection(await host.assertCurrent(context),now);if(!initial||!sameProjection(value,initial)||deadline<=Math.max(now(),initial.checked_at+Math.max(0,monotonic()-receivedAt)))oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');deadline=Math.min(deadline,value.expires_at);return deadline;};
  const http=createEmailConnectionHttp({clients,custody,origin,fetch:fetchImpl,now,host:{
   async resolveSetup({purpose}){const value=await resolve();if(value.purpose!==purpose)oauthFail('EMAIL_CONNECTION_AUTHORITY_DENIED');
    // Cleanup preserves the reviewed ciphertext binding/ceiling. Those Send
    // pins nominate custody only; this purpose can neither mint nor use tokens.
    const capabilities=purpose==='connect'?selected.capabilities.filter(op=>op==='modify'?value.reviewed_action_keys?.includes('triage_message')===true:op==='permanent_delete'?value.reviewed_action_keys?.includes('permanent_delete_message')===true:op==='send'?value.action_binding_id!==null&&value.action_key!==null:value.allowed_operations.includes(op==='search'?'search':'read_one')):selected.capabilities;
    let binding=validateOAuthBinding({...selected,scope:{org_id:value.org_id,owner_id:value.owner_user_id,installation_id:value.installation_id},capabilities});
    if(purpose!=='connect'){
     // A connection may have been admitted with less than the configured
     // ceiling. Status/discard keep that exact stored subset, without upgrading
     // an old epoch/pin or treating descriptive scopes as operation authority.
     const retained=await custody.withAccount(binding,async tx=>{await current();const record=tx.read();return record&&sameEmailScope(record.binding.scope,binding.scope)&&['account_id','provider','connection_target','resource_binding_id','action_binding_id','authority_epoch'].every(key=>record.binding[key]===binding[key])&&record.binding.capabilities.every(op=>binding.capabilities.includes(op))?record.binding:binding;});
     await current();binding=validateOAuthBinding(retained);
    }
    return {binding,browser_binding:'deft.web_session:'+value.web_session_id,expires_at:await current()};},
   async assertAuthority(){return {allowed:true,expires_at:await current()};},
   async publishAccount({setup,account}){await current();const durable=await custody.withAccount(setup.binding,tx=>{const record=tx.read(),stored=accountFromRecord(setup.binding,record);return stored?JSON.stringify(stored)===JSON.stringify(account):record?.health==='revoked'&&sameOAuthBinding(record.binding,setup.binding)&&account?.account_id===setup.binding.account_id&&account.health==='revoked';});await current();return durable;}
  }});
  return http.handle(request,context);
 }});
}
