import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailDrafts, emailSendOperations } from '@deft/db/schema';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import type { EmailScope } from './email-mailbox-service.js';

const schema = { emailAccounts, emailDrafts, emailSendOperations };
export type EmailSendDatabase = Pick<NodePgDatabase<typeof schema>, 'transaction'>;
export type EmailSendTransaction = Parameters<Parameters<EmailSendDatabase['transaction']>[0]>[0];
export type EmailSendState = 'reserved' | 'accepted' | 'unknown';
export type EmailSendReceipt = Readonly<{ state: EmailSendState; mime_digest: string; provider_message_id?: string | null }>;
export type EmailSendOperation = Readonly<{ operation_id: string; draft_id: string; draft_revision: number; state: EmailSendState }>;
export type EmailSendGuard = (transaction: unknown) => Promise<void>;

const context = (scope: EmailScope, operationId: string) => ({ ...scope, kind: 'operation' as const,
  record_id: `email-send:${operationId}`, revision: 1 });
const whereDraft = (scope: EmailScope, draftId: string) => and(eq(emailDrafts.org_id, scope.org_id),
  eq(emailDrafts.owner_user_id, scope.owner_user_id), eq(emailDrafts.account_id, scope.account_id), eq(emailDrafts.draft_id, draftId));
const whereOperation = (scope: EmailScope, operationId: string) => and(eq(emailSendOperations.org_id, scope.org_id),
  eq(emailSendOperations.owner_user_id, scope.owner_user_id), eq(emailSendOperations.account_id, scope.account_id), eq(emailSendOperations.operation_id, operationId));

/** The commit is the send boundary: reserve once and pin the exact draft before provider I/O. */
export class EmailSendStore {
  constructor(private readonly database: EmailSendDatabase, private readonly crypto: EmailMailboxCrypto,
    private readonly now = () => new Date()) {}

