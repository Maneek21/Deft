import {createHash} from 'node:crypto';
import {and,eq,isNull,isNotNull,or,lt,sql} from 'drizzle-orm';
import {emailAccounts,emailDrafts,emailProviderDraftMirrors} from '@deft/db/schema';
import type {db} from './db.js';
import {EmailDraftStore} from './email-draft-store.js';
import type {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailProviderDraftJobInput} from './email-provider-draft-job.js';
import type {EmailScope} from './email-mailbox-service.js';
type Database=Pick<typeof db,'select'|'transaction'>;
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
export type EmailProviderDraftRepairCursor=EmailScope&Readonly<{draft_id:string}>;
type Enqueue=(tx:Tx,payload:EmailProviderDraftJobInput,dedupeKey:string)=>Promise<unknown>;
const scoped=(table:typeof emailAccounts|typeof emailDrafts|typeof emailProviderDraftMirrors,scope:EmailScope)=>and(
 eq(table.org_id,scope.org_id),eq(table.owner_user_id,scope.owner_user_id),eq(table.account_id,scope.account_id));

/** Bounded metadata-only producer. It repairs missed enqueue events and seeds
 * existing local drafts after opt-in. Actual content and provider access still
 * require the worker's fresh account, binding and queue-lease authority. */
export class PostgresEmailProviderDraftScheduler{
 constructor(private readonly database:Database,private readonly cipher:EmailMailboxCrypto,private readonly enqueue:Enqueue){}
 async repair(after:EmailProviderDraftRepairCursor|null=null,limit=50){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('EMAIL_DRAFT_SYNC_SCAN_INVALID');
  const conditions=[eq(emailAccounts.state,'active'),eq(emailAccounts.provider_draft_sync_enabled,true),isNull(emailAccounts.revoked_at),
   isNotNull(emailAccounts.consented_at),isNotNull(emailAccounts.principal_digest),eq(emailDrafts.status,'draft'),
   or(isNull(emailProviderDraftMirrors.draft_id),eq(emailProviderDraftMirrors.state,'queued'),lt(emailProviderDraftMirrors.desired_revision,emailDrafts.revision))];
  if(after)conditions.push(sql`(${emailDrafts.org_id} COLLATE "C",${emailDrafts.owner_user_id} COLLATE "C",${emailDrafts.account_id} COLLATE "C",${emailDrafts.draft_id} COLLATE "C") > (${after.org_id} COLLATE "C",${after.owner_user_id} COLLATE "C",${after.account_id} COLLATE "C",${after.draft_id} COLLATE "C")`);
  const candidates=await this.database.select({org_id:emailDrafts.org_id,owner_user_id:emailDrafts.owner_user_id,account_id:emailDrafts.account_id,draft_id:emailDrafts.draft_id})
   .from(emailDrafts).innerJoin(emailAccounts,and(eq(emailDrafts.org_id,emailAccounts.org_id),eq(emailDrafts.owner_user_id,emailAccounts.owner_user_id),eq(emailDrafts.account_id,emailAccounts.account_id)))
   .leftJoin(emailProviderDraftMirrors,and(eq(emailDrafts.org_id,emailProviderDraftMirrors.org_id),eq(emailDrafts.owner_user_id,emailProviderDraftMirrors.owner_user_id),eq(emailDrafts.account_id,emailProviderDraftMirrors.account_id),eq(emailDrafts.draft_id,emailProviderDraftMirrors.draft_id)))
   .where(and(...conditions)).orderBy(sql`${emailDrafts.org_id} COLLATE "C"`,sql`${emailDrafts.owner_user_id} COLLATE "C"`,sql`${emailDrafts.account_id} COLLATE "C"`,sql`${emailDrafts.draft_id} COLLATE "C"`).limit(limit);
  const drafts=new EmailDraftStore(this.database,this.cipher);let scheduled=0;
  for(const row of candidates){
   const scope={org_id:row.org_id,owner_user_id:row.owner_user_id,account_id:row.account_id};
   scheduled+=await this.database.transaction(async tx=>{
    // Producer acquires no legacy lock and performs no private-content read.
    // Native account -> draft -> mirror -> queue matches worker domain order.
    const [account]=await tx.select().from(emailAccounts).where(scoped(emailAccounts,scope)).limit(1).for('share');
    if(!account||account.state!=='active'||!account.provider_draft_sync_enabled||account.revoked_at||!account.consented_at||!account.principal_digest)return 0;
    const [draft]=await tx.select({revision:emailDrafts.revision,status:emailDrafts.status}).from(emailDrafts).where(and(scoped(emailDrafts,scope),eq(emailDrafts.draft_id,row.draft_id))).limit(1).for('update');
    if(!draft||draft.status!=='draft')return 0;
    await drafts.recordDesired(tx,scope,row.draft_id,draft.revision);
    const [mirror]=await tx.select({state:emailProviderDraftMirrors.state,revision:emailProviderDraftMirrors.desired_revision,generation:emailProviderDraftMirrors.generation})
     .from(emailProviderDraftMirrors).where(and(scoped(emailProviderDraftMirrors,scope),eq(emailProviderDraftMirrors.draft_id,row.draft_id))).limit(1);
    if(!mirror||mirror.state!=='queued'||mirror.revision!==draft.revision)return 0;
    const payload={...scope,draft_id:row.draft_id,revision:draft.revision,authority_revision:account.authority_revision};
    const key='email-draft:'+createHash('sha256').update(JSON.stringify([scope,row.draft_id,draft.revision,mirror.generation,account.authority_revision])).digest('hex');
    await this.enqueue(tx,payload,key);return 1;
   });
  }
  return {scanned:candidates.length,scheduled,next:candidates.length===limit?candidates.at(-1)!:null,done:candidates.length<limit};
 }
}
