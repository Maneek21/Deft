import {canonicalCapabilityJson} from '@deft/shared';
import type {AppConnectionPins} from './app-connection-contract.js';
import type {NativeEmailConnectionContext} from './email-native-adapter-contract.js';
import type {NativeEmailConnectionResolver} from './email-mailbox-provider.js';
import {EmailMailboxError,type EmailScope,type EmailCapability} from './email-mailbox-service.js';
import {EmailAccountConsentSchema,requireEmailAccountConsent,type EmailAccountConsent} from './email-account-lifecycle.js';
import type {EmailImapAliasPort} from './email-imap-alias-contract.js';
type Adapter=Awaited<ReturnType<NativeEmailConnectionResolver>>['adapter'];
export type EmailStandaloneRegistryEntry=Readonly<{pins:AppConnectionPins;module_sha256:string;adapter:Adapter}>;
const denied=():never=>{throw new EmailMailboxError('EMAIL_ACCESS_DENIED');};
const same=(a:unknown,b:unknown)=>canonicalCapabilityJson(a)===canonicalCapabilityJson(b);
const readPurposes=['status','page','source','presentation','file','image','conversation','search','folders'] as const;
/** Read-only first cutover seam. Caller supplies standalone SQL authority and
 * deployment-loaded module hashes; no App live graph or browser module options.
 * Effects remain unavailable until native host operation-consent checks join. */
export function createEmailStandaloneConnectionResolver(ports:{
 currentSql(scope:EmailScope,signal?:AbortSignal):Promise<EmailCapability>;
 readConsent(scope:EmailScope,signal?:AbortSignal):Promise<EmailAccountConsent|null>;
 select(input:Readonly<{org_id:string;owner_user_id:string;installation_id:string;target_key:string}>):Promise<EmailStandaloneRegistryEntry>;
 providerState?(scope:EmailScope,recheck:()=>Promise<void>,signal?:AbortSignal):NativeEmailConnectionContext['provider_state'];
 imapAliasLookup?(scope:EmailScope,recheck:()=>Promise<void>,signal?:AbortSignal):EmailImapAliasPort['lookup'];
 now?:()=>number;
}):NativeEmailConnectionResolver{
 const now=ports.now??Date.now;
 return async(scope,capability,_decoratedRecheck,signal,purpose)=>{
  signal?.throwIfAborted();if(!readPurposes.includes(purpose as (typeof readPurposes)[number]))denied();
  const initial=await ports.currentSql(scope,signal);
  const valid=(cap:EmailCapability)=>same(cap.scope,scope)&&cap.resource_binding_id===capability.resource_binding_id&&Number.isFinite(cap.expires_at)&&cap.expires_at>now();
  if(!valid(initial)||!valid(capability))denied();
  const recheck=async()=>{signal?.throwIfAborted();const fresh=await ports.currentSql(scope,signal);if(!valid(fresh)||fresh.authority_version!==initial.authority_version)denied();signal?.throwIfAborted();};
  const found=await ports.readConsent(scope,signal);await recheck();if(!found)denied();
  const consent=EmailAccountConsentSchema.parse(found);requireEmailAccountConsent(consent,scope,'human_read');
  // This older isolated resolver intentionally selects retained registry entries.
  // First-party native profiles use the explicit production source-mode branch.
  if(consent.bridge.kind!=='retained_registry_v1')return denied();
  if(purpose==='page'&&(!ports.providerState||consent.provider==='imap_smtp'&&!ports.imapAliasLookup))denied();
  const pins=consent.bridge.pins;if(pins.resource_binding_id!==capability.resource_binding_id)denied();
  const entry=await ports.select({org_id:scope.org_id,owner_user_id:scope.owner_user_id,installation_id:pins.installation_id,target_key:pins.target_key});await recheck();
  // A captured App package/grant version is historical context, not native
  // admission. All custody-routing pins and deployment module SHA stay exact.
  if(entry.module_sha256!==consent.bridge.module_sha256||Object.keys(pins).filter(key=>!['app_version_id','grant_snapshot_id'].includes(key))
   .some(key=>entry.pins[key as keyof AppConnectionPins]!==pins[key as keyof AppConnectionPins])||!entry.adapter.nativeEmailAccount||!entry.adapter.nativeEmailPage)denied();
  const context:NativeEmailConnectionContext={...scope,installation_id:pins.installation_id,resource_binding_id:pins.resource_binding_id,
   authority_version:capability.authority_version,expires_at:Math.min(initial.expires_at,capability.expires_at),recheck,signal,
   ...(ports.providerState?{provider_state:ports.providerState(scope,recheck,signal)}:{}),
   ...(consent.provider==='imap_smtp'&&ports.imapAliasLookup?{imap_aliases:{lookup:ports.imapAliasLookup(scope,recheck,signal),reserve:async()=>denied(),reconcile:async()=>denied()}}:{})};
  const nativeAccount=entry.adapter.nativeEmailAccount!,nativePage=entry.adapter.nativeEmailPage!;
  const adapter:Adapter={nativeEmailAccount:async selected=>{await recheck();const account=await nativeAccount.call(entry.adapter,selected);await recheck();
   if(account.account_id!==scope.account_id||account.provider!==consent.provider||account.resource_binding_id!==pins.resource_binding_id
    ||account.principal_digest!==consent.principal_digest||account.health!=='connected'||account.connection_revision<consent.credential_revision)denied();
   return {...account,capabilities:account.capabilities.filter(cap=>['search','thread'].includes(cap)?consent.capabilities.includes('read'):consent.capabilities.includes(cap as 'read'|'modify'|'send'))};
  },nativeEmailPage:nativePage.bind(entry.adapter)};
  for(const name of ['nativeEmailSource','nativeEmailPresentation','nativeEmailFile','nativeEmailImage','nativeEmailConversation','nativeEmailSearch','nativeEmailFolders'] as const){
   const method=entry.adapter[name];if(method)Object.assign(adapter,{[name]:method.bind(entry.adapter)});
  }
  await recheck();return {context,adapter};
 };
}
