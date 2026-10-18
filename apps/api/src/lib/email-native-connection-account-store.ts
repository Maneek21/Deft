import {and,eq} from 'drizzle-orm';
import {emailAccounts,emailAccountConsents,emailNativeAccountConnections} from '@deft/db/schema';
import {z} from 'zod';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailAccountConsentSchema,emailAccountBridgeBindingId,type EmailAccountConsent} from './email-account-lifecycle.js';
import {PostgresEmailAccountConsentStore} from './email-account-consent-store.js';
import {NativeEmailAccountBridgeSchema,nativeEmailAccountBridge} from './email-native-connection-profile.js';
import {NativeEmailConnectionCapabilitiesSchema,nativeEmailConnectionDigest,type NativeEmailConnectionRecord,type NativeEmailConnectionVerified,type NativeEmailConnectionResult,type NativeEmailConnectionBinding} from './email-native-connection-contract.js';
import type {NativeEmailConnectionTransaction} from './email-native-connection-store.js';
import type {db} from './db.js';
import type {EmailScope} from './email-mailbox-service.js';
type Database=Pick<typeof db,'transaction'>;
const descriptorSchema=z.strictObject({bridge:NativeEmailAccountBridgeSchema,capability_ceiling:NativeEmailConnectionCapabilitiesSchema});
const where=(table:typeof emailAccounts|typeof emailAccountConsents|typeof emailNativeAccountConnections,scope:EmailScope)=>and(eq(table.org_id,scope.org_id),eq(table.owner_user_id,scope.owner_user_id),eq(table.account_id,scope.account_id));
const context=(scope:EmailScope)=>({...scope,kind:'checkpoint' as const,record_id:'native-provider-profile',revision:1});
const denied=():never=>{throw Error('EMAIL_ACCESS_DENIED');};
/** Immutable encrypted profile provenance. No authorization decisions or OAuth
 * tokens are stored here; current custody is checked by the native adapter. */
