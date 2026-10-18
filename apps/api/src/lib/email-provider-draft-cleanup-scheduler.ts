import {createHash} from 'node:crypto';
import {and,eq,inArray,isNotNull,or,sql} from 'drizzle-orm';
import {emailAccounts,emailDrafts,emailProviderDraftMirrors,emailSendOperations,emailOutbox} from '@deft/db/schema';
import type {db} from './db.js';
import type {EmailSendStore} from './email-send-store.js';
import type {EmailScope} from './email-mailbox-service.js';
import type {EmailProviderDraftCleanupJobInput} from './email-provider-draft-cleanup-job.js';
type Database=Pick<typeof db,'select'|'transaction'>;
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
export type EmailProviderDraftCleanupCursor=EmailScope&Readonly<{operation_id:string}>;
type Enqueue=(tx:Tx,payload:EmailProviderDraftCleanupJobInput,dedupeKey:string)=>Promise<unknown>;
const scoped=(table:typeof emailAccounts|typeof emailDrafts|typeof emailProviderDraftMirrors|typeof emailSendOperations,scope:EmailScope)=>and(
  eq(table.org_id,scope.org_id),eq(table.owner_user_id,scope.owner_user_id),eq(table.account_id,scope.account_id));

/** Bounded metadata-only accepted-send scanner. It schedules only rows whose
 * authenticated send receipt and exact mirrored content revision still match. */
