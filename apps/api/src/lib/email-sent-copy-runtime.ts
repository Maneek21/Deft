import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {PostgresEmailMailboxAuthority} from './email-mailbox-authority.js';
import {getEmailMailboxComponents} from './email-mailbox-runtime.js';
import {ConnectedEmailMailboxAuthority,inspectEmailMailboxConnection} from './email-mailbox-connected-authority.js';
import {EmailMailboxError,type EmailActor,type EmailScope} from './email-mailbox-service.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailOutboxCrypto} from './email-outbox-crypto.js';
import {EmailOutboxStore} from './email-outbox-store.js';
import {EmailImapCredentialCustody} from './email-imap-custody.js';
import {PostgresEmailImapCredentialStore} from './email-imap-credential-store.js';
import {RegisteredEmailSentCopyProvider} from './email-sent-copy-provider.js';
import {EmailSentCopySettingsService} from './email-sent-copy-settings.js';
import {EmailSentCopyService,readEmailSentCopyStatus,reconcileEmailSentCopy} from './email-sent-copy-service.js';
import type {EmailSentCopyLease} from './email-sent-copy-contract.js';
/** HTTP supplies a real human SID. It cannot manufacture a copy worker lease. */
export async function getEmailSentCopyControls(actor:EmailActor){
 const base=await getEmailMailboxAuthority(db),[{provider,resolve},{keys}]=await Promise.all([
  getEmailMailboxComponents((scope,tx,signal)=>base.current(actor,scope,'human_read',tx,signal)),getAppRunRuntime()]);
 const authority=new ConnectedEmailMailboxAuthority(base,provider),copyProvider=new RegisteredEmailSentCopyProvider(resolve),store=new EmailOutboxStore(db,new EmailMailboxCrypto(keys),new EmailOutboxCrypto(keys));
 const settings=new EmailSentCopySettingsService(authority,copyProvider,async(scope,recheck)=>{
  await recheck();return new EmailImapCredentialCustody(keys,new PostgresEmailImapCredentialStore(db,async(selected,tx)=>{
   if(selected.org_id!==scope.org_id||selected.owner_user_id!==scope.owner_user_id||selected.account_id!==scope.account_id)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
   await base.current(actor,scope,'human_modify',tx);
  }));
 });
 return {settings,read:(scope:EmailScope,outboxId:string,signal?:AbortSignal)=>readEmailSentCopyStatus(authority,store,actor,scope,outboxId,signal),
  reconcile:(scope:EmailScope,outboxId:string,signal?:AbortSignal)=>reconcileEmailSentCopy(authority,store,actor,scope,outboxId,signal)};
}
/** A copy job has its own actual lease and cannot enter the send provider. */
export async function dispatchEmailSentCopy(scope:EmailScope,lease:EmailSentCopyLease,signal?:AbortSignal){
 const base=await getEmailMailboxAuthority(db),sql=(selected:EmailScope,tx?:unknown,abort?:AbortSignal)=>base.currentService(selected,lease,tx,abort);
 const [{provider,resolve},{keys}]=await Promise.all([getEmailMailboxComponents(sql),getAppRunRuntime()]);
 const current=async(selected:EmailScope,delivery:EmailSentCopyLease,tx?:unknown,abort?:AbortSignal)=>{
  if(delivery.job_id!==lease.job_id||delivery.lock_token!==lease.lock_token||delivery.job_name!==lease.job_name||delivery.outbox_id!==lease.outbox_id||delivery.operation_id!==lease.operation_id)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
  const fresh=await inspectEmailMailboxConnection(selected,()=>sql(selected,tx,abort),provider,abort);if(fresh.account.provider!=='imap_smtp'||!fresh.account.capabilities.includes('read'))throw new EmailMailboxError('EMAIL_ACCESS_DENIED');return fresh.capability;
 };
 return new EmailSentCopyService({current},new EmailOutboxStore(db,new EmailMailboxCrypto(keys),new EmailOutboxCrypto(keys)),new RegisteredEmailSentCopyProvider(resolve)).dispatch(scope,lease,signal);
}
