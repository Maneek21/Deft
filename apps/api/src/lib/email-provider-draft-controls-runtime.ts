import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailProviderDraftMirrorStore} from './email-provider-draft-mirror-store.js';
import {EmailProviderDraftControls} from './email-provider-draft-controls.js';
import {getEmailMailboxRuntime} from './email-mailbox-runtime.js';
import {enqueueOrRearmFailed,QUEUE_NAMES} from './queues.js';
import {EMAIL_PROVIDER_DRAFT_JOB} from './email-provider-draft-job.js';
import {EMAIL_PROVIDER_DRAFT_CLEANUP_JOB} from './email-provider-draft-cleanup-job.js';
import {EmailSendStore} from './email-send-store.js';
import type {EmailActor} from './email-mailbox-service.js';
import {EmailMailboxError,type EmailAuthority} from './email-mailbox-service.js';
export async function getEmailProviderDraftControls(actor:EmailActor){
 const [{keys},{authority}]=await Promise.all([getAppRunRuntime(),getEmailMailboxRuntime(actor)]);
 const controlAuthority:EmailAuthority={current:async(host,scope,operation,tx,signal)=>{
  const inspected=await authority.inspect(host,scope,operation,tx,signal);
  if(operation==='human_modify'&&!inspected.account.capabilities.includes('modify'))throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
  return inspected.capability;
 }};
 const cipher=new EmailMailboxCrypto(keys),mirrors=new EmailProviderDraftMirrorStore(db,cipher),sends=new EmailSendStore(db,cipher);
 return new EmailProviderDraftControls(db,controlAuthority,mirrors,
  (tx,payload,dedupeKey)=>enqueueOrRearmFailed(QUEUE_NAMES.SCHEDULED_JOBS,EMAIL_PROVIDER_DRAFT_JOB,payload,{executor:tx,orgId:payload.org_id,dedupeKey,maxAttempts:1}))
   .useCleanup({mirrors,sends,enqueue:(tx,payload,dedupeKey)=>enqueueOrRearmFailed(QUEUE_NAMES.SCHEDULED_JOBS,EMAIL_PROVIDER_DRAFT_CLEANUP_JOB,
    payload,{executor:tx,orgId:payload.org_id,dedupeKey,maxAttempts:1})});
}