export class PostgresEmailProviderDraftCleanupScheduler{
  constructor(private readonly database:Database,private readonly sends:Pick<EmailSendStore,'verifyAccepted'>,private readonly enqueue:Enqueue){}
  async repair(after:EmailProviderDraftCleanupCursor|null=null,limit=50){
    if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('EMAIL_DRAFT_CLEANUP_SCAN_INVALID');
    const conditions=[eq(emailSendOperations.state,'accepted'),eq(emailAccounts.state,'active'),eq(emailAccounts.provider_draft_sync_enabled,true),
      sql`${emailAccounts.revoked_at} IS NULL`,isNotNull(emailAccounts.consented_at),isNotNull(emailAccounts.principal_digest),
      inArray(emailDrafts.status,['submitted','archived']),sql`${emailDrafts.content_revision}=${emailSendOperations.draft_revision}`,
      inArray(emailProviderDraftMirrors.state,['synced','delete_pending']),
      sql`${emailProviderDraftMirrors.desired_revision}=${emailSendOperations.draft_revision}`,
      sql`${emailProviderDraftMirrors.synced_revision}=${emailSendOperations.draft_revision}`];
    if(after)conditions.push(sql`(${emailSendOperations.org_id} COLLATE "C",${emailSendOperations.owner_user_id} COLLATE "C",
      ${emailSendOperations.account_id} COLLATE "C",${emailSendOperations.operation_id} COLLATE "C") >
      (${after.org_id} COLLATE "C",${after.owner_user_id} COLLATE "C",${after.account_id} COLLATE "C",${after.operation_id} COLLATE "C")`);
    const candidates=await this.database.select({org_id:emailSendOperations.org_id,owner_user_id:emailSendOperations.owner_user_id,
      account_id:emailSendOperations.account_id,operation_id:emailSendOperations.operation_id,draft_id:emailSendOperations.draft_id,
      revision:emailSendOperations.draft_revision}).from(emailSendOperations)
      .innerJoin(emailAccounts,and(eq(emailSendOperations.org_id,emailAccounts.org_id),eq(emailSendOperations.owner_user_id,emailAccounts.owner_user_id),eq(emailSendOperations.account_id,emailAccounts.account_id)))
      .innerJoin(emailDrafts,and(eq(emailSendOperations.org_id,emailDrafts.org_id),eq(emailSendOperations.owner_user_id,emailDrafts.owner_user_id),
        eq(emailSendOperations.account_id,emailDrafts.account_id),eq(emailSendOperations.draft_id,emailDrafts.draft_id)))
      .innerJoin(emailProviderDraftMirrors,and(eq(emailSendOperations.org_id,emailProviderDraftMirrors.org_id),eq(emailSendOperations.owner_user_id,emailProviderDraftMirrors.owner_user_id),
        eq(emailSendOperations.account_id,emailProviderDraftMirrors.account_id),eq(emailSendOperations.draft_id,emailProviderDraftMirrors.draft_id)))
      .where(and(...conditions)).orderBy(sql`${emailSendOperations.org_id} COLLATE "C"`,sql`${emailSendOperations.owner_user_id} COLLATE "C"`,
        sql`${emailSendOperations.account_id} COLLATE "C"`,sql`${emailSendOperations.operation_id} COLLATE "C"`).limit(limit);
    const outboxCandidates=await this.database.select({org_id:emailOutbox.org_id,owner_user_id:emailOutbox.owner_user_id,
      account_id:emailOutbox.account_id,operation_id:emailOutbox.operation_id,draft_id:emailOutbox.draft_id,revision:emailOutbox.draft_revision})
      .from(emailOutbox).innerJoin(emailAccounts,and(eq(emailOutbox.org_id,emailAccounts.org_id),eq(emailOutbox.owner_user_id,emailAccounts.owner_user_id),eq(emailOutbox.account_id,emailAccounts.account_id)))
      .innerJoin(emailDrafts,and(eq(emailOutbox.org_id,emailDrafts.org_id),eq(emailOutbox.owner_user_id,emailDrafts.owner_user_id),
        eq(emailOutbox.account_id,emailDrafts.account_id),eq(emailOutbox.draft_id,emailDrafts.draft_id)))
      .innerJoin(emailProviderDraftMirrors,and(eq(emailOutbox.org_id,emailProviderDraftMirrors.org_id),eq(emailOutbox.owner_user_id,emailProviderDraftMirrors.owner_user_id),
        eq(emailOutbox.account_id,emailProviderDraftMirrors.account_id),eq(emailOutbox.draft_id,emailProviderDraftMirrors.draft_id)))
      .where(and(eq(emailOutbox.state,'accepted'),eq(emailAccounts.state,'active'),eq(emailAccounts.provider_draft_sync_enabled,true),
        sql`${emailAccounts.revoked_at} IS NULL`,isNotNull(emailAccounts.consented_at),isNotNull(emailAccounts.principal_digest),
        inArray(emailDrafts.status,['submitted','archived']),sql`${emailDrafts.content_revision}=${emailOutbox.draft_revision}`,
        inArray(emailProviderDraftMirrors.state,['synced','delete_pending']),sql`${emailProviderDraftMirrors.desired_revision}=${emailOutbox.draft_revision}`,
        sql`${emailProviderDraftMirrors.synced_revision}=${emailOutbox.draft_revision}`,
        after?sql`(${emailOutbox.org_id} COLLATE "C",${emailOutbox.owner_user_id} COLLATE "C",${emailOutbox.account_id} COLLATE "C",${emailOutbox.operation_id} COLLATE "C") >
          (${after.org_id} COLLATE "C",${after.owner_user_id} COLLATE "C",${after.account_id} COLLATE "C",${after.operation_id} COLLATE "C")`:undefined))
      .orderBy(sql`${emailOutbox.org_id} COLLATE "C"`,sql`${emailOutbox.owner_user_id} COLLATE "C"`,
        sql`${emailOutbox.account_id} COLLATE "C"`,sql`${emailOutbox.operation_id} COLLATE "C"`).limit(limit);
    const compare=(a:typeof candidates[number],b:typeof candidates[number])=>{
      for(const key of ['org_id','owner_user_id','account_id','operation_id'] as const){if(a[key]!==b[key])return a[key]<b[key]?-1:1;}return 0;
    };
    const selected=[...candidates,...outboxCandidates].sort(compare).slice(0,limit);
    let scheduled=0;
    for(const candidate of selected){
      const scope:EmailScope={org_id:candidate.org_id,owner_user_id:candidate.owner_user_id,account_id:candidate.account_id};
      scheduled+=await this.database.transaction(async tx=>{
        const [account]=await tx.select().from(emailAccounts).where(scoped(emailAccounts,scope)).limit(1).for('share');
        if(!account||account.state!=='active'||!account.provider_draft_sync_enabled||account.revoked_at||!account.consented_at||!account.principal_digest)return 0;
        const [draft]=await tx.select({revision:emailDrafts.revision,content_revision:emailDrafts.content_revision,status:emailDrafts.status})
          .from(emailDrafts).where(and(scoped(emailDrafts,scope),eq(emailDrafts.draft_id,candidate.draft_id))).limit(1).for('update');
        if(!draft||!['submitted','archived'].includes(draft.status)||draft.content_revision!==candidate.revision)return 0;
        const accepted=await this.sends.verifyAccepted(scope,{operation_id:candidate.operation_id,draft_id:candidate.draft_id,revision:candidate.revision},async()=>{},undefined,tx);
        if(!accepted)return 0;
        const [mirror]=await tx.select({state:emailProviderDraftMirrors.state,desired_revision:emailProviderDraftMirrors.desired_revision,
          synced_revision:emailProviderDraftMirrors.synced_revision,generation:emailProviderDraftMirrors.generation,provider_envelope:emailProviderDraftMirrors.provider_envelope})
          .from(emailProviderDraftMirrors).where(and(scoped(emailProviderDraftMirrors,scope),eq(emailProviderDraftMirrors.draft_id,candidate.draft_id))).limit(1).for('update');
        if(!mirror||!['synced','delete_pending'].includes(mirror.state)||mirror.desired_revision!==candidate.revision
          ||mirror.synced_revision!==candidate.revision||!mirror.provider_envelope)return 0;
        const payload:EmailProviderDraftCleanupJobInput={...scope,draft_id:candidate.draft_id,revision:candidate.revision,
          operation_id:candidate.operation_id,generation:mirror.generation,authority_revision:account.authority_revision,mode:'delete'};
        const key='email-draft-cleanup:'+createHash('sha256').update(JSON.stringify([scope,candidate.draft_id,candidate.revision,
          candidate.operation_id,mirror.generation,account.authority_revision])).digest('hex');
        await this.enqueue(tx,payload,key);return 1;
      });
    }
    return {scanned:selected.length,scheduled,next:selected.length===limit?{org_id:selected.at(-1)!.org_id,owner_user_id:selected.at(-1)!.owner_user_id,
      account_id:selected.at(-1)!.account_id,operation_id:selected.at(-1)!.operation_id}:null,done:selected.length<limit};
  }
}
