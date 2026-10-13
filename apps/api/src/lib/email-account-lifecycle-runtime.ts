import {and,asc,eq} from 'drizzle-orm';
import {emailAccounts,emailAccountConsents,appResourceBindings,emailPresentationCache} from '@deft/db/schema';
import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {getAppConnectionRegistry} from './app-connection-registry.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailMailboxError,type EmailActor,type EmailScope} from './email-mailbox-service.js';
import {PostgresEmailAccountConsentStore} from './email-account-consent-store.js';
import {EmailAccountOwnerAuthority,type EmailAccountOwnerSnapshot} from './email-account-owner-authority.js';
import {EmailAccountConnectionProofSchema} from './email-account-lifecycle.js';
import {EmailAccountLifecycleService,type EmailAccountLifecycleCatalogEntry} from './email-account-lifecycle-service.js';
import {NativeEmailConnectionAccountStore} from './email-native-connection-account-store.js';
import {getNativeEmailProfileRegistry} from './email-native-connection-registry.js';
const denied=():never=>{throw new EmailMailboxError('EMAIL_ACCESS_DENIED');};
export async function getEmailAccountLifecycleService(){
 const {keys}=await getAppRunRuntime(),cipher=new EmailMailboxCrypto(keys),store=new PostgresEmailAccountConsentStore(db,cipher),owner=new EmailAccountOwnerAuthority(db,store);
 const connection=async(actor:EmailActor,scope:EmailScope,snapshot:EmailAccountOwnerSnapshot,signal?:AbortSignal)=>{
  const recheck=async()=>{const fresh=await owner.inspect(actor,scope,signal);if(fresh.capability.authority_version!==snapshot.capability.authority_version)return denied();};
  await recheck();const consent=snapshot.consent,a=snapshot.account;
  if(consent?.bridge.kind==='native_owner_provider_v1'){
   const binding=await new NativeEmailConnectionAccountStore(db,cipher).read(scope,consent,recheck,signal),profile=(await getNativeEmailProfileRegistry()).selected(binding),adapter=profile.adapter.mailbox(binding);
   if(!adapter.nativeEmailAccount)return denied();const context={...scope,installation_id:binding.credential_namespace_id,resource_binding_id:binding.credential_binding_id,authority_version:snapshot.capability.authority_version,expires_at:snapshot.capability.expires_at,recheck,signal,lifecycle_inspect:true as const};
   const account=await adapter.nativeEmailAccount(context);await recheck();
   if(account.account_id!==scope.account_id||account.provider!==a.provider||account.resource_binding_id!==a.resource_binding_id||account.principal_digest!==a.principal_digest||account.health!=='connected'||account.connection_revision<consent.credential_revision)return denied();
   return EmailAccountConnectionProofSchema.parse({scope,provider:account.provider,principal_digest:account.principal_digest,native_revision:a.authority_revision,consent_revision:consent.revision,credential_revision:account.connection_revision,health:'connected',available_capabilities:account.capabilities.filter(cap=>['read','modify','send'].includes(cap)),identity:{primary_address:account.primary_address,display_label:account.display_label},bridge:consent.bridge});
  }
  const [binding]=await db.select().from(appResourceBindings).where(and(eq(appResourceBindings.org_id,scope.org_id),eq(appResourceBindings.owner_user_id,scope.owner_user_id),eq(appResourceBindings.id,a.resource_binding_id))).limit(1);
  if(!binding)return denied();
  const pins=consent?.bridge.pins,entry=(await getAppConnectionRegistry()).select({org_id:scope.org_id,owner_user_id:scope.owner_user_id,installation_id:pins?.installation_id??binding.app_installation_id,target_key:pins?.target_key??binding.target_key});
  const selected=entry.pins;
  if(!entry.module_sha256||!entry.adapter.nativeEmailAccount||selected.resource_binding_id!==a.resource_binding_id||selected.org_id!==scope.org_id||selected.owner_user_id!==scope.owner_user_id
   ||consent&&(entry.module_sha256!==consent.bridge.module_sha256||Object.keys(pins!).filter(k=>!['app_version_id','grant_snapshot_id'].includes(k)).some(k=>selected[k as keyof typeof selected]!==pins![k as keyof typeof selected]))
   ||!consent&&(selected.installation_id!==binding.app_installation_id||selected.app_version_id!==binding.app_version_id||selected.grant_snapshot_id!==binding.grant_snapshot_id||selected.target_key!==binding.target_key||selected.resource_key!==binding.resource_key))return denied();
  const context={...scope,installation_id:selected.installation_id,resource_binding_id:a.resource_binding_id,authority_version:snapshot.capability.authority_version,expires_at:snapshot.capability.expires_at,recheck,signal,lifecycle_inspect:true as const};
  await recheck();const account=await entry.adapter.nativeEmailAccount(context);await recheck();
  if(account.account_id!==scope.account_id||account.provider!==a.provider||account.resource_binding_id!==a.resource_binding_id||account.principal_digest!==a.principal_digest||account.health!=='connected'||consent&&account.connection_revision<consent.credential_revision)return denied();
  return EmailAccountConnectionProofSchema.parse({scope,provider:account.provider,principal_digest:account.principal_digest,native_revision:a.authority_revision,consent_revision:consent?.revision??0,credential_revision:account.connection_revision,health:'connected',available_capabilities:account.capabilities.filter(cap=>['read','modify','send'].includes(cap)),identity:{primary_address:account.primary_address,display_label:account.display_label},bridge:consent?.bridge??{kind:'retained_registry_v1',pins:selected,module_sha256:entry.module_sha256}});
 };
 return new EmailAccountLifecycleService({snapshot:(actor,scope,signal)=>owner.inspect(actor,scope,signal),connection,
  schedule:async(scope,revision)=>{await(await import('./email-mailbox-scheduler-runtime.js')).scheduleNativeEmailAccount({...scope,authority_revision:revision});},
  commit:async(actor,plan,signal)=>{const guard=owner.guard(actor,plan.next.scope,signal);return store.commit(plan,async(scope,tx,phase)=>{
   await guard(scope,tx,phase);if(phase==='final'&&['paused','disconnected','revoked'].includes(plan.next.state))await tx.delete(emailPresentationCache).where(and(eq(emailPresentationCache.org_id,scope.org_id),eq(emailPresentationCache.owner_user_id,scope.owner_user_id),eq(emailPresentationCache.account_id,scope.account_id)));
  },signal);},
  catalog:async(actor,orgId,signal)=>{
   const selected={org_id:orgId,owner_user_id:actor.user_id,account_id:'owner-management-catalog'},guard=owner.guard(actor,selected,signal);
   return db.transaction(async tx=>{await guard(selected,tx,'owner');await guard(selected,tx,'principal');
    const rows=await tx.select({account:emailAccounts,consent:emailAccountConsents}).from(emailAccounts).leftJoin(emailAccountConsents,and(eq(emailAccountConsents.org_id,emailAccounts.org_id),eq(emailAccountConsents.owner_user_id,emailAccounts.owner_user_id),eq(emailAccountConsents.account_id,emailAccounts.account_id)))
     .where(and(eq(emailAccounts.org_id,orgId),eq(emailAccounts.owner_user_id,actor.user_id))).orderBy(asc(emailAccounts.account_id)).limit(51);
    const accounts:EmailAccountLifecycleCatalogEntry[]=rows.slice(0,50).map(({account:a,consent:raw})=>{const c=raw?store.decode(raw):null;return {account_id:a.account_id,provider:a.provider as EmailAccountLifecycleCatalogEntry['provider'],authority_mode:c?'standalone':'legacy',state:(c?.state??a.state) as EmailAccountLifecycleCatalogEntry['state'],revision:c?.revision??0,native_revision:a.authority_revision,primary_address:c?.identity?.primary_address??'',display_label:c?.identity?.display_label??''};});
    await guard(selected,tx,'final');signal?.throwIfAborted();return {accounts,has_more:rows.length>50};
   });
  }});
}
