import {createHash} from 'node:crypto';
import {createEmailOAuth} from './oauth-account.mjs';
import {oauthObject,oauthText,validateOAuthBinding,sameOAuthBinding,oauthFail} from './oauth-contract.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
function selected(raw){
 oauthObject(raw,['scope','account_id','provider','source','profile_id','profile_revision','module_sha256','credential_namespace_id','credential_binding_id','credential_action_id','connection_target','authority_epoch','capabilities','expected_principal_digest','expected_native_revision'],'EMAIL_NATIVE_CONNECTION_BINDING_INVALID');
 oauthObject(raw.scope,['org_id','owner_user_id'],'EMAIL_NATIVE_CONNECTION_BINDING_INVALID');
 if(!['gmail','microsoft'].includes(raw.provider)||!['retained_registry_v1','native_owner_provider_v1'].includes(raw.source)||['account_id','profile_id','credential_namespace_id','credential_binding_id','connection_target'].some(k=>!oauthText(raw[k]))||!Number.isSafeInteger(raw.profile_revision)||raw.profile_revision<1||!validHash(raw.module_sha256)||raw.expected_principal_digest!==null&&!validHash(raw.expected_principal_digest)||raw.expected_native_revision!==null&&(!Number.isSafeInteger(raw.expected_native_revision)||raw.expected_native_revision<1)||!Array.isArray(raw.capabilities)||raw.capabilities.length>3||!raw.capabilities.includes('read')||new Set(raw.capabilities).size!==raw.capabilities.length||raw.capabilities.some(v=>!['read','modify','send'].includes(v)))oauthFail('EMAIL_NATIVE_CONNECTION_BINDING_INVALID');
 const capabilities=['read','search','thread',...raw.capabilities.filter(v=>v!=='read')];
 const binding=validateOAuthBinding({scope:{org_id:raw.scope.org_id,owner_id:raw.scope.owner_user_id,installation_id:raw.credential_namespace_id},account_id:raw.account_id,provider:raw.provider,connection_target:raw.connection_target,resource_binding_id:raw.credential_binding_id,action_binding_id:raw.credential_action_id,authority_epoch:raw.authority_epoch,capabilities});
 return {selected:structuredClone(raw),binding};
}
export const nativeEmailConnectionOAuthBinding=raw=>selected(raw).binding;
/** Shipped bundle factory. The API injects custody and exact trusted selection;
 * callers cannot supply OAuth clients, credentials, redirect URLs or App grants.
 * Legacy custody field names remain a serialization compatibility boundary. */
export function createNativeEmailConnectionOAuth({clients,custody,now=Date.now,fetch:fetchImpl=globalThis.fetch}){
 oauthObject(clients,['gmail','microsoft'],'EMAIL_OAUTH_CLIENT_CONFIG_INVALID');
 if(!custody||typeof custody.withAccount!=='function')oauthFail('EMAIL_OAUTH_HOST_PORT_REQUIRED');
 for(const client of Object.values(clients)){
  let redirect;try{redirect=new URL(client.redirect_uri);}catch{oauthFail('EMAIL_OAUTH_CLIENT_CONFIG_INVALID');}
  if(!['/email/connections/callback','/apps/connections/callback'].includes(redirect.pathname)||redirect.search||redirect.hash)oauthFail('EMAIL_OAUTH_CLIENT_CONFIG_INVALID');
 }
 function operation(raw,browserBinding,recheck,signal){
  const {selected:selection,binding}=selected(raw);if(!oauthText(browserBinding,1024)||typeof recheck!=='function')oauthFail('EMAIL_OAUTH_HOST_PORT_REQUIRED');
  const check=async()=>{signal?.throwIfAborted();await recheck();signal?.throwIfAborted();};
  const principal=subject=>digest([selection.scope.org_id,selection.scope.owner_user_id,selection.provider,subject]);
  // Identity is checked before the engine's encrypted credential write, rather
  // than rejecting only after a different principal has replaced the namespace.
  const checkedCustody={storeState:input=>custody.storeState(input),takeState:input=>custody.takeState(input),withAccount:(actual,work)=>{
   if(!sameOAuthBinding(actual,binding))oauthFail('EMAIL_OAUTH_ACCOUNT_BINDING_DENIED');
   return custody.withAccount(actual,tx=>work({read:()=>tx.read(),advanceSetup:()=>tx.advanceSetup(),write:async input=>{
    if(input.secret?.identity?.provider_subject&&selection.expected_principal_digest!==null&&principal(input.secret.identity.provider_subject)!==selection.expected_principal_digest)oauthFail('EMAIL_OAUTH_RECONNECT_IDENTITY_CHANGED');
    await check();return tx.write(input);
   }}));
  }};
  const oauth=createEmailOAuth({clients:{[selection.provider]:clients[selection.provider]},custody:checkedCustody,now,fetch:fetchImpl,host:{
   async resolveAccount(input){await check();if(input.account_id!==binding.account_id||JSON.stringify(input.scope)!==JSON.stringify(binding.scope)||input.purpose!=='connect')oauthFail('EMAIL_OAUTH_AUTHORITY_DENIED');return structuredClone(binding);},
   async assertAuthority(){await check();return {allowed:true,expires_at:now()+30000};},
  }});
  return {selection,binding,browserBinding,oauth,check,principal};
 }
 return Object.freeze({
  async begin(raw,browserBinding,recheck,signal){const op=operation(raw,browserBinding,recheck,signal);await op.check();const value=await op.oauth.begin({scope:op.binding.scope,account_id:op.binding.account_id,browser_binding:browserBinding});await op.check();return value;},
  async complete(raw,browserBinding,input,recheck,signal){
   oauthObject(input,['state','code']);const op=operation(raw,browserBinding,recheck,signal);await op.check();
   const account=await op.oauth.complete({scope:op.binding.scope,browser_binding:browserBinding,state:input.state,code:input.code});await op.check();
   const metadata=await custody.withAccount(op.binding,async tx=>{
    await op.check();const current=tx.read(),secret=current?.secret;if(current?.health!=='connected'||!secret?.identity?.provider_subject||!Number.isSafeInteger(current.setup_generation))oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');
    const principal_digest=op.principal(secret.identity.provider_subject);if(op.selection.expected_principal_digest!==null&&op.selection.expected_principal_digest!==principal_digest)oauthFail('EMAIL_OAUTH_RECONNECT_IDENTITY_CHANGED');
    return {account_id:account.account_id,provider:account.provider,principal_digest,credential_revision:current.setup_generation,authority_epoch:account.authority_epoch,capabilities:account.capabilities.filter(v=>['read','modify','send'].includes(v)),primary_address:account.primary_address,display_label:account.display_label,verified_sender_identities:[...account.verified_sender_identities]};
   });await op.check();return Object.freeze(metadata);
  },
 });
}
