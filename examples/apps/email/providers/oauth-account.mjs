const TOKEN_PROBE_CODES=new Set(['EMAIL_OAUTH_ACCOUNT_BINDING_DENIED', 'EMAIL_OAUTH_ACCOUNT_IDENTITY_CHANGED', 'EMAIL_OAUTH_ACCOUNT_INVALID', 'EMAIL_OAUTH_AUTHORITY_DENIED', 'EMAIL_OAUTH_BINDING_INVALID', 'EMAIL_OAUTH_BROWSER_BINDING_REQUIRED', 'EMAIL_OAUTH_CLIENT_CHANGED', 'EMAIL_OAUTH_CLIENT_CONFIG_INVALID', 'EMAIL_OAUTH_CUSTODY_BINDING_DENIED', 'EMAIL_OAUTH_CUSTODY_CONFIG_INVALID', 'EMAIL_OAUTH_CUSTODY_CONFLICT', 'EMAIL_OAUTH_CUSTODY_INVALID', 'EMAIL_OAUTH_CUSTODY_KEY_UNAVAILABLE', 'EMAIL_OAUTH_CUSTODY_LIMIT', 'EMAIL_OAUTH_CUSTODY_STORE_INVALID', 'EMAIL_OAUTH_CUSTODY_UNAVAILABLE', 'EMAIL_OAUTH_FILE_STORE_CONFIG_INVALID', 'EMAIL_OAUTH_FILE_STORE_FENCE_LOST', 'EMAIL_OAUTH_FILE_STORE_FILESYSTEM_UNSUPPORTED', 'EMAIL_OAUTH_FILE_STORE_FILE_INVALID', 'EMAIL_OAUTH_FILE_STORE_KEY_INVALID', 'EMAIL_OAUTH_FILE_STORE_LOCK_BUSY', 'EMAIL_OAUTH_FILE_STORE_PATH_INVALID', 'EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID', 'EMAIL_OAUTH_FILE_STORE_PAYLOAD_LIMIT', 'EMAIL_OAUTH_FILE_STORE_PLATFORM_UNSUPPORTED', 'EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE', 'EMAIL_OAUTH_FILE_STORE_STALE_LOCK', 'EMAIL_OAUTH_FILE_STORE_UNAVAILABLE', 'EMAIL_OAUTH_HOST_PORT_REQUIRED', 'EMAIL_OAUTH_IDENTITY_SCOPE_REQUIRED', 'EMAIL_OAUTH_INPUT_INVALID', 'EMAIL_OAUTH_MAILBOX_READ_REQUIRED', 'EMAIL_OAUTH_MAIL_SCOPE_REQUIRED', 'EMAIL_OAUTH_PROVIDER_IDENTITY_DENIED', 'EMAIL_OAUTH_PROVIDER_IDENTITY_INVALID', 'EMAIL_OAUTH_PROVIDER_NOT_CONFIGURED', 'EMAIL_OAUTH_PROVIDER_REQUEST_FAILED', 'EMAIL_OAUTH_PROVIDER_RESPONSE', 'EMAIL_OAUTH_PROVIDER_RESPONSE_INVALID', 'EMAIL_OAUTH_PROVIDER_RESPONSE_LIMIT', 'EMAIL_OAUTH_PROVIDER_SCOPE_DENIED', 'EMAIL_OAUTH_PROVIDER_UNAVAILABLE', 'EMAIL_OAUTH_REAUTH_REQUIRED', 'EMAIL_OAUTH_RECONNECT_IDENTITY_CHANGED', 'EMAIL_OAUTH_REFRESH_TOKEN_REQUIRED', 'EMAIL_OAUTH_SCOPE_DENIED', 'EMAIL_OAUTH_SCOPE_REDUCED', 'EMAIL_OAUTH_SETUP_LIMIT', 'EMAIL_OAUTH_SETUP_SUPERSEDED', 'EMAIL_OAUTH_STATE_AUTHORITY_CHANGED', 'EMAIL_OAUTH_STATE_CONFLICT', 'EMAIL_OAUTH_STATE_DENIED', 'EMAIL_OAUTH_STATE_EXPIRED', 'EMAIL_OAUTH_STATE_INVALID', 'EMAIL_OAUTH_STATE_REPLAY', 'EMAIL_OAUTH_TOKEN_RESPONSE_INVALID']);const tokenProbe=(stage,error,details={})=>{try{console.info(JSON.stringify({event:'email_token_probe',stage,code:TOKEN_PROBE_CODES.has(error?.code)?error.code:'OPAQUE_LOCAL_ERROR',...details}));}catch{}};
import {createHash,randomBytes} from 'node:crypto';
import {validateEmailAccount,validateEmailScope,sameEmailScope} from '../account-registry.mjs';
import {EmailOAuthError,oauthFail,oauthObject,oauthText,sameOAuthBinding,validateOAuthBinding} from './oauth-contract.mjs';
import {createOAuthProvider,grantedOAuthCapabilities,requestedOAuthScopes} from './oauth-provider.mjs';

