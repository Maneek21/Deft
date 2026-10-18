import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import { and, eq, inArray } from 'drizzle-orm';
import { emailAccounts, jobQueue } from '@deft/db/schema';
import { PostgresEmailMailboxAuthority, type EmailAuthorityDatabase } from './email-mailbox-authority.js';
import type { ConnectedEmailMailboxAuthority } from './email-mailbox-connected-authority.js';
import { EmailMailboxError, type EmailActor, type EmailScope } from './email-mailbox-service.js';
import { EMAIL_MAILBOX_QUEUE, EMAIL_MAILBOX_SYNC_JOB, emailMailboxFailureCanRearm, emailMailboxSyncDedupeKey } from './email-mailbox-scheduler.js';
import type { enqueue } from './queues.js';

type Runtime = { authority: Pick<ConnectedEmailMailboxAuthority, 'inspect'>;
  sqlAuthority: Pick<PostgresEmailMailboxAuthority, 'current'> };
export type EmailRefreshResult = Readonly<{account_id:string;state:'queued'|'syncing'|'needs_attention'}>;
const denied=():never=>{throw new EmailMailboxError('EMAIL_ACCESS_DENIED');};
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256
  &&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);

/** Refresh advances the existing read-only sync job. It never takes a running
 * worker's lease or creates another provider operation beside it. The HTTP
 * acknowledgement means queued, not that fresh messages have been fetched. */
export class PostgresEmailMailboxRefresh {
  constructor(private readonly database:EmailAuthorityDatabase,
    private readonly runtime:(actor:EmailActor)=>Promise<Runtime>=async actor=>{
      const [{getEmailMailboxRuntime},{db}]=await Promise.all([import('./email-mailbox-runtime.js'),import('./db.js')]);
      const {authority}=await getEmailMailboxRuntime(actor);
      return {authority,sqlAuthority:await getEmailMailboxAuthority(db)};
    },
    private readonly queue:typeof enqueue=async(...args)=>(await import('./queues.js')).enqueue(...args),
    private readonly now=Date.now){}
  async request(actor:EmailActor,orgId:string,accountId:string,signal?:AbortSignal):Promise<EmailRefreshResult>{
    signal?.throwIfAborted();
    if(![actor?.user_id,actor?.web_session_id,orgId,accountId].every(validId)
      ||!Number.isFinite(actor?.access_expires_at)||actor.access_expires_at<=this.now())return denied();
    actor=Object.freeze({...actor});
    const scope:EmailScope=Object.freeze({org_id:orgId,owner_user_id:actor.user_id,account_id:accountId});
    const {authority,sqlAuthority}=await this.runtime(actor);
    // Provider/custody status may perform network-adjacent credential refresh.
    // Keep that work outside the queue transaction to preserve custody -> SQL
    // lock ordering used by sync workers.
    const sqlBefore=await sqlAuthority.current(actor,scope,'human_sync',undefined,signal);
    const before=await authority.inspect(actor,scope,'human_sync',undefined,signal);
    if(before.capability.resource_binding_id!==sqlBefore.resource_binding_id)return denied();
    const result=await this.database.transaction(async tx=>{
      const sqlEntry=await sqlAuthority.current(actor,scope,'human_sync',tx,signal);
      if(sqlEntry.resource_binding_id!==sqlBefore.resource_binding_id||sqlEntry.authority_version!==sqlBefore.authority_version)return denied();
      const [account]=await tx.select().from(emailAccounts).where(and(eq(emailAccounts.org_id,orgId),
        eq(emailAccounts.owner_user_id,actor.user_id),eq(emailAccounts.account_id,accountId))).limit(1);
      if(!account||account.state!=='active'||account.resource_binding_id!==before.capability.resource_binding_id
        ||account.principal_digest!==before.account.principal_digest||!Number.isSafeInteger(account.authority_revision)
        ||account.authority_revision<1)return denied();
      const payload={...scope,authority_revision:account.authority_revision},dedupeKey=emailMailboxSyncDedupeKey(payload);
      await this.queue(EMAIL_MAILBOX_QUEUE,EMAIL_MAILBOX_SYNC_JOB,payload,{orgId,dedupeKey,maxAttempts:5,executor:tx});
      const matches=and(eq(jobQueue.org_id,orgId),eq(jobQueue.queue,EMAIL_MAILBOX_QUEUE),eq(jobQueue.name,EMAIL_MAILBOX_SYNC_JOB),eq(jobQueue.dedupe_key,dedupeKey));
      const [job]=await tx.select().from(jobQueue).where(matches).limit(1).for('update');
      if(!job||JSON.stringify(Object.entries(job.data as object).sort())!==JSON.stringify(Object.entries(payload).sort()))return denied();
      let state:EmailRefreshResult['state']='needs_attention';
      if(job.status==='running')state='syncing';
      else if(job.status==='pending'||job.status==='completed'||job.status==='failed'
        &&emailMailboxFailureCanRearm(job.error)){
        await tx.update(jobQueue).set({status:'pending',run_at:new Date(this.now()),attempts:job.status==='pending'?job.attempts:0,
          started_at:null,completed_at:null,error:null,locked_by:null,lock_token:null,lock_expires_at:null})
          .where(and(matches,inArray(jobQueue.status,['pending','completed','failed'])));
        state='queued';
      }
      const sqlAfter=await sqlAuthority.current(actor,scope,'human_sync',tx,signal);
      signal?.throwIfAborted();
      if(actor.access_expires_at<=this.now()||sqlBefore.authority_version!==sqlAfter.authority_version
        ||sqlBefore.resource_binding_id!==sqlAfter.resource_binding_id)return denied();
      return {account_id:accountId,state};
    });
    // A credential revoke racing the SQL commit may leave a harmless queued
    // row; the worker rechecks connected authority before any data/effect.
    const after=await authority.inspect(actor,scope,'human_sync',undefined,signal);
    if(before.capability.authority_version!==after.capability.authority_version
      ||before.account.principal_digest!==after.account.principal_digest)return denied();
    return result;
  }
}
