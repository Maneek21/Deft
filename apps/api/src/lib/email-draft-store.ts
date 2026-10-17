import { and, asc, eq, gt, lt, ne, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailDrafts, emailProviderDraftMirrors } from '@deft/db/schema';
import { canonicalCapabilityJson } from '@deft/shared';
import { z } from 'zod';
import { AppRunSecretEnvelopeSchema } from './app-run-secrets.js';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import type { EmailScope } from './email-mailbox-service.js';

const schema = { emailAccounts, emailDrafts, emailProviderDraftMirrors };
export type EmailDraftDatabase = Pick<NodePgDatabase<typeof schema>, 'transaction'>;
export type EmailDraftTransaction = Parameters<Parameters<EmailDraftDatabase['transaction']>[0]>[0];
export type EmailDraftContent = Readonly<Record<string, unknown>>;
export type EmailDraftOrigin = Readonly<{ kind: 'human' | 'agent'; created_by_user_id: string; originating_run_id: string | null }>;
export type EmailDraftRow = Readonly<{ draft_id: string; revision: number; content_revision: number; status: 'draft' | 'submitted' | 'archived';
  content: EmailDraftContent; origin: EmailDraftOrigin; last_edited_by_user_id: string; created_at: string; updated_at: string }>;
export type EmailDraftSummary = Readonly<{ draft_id:string; account_id:string; revision:number; content_revision:number;
  status:'draft'|'submitted'; subject:string; updated_at:string }>;
export type EmailDraftSummaryPage = Readonly<{items:readonly EmailDraftSummary[];next_cursor:string|null;has_more:boolean}>;
export type EmailDraftGuard = (transaction: unknown) => Promise<void>;
const SummaryCursorSchema=z.strictObject({schema_version:z.literal('deft.email_draft_summary_cursor.v1'),org_id:z.string().min(1).max(256),
  owner_user_id:z.string().min(1).max(256),account_id:z.string().min(1).max(256),updated_at:z.iso.datetime(),draft_id:z.string().uuid(),expires_at:z.number().finite()});
const SummaryCursorContext=(scope:EmailScope)=>({...scope,kind:'checkpoint' as const,record_id:'draft-summary-cursor',revision:0});
const SummaryCursorTTL=15*60*1000;
export const emailProviderDraftContext=(scope:EmailScope,draftId:string,envelopeRevision:number)=>({...scope,
  kind:'provider_draft' as const,record_id:`provider-draft:${draftId}`,revision:envelopeRevision});

export const emailDraftContext = (scope: EmailScope, draftId: string, revision: number) => ({ ...scope, kind: 'draft' as const,
  record_id: `draft:${draftId}`, revision });
export function materializeEmailDraft(crypto: EmailMailboxCrypto, scope: EmailScope, value: typeof emailDrafts.$inferSelect): EmailDraftRow {
  const content = crypto.open(value.content_envelope, emailDraftContext(scope, value.draft_id, value.content_revision));
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('EMAIL_DRAFT_INVALID');
  return Object.freeze({ draft_id: value.draft_id, revision: value.revision, content_revision: value.content_revision, status: value.status,
    content: content as EmailDraftContent,
    origin: Object.freeze({ kind: value.origin, created_by_user_id: value.created_by_user_id, originating_run_id: value.origin_run_id }),
    last_edited_by_user_id: value.last_edited_by_user_id,
    created_at: value.created_at.toISOString(), updated_at: value.updated_at.toISOString() });
}
const whereDraft = (scope: EmailScope, draftId: string) => and(eq(emailDrafts.org_id, scope.org_id),
  eq(emailDrafts.owner_user_id, scope.owner_user_id), eq(emailDrafts.account_id, scope.account_id), eq(emailDrafts.draft_id, draftId));
/** Encrypted account-scoped draft store. The supplied owner authority guard
 * runs inside each read/write transaction; expected revisions are never LWW. */
