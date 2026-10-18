import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { emailAccounts,emailDrafts,emailProviderDraftMirrors,emailSendOperations } from '@deft/db/schema';
import { z } from 'zod';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import { emailProviderDraftContext, type EmailDraftDatabase, type EmailDraftGuard, type EmailDraftTransaction } from './email-draft-store.js';
import type { EmailScope } from './email-mailbox-service.js';

const ScopeSchema = z.strictObject({ org_id:z.string().min(1).max(256), owner_user_id:z.string().min(1).max(256), account_id:z.string().min(1).max(256) });
const PrivateMirrorSchema = z.record(z.string().min(1).max(128), z.unknown()).refine(value => Object.keys(value).length <= 32);
const lockSchema = z.string().min(16).max(512);
const draftIdSchema=z.string().uuid();
const positiveRevision=z.number().int().min(1).max(2147483647);
const digestSchema=z.string().regex(/^[a-f0-9]{64}$/u);
const RecoveryDescriptorSchema=z.strictObject({operation_id:z.string().uuid(),desired_revision:positiveRevision,desired_digest:digestSchema,
  provider_draft_ref:z.string().min(1).max(256),baseline_digest:digestSchema,provider_version:z.string().min(1).max(256)});
const CleanupDescriptorSchema=z.strictObject({operation_id:z.string().uuid(),send_operation_id:z.string().uuid(),draft_revision:positiveRevision,
  desired_revision:positiveRevision,provider:z.enum(['gmail','microsoft']),provider_draft_ref:z.string().min(1).max(256),
  baseline_digest:digestSchema,provider_version:z.string().min(1).max(256)});
export type EmailProviderDraftMirrorState = 'queued'|'syncing'|'synced'|'conflict'|'unknown'|'unsupported'|'delete_pending'|'deleted'|'paused';
export type ClaimedEmailProviderDraftMirror = Readonly<{
  draft_id:string; desired_revision:number; generation:number; envelope_revision:number; operation_id:string;
  previous_state:EmailProviderDraftMirrorState; provider_state:Readonly<Record<string,unknown>>|null;
}>;
export type EmailProviderDraftActiveClaim=Readonly<{draft_id:string;desired_revision:number;generation:number;operation_id:string}>;
export type EmailProviderDraftRecoveryDescriptor=z.infer<typeof RecoveryDescriptorSchema>;
export type EmailProviderDraftMirrorStatus=Readonly<{draft_id:string;account_id:string;enabled:boolean;draft_revision:number|null;state:EmailProviderDraftMirrorState|'not_synced';desired_revision:number|null;
  synced_revision:number|null;generation:number|null;updated_at:string|null;recovery_available:boolean}>;

/** Same-transaction opt-out hook. In-flight and uncertain effects are left
 * intact so their provider outcome cannot be lost. */
export async function pauseQueuedEmailProviderDraftMirrors(tx:EmailDraftTransaction,scope:EmailScope,now= new Date()):Promise<number>{
  ScopeSchema.parse(scope);
  const rows=await tx.update(emailProviderDraftMirrors).set({state:'paused',updated_at:now}).where(and(
    eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
    eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.state,'queued'))).returning({draft_id:emailProviderDraftMirrors.draft_id});
  return rows.length;
}

/** Re-enable only rows paused before any effect was claimed. */
export async function resumePausedEmailProviderDraftMirrors(tx:EmailDraftTransaction,scope:EmailScope,now=new Date()):Promise<number>{
  ScopeSchema.parse(scope);
  const rows=await tx.update(emailProviderDraftMirrors).set({state:'queued',updated_at:now}).where(and(
    eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
    eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.state,'paused'))).returning({draft_id:emailProviderDraftMirrors.draft_id});
  return rows.length;
}

/** The provider reference and compare baseline are private encrypted state.
 * Queue jobs carry only the account/draft/revision scope and a lease. */
export class EmailProviderDraftMirrorStore {
  constructor(private readonly database:EmailDraftDatabase, private readonly crypto:EmailMailboxCrypto, private readonly now=()=>new Date()) {}