  private receipt(scope: EmailScope, row: typeof emailSendOperations.$inferSelect): EmailSendReceipt {
    const value = this.crypto.open(row.receipt_envelope, context(scope, row.operation_id));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EMAIL_SEND_UNAVAILABLE');
    const receipt = value as Record<string, unknown>;
    if (receipt.state !== row.state || typeof receipt.mime_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.mime_digest)
      || receipt.mime_digest !== row.operation_digest
      || receipt.provider_message_id !== undefined && receipt.provider_message_id !== null && typeof receipt.provider_message_id !== 'string') throw new Error('EMAIL_SEND_UNAVAILABLE');
    return Object.freeze({ state: receipt.state as EmailSendState, mime_digest: receipt.mime_digest,
      ...(receipt.provider_message_id === undefined ? {} : { provider_message_id: receipt.provider_message_id as string | null }) });
  }

  async reserve(scope: EmailScope, draftId: string, expectedRevision: number, userId: string, operationId: string,
    mimeDigest: string, guard: EmailSendGuard, signal?: AbortSignal): Promise<Readonly<{ operation: EmailSendOperation; receipt: EmailSendReceipt; replay: boolean }>> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      const [draft] = await tx.select().from(emailDrafts).where(whereDraft(scope, draftId)).limit(1).for('update');
      if (!draft) throw new Error('EMAIL_DRAFT_NOT_FOUND');
      const [existing] = await tx.select().from(emailSendOperations).where(and(eq(emailSendOperations.org_id, scope.org_id),
        eq(emailSendOperations.owner_user_id, scope.owner_user_id), eq(emailSendOperations.account_id, scope.account_id),
        eq(emailSendOperations.draft_id, draftId), eq(emailSendOperations.draft_revision, expectedRevision))).limit(1);
      if (existing) {
        const receipt = this.receipt(scope, existing);
        if (receipt.mime_digest !== mimeDigest) throw new Error('EMAIL_SEND_CONFLICT');
        await guard(tx); signal?.throwIfAborted();
        return Object.freeze({ operation: Object.freeze({ operation_id: existing.operation_id, draft_id: draftId,
          draft_revision: existing.draft_revision, state: existing.state }), receipt, replay: true });
      }
      if (draft.status !== 'draft' || draft.revision !== expectedRevision || draft.content_revision !== expectedRevision) throw new Error('EMAIL_DRAFT_CONFLICT');
      const now = this.now();
      const initial: EmailSendReceipt = Object.freeze({ state: 'reserved', mime_digest: mimeDigest });
      const [operation] = await tx.insert(emailSendOperations).values({ ...scope, operation_id: operationId, draft_id: draftId,
        draft_revision: expectedRevision, operation_digest: mimeDigest, state: 'reserved',
        receipt_envelope: this.crypto.seal(initial, context(scope, operationId)), initiated_by_user_id: userId,
        created_at: now, updated_at: now }).onConflictDoNothing().returning();
      if (!operation) throw new Error('EMAIL_SEND_CONFLICT');
      const [pinned] = await tx.update(emailDrafts).set({ status: 'submitted', revision: expectedRevision + 1,
        submitted_at: now, updated_at: now }).where(and(whereDraft(scope, draftId), eq(emailDrafts.revision, expectedRevision), eq(emailDrafts.status, 'draft'))).returning();
      if (!pinned) throw new Error('EMAIL_DRAFT_CONFLICT');
      await guard(tx); signal?.throwIfAborted();
      return Object.freeze({ operation: Object.freeze({ operation_id: operationId, draft_id: draftId,
        draft_revision: expectedRevision, state: 'reserved' as const }), receipt: initial, replay: false });
    });
  }

  async finish(scope: EmailScope, operationId: string, state: 'accepted' | 'unknown', providerMessageId: string | null,
    guard: EmailSendGuard, signal?: AbortSignal): Promise<EmailSendOperation> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      const [row] = await tx.select().from(emailSendOperations).where(whereOperation(scope, operationId)).limit(1).for('update');
      if (!row) throw new Error('EMAIL_SEND_NOT_FOUND');
      const old = this.receipt(scope, row);
      if (row.state !== 'reserved') {
        if (row.state !== state) throw new Error('EMAIL_SEND_CONFLICT');
        await guard(tx); signal?.throwIfAborted();
        return Object.freeze({ operation_id: row.operation_id, draft_id: row.draft_id, draft_revision: row.draft_revision, state: row.state });
      }
      const next: EmailSendReceipt = Object.freeze({ state, mime_digest: old.mime_digest,
        ...(state === 'accepted' ? { provider_message_id: providerMessageId } : {}) });
      const [updated] = await tx.update(emailSendOperations).set({ state,
        receipt_envelope: this.crypto.seal(next, context(scope, operationId)), updated_at: this.now() })
        .where(and(whereOperation(scope, operationId), eq(emailSendOperations.state, 'reserved'))).returning();
      if (!updated) throw new Error('EMAIL_SEND_CONFLICT');
      await guard(tx); signal?.throwIfAborted();
      return Object.freeze({ operation_id: updated.operation_id, draft_id: updated.draft_id, draft_revision: updated.draft_revision, state: updated.state });
    });
  }

  async status(scope: EmailScope, draftId: string, draftRevision: number, guard: EmailSendGuard,
    signal?: AbortSignal): Promise<Readonly<{ operation: EmailSendOperation; receipt: EmailSendReceipt }> | null> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      const [row] = await tx.select().from(emailSendOperations).where(and(eq(emailSendOperations.org_id, scope.org_id),
        eq(emailSendOperations.owner_user_id, scope.owner_user_id), eq(emailSendOperations.account_id, scope.account_id),
        eq(emailSendOperations.draft_id, draftId), eq(emailSendOperations.draft_revision, draftRevision))).limit(1);
      await guard(tx); signal?.throwIfAborted();
      if (!row) return null;
      return Object.freeze({ operation: Object.freeze({ operation_id: row.operation_id, draft_id: row.draft_id,
        draft_revision: row.draft_revision, state: row.state }), receipt: this.receipt(scope, row) });
    }, { isolationLevel: 'repeatable read' });
  }

  async verifyReservation(scope: EmailScope, operationId: string, mimeDigest: string, guard: EmailSendGuard,
    signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      const [row] = await tx.select().from(emailSendOperations).where(whereOperation(scope, operationId)).limit(1);
      const matches = !!row && this.receipt(scope, row).mime_digest === mimeDigest;
      await guard(tx); signal?.throwIfAborted();
      return matches;
    }, { isolationLevel: 'repeatable read' });
  }

  /** Verify the exact accepted human send while composing a cleanup claim in
   * the caller's transaction. A queued cleanup lease is never receipt proof. */
  async verifyAccepted(scope:EmailScope,input:Readonly<{operation_id:string;draft_id:string;revision:number}>,
    guard:EmailSendGuard,signal?:AbortSignal,transaction?:unknown):Promise<boolean>{
    signal?.throwIfAborted();
    const verify=async(tx:EmailSendTransaction)=>{
      await guard(tx);signal?.throwIfAborted();
      const [draft]=await tx.select().from(emailDrafts).where(and(eq(emailDrafts.org_id,scope.org_id),
        eq(emailDrafts.owner_user_id,scope.owner_user_id),eq(emailDrafts.account_id,scope.account_id),
        eq(emailDrafts.draft_id,input.draft_id))).limit(1).for('share');
      const [row]=await tx.select().from(emailSendOperations).where(and(whereOperation(scope,input.operation_id),
        eq(emailSendOperations.draft_id,input.draft_id),eq(emailSendOperations.draft_revision,input.revision))).limit(1).for('share');
      const directAccepted=Boolean(draft&&row&&row.state==='accepted'&&draft.status!=='draft'
        &&draft.content_revision===input.revision&&draft.revision>input.revision&&this.receipt(scope,row).state==='accepted');
      let outboxAccepted=false;
      if(!directAccepted){
        const result=await tx.execute(sql`SELECT outbox_id,revision,state_envelope FROM email_outbox
          WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id}
            AND operation_id=${input.operation_id} AND draft_id=${input.draft_id} AND draft_revision=${input.revision} AND state='accepted'
          LIMIT 1 FOR SHARE`);
        const outbox=result.rows[0] as {outbox_id:string;revision:number;state_envelope:unknown}|undefined;
        if(outbox&&draft&&draft.status!=='draft'&&draft.content_revision===input.revision&&draft.revision>input.revision){
          const state=this.crypto.open(outbox.state_envelope,{...scope,kind:'operation',record_id:`outbox:${outbox.outbox_id}:state`,revision:outbox.revision});
          outboxAccepted=!!state&&typeof state==='object'&&!Array.isArray(state)
            &&(state as Record<string,unknown>).provider_message_id!==null
            &&typeof (state as Record<string,unknown>).provider_message_id==='string';
        }
      }
      await guard(tx);signal?.throwIfAborted();
      return directAccepted||outboxAccepted;
    };
    return transaction===undefined?this.database.transaction(verify,{isolationLevel:'repeatable read'}):verify(transaction as EmailSendTransaction);
  }
}
