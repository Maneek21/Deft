import {createHash} from 'node:crypto';
import {createNativeEmailConnectionOAuth} from './native-connection-oauth.mjs';
import {validateOAuthClient,oauthClientFingerprint} from './oauth-provider.mjs';
import {oauthObject,oauthText,oauthFail,validateOAuthBinding} from './oauth-contract.mjs';
/** Exact registered adapter reconnect. Private clients/custody remain bound to
 * this closure; ordinary browser setup cannot choose their profile or routing. */
export function createRetainedNativeEmailConnectionProfile({selected,clients,custody,fetch,now=Date.now}){
 const client=validateOAuthClient(selected.provider,clients[selected.provider]),fingerprint=oauthClientFingerprint(selected.provider,client);
 const oauth=createNativeEmailConnectionOAuth({clients:{[selected.provider]:client},custody,fetch,now});
 return async context=>{
  oauthObject(context,['org_id','owner_user_id','account_id','installation_id','resource_binding_id','authority_version','expires_at','recheck','signal','owner_capabilities','lifecycle_inspect'],'EMAIL_NATIVE_CONNECTION_BINDING_INVALID');
  if(['org_id','owner_user_id','account_id','installation_id','resource_binding_id','authority_version'].some(k=>!oauthText(context[k]))||context.account_id!==selected.account_id||context.resource_binding_id!==selected.resource_binding_id||typeof context.recheck!=='function'||!Number.isSafeInteger(context.expires_at)||context.expires_at<=now()||context.signal!==undefined&&!(context.signal instanceof AbortSignal))oauthFail('EMAIL_NATIVE_CONNECTION_BINDING_INVALID');
  const check=async()=>{context.signal?.throwIfAborted();if(context.expires_at<=now())oauthFail('EMAIL_NATIVE_AUTHORITY_DENIED');await context.recheck();context.signal?.throwIfAborted();};
  const scope={org_id:context.org_id,owner_id:context.owner_user_id,installation_id:context.installation_id},nominated=validateOAuthBinding({...selected,scope});
  await check();const record=await custody.withAccount(nominated,async tx=>{await check();return tx.read();});await check();
  if(!record||record.secret?.client_fingerprint!==fingerprint||!oauthText(record.secret?.identity?.provider_subject)||!Number.isSafeInteger(record.setup_generation)||record.setup_generation<1||['account_id','provider','connection_target','resource_binding_id','action_binding_id','authority_epoch'].some(k=>record.binding[k]!==nominated[k])||record.binding.capabilities.some(c=>!nominated.capabilities.includes(c)))oauthFail('EMAIL_CONNECTION_PROFILE_UNAVAILABLE');
  const principal_digest=createHash('sha256').update(JSON.stringify([scope.org_id,scope.owner_id,nominated.provider,record.secret.identity.provider_subject])).digest('hex');
  const ceiling=selected.capabilities.filter(c=>['read','modify','send'].includes(c));if(!ceiling.includes('read'))oauthFail('EMAIL_CONNECTION_PROFILE_UNAVAILABLE');
  const profile={scope:{org_id:scope.org_id,owner_user_id:scope.owner_id},account_id:nominated.account_id,provider:nominated.provider,credential_namespace_id:scope.installation_id,credential_binding_id:nominated.resource_binding_id,credential_action_id:nominated.action_binding_id,connection_target:nominated.connection_target,authority_epoch:nominated.authority_epoch,capability_ceiling:Object.freeze([...ceiling]),principal_digest,credential_revision:record.setup_generation};
  const bound=raw=>{if(!raw||raw.source!=='retained_registry_v1'||raw.scope?.org_id!==profile.scope.org_id||raw.scope?.owner_user_id!==profile.scope.owner_user_id||['account_id','provider','credential_namespace_id','credential_binding_id','credential_action_id','connection_target','authority_epoch'].some(k=>raw[k]!==profile[k])||raw.expected_principal_digest!==principal_digest||!Array.isArray(raw.capabilities)||raw.capabilities.some(c=>!ceiling.includes(c)))oauthFail('EMAIL_NATIVE_CONNECTION_BINDING_INVALID');};
  return Object.freeze({...profile,connection:Object.freeze({
   async begin(raw,browser,recheck,signal){bound(raw);await check();const result=await oauth.begin(raw,browser,async()=>{await check();await recheck();},signal);await check();return result;},
   async complete(raw,browser,input,recheck,signal){bound(raw);await check();const result=await oauth.complete(raw,browser,input,async()=>{await check();await recheck();},signal);await check();return result;},
  })});
 };
}
