import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {PostgresEmailMailboxAuthority,type EmailServiceLease} from './email-mailbox-authority.js';
import {inspectEmailMailboxConnection} from './email-mailbox-connected-authority.js';
import {getEmailMailboxComponents} from './email-mailbox-runtime.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailSendStore} from './email-send-store.js';
import {EmailProviderDraftMirrorStore} from './email-provider-draft-mirror-store.js';
import {EmailProviderDraftCleanupService} from './email-provider-draft-cleanup.js';
import {RegisteredEmailNativeDraftProvider} from './email-native-draft-provider.js';
import {EmailMailboxError,type EmailScope,type EmailCapability} from './email-mailbox-service.js';

/** Cleanup jobs use the accepted-send ID plus current queue lease. They do not
 * manufacture a human actor; receipt proof remains inside the cleanup store. */
export async function runEmailProviderDraftCleanup(scope:EmailScope,draftId:string,revision:number,operationId:string,lease:EmailServiceLease,signal?:AbortSignal){
 if(lease.job_name!=='native-email-draft-cleanup'||lease.draft_id!==draftId||lease.revision!==revision||lease.operation_id!==operationId)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
 const base=await getEmailMailboxAuthority(db),sql=(account:EmailScope,tx?:unknown,abort?:AbortSignal)=>base.currentService(account,lease,tx,abort);
 const [{provider,resolve},{keys}]=await Promise.all([getEmailMailboxComponents(sql),getAppRunRuntime()]);
 const current=async(account:EmailScope,delivery:EmailServiceLease,tx?:unknown,abort?:AbortSignal):Promise<EmailCapability>=>{
  if(delivery.job_id!==lease.job_id||delivery.lock_token!==lease.lock_token||delivery.job_name!=='native-email-draft-cleanup'
   ||delivery.draft_id!==draftId||delivery.revision!==revision||delivery.operation_id!==operationId
   ||delivery.mode!==lease.mode||delivery.generation!==lease.generation)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
  const inspected=await inspectEmailMailboxConnection(account,()=>sql(account,tx,abort),provider,abort);
  if(!inspected.account.capabilities.includes('modify'))throw new EmailMailboxError('EMAIL_ACCESS_DENIED');return inspected.capability;
 };
 const cipher=new EmailMailboxCrypto(keys),mirrors=new EmailProviderDraftMirrorStore(db,cipher),sends=new EmailSendStore(db,cipher);
 const service=new EmailProviderDraftCleanupService(current,mirrors,sends,new RegisteredEmailNativeDraftProvider(resolve));
 return lease.mode==='reconcile'?service.reconcileUnknown(scope,draftId,revision,operationId,lease,signal)
  :service.deleteAccepted(scope,draftId,revision,operationId,lease,signal);
}
