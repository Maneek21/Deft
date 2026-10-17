import {and,eq,gt,lt,inArray,sql} from 'drizzle-orm';
import {emailAccounts,emailProviderDraftMirrors,jobQueue} from '@deft/db/schema';
import type {db} from './db.js';
import type {EmailProviderDraftMirrorStore} from './email-provider-draft-mirror-store.js';
import type {EmailScope} from './email-mailbox-service.js';
import {EMAIL_PROVIDER_DRAFT_JOB} from './email-provider-draft-job.js';
type Database=Pick<typeof db,'select'|'transaction'>;
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
const stillRunning='EMAIL_DRAFT_SYNC_STILL_RUNNING';
/** Expired delivery recovery only marks uncertainty. It never replays a
 * mutation or clears a provider reference. A live worker's scoped queue lease
 * is locked/rechecked before the mirror write, including during opt-out. */
export class PostgresEmailProviderDraftRecovery{
 constructor(private readonly database:Database,private readonly mirrors:Pick<EmailProviderDraftMirrorStore,'readActiveClaim'|'recoverToUnknown'>,private readonly now=Date.now){}
 async recover(limit=50){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('EMAIL_DRAFT_SYNC_SCAN_INVALID');
  const rows=await this.database.select({org_id:emailProviderDraftMirrors.org_id,owner_user_id:emailProviderDraftMirrors.owner_user_id,
   account_id:emailProviderDraftMirrors.account_id,draft_id:emailProviderDraftMirrors.draft_id}).from(emailProviderDraftMirrors)
   .where(and(eq(emailProviderDraftMirrors.state,'syncing'),lt(emailProviderDraftMirrors.updated_at,new Date(this.now()-120000)),
    // Skip live claims before LIMIT so a slow live batch cannot starve older
    // expired claims. The transaction guard below still fences the race.
    sql`NOT EXISTS (SELECT 1 FROM ${jobQueue} WHERE ${jobQueue.org_id}=${emailProviderDraftMirrors.org_id}
     AND ${jobQueue.queue}='scheduled-jobs' AND ${jobQueue.name} IN (${EMAIL_PROVIDER_DRAFT_JOB},'native-email-draft-cleanup')
     AND ${jobQueue.status}='running' AND ${jobQueue.lock_expires_at}>${new Date(this.now())}
     AND ${jobQueue.data}->>'org_id'=${emailProviderDraftMirrors.org_id}
     AND ${jobQueue.data}->>'owner_user_id'=${emailProviderDraftMirrors.owner_user_id}
     AND ${jobQueue.data}->>'account_id'=${emailProviderDraftMirrors.account_id}
     AND ${jobQueue.data}->>'draft_id'=${emailProviderDraftMirrors.draft_id})`))
   .orderBy(emailProviderDraftMirrors.updated_at,emailProviderDraftMirrors.draft_id).limit(limit);
  let recovered=0;
  for(const row of rows){
   const scope:EmailScope={org_id:row.org_id,owner_user_id:row.owner_user_id,account_id:row.account_id};
   const guard=async(transaction:unknown)=>{
    const tx=transaction as Tx;
    const [account]=await tx.select({id:emailAccounts.account_id}).from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1).for('share');
    if(!account)throw Error('EMAIL_DRAFT_SYNC_RECOVERY_UNAVAILABLE');
    const jobs=await tx.select({id:jobQueue.id}).from(jobQueue).where(and(eq(jobQueue.org_id,scope.org_id),eq(jobQueue.queue,'scheduled-jobs'),
     inArray(jobQueue.name,[EMAIL_PROVIDER_DRAFT_JOB,'native-email-draft-cleanup']),eq(jobQueue.status,'running'),gt(jobQueue.lock_expires_at,new Date(this.now())),
     sql`${jobQueue.data}->>'org_id'=${scope.org_id}`,sql`${jobQueue.data}->>'owner_user_id'=${scope.owner_user_id}`,
     sql`${jobQueue.data}->>'account_id'=${scope.account_id}`,sql`${jobQueue.data}->>'draft_id'=${row.draft_id}`)).limit(1).for('share');
    if(jobs.length)throw Error(stillRunning);
   };
   try{const claim=await this.mirrors.readActiveClaim(scope,row.draft_id,guard);
    if(claim&&await this.mirrors.recoverToUnknown(scope,row.draft_id,claim,guard))recovered++;
   }catch(error){if(!(error instanceof Error)||error.message!==stillRunning)throw error;}
  }
  return {scanned:rows.length,recovered};
 }
}
