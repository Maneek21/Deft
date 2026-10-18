import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailSendStore} from './email-send-store.js';
import {PostgresEmailProviderDraftCleanupScheduler,type EmailProviderDraftCleanupCursor} from './email-provider-draft-cleanup-scheduler.js';
import {enqueueOrRearmFailed,QUEUE_NAMES} from './queues.js';
import {EMAIL_PROVIDER_DRAFT_CLEANUP_JOB} from './email-provider-draft-cleanup-job.js';
export async function repairNativeEmailDraftCleanupBatch(after:EmailProviderDraftCleanupCursor|null,limit=50){
 const {keys}=await getAppRunRuntime(),cipher=new EmailMailboxCrypto(keys),sends=new EmailSendStore(db,cipher);
 const scheduler=new PostgresEmailProviderDraftCleanupScheduler(db,sends,(tx,payload,dedupeKey)=>enqueueOrRearmFailed(
  QUEUE_NAMES.SCHEDULED_JOBS,EMAIL_PROVIDER_DRAFT_CLEANUP_JOB,payload,{executor:tx,orgId:payload.org_id,dedupeKey,maxAttempts:1}));
 return scheduler.repair(after,limit);
}
