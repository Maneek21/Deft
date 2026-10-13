import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {getEmailNativeSendComponents} from './email-send-runtime.js';
import {PostgresEmailMailboxAuthority} from './email-mailbox-authority.js';
import {getEmailMailboxComponents} from './email-mailbox-runtime.js';
import {inspectEmailMailboxConnection} from './email-mailbox-connected-authority.js';
import {EmailMailboxError,type EmailActor,type EmailScope} from './email-mailbox-service.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailDraftStore} from './email-draft-store.js';
import {EmailOutboxCrypto} from './email-outbox-crypto.js';
import {EmailOutboxStore} from './email-outbox-store.js';
import {EmailOutboxService} from './email-outbox-service.js';
import {RegisteredEmailNativeSendProvider} from './email-native-send-provider.js';
import type {EmailOutboxLease} from './email-outbox-contract.js';

const unavailable=async():Promise<never>=>{throw new EmailMailboxError('EMAIL_ACCESS_DENIED');};
/** Human preparation shares the trusted direct-send serializer and file/reply
 * custody. The worker port is deliberately unavailable in this HTTP instance. */
export async function getEmailOutboxService(actor:EmailActor){
 const {authority,drafts,snapshots,sender,crypto,keys}=await getEmailNativeSendComponents(actor,{outboxPreparation:true});
 return new EmailOutboxService(authority,{current:unavailable},drafts,new EmailOutboxStore(db,crypto,new EmailOutboxCrypto(keys)),snapshots,sender);
}
/** Background dispatch receives a real current job lease. It opens only the
 * immutable Outbox snapshot and cannot manufacture a human enqueue request. */
export async function dispatchEmailOutbox(scope:EmailScope,lease:EmailOutboxLease,signal?:AbortSignal){
 const base=await getEmailMailboxAuthority(db),sql=(account:EmailScope,tx?:unknown,abort?:AbortSignal)=>base.currentService(account,lease,tx,abort);
 const [{provider,resolve},{keys}]=await Promise.all([getEmailMailboxComponents(sql),getAppRunRuntime()]);
 const current=async(account:EmailScope,delivery:EmailOutboxLease,tx?:unknown,abort?:AbortSignal)=>{
  if(delivery.job_id!==lease.job_id||delivery.lock_token!==lease.lock_token||delivery.outbox_id!==lease.outbox_id||delivery.operation_id!==lease.operation_id||delivery.job_name!==lease.job_name)
   throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
  const result=await inspectEmailMailboxConnection(account,()=>sql(account,tx,abort),provider,abort);
  if(!result.account.capabilities.includes('send'))throw new EmailMailboxError('EMAIL_ACCESS_DENIED');return result.capability;
 };
 const cipher=new EmailMailboxCrypto(keys),service=new EmailOutboxService({current:unavailable},{current},new EmailDraftStore(db,cipher),
  new EmailOutboxStore(db,cipher,new EmailOutboxCrypto(keys)),{prepareAndBind:unavailable},new RegisteredEmailNativeSendProvider(resolve));
 return service.dispatch(scope,lease,signal);
}
