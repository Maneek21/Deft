import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import {EmailMailboxConversationService} from './email-mailbox-conversation.js';
import { EmailMailboxService, EmailMailboxError, type EmailActor, type EmailOperationActor, type EmailScope, type EmailCapability } from './email-mailbox-service.js';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import { PostgresEmailMailboxStore } from './email-mailbox-store.js';
import { PostgresEmailMailboxAuthority } from './email-mailbox-authority.js';
import { ConnectedEmailMailboxAuthority } from './email-mailbox-connected-authority.js';
import { RegisteredEmailMailboxProvider,type NativeEmailConnectionResolver } from './email-mailbox-provider.js';
import { getAppConnectionRegistry } from './app-connection-registry.js';
import { emailAccounts, appResourceBindings,emailAccountConsents } from '@deft/db/schema';
import {PostgresEmailAccountConsentStore} from './email-account-consent-store.js';
import {requireEmailAccountConsent} from './email-account-lifecycle.js';
import {resolveNativeEmailProfileMailbox} from './email-native-connection-mailbox.js';
import { and, asc, eq } from 'drizzle-orm';
import { db } from './db.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { EmailMailboxUnifiedService } from './email-mailbox-unified.js';
import { EmailMessageContentService } from './email-message-content.js';
import { PostgresEmailPresentationCache } from './email-presentation-cache.js';
import { EmailAccountCatalogService } from './email-account-catalog.js';
import { EmailMailboxSearchService } from './email-mailbox-search.js';
import {PostgresEmailOperationJournal} from './email-operation-journal.js';
import {PostgresEmailFolderManagementJournal} from './email-folder-management-journal.js';
import {PostgresEmailDraftSyncJournal} from './email-draft-sync-journal.js';
import {PostgresEmailGraphSendJournal} from './email-graph-send-journal.js';
import {PostgresEmailSentCopyJournal} from './email-sent-copy-journal.js';
import {EmailNativeTriageService,RegisteredEmailNativeTriageProvider} from './email-native-triage.js';
import {EmailNativeFolderService,RegisteredEmailNativeFolderProvider} from './email-native-folders.js';
import {PostgresEmailImapAliasStore} from './email-imap-alias-store.js';

/** Additive endpoint for explicitly enrolled accounts. Host lookup selects the
 * existing reviewed adapter; neither HTTP input nor cached provider IDs nominate
 * a credential store, installation, target or provider implementation. */
