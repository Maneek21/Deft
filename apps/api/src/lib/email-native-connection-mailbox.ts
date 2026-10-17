import type {EmailAccountConsent} from './email-account-lifecycle.js';
import type {EmailScope,EmailCapability} from './email-mailbox-service.js';
import type {NativeEmailConnectionContext} from './email-native-adapter-contract.js';
import type {NativeEmailConnectionResolver} from './email-mailbox-provider.js';
import {getNativeEmailProfileRegistry} from './email-native-connection-registry.js';
import {NativeEmailConnectionAccountStore} from './email-native-connection-account-store.js';
import {PostgresEmailOperationJournal} from './email-operation-journal.js';
import {PostgresEmailDraftSyncJournal} from './email-draft-sync-journal.js';
import {PostgresEmailGraphSendJournal} from './email-graph-send-journal.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {db} from './db.js';
const denied=():never=>{throw Error('EMAIL_ACCESS_DENIED');};
/** First-party profile composition, separate from retained App registry lookup.
 * It receives only a server-decoded consent and fresh SQL callbacks. */
export async function resolveNativeEmailProfileMailbox(args:{scope:EmailScope;capability:EmailCapability;consent:EmailAccountConsent;cipher:EmailMailboxCrypto;recheck:()=>Promise<void>;transactionGuard?:(transaction:unknown)=>Promise<void>;purpose:Parameters<NativeEmailConnectionResolver>[4];signal?:AbortSignal;provider_state:NonNullable<NativeEmailConnectionContext['provider_state']>}):Promise<Awaited<ReturnType<NativeEmailConnectionResolver>>>{
 const {scope,capability,consent,cipher,recheck,transactionGuard,purpose,signal}=args;
 if(consent.bridge.kind!=='native_owner_provider_v1')return denied();await recheck();
 const binding=await new NativeEmailConnectionAccountStore(db,cipher).read(scope,consent,async()=>recheck(),signal),profile=(await getNativeEmailProfileRegistry()).selected(binding);
 if(binding.credential_binding_id!==capability.resource_binding_id||binding.capabilities.some(c=>!profile.capabilities.includes(c)))return denied();
 const adapter=profile.adapter.mailbox(binding);if(!adapter.nativeEmailAccount||!adapter.nativeEmailPage)return denied();
 const providerScope={org_id:scope.org_id,owner_id:scope.owner_user_id,installation_id:binding.credential_namespace_id};
 if(['triage','draft_sync','send'].includes(purpose)&&!transactionGuard)return denied();
 const context:NativeEmailConnectionContext={...scope,installation_id:binding.credential_namespace_id,resource_binding_id:binding.credential_binding_id,authority_version:capability.authority_version,expires_at:capability.expires_at,recheck,signal,owner_capabilities:consent.capabilities,provider_state:args.provider_state,
  ...(purpose==='triage'?{triage_journal:new PostgresEmailOperationJournal(db,cipher,scope,providerScope,transactionGuard!)}:{}),
  ...(purpose==='draft_sync'?{draft_sync_journal:new PostgresEmailDraftSyncJournal(db,cipher,scope,transactionGuard!)}:{}),
  ...(purpose==='send'&&binding.provider==='microsoft'?{send_upload_journal:new PostgresEmailGraphSendJournal(db,cipher,scope,transactionGuard!)}:{}),
 };
 const accountMethod=adapter.nativeEmailAccount;
 const wrapped={...adapter,nativeEmailAccount:async(selected:NativeEmailConnectionContext)=>{
  await recheck();const account=await accountMethod.call(adapter,selected);await recheck();
  if(account.account_id!==scope.account_id||account.provider!==consent.provider||account.resource_binding_id!==binding.credential_binding_id||account.principal_digest!==consent.principal_digest||account.connection_revision<consent.credential_revision||account.health!=='connected')return denied();return {...account,...(profile.implementation_digest?{implementation_digest:profile.implementation_digest}:{})};
 }};
 if(adapter.nativeEmailSendIdentity){const sendIdentity=adapter.nativeEmailSendIdentity;Object.assign(wrapped,{nativeEmailSendIdentity:async(selected:NativeEmailConnectionContext)=>{await recheck();const value=await sendIdentity.call(adapter,selected);await recheck();return {...value,...(profile.implementation_digest?{implementation_digest:profile.implementation_digest}:{})};}});}
 await recheck();return {adapter:wrapped,context};
}
