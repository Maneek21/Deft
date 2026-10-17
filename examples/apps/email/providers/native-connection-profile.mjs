import {validateEmailAccount} from '../account-registry.mjs';
import {createNativeEmailBridge} from './native-mailbox.mjs';
import {createNativeEmailConnectionOAuth,nativeEmailConnectionOAuthBinding} from './native-connection-oauth.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {createEmailFileCustodyStore} from './custody-file-store.mjs';
import {grantedOAuthCapabilities} from './oauth-provider.mjs';
import {oauthObject,oauthFail} from './oauth-contract.mjs';

function accountFromRecord(binding,record){
 if(!record?.secret?.identity||record.health!=='connected')return null;
 const identity=record.secret.identity;
 return validateEmailAccount({account_id:binding.account_id,provider:binding.provider,display_label:identity.display_label,primary_address:identity.primary_address,
  verified_sender_identities:[...identity.verified_sender_identities],capabilities:grantedOAuthCapabilities(binding,record.secret.scopes),connection_target:binding.connection_target,
  resource_binding_id:binding.resource_binding_id,action_binding_id:binding.action_binding_id,authority_epoch:binding.authority_epoch,health:'connected'});
}
/** Deployment-owned native provider profile. All options are private server
 * configuration. The same custody/client instance serves connection setup and
 * ordinary mailbox ports, so no App graph or client-fingerprint rewrite occurs. */
export async function createNativeEmailProviderProfile({options,custody:injectedCustody,fetch:fetchImpl=globalThis.fetch,now=Date.now,monotonic=()=>performance.now(),imageDependencies}){
 oauthObject(options,['provider','clients','encryption_key_hex','key_id','custody_root','custody_owner_uid'],'EMAIL_CONNECTION_CONFIG_INVALID');
 if(!['gmail','microsoft'].includes(options.provider)||!options.clients||Object.keys(options.clients).length!==1||!options.clients[options.provider])oauthFail('EMAIL_CONNECTION_CONFIG_INVALID');
 const clients=structuredClone(options.clients);let custody=injectedCustody;
 if(!custody){
  if(typeof options.encryption_key_hex!=='string'||!/^[a-fA-F0-9]{64}$/u.test(options.encryption_key_hex))oauthFail('EMAIL_CONNECTION_CONFIG_INVALID');
  const store=await createEmailFileCustodyStore({root:options.custody_root,ownerUid:options.custody_owner_uid??null,now});
  custody=createEncryptedEmailCustody({encryption_key:Buffer.from(options.encryption_key_hex,'hex'),key_id:options.key_id,store,now});
 }
 const connection=createNativeEmailConnectionOAuth({clients,custody,fetch:fetchImpl,now});
 return Object.freeze({connection,mailbox(raw){
  const selected=nativeEmailConnectionOAuthBinding(raw);if(raw.source!=='native_owner_provider_v1'||selected.provider!==options.provider)oauthFail('EMAIL_NATIVE_CONNECTION_BINDING_INVALID');
  return createNativeEmailBridge({selected,clients,custody,accountFromRecord,fetch:fetchImpl,now,monotonic,imageDependencies});
 }});
}