export class NativeEmailConnectionAccountStore{
 constructor(private readonly database:Database,private readonly cipher:EmailMailboxCrypto,private readonly now=Date.now){}
 async read(scope:EmailScope,consent:EmailAccountConsent,guard:(transaction?:unknown)=>Promise<void>,signal?:AbortSignal,transaction?:NativeEmailConnectionTransaction):Promise<NativeEmailConnectionBinding>{
  const work=async(tx:NativeEmailConnectionTransaction)=>{signal?.throwIfAborted();await guard(tx);
   const [account]=await tx.select().from(emailAccounts).where(where(emailAccounts,scope)).limit(1),[row]=await tx.select().from(emailNativeAccountConnections).where(where(emailNativeAccountConnections,scope)).limit(1);
   if(!account||!row||consent.bridge.kind!=='native_owner_provider_v1'||account.credential_source!==consent.bridge.kind||account.resource_binding_id!==consent.bridge.credential_binding_id||row.provider!==consent.provider||account.provider!==consent.provider||row.principal_digest!==consent.principal_digest||account.principal_digest!==consent.principal_digest||row.bridge_digest!==nativeEmailConnectionDigest(consent.bridge))return denied();
   const descriptor=descriptorSchema.parse(this.cipher.open(row.descriptor_envelope,context(scope))),b=descriptor.bridge;
   if(nativeEmailConnectionDigest(b)!==row.bridge_digest||b.scope.org_id!==scope.org_id||b.scope.owner_user_id!==scope.owner_user_id||b.scope.account_id!==scope.account_id||b.provider!==consent.provider||consent.capabilities.some(cap=>!descriptor.capability_ceiling.includes(cap)))return denied();
   await guard(tx);signal?.throwIfAborted();return {scope:{org_id:scope.org_id,owner_user_id:scope.owner_user_id},source:b.kind,account_id:scope.account_id,provider:b.provider,profile_id:b.profile_id,profile_revision:b.profile_revision,module_sha256:b.module_sha256,credential_namespace_id:b.credential_namespace_id,credential_binding_id:b.credential_binding_id,credential_action_id:b.credential_action_id,connection_target:b.connection_target,authority_epoch:b.authority_epoch,capabilities:descriptor.capability_ceiling,expected_principal_digest:consent.principal_digest,expected_native_revision:account.authority_revision};
  };return transaction?work(transaction):this.database.transaction(work);
 }
 /** Called only by the connection receipt publisher, under a current owner/SID
  * transaction guard. Effects are DB-only and share its commit/rollback. */
 async publish(tx:NativeEmailConnectionTransaction,record:NativeEmailConnectionRecord,v:NativeEmailConnectionVerified,rawCeiling:readonly ('read'|'modify'|'send')[]):Promise<NativeEmailConnectionResult>{
  const b=record.binding,ceiling=NativeEmailConnectionCapabilitiesSchema.parse(rawCeiling),scope={...record.scope,account_id:b.account_id},time=new Date(this.now()),caps=[...v.capabilities].sort() as ('read'|'modify'|'send')[];
  if(v.account_id!==b.account_id||v.provider!==b.provider||v.authority_epoch!==b.authority_epoch||!v.capabilities.includes('read')||caps.some(cap=>!b.capabilities.includes(cap)||!ceiling.includes(cap))||b.expected_principal_digest&&b.expected_principal_digest!==v.principal_digest)return denied();
  const [account]=await tx.select().from(emailAccounts).where(where(emailAccounts,scope)).for('update').limit(1),[prior]=await tx.select().from(emailAccountConsents).where(where(emailAccountConsents,scope)).for('update').limit(1);
  const fresh=b.expected_native_revision===null;
  if(b.source==='retained_registry_v1'&&(!prior||fresh))return denied();
  const bridge=b.source==='native_owner_provider_v1'?nativeEmailAccountBridge(b):new PostgresEmailAccountConsentStore(this.database,this.cipher).decode(prior!).bridge;
  if(bridge.kind!==b.source||bridge.kind==='retained_registry_v1'&&(bridge.module_sha256!==b.module_sha256||bridge.pins.installation_id!==b.credential_namespace_id||bridge.pins.resource_binding_id!==b.credential_binding_id||bridge.pins.action_binding_id!==b.credential_action_id||bridge.pins.target_key!==b.connection_target))return denied();
  if(fresh?(Boolean(account)||Boolean(prior)):(!account||!prior||account.state==='revoked'||account.credential_source!==bridge.kind||account.authority_revision!==b.expected_native_revision||account.principal_digest!==v.principal_digest||account.resource_binding_id!==emailAccountBridgeBindingId(bridge)||account.provider!==v.provider||prior.bridge_digest!==nativeEmailConnectionDigest(bridge)||prior.credential_revision>v.credential_revision))return denied();
  const native_revision=fresh?1:account!.authority_revision+1,revision=fresh?1:prior!.revision+1;
  const consent=EmailAccountConsentSchema.parse({scope,provider:v.provider,principal_digest:v.principal_digest,revision,native_revision,credential_revision:v.credential_revision,state:'active',capabilities:caps,bridge,identity:{primary_address:v.primary_address,display_label:v.display_label},consented_at:time.toISOString(),updated_at:time.toISOString(),revoked_at:null});
  const accountValue={...scope,provider:v.provider,credential_source:bridge.kind,resource_binding_id:emailAccountBridgeBindingId(bridge),principal_digest:v.principal_digest,state:'active' as const,authority_revision:native_revision,consented_at:time,revoked_at:null,updated_at:time};
  if(fresh)await tx.insert(emailAccounts).values({...accountValue,created_at:time});else await tx.update(emailAccounts).set(accountValue).where(and(where(emailAccounts,scope),eq(emailAccounts.authority_revision,b.expected_native_revision!)));
  const consentValue={...scope,provider:v.provider,principal_digest:v.principal_digest,revision,native_revision,credential_revision:v.credential_revision,state:'active' as const,capabilities:caps,bridge_digest:nativeEmailConnectionDigest(bridge),bridge_envelope:this.cipher.seal({bridge,identity:consent.identity},{...scope,kind:'checkpoint',record_id:'native-consent-bridge',revision}),consented_at:time,updated_at:time,revoked_at:null};
  if(fresh){await tx.insert(emailAccountConsents).values(consentValue);await tx.insert(emailNativeAccountConnections).values({...scope,provider:v.provider,principal_digest:v.principal_digest,bridge_digest:consentValue.bridge_digest,revision:1,descriptor_envelope:this.cipher.seal({bridge,capability_ceiling:ceiling},context(scope)),created_at:time,updated_at:time});}
  else await tx.update(emailAccountConsents).set(consentValue).where(and(where(emailAccountConsents,scope),eq(emailAccountConsents.revision,prior!.revision)));
  return {account_id:b.account_id,provider:v.provider,capabilities:caps,primary_address:v.primary_address,display_label:v.display_label,native_revision};
 }
}
