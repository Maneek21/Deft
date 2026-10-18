import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {PostgresEmailProviderDraftScheduler,type EmailProviderDraftRepairCursor} from './email-provider-draft-scheduler.js';
import {enqueueOrRearmFailed,QUEUE_NAMES} from './queues.js';
import {EMAIL_PROVIDER_DRAFT_JOB} from './email-provider-draft-job.js';
import {PostgresEmailProviderDraftRecovery} from './email-provider-draft-recovery.js';
import {EmailProviderDraftMirrorStore} from './email-provider-draft-mirror-store.js';
export async function repairNativeEmailDraftBatch(after:EmailProviderDraftRepairCursor|null,limit=50){
 const {keys}=await getAppRunRuntime();
 const cipher=new EmailMailboxCrypto(keys);
 await new PostgresEmailProviderDraftRecovery(db,new EmailProviderDraftMirrorStore(db,cipher)).recover(limit);
 return new PostgresEmailProviderDraftScheduler(db,cipher,(tx,payload,dedupeKey)=>enqueueOrRearmFailed(
  QUEUE_NAMES.SCHEDULED_JOBS,EMAIL_PROVIDER_DRAFT_JOB,payload,{executor:tx,orgId:payload.org_id,dedupeKey,maxAttempts:1})).repair(after,limit);
}
