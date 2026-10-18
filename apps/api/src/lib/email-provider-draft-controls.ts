import {createHash} from 'node:crypto';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {emailAccounts,emailDrafts,emailProviderDraftMirrors,jobQueue} from '@deft/db/schema';
import {z} from 'zod';
import type {db} from './db.js';
import type {EmailActor,EmailScope,EmailAuthority} from './email-mailbox-service.js';
import type {EmailProviderDraftMirrorStore} from './email-provider-draft-mirror-store.js';
import type {EmailProviderDraftJobInput} from './email-provider-draft-job.js';
import type {EmailProviderDraftCleanupJobInput} from './email-provider-draft-cleanup-job.js';
import type {EmailSendStore} from './email-send-store.js';
import {EMAIL_PROVIDER_DRAFT_JOB} from './email-provider-draft-job.js';
import {EMAIL_PROVIDER_DRAFT_CLEANUP_JOB} from './email-provider-draft-cleanup-job.js';
type Database=Pick<typeof db,'transaction'>;
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
const Revision=z.number().int().min(1).max(2147483647);
const Recovery=z.strictObject({expected_revision:Revision,expected_generation:Revision});
const scopeSchema=z.strictObject({org_id:z.string().min(1).max(256),owner_user_id:z.string().min(1).max(256),account_id:z.string().min(1).max(256)});
export class EmailProviderDraftControlError extends Error{
 constructor(readonly code:'EMAIL_DRAFT_SYNC_CONFLICT'|'EMAIL_DRAFT_SYNC_ACCESS_DENIED'|'EMAIL_DRAFT_SYNC_INVALID'){super(code);}
}
/** Human controls only enqueue an explicitly requested reconciliation. The
 * leased worker, never this HTTP path, decides which journal step is provable. */
