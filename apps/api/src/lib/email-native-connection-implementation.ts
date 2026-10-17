import {createHash} from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
/** Operator compatibility proof. Hash private policy without returning it. The
 * digest includes exact client settings and custody routing, not implementation
 * paths or cache indexes. A changed policy needs separate reviewed migration. */
export function nativeEmailCredentialPolicyDigest(options:Record<string,unknown>,capabilities:readonly string[]):string{
 const provider=options.provider,clients=options.clients;
 if(!['gmail','microsoft'].includes(String(provider))||!clients||typeof clients!=='object'||Array.isArray(clients))throw Error('EMAIL_CONNECTION_PROFILE_UNAVAILABLE');
 const client=(clients as Record<string,unknown>)[String(provider)];
 if(!client||typeof client!=='object'||Array.isArray(client))throw Error('EMAIL_CONNECTION_PROFILE_UNAVAILABLE');
 const policy={provider,client,custody_root:options.custody_root,key_id:options.key_id,custody_owner_uid:options.custody_owner_uid??null,
  encryption_key_digest:typeof options.encryption_key_hex==='string'?createHash('sha256').update(options.encryption_key_hex.toLowerCase()).digest('hex'):null,
  capabilities:[...capabilities].sort(),routing:Object.fromEntries(['account_id','connection_target','resource_binding_id','action_binding_id','authority_epoch'].filter(k=>options[k]!==undefined).map(k=>[k,options[k]]))};
 return createHash('sha256').update(canonicalCapabilityJson(policy)).digest('hex');
}
export const nativeEmailImplementationDigest=(value:Readonly<{original_sha256:string;module_sha256:string;revision:number;credential_policy_sha256:string}>)=>createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex');