export async function getEmailMailboxComponents(currentSql:(scope:EmailScope,transaction?:unknown,signal?:AbortSignal)=>Promise<EmailCapability>) {
  const { keys } = await getAppRunRuntime();
  const cipher=new EmailMailboxCrypto(keys),aliases=new PostgresEmailImapAliasStore(db,cipher),store=new PostgresEmailMailboxStore(db,cipher,{identities:aliases});
  const consentStore=new PostgresEmailAccountConsentStore(db,cipher);
  const resolve:NativeEmailConnectionResolver = async (scope, capability, recheck, signal, purpose) => {
    signal?.throwIfAborted();
    // A status lookup may be running inside the store's commit transaction.
    // Its supplied SQL-only guard preserves that transaction and lock order.
    // A page lookup runs outside it and must not invoke custody while custody
    // already holds its refresh lock, so give the adapter a separate SQL guard.
    let sqlRecheck=recheck;
    let sqlTransactionGuard:((transaction:unknown)=>Promise<void>)|undefined;
    if(purpose!=='status') {
      const initial=await currentSql(scope,undefined,signal);
      sqlRecheck=async()=>{
        const current=await currentSql(scope,undefined,signal);
        if(current.authority_version!==initial.authority_version || current.resource_binding_id!==capability.resource_binding_id)
          throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
      };
      sqlTransactionGuard=async transaction=>{
        const current=await currentSql(scope,transaction,signal);
        if(current.authority_version!==initial.authority_version||current.resource_binding_id!==capability.resource_binding_id)
          throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
      };
    }
    const [consentRow]=await db.select().from(emailAccountConsents).where(and(eq(emailAccountConsents.org_id,scope.org_id),eq(emailAccountConsents.owner_user_id,scope.owner_user_id),eq(emailAccountConsents.account_id,scope.account_id))).limit(1);
    const consent=consentRow?consentStore.decode(consentRow):null;
    if(consent)requireEmailAccountConsent(consent,scope,['triage','destination','folder_manage','draft_sync'].includes(purpose)?'human_modify':purpose==='send'?'human_send':'human_read');
    if(consent?.bridge.kind==='native_owner_provider_v1')return resolveNativeEmailProfileMailbox({scope,capability,consent,cipher,recheck:sqlRecheck,transactionGuard:sqlTransactionGuard,purpose,signal,provider_state:{
      read:async stateKey=>{await sqlRecheck();const value=await store.readProviderState(scope,stateKey,signal);await sqlRecheck();return value;},
      stale:async(generation,after,limit)=>{await sqlRecheck();const value=await store.readStaleRecords(scope,generation,after,limit,signal);await sqlRecheck();return value;},
    }});
    const [selected] = await db.select({binding:appResourceBindings,provider:emailAccounts.provider,principal:emailAccounts.principal_digest})
      .from(emailAccounts).innerJoin(appResourceBindings,and(eq(appResourceBindings.org_id,emailAccounts.org_id),
        eq(appResourceBindings.id,emailAccounts.resource_binding_id),eq(appResourceBindings.owner_user_id,emailAccounts.owner_user_id)))
      .where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),
        eq(emailAccounts.account_id,scope.account_id),eq(emailAccounts.resource_binding_id,capability.resource_binding_id))).limit(1);
    if (!selected) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    const binding=selected.binding;
    const entry=(await getAppConnectionRegistry()).select({org_id:scope.org_id,owner_user_id:scope.owner_user_id,
      installation_id:binding.app_installation_id,target_key:binding.target_key});
    const pins=entry.pins;
    if (pins.org_id!==scope.org_id || pins.owner_user_id!==scope.owner_user_id
      || pins.installation_id!==binding.app_installation_id || !consent&&(pins.app_version_id!==binding.app_version_id
      || pins.grant_snapshot_id!==binding.grant_snapshot_id) || pins.target_key!==binding.target_key
      || pins.resource_key!==binding.resource_key || pins.resource_binding_id!==binding.id
      || !entry.adapter.nativeEmailAccount || !entry.adapter.nativeEmailPage) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    const retainedPins=consent?.bridge.kind==='retained_registry_v1'?consent.bridge.pins:null;
    if(consent&&(!retainedPins||entry.module_sha256!==consent.bridge.module_sha256||selected.principal!==consent.principal_digest||selected.provider!==consent.provider
      ||Object.keys(retainedPins).filter(key=>!['app_version_id','grant_snapshot_id'].includes(key)).some(key=>pins[key as keyof typeof pins]!==retainedPins[key as keyof typeof pins])))throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    await sqlRecheck();
    const aliasContext={...scope,installation_id:binding.app_installation_id,resource_binding_id:binding.id,
      authority_version:capability.authority_version,expires_at:capability.expires_at,recheck:sqlRecheck,signal,...(consent?{owner_capabilities:consent.capabilities}:{})};
    const aliasGuard=sqlTransactionGuard??(async(transaction:unknown)=>{await currentSql(scope,transaction,signal);});
    const moveBinding=async()=>{await sqlRecheck();const account=await entry.adapter.nativeEmailAccount!(aliasContext);await sqlRecheck();
      if(account.provider!=='imap_smtp'||account.account_id!==scope.account_id||account.resource_binding_id!==binding.id||account.principal_digest!==selected.principal||account.health!=='connected')throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
      return {resource_binding_id:binding.id,authority_epoch:account.authority_epoch};};
    const providerScope={org_id:scope.org_id,owner_id:scope.owner_user_id,installation_id:binding.app_installation_id};
    return { context:{...scope,installation_id:binding.app_installation_id,resource_binding_id:binding.id,
      authority_version:capability.authority_version,expires_at:capability.expires_at,recheck:sqlRecheck,signal,...(consent?{owner_capabilities:consent.capabilities}:{}),
      ...(selected.provider==='imap_smtp'?{imap_aliases:{
        lookup:async locator=>{await sqlRecheck();const value=await aliases.lookup(scope,locator,aliasGuard);await sqlRecheck();return value;},
        reserve:async input=>{if(purpose!=='triage')throw new EmailMailboxError('EMAIL_ACCESS_DENIED');await aliases.reserveMove(scope,input,providerScope,await moveBinding(),aliasGuard);await sqlRecheck();},
        reconcile:async operationId=>{if(purpose!=='triage')throw new EmailMailboxError('EMAIL_ACCESS_DENIED');await aliases.reconcileMove(scope,operationId,providerScope,await moveBinding(),aliasGuard);await sqlRecheck();},
      }}:{}),
      ...(purpose==='triage'?{triage_journal:new PostgresEmailOperationJournal(db,cipher,scope,
        {org_id:scope.org_id,owner_id:scope.owner_user_id,installation_id:binding.app_installation_id},sqlTransactionGuard!)}:{}),
      ...(purpose==='draft_sync'?{draft_sync_journal:new PostgresEmailDraftSyncJournal(db,cipher,scope,sqlTransactionGuard!)}:{}),
      ...(purpose==='send'&&selected.provider==='microsoft'?{send_upload_journal:new PostgresEmailGraphSendJournal(db,cipher,scope,sqlTransactionGuard!)}:{}),
      ...(purpose==='sent_copy'&&selected.provider==='imap_smtp'?{sent_copy_journal:new PostgresEmailSentCopyJournal(db,cipher,scope,sqlTransactionGuard!)}:{}),
      provider_state:{
        read:async stateKey=>{await sqlRecheck();const value=await store.readProviderState(scope,stateKey,signal);await sqlRecheck();return value;},
        stale:async(generation,after,limit)=>{await sqlRecheck();const value=await store.readStaleRecords(scope,generation,after,limit,signal);await sqlRecheck();return value;},
      }},
      adapter:{
        nativeEmailAccount:async context=>{
          const account=await entry.adapter.nativeEmailAccount!(context);
          if(account.provider!==selected.provider || !selected.principal || account.principal_digest!==selected.principal)
            throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
          return {...account,...(entry.implementation_digest?{implementation_digest:entry.implementation_digest}:{})};
        },nativeEmailPage:entry.adapter.nativeEmailPage.bind(entry.adapter),
        ...(entry.adapter.nativeEmailSource?{nativeEmailSource:entry.adapter.nativeEmailSource.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailPresentation?{nativeEmailPresentation:entry.adapter.nativeEmailPresentation.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailFile?{nativeEmailFile:entry.adapter.nativeEmailFile.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailImage?{nativeEmailImage:entry.adapter.nativeEmailImage.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailCalendarParts?{nativeEmailCalendarParts:entry.adapter.nativeEmailCalendarParts.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailConversation?{nativeEmailConversation:entry.adapter.nativeEmailConversation.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailSearch?{nativeEmailSearch:entry.adapter.nativeEmailSearch.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailTriage?{nativeEmailTriage:entry.adapter.nativeEmailTriage.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailFolders?{nativeEmailFolders:entry.adapter.nativeEmailFolders.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailFolderManage?{nativeEmailFolderManage:entry.adapter.nativeEmailFolderManage.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailDestination?{nativeEmailDestination:entry.adapter.nativeEmailDestination.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailSendIdentity?{nativeEmailSendIdentity:async(context:Parameters<NonNullable<typeof entry.adapter.nativeEmailSendIdentity>>[0])=>({...await entry.adapter.nativeEmailSendIdentity!(context),...(entry.implementation_digest?{implementation_digest:entry.implementation_digest}:{})})}:{}),
        ...(entry.adapter.nativeEmailSend?{nativeEmailSend:entry.adapter.nativeEmailSend.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailPrepareSend?{nativeEmailPrepareSend:entry.adapter.nativeEmailPrepareSend.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailSentCopy?{nativeEmailSentCopy:entry.adapter.nativeEmailSentCopy.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailSentCopySettings?{nativeEmailSentCopySettings:entry.adapter.nativeEmailSentCopySettings.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailSnapshotFactory?{nativeEmailSnapshotFactory:entry.adapter.nativeEmailSnapshotFactory.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailDraftMime?{nativeEmailDraftMime:entry.adapter.nativeEmailDraftMime.bind(entry.adapter)}:{}),
        ...(entry.adapter.nativeEmailDraftSync?{nativeEmailDraftSync:entry.adapter.nativeEmailDraftSync.bind(entry.adapter)}:{})} };
  };
  const provider=new RegisteredEmailMailboxProvider(resolve);
  return {store,provider,resolve};
}

export async function getEmailMailboxRuntime(actor: EmailOperationActor) {
  const base=await getEmailMailboxAuthority(db);
  const {store,provider}=await getEmailMailboxComponents((scope,transaction,signal)=>base.current(actor,scope,'human_read',transaction,signal));
  const authority=new ConnectedEmailMailboxAuthority(base,provider);
  return {service:new EmailMailboxService(authority,store,provider),store,authority,provider};
}

export async function getEmailMailboxReadService(actor: EmailOperationActor) {
  return (await getEmailMailboxRuntime(actor)).service;
}

export async function getEmailMessageContentService(actor:EmailOperationActor){
  const [{authority,store,provider},{keys}]=await Promise.all([getEmailMailboxRuntime(actor),getAppRunRuntime()]);
  const base=await getEmailMailboxAuthority(db);
  const cache=new PostgresEmailPresentationCache(db,new EmailMailboxCrypto(keys),async(scope,transaction,signal)=>{
    await base.current(actor,scope,'human_read',transaction,signal);
  });
  return new EmailMessageContentService(authority,store,provider,Date.now,cache);
}

export async function getEmailMailboxSearchService(actor:EmailOperationActor){
  const [{authority,store,provider},{keys}]=await Promise.all([getEmailMailboxRuntime(actor),getAppRunRuntime()]);
  return new EmailMailboxSearchService(authority,store,provider,new EmailMailboxCrypto(keys));
}

export async function getEmailNativeTriageService(actor:EmailOperationActor){
  const base=await getEmailMailboxAuthority(db);
  const {store,provider,resolve}=await getEmailMailboxComponents((scope,transaction,signal)=>base.current(actor,scope,'human_modify',transaction,signal));
  const authority=new ConnectedEmailMailboxAuthority(base,provider),{keys}=await getAppRunRuntime();
  const folders=new EmailNativeFolderService(authority,new RegisteredEmailNativeFolderProvider(resolve),new EmailMailboxCrypto(keys));
  return new EmailNativeTriageService(authority,store,new RegisteredEmailNativeTriageProvider(resolve),folders.resolveDestination);
}

export async function getEmailNativeFolderService(actor:EmailOperationActor){
  const base=await getEmailMailboxAuthority(db),{keys}=await getAppRunRuntime();
  const {provider,resolve}=await getEmailMailboxComponents((scope,transaction,signal)=>base.current(actor,scope,'human_read',transaction,signal));
  // Modify composition is lazy: ordinary catalogue/Move consumers pay no new
  // registry/provider lookups and retain the original resolver purpose.
  let modify:ReturnType<typeof getEmailMailboxComponents>|undefined;
  const selected:NativeEmailConnectionResolver=async(scope,cap,recheck,signal,purpose)=>{
    if(purpose!=='folder_manage')return resolve(scope,cap,recheck,signal,purpose);
    modify??=getEmailMailboxComponents((scope,transaction,signal)=>base.current(actor,scope,'human_modify',transaction,signal));
    return (await modify).resolve(scope,cap,recheck,signal,purpose);
  };
  return new EmailNativeFolderService(new ConnectedEmailMailboxAuthority(base,provider),new RegisteredEmailNativeFolderProvider(selected),new EmailMailboxCrypto(keys),Date.now,
    (scope,cap,recheck,signal)=>{
      // Connected authority versions include custody identity. The transaction
      // fence pins the underlying SQL version, as the resolver's guards do.
      const initial=base.current(actor,scope,'human_modify',undefined,signal);
      return new PostgresEmailFolderManagementJournal(db,new EmailMailboxCrypto(keys),scope,async transaction=>{
        signal?.throwIfAborted();const before=await initial,current=await base.current(actor,scope,'human_modify',transaction,signal);
        if(current.authority_version!==before.authority_version||current.resource_binding_id!==before.resource_binding_id
          ||current.resource_binding_id!==cap.resource_binding_id)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
      });
    });
}

export async function getEmailAccountCatalogService(actor:EmailActor){
  const {authority}=await getEmailMailboxRuntime(actor);
  return new EmailAccountCatalogService({
    listCandidates:async(orgId,ownerId,limit,signal)=>{
      signal?.throwIfAborted();
      const rows=await db.select({account_id:emailAccounts.account_id}).from(emailAccounts).where(and(
        eq(emailAccounts.org_id,orgId),eq(emailAccounts.owner_user_id,ownerId),eq(emailAccounts.state,'active')))
        .orderBy(asc(emailAccounts.account_id)).limit(limit);
      signal?.throwIfAborted();return rows.map(row=>row.account_id);
    },
    inspect:(host,scope,signal)=>authority.inspect(host,scope,'human_read',undefined,signal),
    current:(host,scope,signal)=>authority.current(host,scope,'human_read',undefined,signal),
  });
}

/** Aggregate reads finish with fresh per-account human/custody checks after all
 * content I/O. These checks deliberately use separate transactions: current
 * authority fences reject a new account scope inside an already-held transaction
 * to preserve legacy-to-native lock order. The aggregate is not an atomic
 * multi-account snapshot; each account has its own final authorization point. */
export async function getEmailMailboxUnifiedService(actor:EmailOperationActor){
  const [{service,authority},{keys}]=await Promise.all([getEmailMailboxRuntime(actor),getAppRunRuntime()]);
  return new EmailMailboxUnifiedService(service,new EmailMailboxCrypto(keys),async(host,scope,accounts,signal)=>{
    for(const account_id of [...accounts].sort()){
      signal?.throwIfAborted();
      await authority.current(host,{...scope,account_id},'human_read',undefined,signal);
    }
    signal?.throwIfAborted();
  });
}

export async function getEmailMailboxConversationService(actor:EmailOperationActor){
 const [{authority,store,provider},{keys}]=await Promise.all([getEmailMailboxRuntime(actor),getAppRunRuntime()]);
 return new EmailMailboxConversationService(authority,store,provider,new EmailMailboxCrypto(keys));
}