const STATE_TTL_MS=10*60*1000,TOKEN_SKEW_MS=30000;
const discardTokens=secret=>secret?{...secret,access_token:'discarded',refresh_token:'discarded',expires_at:0}:null;
const publicAccount=(binding,secret)=>validateEmailAccount({account_id:binding.account_id,provider:binding.provider,display_label:secret.identity.display_label,primary_address:secret.identity.primary_address,verified_sender_identities:[...secret.identity.verified_sender_identities],capabilities:grantedOAuthCapabilities(binding,secret.scopes),connection_target:binding.connection_target,resource_binding_id:binding.resource_binding_id,action_binding_id:binding.action_binding_id,authority_epoch:binding.authority_epoch,health:'connected'});
// Host closures must authenticate the human/runtime and resolve reviewed target
// custody. The supplied scope/account ID nominates a resource, never authority.
export function createEmailOAuth({clients,host,custody,fetch:fetchImpl=globalThis.fetch,now=Date.now}){
 oauthObject(clients,['gmail','microsoft'],'EMAIL_OAUTH_CLIENT_CONFIG_INVALID');
 if(typeof host?.resolveAccount!=='function'||typeof host?.assertAuthority!=='function'||typeof custody?.storeState!=='function'||typeof custody?.takeState!=='function'||typeof custody?.withAccount!=='function'||typeof now!=='function')oauthFail('EMAIL_OAUTH_HOST_PORT_REQUIRED');
 const providers=new Map(Object.entries(clients).map(([provider,client])=>[provider,createOAuthProvider({provider,client,fetch:fetchImpl,now})]));
 function inputScope(value){try{return validateEmailScope(value);}catch{oauthFail('EMAIL_OAUTH_SCOPE_DENIED');}}
 async function resolved(scope,account_id,purpose){
  if(!oauthText(account_id))oauthFail('EMAIL_OAUTH_INPUT_INVALID');let value;try{value=await host.resolveAccount({scope:{...scope},account_id,purpose});}catch(error){tokenProbe('resolve_account',error);oauthFail('EMAIL_OAUTH_AUTHORITY_DENIED');}
  const binding=validateOAuthBinding(value);if(!sameEmailScope(binding.scope,scope)||binding.account_id!==account_id)oauthFail('EMAIL_OAUTH_AUTHORITY_DENIED');return binding;
 }
 function checker(binding,purpose,deadline=Infinity){
  return async()=>{let current;try{current=await host.assertAuthority({binding:structuredClone(binding),purpose});}catch(error){tokenProbe('assert_authority',error);oauthFail('EMAIL_OAUTH_AUTHORITY_DENIED');}
   if(current?.allowed!==true||!Number.isSafeInteger(current.expires_at)||current.expires_at<=now()||deadline<=now())oauthFail('EMAIL_OAUTH_AUTHORITY_DENIED');deadline=Math.min(deadline,current.expires_at);return deadline;};
 }
 function selected(binding){const provider=providers.get(binding.provider);if(!provider)oauthFail('EMAIL_OAUTH_PROVIDER_NOT_CONFIGURED');return provider;}
 function validateSecret(secret){
  if(!secret||!oauthText(secret.access_token,16384)||!oauthText(secret.refresh_token,16384)||!Number.isSafeInteger(secret.expires_at)||!Array.isArray(secret.scopes)||secret.scopes.some(scope=>!oauthText(scope,2048))||!oauthText(secret.identity?.provider_subject)||!Array.isArray(secret.identity?.verified_sender_identities)||!oauthText(secret.client_fingerprint,64))oauthFail('EMAIL_OAUTH_CUSTODY_INVALID');return secret;
 }
 return Object.freeze({
  async begin(input){
   oauthObject(input,['scope','account_id','browser_binding']);const scope=inputScope(input.scope);if(!oauthText(input.browser_binding,1024))oauthFail('EMAIL_OAUTH_BROWSER_BINDING_REQUIRED');
   const binding=await resolved(scope,input.account_id,'connect'),checkAuthority=checker(binding,'connect');await checkAuthority();const provider=selected(binding),scopes=requestedOAuthScopes(binding),state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url'),expires_at=now()+STATE_TTL_MS;
   const setup_generation=await custody.withAccount(binding,async tx=>{await checkAuthority();return tx.advanceSetup();});
   await custody.storeState({state,binding,browser_binding:input.browser_binding,expires_at,secret:{verifier,scopes,client_fingerprint:provider.client_fingerprint,setup_generation}});await checkAuthority();return {authorization_url:provider.authorizationUrl({state,challenge,scopes}),expires_at};
  },
  async complete(input){
   oauthObject(input,['scope','state','code','browser_binding']);const scope=inputScope(input.scope);if(!oauthText(input.code,4096))oauthFail('EMAIL_OAUTH_INPUT_INVALID');
   const pending=await custody.takeState({scope,state:input.state,browser_binding:input.browser_binding}),binding=await resolved(scope,pending.binding.account_id,'connect');
   if(!sameOAuthBinding(binding,pending.binding))oauthFail('EMAIL_OAUTH_STATE_AUTHORITY_CHANGED');
   const provider=selected(binding),checkAuthority=checker(binding,'connect',pending.expires_at),secret=pending.secret;
   if(secret.client_fingerprint!==provider.client_fingerprint||!oauthText(secret.verifier,128)||!Number.isSafeInteger(secret.setup_generation)||secret.setup_generation<1||!Array.isArray(secret.scopes)||secret.scopes.join(' ')!==requestedOAuthScopes(binding).join(' '))oauthFail('EMAIL_OAUTH_STATE_INVALID');
   await checkAuthority();
   const account=await custody.withAccount(binding,async tx=>{
    const prior=tx.read();if(prior?.setup_generation!==secret.setup_generation)oauthFail('EMAIL_OAUTH_SETUP_SUPERSEDED');if(prior?.secret)validateSecret(prior.secret);
    const tokens=await provider.exchange({code:input.code,verifier:secret.verifier,scopes:secret.scopes,checkAuthority}),identity=await provider.verify({tokens,checkAuthority});
    if(prior?.secret&&identity.provider_subject!==prior.secret.identity.provider_subject)oauthFail('EMAIL_OAUTH_RECONNECT_IDENTITY_CHANGED');
    const credentials={...tokens,identity,client_fingerprint:provider.client_fingerprint};
    // Validate before custody; reduced scopes yield a reduced account descriptor.
    const account=publicAccount(binding,credentials);if(account.capabilities.length===0)oauthFail('EMAIL_OAUTH_MAIL_SCOPE_REQUIRED');
    await checkAuthority();await tx.write({health:'connected',secret:credentials});await checkAuthority();return account;
   });await checkAuthority();return account;
  },
  async getAccessToken(input){
   oauthObject(input,['scope','account','account_id','operation','authority_epoch']);const scope=inputScope(input.scope);
   let account;try{account=validateEmailAccount(input.account);}catch{oauthFail('EMAIL_OAUTH_ACCOUNT_INVALID');}
   if(input.account_id!==account.account_id||input.authority_epoch!==account.authority_epoch||!['read','search','thread','send','modify','permanent_delete'].includes(input.operation)||!account.capabilities.includes(input.operation))oauthFail('EMAIL_OAUTH_ACCOUNT_BINDING_DENIED');
   const binding=await resolved(scope,input.account_id,input.operation),expected=validateOAuthBinding({scope,account_id:account.account_id,provider:account.provider,connection_target:account.connection_target,resource_binding_id:account.resource_binding_id,action_binding_id:account.action_binding_id,authority_epoch:account.authority_epoch,capabilities:account.capabilities});
   // Scope reduction may narrow the public descriptor without broadening review.
   if(['provider','connection_target','resource_binding_id','action_binding_id','authority_epoch'].some(key=>binding[key]!==expected[key])||!binding.capabilities.includes(input.operation))oauthFail('EMAIL_OAUTH_ACCOUNT_BINDING_DENIED');
   const provider=selected(binding),checkAuthority=checker(binding,input.operation);await checkAuthority();
   const access_token=await custody.withAccount(binding,async tx=>{
    const prior=tx.read();if(!prior||prior.health!=='connected'||!sameOAuthBinding(prior.binding,binding))oauthFail('EMAIL_OAUTH_REAUTH_REQUIRED');let secret=validateSecret(prior.secret);
    if(secret.client_fingerprint!==provider.client_fingerprint)oauthFail('EMAIL_OAUTH_CLIENT_CHANGED');
    if(!grantedOAuthCapabilities(binding,secret.scopes).includes(input.operation))oauthFail('EMAIL_OAUTH_SCOPE_REDUCED');
    if(secret.expires_at<=now()+TOKEN_SKEW_MS){
     await checkAuthority();await tx.write({health:'refresh_pending',secret});
     try{
      const tokens=await provider.refresh({secret,checkAuthority}),identity=await provider.verify({tokens,checkAuthority});
      if(identity.provider_subject!==secret.identity.provider_subject)oauthFail('EMAIL_OAUTH_RECONNECT_IDENTITY_CHANGED');
      secret={...tokens,identity,client_fingerprint:provider.client_fingerprint};await checkAuthority();await tx.write({health:'connected',secret});
     }catch(error){
      // Preserve identity continuity while discarding unusable token bytes. A
      // pending durable marker is also fail-closed after process/lock failure.
      await tx.write({health:'reauth_required',secret:discardTokens(secret)});
      if(error instanceof EmailOAuthError)throw error;oauthFail('EMAIL_OAUTH_REAUTH_REQUIRED');
     }
    }
    if(!grantedOAuthCapabilities(binding,secret.scopes).includes(input.operation))oauthFail('EMAIL_OAUTH_SCOPE_REDUCED');
    const verified=publicAccount(binding,secret);if(account.primary_address.toLowerCase()!==verified.primary_address||input.operation==='send'&&account.verified_sender_identities.some(address=>!verified.verified_sender_identities.includes(address.toLowerCase())))oauthFail('EMAIL_OAUTH_ACCOUNT_IDENTITY_CHANGED');
    await checkAuthority();return secret.access_token;
   });await checkAuthority();return access_token;
  },
  async disconnect(input){
   oauthObject(input,['scope','account_id']);const scope=inputScope(input.scope),binding=await resolved(scope,input.account_id,'disconnect'),checkAuthority=checker(binding,'disconnect');await checkAuthority();
   const result=await custody.withAccount(binding,async tx=>{await checkAuthority();const prior=tx.read();await tx.write({health:'revoked',secret:discardTokens(prior?.secret),advance_setup:true});await checkAuthority();return {account_id:binding.account_id,health:'revoked'};});await checkAuthority();return result;
  },
  async revokeProviderGrant(input){
   oauthObject(input,['scope','account_id']);const scope=inputScope(input.scope),binding=await resolved(scope,input.account_id,'revoke_provider_grant'),checkAuthority=checker(binding,'revoke_provider_grant');await checkAuthority();const provider=selected(binding);
   return custody.withAccount(binding,async tx=>{const prior=tx.read();const refresh_token=prior?.secret&&prior.health==='connected'?validateSecret(prior.secret).refresh_token:null;await checkAuthority();await tx.write({health:'revoked',secret:discardTokens(prior?.secret),advance_setup:true});if(!refresh_token)return {state:'already_disconnected'};return provider.revokeProjectGrant({refresh_token,checkAuthority});});
  }
 });
}