export class EmailDraftStore {
  constructor(private readonly database: EmailDraftDatabase, private readonly crypto: EmailMailboxCrypto,
    private readonly now = () => new Date()) {}

  private materialize(scope: EmailScope, value: typeof emailDrafts.$inferSelect): EmailDraftRow { return materializeEmailDraft(this.crypto, scope, value); }

  /** Record only durable desired state; a separate bounded repair worker does
   * provider I/O after this transaction commits. Safe for attachment writers. */
  async recordDesired(tx: EmailDraftTransaction, scope: EmailScope, draftId: string, revision: number): Promise<void> {
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647) throw new Error('EMAIL_DRAFT_INVALID');
    const [account] = await tx.select({ enabled: emailAccounts.provider_draft_sync_enabled }).from(emailAccounts)
      .where(and(eq(emailAccounts.org_id, scope.org_id), eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id)))
      .limit(1);
    if (!account?.enabled) return;
    const [existing] = await tx.select().from(emailProviderDraftMirrors).where(and(
      eq(emailProviderDraftMirrors.org_id, scope.org_id), eq(emailProviderDraftMirrors.owner_user_id, scope.owner_user_id),
      eq(emailProviderDraftMirrors.account_id, scope.account_id), eq(emailProviderDraftMirrors.draft_id, draftId))).limit(1).for('update');
    if (!existing) {
      await tx.insert(emailProviderDraftMirrors).values({ ...scope, draft_id: draftId, desired_revision: revision,
        generation: 1, envelope_revision: 0, state: 'queued' });
      return;
    }
    if (revision <= existing.desired_revision) return;
    const terminal = ['conflict', 'unknown', 'unsupported', 'delete_pending', 'deleted', 'paused'].includes(existing.state);
    const inFlight = existing.state === 'syncing';
    await tx.update(emailProviderDraftMirrors).set({ desired_revision: revision, generation: existing.generation + 1,
      state: terminal ? existing.state : inFlight ? 'syncing' : 'queued',
      ...(inFlight ? {} : { claim_token_hash: null, claim_generation: null, claim_revision: null, claim_operation_id: null }), updated_at: this.now() }).where(and(
      eq(emailProviderDraftMirrors.org_id, scope.org_id), eq(emailProviderDraftMirrors.owner_user_id, scope.owner_user_id),
      eq(emailProviderDraftMirrors.account_id, scope.account_id), eq(emailProviderDraftMirrors.draft_id, draftId)));
  }

  async create(scope: EmailScope, draftId: string, content: EmailDraftContent, origin: EmailDraftOrigin,
    guard: EmailDraftGuard, signal?: AbortSignal): Promise<EmailDraftRow> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      const now = this.now();
      const [created] = await tx.insert(emailDrafts).values({ ...scope, draft_id: draftId, revision: 1, content_revision: 1,
        origin: origin.kind, created_by_user_id: origin.created_by_user_id, origin_run_id: origin.originating_run_id,
        last_edited_by_user_id: origin.created_by_user_id,
        status: 'draft', content_envelope: this.crypto.seal(content, emailDraftContext(scope, draftId, 1)), updated_at: now })
        .onConflictDoNothing().returning();
      if (!created) {
        const [existing] = await tx.select().from(emailDrafts).where(whereDraft(scope, draftId)).limit(1).for('update');
        if (!existing) throw new Error('EMAIL_DRAFT_UNAVAILABLE');
        const sameCreate = existing.status === 'draft' && existing.revision === 1 && existing.content_revision === 1
          && existing.origin === origin.kind && existing.created_by_user_id === origin.created_by_user_id
          && existing.origin_run_id === origin.originating_run_id
          && canonicalCapabilityJson(this.crypto.open(existing.content_envelope, emailDraftContext(scope, draftId, existing.content_revision)))
            === canonicalCapabilityJson(content);
        if (!sameCreate) throw new Error('EMAIL_DRAFT_CONFLICT');
        await guard(tx); signal?.throwIfAborted();
        return this.materialize(scope, existing);
      }
      await this.recordDesired(tx, scope, draftId, created.revision);
      await guard(tx); signal?.throwIfAborted();
      return this.materialize(scope, created);
    });
  }

  async read(scope: EmailScope, draftId: string, guard: EmailDraftGuard, signal?: AbortSignal): Promise<EmailDraftRow | null> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      const [found] = await tx.select().from(emailDrafts).where(whereDraft(scope, draftId)).limit(1);
      await guard(tx); signal?.throwIfAborted();
      return found ? this.materialize(scope, found) : null;
    }, { isolationLevel: 'repeatable read' });
  }

  async list(scope: EmailScope, guard: EmailDraftGuard, signal?: AbortSignal): Promise<EmailDraftRow[]> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      const rows = await tx.select().from(emailDrafts).where(and(eq(emailDrafts.org_id, scope.org_id),
        eq(emailDrafts.owner_user_id, scope.owner_user_id), eq(emailDrafts.account_id, scope.account_id), ne(emailDrafts.status, 'archived')))
        .orderBy(asc(emailDrafts.updated_at), asc(emailDrafts.draft_id)).limit(200);
      await guard(tx); signal?.throwIfAborted();
      return rows.map(value => this.materialize(scope, value));
    }, { isolationLevel: 'repeatable read' });
  }

  /** Bounded metadata-only page. SQL keyset selection happens before any
   * content envelope is opened, so older pages are not decrypted or loaded. */
  async listSummaries(scope:EmailScope,cursor:string|null,limit:number,guard:EmailDraftGuard,signal?:AbortSignal):Promise<EmailDraftSummaryPage>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>50||!(cursor===null||typeof cursor==='string'&&cursor.length>0&&cursor.length<=8192))
      throw new Error('EMAIL_DRAFT_INVALID');
    signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      let anchor:z.infer<typeof SummaryCursorSchema>|null=null;
      if(cursor!==null){
        try{
          if(!/^[A-Za-z0-9_-]+$/u.test(cursor))throw new Error();
          const raw=Buffer.from(cursor,'base64url');if(raw.toString('base64url')!==cursor)throw new Error();
          const envelope=AppRunSecretEnvelopeSchema.parse(JSON.parse(raw.toString('utf8')));
          anchor=SummaryCursorSchema.parse(this.crypto.open(envelope,SummaryCursorContext(scope)));
          if(anchor.org_id!==scope.org_id||anchor.owner_user_id!==scope.owner_user_id||anchor.account_id!==scope.account_id
            ||anchor.expires_at<=this.now().getTime())throw new Error();
        }catch{throw new Error('EMAIL_DRAFT_INVALID');}
      }
      const scoped=and(eq(emailDrafts.org_id,scope.org_id),eq(emailDrafts.owner_user_id,scope.owner_user_id),
        eq(emailDrafts.account_id,scope.account_id),ne(emailDrafts.status,'archived'));
      const after=anchor?or(gt(emailDrafts.updated_at,new Date(anchor.updated_at)),and(eq(emailDrafts.updated_at,new Date(anchor.updated_at)),gt(emailDrafts.draft_id,anchor.draft_id))):undefined;
      const rows=await tx.select({draft_id:emailDrafts.draft_id,account_id:emailDrafts.account_id,revision:emailDrafts.revision,
        content_revision:emailDrafts.content_revision,status:emailDrafts.status,content_envelope:emailDrafts.content_envelope,updated_at:emailDrafts.updated_at})
        .from(emailDrafts).where(after?and(scoped,after):scoped).orderBy(asc(emailDrafts.updated_at),asc(emailDrafts.draft_id)).limit(limit+1);
      await guard(tx);signal?.throwIfAborted();
      const has_more=rows.length>limit,pageRows=rows.slice(0,limit);
      const items=pageRows.map(row=>{
        const content=this.crypto.open(row.content_envelope,emailDraftContext(scope,row.draft_id,row.content_revision));
        const subject=content&&typeof content==='object'&&!Array.isArray(content)?(content as Record<string,unknown>).subject:undefined;
        if(typeof subject!=='string'||subject.length>998||/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(subject)
          ||!['draft','submitted'].includes(row.status))throw new Error('EMAIL_DRAFT_INVALID');
        return Object.freeze({draft_id:row.draft_id,account_id:row.account_id,revision:row.revision,content_revision:row.content_revision,
          status:row.status as 'draft'|'submitted',subject,updated_at:row.updated_at.toISOString()});
      });
      await guard(tx);signal?.throwIfAborted();
      let next_cursor:string|null=null;
      if(has_more&&pageRows.length){
        const last=pageRows[pageRows.length-1]!;
        const encrypted=this.crypto.seal({schema_version:'deft.email_draft_summary_cursor.v1',...scope,updated_at:last.updated_at.toISOString(),
          draft_id:last.draft_id,expires_at:this.now().getTime()+SummaryCursorTTL},SummaryCursorContext(scope));
        next_cursor=Buffer.from(JSON.stringify(encrypted),'utf8').toString('base64url');
      }
      return Object.freeze({items:Object.freeze(items),next_cursor,has_more});
    },{isolationLevel:'repeatable read'});
  }

  async update(scope: EmailScope, draftId: string, expectedRevision: number, content: EmailDraftContent, editorUserId: string,
    guard: EmailDraftGuard, signal?: AbortSignal): Promise<EmailDraftRow> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      const [current] = await tx.select().from(emailDrafts).where(whereDraft(scope, draftId)).limit(1).for('update');
      if (!current) throw new Error('EMAIL_DRAFT_NOT_FOUND');
      if (current.status !== 'draft' || current.revision !== expectedRevision) throw new Error('EMAIL_DRAFT_CONFLICT');
      const revision = current.revision + 1;
      if (!Number.isSafeInteger(revision) || revision > 2147483647) throw new Error('EMAIL_DRAFT_CONFLICT');
      const [updated] = await tx.update(emailDrafts).set({ revision, content_revision: revision,
        content_envelope: this.crypto.seal(content, emailDraftContext(scope, draftId, revision)), last_edited_by_user_id: editorUserId, updated_at: this.now() })
        .where(and(whereDraft(scope, draftId), eq(emailDrafts.revision, expectedRevision), eq(emailDrafts.status, 'draft'))).returning();
      if (!updated) throw new Error('EMAIL_DRAFT_CONFLICT');
      await this.recordDesired(tx, scope, draftId, updated.revision);
      await guard(tx); signal?.throwIfAborted();
      return this.materialize(scope, updated);
    });
  }

  async archive(scope: EmailScope, draftId: string, expectedRevision: number, guard: EmailDraftGuard, signal?: AbortSignal): Promise<EmailDraftRow> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      await guard(tx); signal?.throwIfAborted();
      const [current] = await tx.select().from(emailDrafts).where(whereDraft(scope, draftId)).limit(1).for('update');
      if (!current) throw new Error('EMAIL_DRAFT_NOT_FOUND');
      if (current.status === 'archived' || current.revision !== expectedRevision) throw new Error('EMAIL_DRAFT_CONFLICT');
      const revision = current.revision + 1;
      const [updated] = await tx.update(emailDrafts).set({ revision, status: 'archived', archived_at: this.now(), updated_at: this.now() })
        .where(and(whereDraft(scope, draftId), eq(emailDrafts.revision, expectedRevision), ne(emailDrafts.status, 'archived'))).returning();
      if (!updated) throw new Error('EMAIL_DRAFT_CONFLICT');
      await guard(tx); signal?.throwIfAborted();
      return this.materialize(scope, updated);
    });
  }
}