  private async acceptedCleanupReceipt(tx:EmailDraftTransaction,scope:EmailScope,operationId:string,draftId:string,revision:number):Promise<boolean>{
    const [direct]=await tx.select({operation_id:emailSendOperations.operation_id}).from(emailSendOperations).where(and(
      eq(emailSendOperations.org_id,scope.org_id),eq(emailSendOperations.owner_user_id,scope.owner_user_id),eq(emailSendOperations.account_id,scope.account_id),
      eq(emailSendOperations.operation_id,operationId),eq(emailSendOperations.draft_id,draftId),eq(emailSendOperations.draft_revision,revision),
      eq(emailSendOperations.state,'accepted'))).limit(1);
    if(direct)return true;
    const result=await tx.execute(sql`SELECT outbox_id,revision,state_envelope FROM email_outbox
      WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id}
        AND operation_id=${operationId} AND draft_id=${draftId} AND draft_revision=${revision} AND state='accepted'
      LIMIT 1`);
    const row=result.rows[0] as {outbox_id:string;revision:number;state_envelope:unknown}|undefined;
    if(!row)return false;
    const value=this.crypto.open(row.state_envelope,{...scope,kind:'operation',record_id:`outbox:${row.outbox_id}:state`,revision:row.revision});
    return !!value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as Record<string,unknown>).provider_message_id==='string';
  }

  /** Owner-guarded metadata only. `recovery_available` is a local candidate;
   * reconciliation still rebuilds and verifies the pinned MIME digest. */
  async readStatus(scope:EmailScope,draftId:string,guard:EmailDraftGuard,signal?:AbortSignal,transaction?:unknown):Promise<EmailProviderDraftMirrorStatus>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);signal?.throwIfAborted();
    const read=async(tx:EmailDraftTransaction)=>{
      await guard(tx);signal?.throwIfAborted();
      const [account]=await tx.select({enabled:emailAccounts.provider_draft_sync_enabled,provider:emailAccounts.provider}).from(emailAccounts).where(and(
        eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1);
      const [draft]=await tx.select({revision:emailDrafts.revision,content_revision:emailDrafts.content_revision,status:emailDrafts.status}).from(emailDrafts).where(and(
        eq(emailDrafts.org_id,scope.org_id),eq(emailDrafts.owner_user_id,scope.owner_user_id),eq(emailDrafts.account_id,scope.account_id),eq(emailDrafts.draft_id,draftId))).limit(1);
      const [row]=await tx.select({state:emailProviderDraftMirrors.state,desired_revision:emailProviderDraftMirrors.desired_revision,
        synced_revision:emailProviderDraftMirrors.synced_revision,generation:emailProviderDraftMirrors.generation,envelope_revision:emailProviderDraftMirrors.envelope_revision,
        provider_envelope:emailProviderDraftMirrors.provider_envelope,updated_at:emailProviderDraftMirrors.updated_at}).from(emailProviderDraftMirrors).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1);
      if(!row){await guard(tx);signal?.throwIfAborted();return Object.freeze({draft_id:draftId,account_id:scope.account_id,enabled:Boolean(account?.enabled),draft_revision:draft?.revision??null,
        state:'not_synced',desired_revision:null,synced_revision:null,generation:null,updated_at:null,recovery_available:false});}
      let recoveryAvailable=false;
      if(account?.enabled&&account.provider==='microsoft'&&row.state==='unknown'&&row.provider_envelope){
        try{
          const value=PrivateMirrorSchema.parse(this.crypto.open(row.provider_envelope,emailProviderDraftContext(scope,draftId,row.envelope_revision)));
          const descriptor=RecoveryDescriptorSchema.safeParse(value.recovery);
          if(descriptor.success&&value.provider==='microsoft'&&descriptor.data.desired_revision===row.desired_revision){
            recoveryAvailable=Boolean(draft&&draft.status==='draft'&&draft.revision===descriptor.data.desired_revision&&draft.content_revision===descriptor.data.desired_revision);
          }
        }catch{recoveryAvailable=false;}
      }
      if(!recoveryAvailable&&account?.enabled&&row.state==='unknown'&&row.provider_envelope&&draft
        &&['submitted','archived'].includes(draft.status)){
        try{
          const value=PrivateMirrorSchema.parse(this.crypto.open(row.provider_envelope,emailProviderDraftContext(scope,draftId,row.envelope_revision)));
          const descriptor=CleanupDescriptorSchema.safeParse(value.cleanup);
          if(descriptor.success&&descriptor.data.provider===account.provider&&descriptor.data.draft_revision===draft.content_revision
            &&descriptor.data.desired_revision===draft.content_revision&&descriptor.data.send_operation_id){
            recoveryAvailable=await this.acceptedCleanupReceipt(tx,scope,descriptor.data.send_operation_id,draftId,descriptor.data.draft_revision);
          }
        }catch{recoveryAvailable=false;}
      }
      await guard(tx);signal?.throwIfAborted();
      return Object.freeze({draft_id:draftId,account_id:scope.account_id,enabled:Boolean(account?.enabled),draft_revision:draft?.revision??null,state:row.state as EmailProviderDraftMirrorState,desired_revision:row.desired_revision,
        synced_revision:row.synced_revision,generation:row.generation,updated_at:row.updated_at.toISOString(),recovery_available:recoveryAvailable});
    };
    return transaction===undefined?this.database.transaction(read):read(transaction as EmailDraftTransaction);
  }

  /** Private control-plane nomination only. Never serialize the returned
   * provider-free tuple directly from a public route. */
  async readCleanupRecoveryNomination(scope:EmailScope,draftId:string,guard:EmailDraftGuard,signal?:AbortSignal,transaction?:unknown):Promise<Readonly<{send_operation_id:string;revision:number;generation:number}>|null>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);signal?.throwIfAborted();
    const read=async(tx:EmailDraftTransaction)=>{
      await guard(tx);signal?.throwIfAborted();
      const [account]=await tx.select({enabled:emailAccounts.provider_draft_sync_enabled,provider:emailAccounts.provider}).from(emailAccounts).where(and(
        eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1);
      const [draft]=await tx.select({revision:emailDrafts.revision,content_revision:emailDrafts.content_revision,status:emailDrafts.status}).from(emailDrafts).where(and(
        eq(emailDrafts.org_id,scope.org_id),eq(emailDrafts.owner_user_id,scope.owner_user_id),eq(emailDrafts.account_id,scope.account_id),eq(emailDrafts.draft_id,draftId))).limit(1);
      const [row]=await tx.select({state:emailProviderDraftMirrors.state,generation:emailProviderDraftMirrors.generation,envelope_revision:emailProviderDraftMirrors.envelope_revision,
        provider_envelope:emailProviderDraftMirrors.provider_envelope}).from(emailProviderDraftMirrors).where(and(eq(emailProviderDraftMirrors.org_id,scope.org_id),
        eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1);
      if(!account?.enabled||row?.state!=='unknown'||!row.provider_envelope||!draft||!['submitted','archived'].includes(draft.status))return null;
      const value=PrivateMirrorSchema.parse(this.crypto.open(row.provider_envelope,emailProviderDraftContext(scope,draftId,row.envelope_revision)));
      const parsed=CleanupDescriptorSchema.safeParse(value.cleanup);
      if(!parsed.success||parsed.data.provider!==account.provider||parsed.data.draft_revision!==draft.content_revision||parsed.data.desired_revision!==draft.content_revision)return null;
      const accepted=await this.acceptedCleanupReceipt(tx,scope,parsed.data.send_operation_id,draftId,parsed.data.draft_revision);
      await guard(tx);signal?.throwIfAborted();
      return accepted?Object.freeze({send_operation_id:parsed.data.send_operation_id,revision:parsed.data.draft_revision,generation:row.generation}):null;
    };
    return transaction===undefined?this.database.transaction(read):read(transaction as EmailDraftTransaction);
  }

  async claim(scope:EmailScope,draftId:string,expectedRevision:number,lockToken:string,guard:EmailDraftGuard,signal?:AbortSignal):Promise<ClaimedEmailProviderDraftMirror|null>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);positiveRevision.parse(expectedRevision);lockSchema.parse(lockToken);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const [row]=await tx.select().from(emailProviderDraftMirrors).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1).for('update');
      if(!row||row.desired_revision!==expectedRevision||row.state!=='queued')return null;
      const claimHash=createHash('sha256').update(lockToken,'utf8').digest('hex');
      const operationId=randomUUID();
      await tx.update(emailProviderDraftMirrors).set({state:'syncing',claim_token_hash:claimHash,
        claim_generation:row.generation,claim_revision:row.desired_revision,claim_operation_id:operationId,updated_at:this.now()}).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId),
        eq(emailProviderDraftMirrors.generation,row.generation)));
      let provider_state:Record<string,unknown>|null=null;
      if(row.provider_envelope){
        const opened=PrivateMirrorSchema.parse(this.crypto.open(row.provider_envelope,emailProviderDraftContext(scope,draftId,row.envelope_revision)));
        provider_state=Object.freeze(opened);
      }
      await guard(tx);signal?.throwIfAborted();
      return Object.freeze({draft_id:draftId,desired_revision:row.desired_revision,generation:row.generation,
        envelope_revision:row.envelope_revision,operation_id:operationId,previous_state:row.state as EmailProviderDraftMirrorState,provider_state});
    });
  }

  /** Claim cleanup only for a send whose accepted receipt and submitted content
   * revision are revalidated by `accepted` in this same transaction. */
  async claimAcceptedCleanup(scope:EmailScope,draftId:string,revision:number,expectedGeneration:number,lockToken:string,guard:EmailDraftGuard,
    accepted:(tx:EmailDraftTransaction)=>Promise<boolean>,signal?:AbortSignal):Promise<ClaimedEmailProviderDraftMirror|null>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);positiveRevision.parse(revision);positiveRevision.parse(expectedGeneration);lockSchema.parse(lockToken);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      if(!await accepted(tx))return null;
      const [account]=await tx.select({enabled:emailAccounts.provider_draft_sync_enabled}).from(emailAccounts).where(and(
        eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1);
      const [row]=await tx.select().from(emailProviderDraftMirrors).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1).for('update');
      if(!account?.enabled||!row||!['synced','delete_pending'].includes(row.state)||row.generation!==expectedGeneration||row.desired_revision!==revision
        ||row.synced_revision!==revision||!row.provider_envelope)return null;
      const privateState=PrivateMirrorSchema.parse(this.crypto.open(row.provider_envelope,emailProviderDraftContext(scope,draftId,row.envelope_revision)));
      if(privateState.cleanup!==undefined||privateState.recovery!==undefined)return null;
      const claimHash=createHash('sha256').update(lockToken,'utf8').digest('hex'),operationId=randomUUID();
      await tx.update(emailProviderDraftMirrors).set({state:'syncing',claim_token_hash:claimHash,claim_generation:row.generation,
        claim_revision:revision,claim_operation_id:operationId,updated_at:this.now()}).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId),eq(emailProviderDraftMirrors.generation,row.generation)));
      await guard(tx);if(!await accepted(tx))throw new Error('EMAIL_DRAFT_CLEANUP_SEND_NOT_ACCEPTED');signal?.throwIfAborted();
      return Object.freeze({draft_id:draftId,desired_revision:revision,generation:row.generation,envelope_revision:row.envelope_revision,
        operation_id:operationId,previous_state:'synced',provider_state:Object.freeze(privateState)});
    });
  }

  /** Recovery can own the claim only with the current ledger generation; the
   * operation ID comes from the encrypted cleanup descriptor, not the job. */
  async claimAcceptedCleanupRecovery(scope:EmailScope,draftId:string,revision:number,expectedGeneration:number,sendOperationId:string,
    lockToken:string,guard:EmailDraftGuard,accepted:(tx:EmailDraftTransaction)=>Promise<boolean>,signal?:AbortSignal):Promise<ClaimedEmailProviderDraftMirror|null>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);positiveRevision.parse(revision);positiveRevision.parse(expectedGeneration);
    if(!z.string().uuid().safeParse(sendOperationId).success)throw new Error('EMAIL_DRAFT_INVALID');lockSchema.parse(lockToken);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();if(!await accepted(tx))return null;
      const [row]=await tx.select().from(emailProviderDraftMirrors).where(and(eq(emailProviderDraftMirrors.org_id,scope.org_id),
        eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),eq(emailProviderDraftMirrors.account_id,scope.account_id),
        eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1).for('update');
      if(!row||row.state!=='unknown'||row.generation!==expectedGeneration||row.desired_revision!==revision
        ||row.synced_revision!==revision||!row.provider_envelope)return null;
      const privateState=PrivateMirrorSchema.parse(this.crypto.open(row.provider_envelope,emailProviderDraftContext(scope,draftId,row.envelope_revision)));
      const cleanup=privateState.cleanup as Record<string,unknown>|undefined;
      if(!cleanup||cleanup.send_operation_id!==sendOperationId||cleanup.draft_revision!==revision||cleanup.desired_revision!==revision
        ||cleanup.provider!==privateState.provider||typeof cleanup.operation_id!=='string'||!z.string().uuid().safeParse(cleanup.operation_id).success)return null;
      const claimHash=createHash('sha256').update(lockToken,'utf8').digest('hex');
      await tx.update(emailProviderDraftMirrors).set({state:'syncing',claim_token_hash:claimHash,claim_generation:row.generation,
        claim_revision:revision,claim_operation_id:cleanup.operation_id,updated_at:this.now()}).where(and(eq(emailProviderDraftMirrors.org_id,scope.org_id),
        eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),eq(emailProviderDraftMirrors.account_id,scope.account_id),
        eq(emailProviderDraftMirrors.draft_id,draftId),eq(emailProviderDraftMirrors.generation,row.generation)));
      await guard(tx);if(!await accepted(tx))throw new Error('EMAIL_DRAFT_CLEANUP_SEND_NOT_ACCEPTED');signal?.throwIfAborted();
      return Object.freeze({draft_id:draftId,desired_revision:revision,generation:row.generation,envelope_revision:row.envelope_revision,
        operation_id:cleanup.operation_id,previous_state:'unknown',provider_state:Object.freeze(privateState)});
    });
  }

  /** Pin the accepted send and exact provider baseline before authorizing the
   * one delete effect. The caller's guard rechecks both service lease and send receipt. */
  async pinCleanup(scope:EmailScope,draftId:string,claim:ClaimedEmailProviderDraftMirror,lockToken:string,
    cleanup:Readonly<Record<string,unknown>>,guard:EmailDraftGuard,signal?:AbortSignal):Promise<boolean>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);lockSchema.parse(lockToken);PrivateMirrorSchema.parse(cleanup);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();const hash=createHash('sha256').update(lockToken,'utf8').digest('hex');
      const [row]=await tx.select().from(emailProviderDraftMirrors).where(and(eq(emailProviderDraftMirrors.org_id,scope.org_id),
        eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),eq(emailProviderDraftMirrors.account_id,scope.account_id),
        eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1).for('update');
      if(!row||row.state!=='syncing'||row.claim_token_hash!==hash||row.claim_generation!==claim.generation
        ||row.claim_revision!==claim.desired_revision||row.claim_operation_id!==claim.operation_id||!row.provider_envelope)return false;
      const current=PrivateMirrorSchema.parse(this.crypto.open(row.provider_envelope,emailProviderDraftContext(scope,draftId,row.envelope_revision)));
      if(current.provider!==cleanup.provider||current.provider_draft_ref!==cleanup.provider_draft_ref
        ||current.baseline_digest!==cleanup.baseline_digest||current.provider_version!==cleanup.provider_version
        ||current.cleanup!==undefined)return false;
      const envelopeRevision=row.envelope_revision+1,envelope=this.crypto.seal(PrivateMirrorSchema.parse({...current,cleanup}),emailProviderDraftContext(scope,draftId,envelopeRevision));
      await tx.update(emailProviderDraftMirrors).set({provider_envelope:envelope,envelope_revision:envelopeRevision,updated_at:this.now()}).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId),eq(emailProviderDraftMirrors.claim_token_hash,hash)));
      await guard(tx);signal?.throwIfAborted();return true;
    });
  }

  /** Explicit journal-backed reconciliation only. Normal queue claims never
   * consume unknown rows; this preserves the original operation UUID. */
  async claimRecovery(scope:EmailScope,draftId:string,expectedGeneration:number,lockToken:string,guard:EmailDraftGuard,signal?:AbortSignal):Promise<ClaimedEmailProviderDraftMirror|null>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);positiveRevision.parse(expectedGeneration);lockSchema.parse(lockToken);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const [row]=await tx.select().from(emailProviderDraftMirrors).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1).for('update');
      if(!row||row.state!=='unknown'||row.generation!==expectedGeneration||!row.provider_envelope)return null;
      const privateState=PrivateMirrorSchema.parse(this.crypto.open(row.provider_envelope,emailProviderDraftContext(scope,draftId,row.envelope_revision)));
      const parsed=RecoveryDescriptorSchema.safeParse(privateState.recovery);if(!parsed.success||parsed.data.desired_revision>row.desired_revision)return null;
      const descriptor=parsed.data,claimHash=createHash('sha256').update(lockToken,'utf8').digest('hex');
      await tx.update(emailProviderDraftMirrors).set({state:'syncing',claim_token_hash:claimHash,claim_generation:row.generation,
        claim_revision:descriptor.desired_revision,claim_operation_id:descriptor.operation_id,updated_at:this.now()}).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId),eq(emailProviderDraftMirrors.generation,row.generation)));
      await guard(tx);signal?.throwIfAborted();
      return Object.freeze({draft_id:draftId,desired_revision:descriptor.desired_revision,generation:row.generation,
        envelope_revision:row.envelope_revision,operation_id:descriptor.operation_id,previous_state:'unknown',provider_state:Object.freeze(privateState)});
    });
  }

  /** Persist the immutable Graph operation tuple before the provider can make
   * any change. A process crash then leaves enough encrypted state to resume
   * only through explicit journal reconciliation. */
  async pinRecovery(scope:EmailScope,draftId:string,claim:ClaimedEmailProviderDraftMirror,lockToken:string,descriptor:EmailProviderDraftRecoveryDescriptor,
    guard:EmailDraftGuard,signal?:AbortSignal):Promise<boolean>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);lockSchema.parse(lockToken);const pinned=RecoveryDescriptorSchema.parse(descriptor);signal?.throwIfAborted();
    if(pinned.operation_id!==claim.operation_id||pinned.desired_revision!==claim.desired_revision)throw new Error('EMAIL_DRAFT_INVALID');
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();const hash=createHash('sha256').update(lockToken,'utf8').digest('hex');
      const [row]=await tx.select().from(emailProviderDraftMirrors).where(and(eq(emailProviderDraftMirrors.org_id,scope.org_id),
        eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),eq(emailProviderDraftMirrors.account_id,scope.account_id),
        eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1).for('update');
      if(!row||row.state!=='syncing'||row.claim_token_hash!==hash||row.claim_generation!==claim.generation
        ||row.claim_revision!==claim.desired_revision||row.claim_operation_id!==claim.operation_id||!row.provider_envelope)return false;
      const current=PrivateMirrorSchema.parse(this.crypto.open(row.provider_envelope,emailProviderDraftContext(scope,draftId,row.envelope_revision)));
      const parsed=RecoveryDescriptorSchema.safeParse(current.recovery);
      if(current.provider!=='microsoft'||current.provider_draft_ref!==pinned.provider_draft_ref||current.baseline_digest!==pinned.baseline_digest
        ||current.provider_version!==pinned.provider_version||parsed.success&&JSON.stringify(parsed.data)!==JSON.stringify(pinned))return false;
      const envelopeRevision=row.envelope_revision+1;
      const envelope=this.crypto.seal(PrivateMirrorSchema.parse({...current,recovery:pinned}),emailProviderDraftContext(scope,draftId,envelopeRevision));
      await tx.update(emailProviderDraftMirrors).set({provider_envelope:envelope,envelope_revision:envelopeRevision,updated_at:this.now()}).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId),
        eq(emailProviderDraftMirrors.claim_token_hash,hash),eq(emailProviderDraftMirrors.claim_operation_id,claim.operation_id)));
      await guard(tx);signal?.throwIfAborted();return true;
    });
  }

  /** Finish only the exact claimed desire. A newer edit or queue lease wins. */
  async finish(scope:EmailScope,draftId:string,claim:ClaimedEmailProviderDraftMirror,lockToken:string,
    outcome:Readonly<{state:'synced'|'conflict'|'unknown'|'unsupported'|'delete_pending'|'deleted'|'paused';provider_state?:Readonly<Record<string,unknown>>;error_code?:string|null}>,
    guard:EmailDraftGuard,signal?:AbortSignal):Promise<EmailProviderDraftMirrorState|false>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);lockSchema.parse(lockToken);positiveRevision.parse(claim.desired_revision);
    if(!Number.isSafeInteger(claim.generation)||claim.generation<1||!Number.isSafeInteger(claim.envelope_revision)||claim.envelope_revision<0||!z.string().uuid().safeParse(claim.operation_id).success)throw new Error('EMAIL_DRAFT_INVALID');
    PrivateMirrorSchema.optional().parse(outcome.provider_state);
    if(outcome.state==='synced'&&!outcome.provider_state)throw new Error('EMAIL_DRAFT_INVALID');
    if(outcome.error_code!=null&&!/^[A-Z0-9_]{1,64}$/u.test(outcome.error_code))throw new Error('EMAIL_DRAFT_INVALID');
    signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const hash=createHash('sha256').update(lockToken,'utf8').digest('hex');
      const [row]=await tx.select().from(emailProviderDraftMirrors).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1).for('update');
      if(!row||row.state!=='syncing'||row.claim_token_hash!==hash||row.claim_generation!==claim.generation
        ||row.claim_revision!==claim.desired_revision||row.claim_operation_id!==claim.operation_id)return false;
      let envelope=row.provider_envelope,envelopeRevision=row.envelope_revision;
      if(outcome.state==='deleted') { envelope=null; }
      else if(outcome.provider_state) {
        envelopeRevision++;
        envelope=this.crypto.seal(PrivateMirrorSchema.parse(outcome.provider_state),emailProviderDraftContext(scope,draftId,envelopeRevision));
      }
      const completedState=outcome.state==='synced'&&row.desired_revision>claim.desired_revision?'queued':outcome.state;
      await tx.update(emailProviderDraftMirrors).set({state:completedState,claim_token_hash:null,claim_generation:null,claim_revision:null,claim_operation_id:null,
        synced_revision:outcome.state==='synced'?claim.desired_revision:row.synced_revision,
        envelope_revision:envelopeRevision,provider_envelope:envelope,last_error_code:outcome.error_code??null,updated_at:this.now()}).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId),
        eq(emailProviderDraftMirrors.claim_generation,claim.generation),eq(emailProviderDraftMirrors.claim_token_hash,hash)));
      await guard(tx);signal?.throwIfAborted();return completedState;
    });
  }

  async readActiveClaim(scope:EmailScope,draftId:string,guard:EmailDraftGuard,signal?:AbortSignal):Promise<EmailProviderDraftActiveClaim|null>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const [row]=await tx.select({state:emailProviderDraftMirrors.state,claim_generation:emailProviderDraftMirrors.claim_generation,
        claim_revision:emailProviderDraftMirrors.claim_revision,claim_operation_id:emailProviderDraftMirrors.claim_operation_id}).from(emailProviderDraftMirrors).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1);
      await guard(tx);signal?.throwIfAborted();
      if(!row||row.state!=='syncing'||row.claim_generation===null||row.claim_revision===null||row.claim_operation_id===null)return null;
      return Object.freeze({draft_id:draftId,generation:row.claim_generation,desired_revision:row.claim_revision,operation_id:row.claim_operation_id});
    });
  }

  /** Call only after the scheduler has proved this exact queue lease expired.
   * A crash after an external effect becomes unknown and can never be replayed. */
  async recoverToUnknown(scope:EmailScope,draftId:string,claim:EmailProviderDraftActiveClaim,
    guard:EmailDraftGuard,signal?:AbortSignal):Promise<boolean>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const [row]=await tx.select().from(emailProviderDraftMirrors).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1).for('update');
      if(!row||row.state!=='syncing'||row.claim_generation!==claim.generation
        ||row.claim_revision!==claim.desired_revision||row.claim_operation_id!==claim.operation_id)return false;
      await tx.update(emailProviderDraftMirrors).set({state:'unknown',claim_token_hash:null,claim_generation:null,claim_revision:null,
        claim_operation_id:null,last_error_code:'EMAIL_DRAFT_SYNC_UNKNOWN',updated_at:this.now()}).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId),
        eq(emailProviderDraftMirrors.claim_generation,claim.generation),eq(emailProviderDraftMirrors.claim_operation_id,claim.operation_id)));
      await guard(tx);signal?.throwIfAborted();return true;
    });
  }

  async verifyClaim(scope:EmailScope,draftId:string,claim:ClaimedEmailProviderDraftMirror,lockToken:string,guard:EmailDraftGuard,signal?:AbortSignal):Promise<boolean>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);lockSchema.parse(lockToken);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const hash=createHash('sha256').update(lockToken,'utf8').digest('hex');
      const [row]=await tx.select({state:emailProviderDraftMirrors.state,claim_token_hash:emailProviderDraftMirrors.claim_token_hash,
        claim_generation:emailProviderDraftMirrors.claim_generation,claim_revision:emailProviderDraftMirrors.claim_revision,
        claim_operation_id:emailProviderDraftMirrors.claim_operation_id}).from(emailProviderDraftMirrors).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1);
      await guard(tx);signal?.throwIfAborted();
      return Boolean(row&&row.state==='syncing'&&row.claim_token_hash===hash&&row.claim_generation===claim.generation
        &&row.claim_revision===claim.desired_revision&&row.claim_operation_id===claim.operation_id);
    });
  }

  /** Release only failures known to precede the effect callback; callers must
   * never use this after a provider effect was authorized. */
  async releaseBeforeEffect(scope:EmailScope,draftId:string,claim:ClaimedEmailProviderDraftMirror,lockToken:string,
    guard:EmailDraftGuard,signal?:AbortSignal):Promise<boolean>{
    ScopeSchema.parse(scope);draftIdSchema.parse(draftId);lockSchema.parse(lockToken);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const hash=createHash('sha256').update(lockToken,'utf8').digest('hex');
      const [row]=await tx.select().from(emailProviderDraftMirrors).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId))).limit(1).for('update');
      if(!row||row.state!=='syncing'||row.claim_token_hash!==hash||row.claim_generation!==claim.generation
        ||row.claim_revision!==claim.desired_revision||row.claim_operation_id!==claim.operation_id)return false;
      await tx.update(emailProviderDraftMirrors).set({state:'queued',claim_token_hash:null,claim_generation:null,claim_revision:null,
        claim_operation_id:null,last_error_code:null,updated_at:this.now()}).where(and(
        eq(emailProviderDraftMirrors.org_id,scope.org_id),eq(emailProviderDraftMirrors.owner_user_id,scope.owner_user_id),
        eq(emailProviderDraftMirrors.account_id,scope.account_id),eq(emailProviderDraftMirrors.draft_id,draftId),
        eq(emailProviderDraftMirrors.claim_token_hash,hash)));
      await guard(tx);signal?.throwIfAborted();return true;
    });
  }
}
