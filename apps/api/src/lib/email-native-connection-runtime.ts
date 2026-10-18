import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {emailAccounts,emailAccountConsents} from '@deft/db/schema';
import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {PostgresEmailAccountConsentStore} from './email-account-consent-store.js';
import {PostgresNativeEmailConnectionOwner} from './email-native-connection-owner.js';
import {PostgresNativeEmailConnectionStore} from './email-native-connection-store.js';
import {NativeEmailConnectionAccountStore} from './email-native-connection-account-store.js';
import {NativeEmailConnectionService} from './email-native-connection-service.js';
import {getNativeEmailProfileRegistry} from './email-native-connection-registry.js';
import {resolveRetainedNativeEmailConnection} from './email-native-connection-retained-runtime.js';
import {assertNativeAccountAvailable,currentNativeAccountAvailable} from './email-native-adoption-gate.js';
import type {EmailAccountConsentTransaction} from './email-account-consent-store.js';

export async function getNativeEmailConnectionService(){
 const [{keys},registry]=await Promise.all([getAppRunRuntime(),getNativeEmailProfileRegistry()]),cipher=new EmailMailboxCrypto(keys),owner=new PostgresNativeEmailConnectionOwner(db),accounts=new NativeEmailConnectionAccountStore(db,cipher),consents=new PostgresEmailAccountConsentStore(db,cipher);
 const store=new PostgresNativeEmailConnectionStore(db,cipher,async(tx,record,verified)=>{const ceiling=record.binding.source==='retained_registry_v1'?record.binding.capabilities:registry.selected(record.binding).capabilities;return accounts.publish(tx,record,verified,ceiling);});
 return new NativeEmailConnectionService({store,current:(actor,scope,transaction,signal)=>owner.current(actor,scope,transaction,signal),
  providers:async()=>registry.providers(),provider:binding=>binding.source==='retained_registry_v1'?{
   async begin(b,browser,recheck,signal){const {profile,module_sha256}=await resolveRetainedNativeEmailConnection(b,cipher,recheck,signal);if(module_sha256!==b.module_sha256)throw Error('EMAIL_CONNECTION_PROFILE_UNAVAILABLE');return profile.connection.begin(b,browser,recheck,signal);},
   async complete(b,browser,input,recheck,signal){const {profile,module_sha256}=await resolveRetainedNativeEmailConnection(b,cipher,recheck,signal);if(module_sha256!==b.module_sha256)throw Error('EMAIL_CONNECTION_PROFILE_UNAVAILABLE');return profile.connection.complete(b,browser,input,recheck,signal);},
  }:registry.selected(binding).adapter.connection,
  assertBinding:async(actor,binding,signal)=>{
   await currentNativeAccountAvailable(db,{...binding.scope,account_id:binding.account_id});
   if(binding.source!=='retained_registry_v1'){const profile=registry.selected(binding);if(binding.capabilities.some(cap=>!profile.capabilities.includes(cap)))throw Error('EMAIL_CONNECTION_CAPABILITY_UNAVAILABLE');}await owner.current(actor,binding.scope,undefined,signal);
   const [account]=await db.select().from(emailAccounts).where(and(eq(emailAccounts.org_id,binding.scope.org_id),eq(emailAccounts.owner_user_id,binding.scope.owner_user_id),eq(emailAccounts.account_id,binding.account_id))).limit(1);
   if(binding.expected_native_revision===null){if(account)throw Error('EMAIL_ACCESS_DENIED');}
   else if(!account||account.credential_source!==binding.source||account.provider!==binding.provider||account.resource_binding_id!==binding.credential_binding_id||account.principal_digest!==binding.expected_principal_digest||account.authority_revision!==binding.expected_native_revision||account.state==='revoked')throw Error('EMAIL_ACCESS_DENIED');
   await owner.current(actor,binding.scope,undefined,signal);await currentNativeAccountAvailable(db,{...binding.scope,account_id:binding.account_id});
  },
  schedule:async(result,scope)=>{await(await import('./email-mailbox-scheduler-runtime.js')).scheduleNativeEmailAccount({...scope,account_id:result.account_id,authority_revision:result.native_revision});},
  select:async(actor,scope,input,signal)=>{
   const held=await owner.current(actor,scope,undefined,signal),recheck=async(transaction?:unknown)=>{const fresh=await owner.current(actor,scope,transaction,signal);if(fresh.authority_version!==held.authority_version)throw Error('EMAIL_ACCESS_DENIED');
    if(input.account_id){const selected={...scope,account_id:input.account_id};if(transaction)await assertNativeAccountAvailable(transaction as EmailAccountConsentTransaction,selected);else await currentNativeAccountAvailable(db,selected);}};
   if(input.account_id){
    const selected={...scope,account_id:input.account_id};await recheck();
    const [account]=await db.select().from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,input.account_id))).limit(1);
    const [row]=await db.select().from(emailAccountConsents).where(and(eq(emailAccountConsents.org_id,scope.org_id),eq(emailAccountConsents.owner_user_id,scope.owner_user_id),eq(emailAccountConsents.account_id,input.account_id))).limit(1);
    if(!account||!row||account.provider!==input.provider||account.state==='revoked')throw Error('EMAIL_ACCESS_DENIED');
    const consent=consents.decode(row);if(consent.bridge.kind==='retained_registry_v1'){
     const {profile,module_sha256}=await resolveRetainedNativeEmailConnection({scope,account_id:input.account_id,provider:input.provider,expected_native_revision:account.authority_revision,expected_principal_digest:account.principal_digest},cipher,()=>recheck(),signal);
     if(input.capabilities.some(cap=>!profile.capability_ceiling.includes(cap)))throw Error('EMAIL_CONNECTION_CAPABILITY_UNAVAILABLE');
     return {scope,account_id:input.account_id,provider:input.provider,source:'retained_registry_v1' as const,profile_id:'retained-registry',profile_revision:1,module_sha256,credential_namespace_id:profile.credential_namespace_id,credential_binding_id:profile.credential_binding_id,credential_action_id:profile.credential_action_id,connection_target:profile.connection_target,authority_epoch:profile.authority_epoch,capabilities:[...input.capabilities],expected_principal_digest:profile.principal_digest,expected_native_revision:account.authority_revision};
    }
    const binding=await accounts.read(selected,consent,recheck,signal),profile=registry.selected(binding);if(input.capabilities.some(cap=>!profile.capabilities.includes(cap)||!binding.capabilities.includes(cap)))throw Error('EMAIL_CONNECTION_CAPABILITY_UNAVAILABLE');await recheck();
    return {...binding,capabilities:[...input.capabilities]};
   }
   const profile=registry.forConnect(input.provider);if(input.capabilities.some(cap=>!profile.capabilities.includes(cap)))throw Error('EMAIL_CONNECTION_CAPABILITY_UNAVAILABLE');await recheck();return {scope,account_id:randomUUID(),provider:input.provider,source:'native_owner_provider_v1' as const,profile_id:profile.profile_id,profile_revision:profile.profile_revision,module_sha256:profile.module_sha256,
    credential_namespace_id:randomUUID(),credential_binding_id:randomUUID(),credential_action_id:randomUUID(),connection_target:'native-owner-mail',authority_epoch:1,capabilities:[...input.capabilities],expected_principal_digest:null,expected_native_revision:null};
  },
 });
}