export class EmailProviderDraftControls{
 constructor(private readonly database:Database,private readonly authority:EmailAuthority,private readonly mirrors:Pick<EmailProviderDraftMirrorStore,'readStatus'>,
  private readonly enqueue:(tx:Tx,payload:EmailProviderDraftJobInput,key:string)=>Promise<unknown>){}
 private cleanup?:Readonly<{mirrors:Pick<EmailProviderDraftMirrorStore,'readCleanupRecoveryNomination'>;sends:Pick<EmailSendStore,'verifyAccepted'>;
  enqueue:(tx:Tx,payload:EmailProviderDraftCleanupJobInput,key:string)=>Promise<unknown>}>;
 useCleanup(dependencies:NonNullable<EmailProviderDraftControls['cleanup']>):this{this.cleanup=dependencies;return this;}
 private async run<T>(actor:EmailActor,scope:EmailScope,draftId:string,operation:'human_read'|'human_modify',
  work:(tx:Tx,guard:(tx:unknown)=>Promise<void>)=>Promise<T>,signal?:AbortSignal){
  try{scopeSchema.parse(scope);z.string().uuid().parse(draftId);}catch{throw new EmailProviderDraftControlError('EMAIL_DRAFT_SYNC_INVALID');}
  if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=Date.now())throw new EmailProviderDraftControlError('EMAIL_DRAFT_SYNC_ACCESS_DENIED');
  const expected=await this.authority.current(actor,scope,operation,undefined,signal);
  const guard=async(tx:unknown)=>{signal?.throwIfAborted();const current=await this.authority.current(actor,scope,operation,tx,signal);
   if(current.authority_version!==expected.authority_version||current.resource_binding_id!==expected.resource_binding_id||current.expires_at<=Date.now())throw new EmailProviderDraftControlError('EMAIL_DRAFT_SYNC_ACCESS_DENIED');};
  return this.database.transaction(async tx=>{await guard(tx);const result=await work(tx,guard);await guard(tx);signal?.throwIfAborted();return result;});
 }
 private async pending(tx:Tx,scope:EmailScope,draftId:string){
  const rows=await tx.select({id:jobQueue.id}).from(jobQueue).where(and(eq(jobQueue.org_id,scope.org_id),eq(jobQueue.queue,'scheduled-jobs'),
   eq(jobQueue.name,EMAIL_PROVIDER_DRAFT_JOB),inArray(jobQueue.status,['pending','running']),sql`${jobQueue.data}->>'mode'='reconcile'`,
   sql`${jobQueue.data}->>'org_id'=${scope.org_id}`,sql`${jobQueue.data}->>'owner_user_id'=${scope.owner_user_id}`,
   sql`${jobQueue.data}->>'account_id'=${scope.account_id}`,sql`${jobQueue.data}->>'draft_id'=${draftId}`)).limit(1);
  return rows.length>0;
 }
 private async pendingCleanup(tx:Tx,scope:EmailScope,draftId:string){
  const rows=await tx.select({id:jobQueue.id}).from(jobQueue).where(and(eq(jobQueue.org_id,scope.org_id),eq(jobQueue.queue,'scheduled-jobs'),
   eq(jobQueue.name,EMAIL_PROVIDER_DRAFT_CLEANUP_JOB),inArray(jobQueue.status,['pending','running']),sql`${jobQueue.data}->>'mode'='reconcile'`,
   sql`${jobQueue.data}->>'org_id'=${scope.org_id}`,sql`${jobQueue.data}->>'owner_user_id'=${scope.owner_user_id}`,
   sql`${jobQueue.data}->>'account_id'=${scope.account_id}`,sql`${jobQueue.data}->>'draft_id'=${draftId}`)).limit(1);
  return rows.length>0;
 }
 async status(actor:EmailActor,scope:EmailScope,draftId:string,signal?:AbortSignal){
  return this.run(actor,scope,draftId,'human_read',async(tx,guard)=>{
   const status=await this.mirrors.readStatus(scope,draftId,guard,signal,tx);
   if(status.draft_revision===null)throw new EmailProviderDraftControlError('EMAIL_DRAFT_SYNC_CONFLICT');
   return {...status,draft_revision:status.draft_revision,recovery_pending:await this.pending(tx,scope,draftId)||await this.pendingCleanup(tx,scope,draftId)};
  },signal);
 }
 async recover(actor:EmailActor,scope:EmailScope,draftId:string,input:unknown,signal?:AbortSignal){
  const parsed=Recovery.safeParse(input);if(!parsed.success)throw new EmailProviderDraftControlError('EMAIL_DRAFT_SYNC_INVALID');
  return this.run(actor,scope,draftId,'human_modify',async(tx,guard)=>{
   const where=(table:typeof emailDrafts|typeof emailProviderDraftMirrors)=>and(eq(table.org_id,scope.org_id),eq(table.owner_user_id,scope.owner_user_id),eq(table.account_id,scope.account_id),eq(table.draft_id,draftId));
   await tx.select({id:emailDrafts.draft_id}).from(emailDrafts).where(where(emailDrafts)).limit(1).for('update');
   await tx.select({id:emailProviderDraftMirrors.draft_id}).from(emailProviderDraftMirrors).where(where(emailProviderDraftMirrors)).limit(1).for('update');
   const status=await this.mirrors.readStatus(scope,draftId,guard,signal,tx);
   if(await this.pending(tx,scope,draftId)||await this.pendingCleanup(tx,scope,draftId))return {account_id:scope.account_id,draft_id:draftId,state:'queued' as const};
   if(!status.enabled||!status.recovery_available||status.state!=='unknown'||status.draft_revision!==parsed.data.expected_revision||status.generation!==parsed.data.expected_generation)
    throw new EmailProviderDraftControlError('EMAIL_DRAFT_SYNC_CONFLICT');
   const cleanup=this.cleanup?await this.cleanup.mirrors.readCleanupRecoveryNomination(scope,draftId,guard,signal,tx):null;
   if(cleanup){
    if(await this.pendingCleanup(tx,scope,draftId))return {account_id:scope.account_id,draft_id:draftId,state:'queued' as const};
    if(!this.cleanup||cleanup.generation!==parsed.data.expected_generation)
     throw new EmailProviderDraftControlError('EMAIL_DRAFT_SYNC_CONFLICT');
    const accepted=await this.cleanup.sends.verifyAccepted(scope,{operation_id:cleanup.send_operation_id,draft_id:draftId,revision:cleanup.revision},guard,signal,tx);
    if(!accepted)throw new EmailProviderDraftControlError('EMAIL_DRAFT_SYNC_CONFLICT');
    const [cleanupAccount]=await tx.select({revision:emailAccounts.authority_revision}).from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),
     eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1);
    if(!cleanupAccount)throw new EmailProviderDraftControlError('EMAIL_DRAFT_SYNC_ACCESS_DENIED');
    const payload:EmailProviderDraftCleanupJobInput={...scope,draft_id:draftId,revision:cleanup.revision,operation_id:cleanup.send_operation_id,
     generation:cleanup.generation,authority_revision:cleanupAccount.revision,mode:'reconcile'};
    const key='email-draft-cleanup-recovery:'+createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await this.cleanup.enqueue(tx,payload,key);return {account_id:scope.account_id,draft_id:draftId,state:'queued' as const};
   }
   const [account]=await tx.select({revision:emailAccounts.authority_revision}).from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),
    eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1);
   if(!account)throw new EmailProviderDraftControlError('EMAIL_DRAFT_SYNC_ACCESS_DENIED');
   const payload:EmailProviderDraftJobInput={...scope,draft_id:draftId,revision:parsed.data.expected_revision,generation:parsed.data.expected_generation,
    mode:'reconcile',authority_revision:account.revision};
   const key='email-draft-recovery:'+createHash('sha256').update(JSON.stringify(payload)).digest('hex');
   await this.enqueue(tx,payload,key);
   return {account_id:scope.account_id,draft_id:draftId,state:'queued' as const};
  },signal);
 }
}
