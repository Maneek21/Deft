import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, exists, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from './queues.js';
import { canonicalCapabilityJson } from '@deft/shared';
import { z } from 'zod';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import { EmailMailboxError, validateEmailMessageRecords, type EmailScope, type EmailListRequest, type EmailCachedPage, type EmailMessageRecord,
  type EmailMailboxStore, type EmailProviderState, type EmailProviderStateUpdate, type EmailStaleRecord,
  type EmailSyncCommit, type EmailSyncReceipt, type EmailSyncResult } from './email-mailbox-service.js';

const nativeSchema = { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts };
export type EmailMailboxDatabase = Pick<NodePgDatabase<typeof nativeSchema>, 'transaction'>;
type EmailMailboxTransaction = Parameters<Parameters<EmailMailboxDatabase['transaction']>[0]>[0];
export type EmailMailboxIdentityNormalizer = Readonly<{
 normalizeRecords(transaction:unknown,scope:EmailScope,records:readonly EmailMessageRecord[]):Promise<EmailMessageRecord[]>;
 filterTombstones(transaction:unknown,scope:EmailScope,ids:readonly string[],proofs?:Readonly<Record<string,string>>):Promise<string[]>;
}>;
export type EmailMailboxFlagAcknowledgement = Readonly<{logical_message_id:string;expected_revision:string;expected_source_digest:string;
  flags:Readonly<{seen:boolean|null;flagged:boolean|null;answered:boolean|null}>;folders?:readonly string[];expected_checkpoint_revision?:number;expected_storage_revision?:number}>;
const LIST_CURSOR_TTL_MS = 15 * 60_000;
const cursorSchema = z.strictObject({ version: z.literal(1), revision: z.number().int().nonnegative(), envelope: z.record(z.string(), z.json()) });
const positionSchema = z.strictObject({ folder: z.string(), sort_at: z.iso.datetime(), logical_message_id: z.string().regex(/^mail_[a-f0-9]{64}$/), expires_at: z.iso.datetime() });
const providerStateSchema = z.strictObject({ state_key: z.string().regex(/^[a-f0-9]{64}$/), generation: z.string().min(1).max(128),
  value: z.record(z.string(), z.json()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 65536) });
const providerStateValueSchema = z.record(z.string(), z.json());
const generationSchema = z.string().min(1).max(128).refine(value => !/[\r\n\0]/.test(value));
const stateKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
const staleAfterSchema = z.string().regex(/^mail_[a-f0-9]{64}$/).nullable();
const scopeWhere = (table: typeof emailCheckpoints | typeof emailMessages | typeof emailMemberships | typeof emailSyncReceipts | typeof emailProviderStates, scope: EmailScope) =>
  and(eq(table.org_id, scope.org_id), eq(table.owner_user_id, scope.owner_user_id), eq(table.account_id, scope.account_id));
const context = (scope: EmailScope, kind: 'summary' | 'provider_source' | 'checkpoint', record_id: string, revision: number) => ({ ...scope, kind, record_id, revision });
const providerStateRecord = (stateKey: string, generation: string) => `provider-state:${stateKey}:${generation}`;
const listRecord = (folder: string) => 'list:' + createHash('sha256').update(folder).digest('hex');
const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Account-scoped encrypted native mailbox storage. Permissions belong to the
 * service's fresh authority port; no receipt, checkpoint or cache row is a grant.
 * All mutations share one native transaction and its authority lock fence. */
export class PostgresEmailMailboxStore implements EmailMailboxStore {
  private readonly now: () => Date;
  private readonly freshnessMs: number;
  constructor(private readonly database: EmailMailboxDatabase, private readonly crypto: EmailMailboxCrypto,
    private readonly options: { now?: () => Date; freshnessMs?: number; identities?:EmailMailboxIdentityNormalizer } = {}) {
    this.now = options.now ?? (() => new Date()); this.freshnessMs = options.freshnessMs ?? 30000;
    if (!Number.isSafeInteger(this.freshnessMs) || this.freshnessMs < 0 || this.freshnessMs > 300000) throw new TypeError('Invalid mailbox freshness bound');
  }
  private cursor(scope: EmailScope, row: typeof emailCheckpoints.$inferSelect) {
    if (row.cursor_envelope === null) return null;
    const value = this.crypto.open(row.cursor_envelope, context(scope, 'checkpoint', 'provider-cursor', row.revision));
    const parsed = z.strictObject({ cursor: z.string().min(1).max(8192) }).safeParse(value);
    if (!parsed.success) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
    return parsed.data.cursor;
  }
  private position(scope: EmailScope, request: EmailListRequest, revision: number) {
    if (request.cursor === null) return null;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(request.cursor)) throw new Error('Invalid cursor');
      const decoded = Buffer.from(request.cursor, 'base64url');
      if (decoded.toString('base64url') !== request.cursor || decoded.byteLength > 6144) throw new Error('Invalid cursor');
      const token = cursorSchema.parse(JSON.parse(decoded.toString('utf8')));
      if (token.revision > revision) throw new EmailMailboxError('EMAIL_CURSOR_EXPIRED');
      const position = positionSchema.parse(this.crypto.open(token.envelope, context(scope, 'checkpoint', listRecord(request.folder), token.revision)));
      if (Date.parse(position.expires_at) <= this.now().getTime()) throw new EmailMailboxError('EMAIL_CURSOR_EXPIRED');
      if (position.folder !== request.folder) throw new Error('Invalid folder');
      return position;
    } catch (error) {
      if (error instanceof EmailMailboxError) throw error;
      throw new EmailMailboxError('EMAIL_PAGE_INVALID');
    }
  }
  async readPage(scope: EmailScope, request: EmailListRequest, signal?: AbortSignal): Promise<EmailCachedPage> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      const [checkpoint] = await tx.select().from(emailCheckpoints).where(scopeWhere(emailCheckpoints, scope)).limit(1);
      const revision = checkpoint?.revision ?? 0, position = this.position(scope, request, revision);
      const conditions: (SQL | undefined)[] = [scopeWhere(emailMessages, scope), isNull(emailMessages.deleted_at)];
      const flagView=request.folder==='starred',directView=request.folder==='all'||flagView;
      if(flagView)conditions.push(eq(emailMessages.flagged,true));
      if (position) conditions.push(or(lt(emailMessages.sort_at, new Date(position.sort_at)),
        and(eq(emailMessages.sort_at, new Date(position.sort_at)), lt(emailMessages.logical_message_id, position.logical_message_id))));
      const folderCondition = directView ? undefined : eq(emailMemberships.folder, request.folder);
      const base = () => directView
        ? tx.select({ message: emailMessages }).from(emailMessages).where(and(...conditions))
        : tx.select({ message: emailMessages }).from(emailMessages).innerJoin(emailMemberships, and(
          eq(emailMemberships.org_id, emailMessages.org_id), eq(emailMemberships.owner_user_id, emailMessages.owner_user_id),
          eq(emailMemberships.account_id, emailMessages.account_id), eq(emailMemberships.logical_message_id, emailMessages.logical_message_id)))
          .where(and(...conditions, folderCondition));
      const selected = await base().orderBy(desc(emailMessages.sort_at), desc(emailMessages.logical_message_id)).limit(request.limit + 1);
      const rows = selected.slice(0, request.limit), ids = rows.map(row => row.message.logical_message_id);
      const memberships = ids.length ? await tx.select({ logical_message_id: emailMemberships.logical_message_id, folder: emailMemberships.folder })
        .from(emailMemberships).where(and(scopeWhere(emailMemberships, scope), inArray(emailMemberships.logical_message_id, ids))) : [];
      const items: EmailMessageRecord[] = rows.map(({ message }) => {
        if (message.summary_envelope === null || message.source_envelope === null) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
        const data = this.crypto.open(message.summary_envelope, context(scope, 'summary', message.logical_message_id, message.storage_revision));
        const provider_source = this.crypto.open(message.source_envelope, context(scope, 'provider_source', message.logical_message_id, message.storage_revision));
        if (!data || Array.isArray(data) || typeof data !== 'object' || !provider_source || Array.isArray(provider_source) || typeof provider_source !== 'object') throw new EmailMailboxError('EMAIL_PAGE_INVALID');
        return { account_id: scope.account_id, logical_message_id: message.logical_message_id, revision: message.revision,
          received_at: iso(message.received_at), folders: memberships.filter(item => item.logical_message_id === message.logical_message_id).map(item => item.folder).sort(),
          flags: { seen: message.seen, flagged: message.flagged, answered: message.answered },
          data: data as EmailMessageRecord['data'], provider_source: provider_source as EmailMessageRecord['provider_source'] };
      });
      let exact_total: number | null = null;
      // List views and refresh probes can explicitly skip the full-folder scan.
      // Existing callers keep exact snapshot counts; omission is honestly null
      // and does not change inventory coverage, pagination or authority checks.
      if (checkpoint?.coverage === 'complete' && request.include_total !== false) {
        const visible = and(scopeWhere(emailMessages, scope), isNull(emailMessages.deleted_at),flagView?eq(emailMessages.flagged,true):undefined);
        const [total] = directView
          ? await tx.select({ value: count() }).from(emailMessages).where(visible)
          : await tx.select({ value: count() }).from(emailMessages).innerJoin(emailMemberships, and(
            eq(emailMemberships.org_id, emailMessages.org_id), eq(emailMemberships.owner_user_id, emailMessages.owner_user_id),
            eq(emailMemberships.account_id, emailMessages.account_id), eq(emailMemberships.logical_message_id, emailMessages.logical_message_id)))
            .where(and(visible, folderCondition));
        exact_total = total?.value ?? 0;
      }
      const last = rows.at(-1)?.message;
      const next_cursor = selected.length > request.limit && last ? Buffer.from(JSON.stringify({ version: 1, revision,
        envelope: this.crypto.seal({ folder: request.folder, sort_at: last.sort_at.toISOString(), logical_message_id: last.logical_message_id,
          expires_at: new Date(this.now().getTime() + LIST_CURSOR_TTL_MS).toISOString() },
          context(scope, 'checkpoint', listRecord(request.folder), revision)) })).toString('base64url') : null;
      signal?.throwIfAborted();
      return { account_id: scope.account_id, items, next_cursor, observed_at: iso(checkpoint?.observed_at ?? null),
        fresh_until: iso(checkpoint?.fresh_until ?? null), coverage: checkpoint?.coverage ?? 'partial', exact_total,
        sync_state: checkpoint?.sync_state ?? 'paused', checkpoint_revision: revision };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  /** Search can discover previously uncached messages. Insert only missing
   * identities; a delayed search must not overwrite newer sync state or revive
   * a tombstone. Accepted results are durable and therefore reader-openable. */
  async persistSearchResults(scope:EmailScope,input:readonly EmailMessageRecord[],guard:(transaction:unknown)=>Promise<void>,signal?:AbortSignal):Promise<{records:EmailMessageRecord[];dropped:number}>{
    const inputItems=validateEmailMessageRecords(scope,input,100);
    signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      await tx.insert(emailCheckpoints).values({...scope}).onConflictDoNothing();
      const [checkpoint]=await tx.select().from(emailCheckpoints).where(scopeWhere(emailCheckpoints,scope)).limit(1).for('update');
      if(!checkpoint)throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');
      const items=this.options.identities?await this.options.identities.normalizeRecords(tx,scope,inputItems):inputItems;
      const revision=checkpoint.revision+1,now=this.now();
      if(revision>2147483647||!Number.isFinite(now.getTime()))throw new EmailMailboxError('EMAIL_PAGE_INVALID');
      const ids=items.map(item=>item.logical_message_id);
      // Search metadata may be older than sync/triage, or refer to a tombstone.
      // Existence includes deleted rows. Only genuinely missing identities are
      // encrypted/inserted, while the normal readback remains the data source.
      const existing=ids.length?await tx.select({logical_message_id:emailMessages.logical_message_id}).from(emailMessages)
        .where(and(scopeWhere(emailMessages,scope),inArray(emailMessages.logical_message_id,ids))):[];
      const existingIds=new Set(existing.map(row=>row.logical_message_id)),missing=items.filter(item=>!existingIds.has(item.logical_message_id));
      const values=missing.map(item=>{
        signal?.throwIfAborted();
        const received_at=item.received_at===null?null:new Date(item.received_at);
        return {...scope,logical_message_id:item.logical_message_id,revision:item.revision,storage_revision:revision,
          received_at,sort_at:received_at??new Date(0),seen:item.flags.seen,flagged:item.flags.flagged,answered:item.flags.answered,
          summary_envelope:this.crypto.seal(item.data,context(scope,'summary',item.logical_message_id,revision)),
          source_envelope:this.crypto.seal(item.provider_source,context(scope,'provider_source',item.logical_message_id,revision)),
          inventory_generation:null,updated_at:now};
      });
      const added=values.length?await tx.insert(emailMessages).values(values).onConflictDoNothing().returning({id:emailMessages.logical_message_id}):[];
      const addedIds=new Set(added.map(row=>row.id));
      const newMemberships=missing.flatMap(item=>addedIds.has(item.logical_message_id)?[...new Set(item.folders)]
        .map(folder=>({...scope,logical_message_id:item.logical_message_id,folder,inventory_generation:null})):[]);
      if(newMemberships.length)await tx.insert(emailMemberships).values(newMemberships);
      if(added.length){
        const retainedCursor=this.cursor(scope,checkpoint),cursor_envelope=retainedCursor===null?null:this.crypto.seal({cursor:retainedCursor},context(scope,'checkpoint','provider-cursor',revision));
        await tx.update(emailCheckpoints).set({revision,cursor_envelope,coverage:'partial',fresh_until:null,updated_at:now}).where(scopeWhere(emailCheckpoints,scope));
      }
      const rows=ids.length?await tx.select().from(emailMessages).where(and(scopeWhere(emailMessages,scope),inArray(emailMessages.logical_message_id,ids),isNull(emailMessages.deleted_at))):[];
      const memberships=rows.length?await tx.select().from(emailMemberships).where(and(scopeWhere(emailMemberships,scope),inArray(emailMemberships.logical_message_id,rows.map(row=>row.logical_message_id)))):[];
      const records=rows.map(row=>{
        if(!row.summary_envelope||!row.source_envelope)throw new EmailMailboxError('EMAIL_PAGE_INVALID');
        return {account_id:scope.account_id,logical_message_id:row.logical_message_id,revision:row.revision,received_at:iso(row.received_at),
          folders:memberships.filter(member=>member.logical_message_id===row.logical_message_id).map(member=>member.folder).sort(),
          flags:{seen:row.seen,flagged:row.flagged,answered:row.answered},
          data:this.crypto.open(row.summary_envelope,context(scope,'summary',row.logical_message_id,row.storage_revision)),
          provider_source:this.crypto.open(row.source_envelope,context(scope,'provider_source',row.logical_message_id,row.storage_revision))};
      });
      const validated=validateEmailMessageRecords(scope,records,100),byId=new Map(validated.map(row=>[row.logical_message_id,row]));
      await guard(tx);signal?.throwIfAborted();
      return {records:ids.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]),dropped:inputItems.length-records.length};
    });
  }
  async readCheckpoint(scope: EmailScope, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      const [row] = await tx.select().from(emailCheckpoints).where(scopeWhere(emailCheckpoints, scope)).limit(1);
      signal?.throwIfAborted(); return { revision: row?.revision ?? 0, cursor: row ? this.cursor(scope, row) : null, has_more: row?.has_more ?? false };
    }, { accessMode: 'read only' });
  }
  private unreadPredicate(tx: EmailMailboxTransaction, scope: EmailScope, folder: string) {
    const membership = tx.select({ one: sql`1` }).from(emailMemberships).where(and(
      scopeWhere(emailMemberships, scope), eq(emailMemberships.logical_message_id, emailMessages.logical_message_id),
      inArray(emailMemberships.folder, folder.toLowerCase() === 'inbox' ? ['inbox', 'INBOX'] : [folder])));
    return and(scopeWhere(emailMessages, scope), isNull(emailMessages.deleted_at), eq(emailMessages.seen, false),
      folder === 'starred' ? eq(emailMessages.flagged, true) : folder === 'all' ? undefined : exists(membership));
  }

  /** Count in PostgreSQL, excluding only sparse, authorized local snoozes.
   * Count and checkpoint share a repeatable-read snapshot; no mailbox-sized
   * identifier projection, hash loop or safety ceiling is needed. */
  async readUnreadCount(scope: EmailScope, folder: string, hiddenMessageIds: readonly string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const safeFolder = z.string().min(1).max(128).refine(value => !/[\r\n\0]/u.test(value)).parse(folder);
    const hidden = [...new Set(hiddenMessageIds)];
    return this.database.transaction(async tx => {
      const [total] = await tx.select({ value: count() }).from(emailMessages).where(and(
        this.unreadPredicate(tx, scope, safeFolder),
        hidden.length ? sql`NOT (${emailMessages.logical_message_id} = ANY(${sql.param(hidden)}::text[]))` : undefined));
      const [checkpoint] = await tx.select({ revision: emailCheckpoints.revision, coverage: emailCheckpoints.coverage,
        observed_at: emailCheckpoints.observed_at, fresh_until: emailCheckpoints.fresh_until, sync_state: emailCheckpoints.sync_state })
        .from(emailCheckpoints).where(scopeWhere(emailCheckpoints, scope)).limit(1);
      signal?.throwIfAborted();
      const value = total?.value ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
      return { cached_unread_count: value, coverage: checkpoint?.coverage ?? 'partial', checkpoint_revision: checkpoint?.revision ?? 0,
        observed_at: checkpoint?.observed_at?.toISOString() ?? null, fresh_until: checkpoint?.fresh_until?.toISOString() ?? null,
        sync_state: checkpoint?.sync_state ?? 'paused' };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  /** Legacy bounded identifier projection retained for direct cache consumers.
   * Production unread counts use readUnreadCount instead. */
  async readUnreadIds(scope: EmailScope, folder: string, limit: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const safeFolder = z.string().min(1).max(128).refine(value => !/[\r\n\0]/u.test(value)).parse(folder);
    const safeLimit = z.number().int().min(1).max(100001).parse(limit);
    return this.database.transaction(async tx => {
      const rows = await tx.select({ logical_message_id: emailMessages.logical_message_id }).from(emailMessages).where(this.unreadPredicate(tx, scope, safeFolder))
        .orderBy(asc(emailMessages.logical_message_id)).limit(safeLimit);
      const [checkpoint] = await tx.select({ revision: emailCheckpoints.revision, coverage: emailCheckpoints.coverage,
        observed_at: emailCheckpoints.observed_at, fresh_until: emailCheckpoints.fresh_until, sync_state: emailCheckpoints.sync_state })
        .from(emailCheckpoints).where(scopeWhere(emailCheckpoints, scope)).limit(1);
      signal?.throwIfAborted();
      return { logical_message_ids: rows.map(row => row.logical_message_id), overflow: rows.length >= safeLimit,
        coverage: checkpoint?.coverage ?? 'partial', checkpoint_revision: checkpoint?.revision ?? 0,
        observed_at: checkpoint?.observed_at?.toISOString() ?? null, fresh_until: checkpoint?.fresh_until?.toISOString() ?? null,
        sync_state: checkpoint?.sync_state ?? 'paused' };
    }, { accessMode: 'read only' });
  }
  /** Read before message review, under the same scoped authority fences. A
   * later sync commit or ACK (including equal-value ACK) invalidates this version. */
  async readAcknowledgementRevision(scope:EmailScope,guard:(transaction:unknown)=>Promise<void>,signal?:AbortSignal):Promise<number|null>{
    signal?.throwIfAborted();return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const [row]=await tx.select({revision:emailCheckpoints.revision}).from(emailCheckpoints).where(scopeWhere(emailCheckpoints,scope)).limit(1);
      const revision=row?z.number().int().min(0).max(2147483647).parse(row.revision):null;
      await guard(tx);signal?.throwIfAborted();return revision;
    });
  }
  /** A provider-confirmed triage result can update cached flags only while the
   * reviewed source record remains byte-for-byte current. The checkpoint bump
   * invalidates pages fetched before the provider effect without changing the
   * cursor or pretending that a fresh provider scan has completed. Gmail's exact
   * confirmed memberships may share this CAS; other providers remain flags-only. */
  /** Private per-target ACK pin. Read before reviewed messages, with the same
   * current authority fences. Unrelated account writes cannot change these pins. */
  async readAcknowledgementVersions(scope:EmailScope,logicalIdsRaw:readonly string[],guard:(transaction:unknown)=>Promise<void>,signal?:AbortSignal){
    signal?.throwIfAborted();const ids=z.array(z.string().regex(/^mail_[a-f0-9]{64}$/u)).min(1).max(25).refine(ids=>new Set(ids).size===ids.length).parse(logicalIdsRaw);
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const rows=await tx.select({logical_message_id:emailMessages.logical_message_id,storage_revision:emailMessages.storage_revision}).from(emailMessages)
        .where(and(scopeWhere(emailMessages,scope),inArray(emailMessages.logical_message_id,ids),isNull(emailMessages.deleted_at)));
      const parsed=z.array(z.strictObject({logical_message_id:z.string().regex(/^mail_[a-f0-9]{64}$/u),storage_revision:z.number().int().min(1).max(2147483647)})).max(25).parse(rows);
      if(new Set(parsed.map(row=>row.logical_message_id)).size!==parsed.length||parsed.some(row=>!ids.includes(row.logical_message_id)))throw new EmailMailboxError('EMAIL_PAGE_INVALID');
      await guard(tx);signal?.throwIfAborted();return parsed;
    });
  }
  async acknowledgeFlags(scope:EmailScope,updatesRaw:readonly EmailMailboxFlagAcknowledgement[],guard:(transaction:unknown)=>Promise<void>,signal?:AbortSignal){
    signal?.throwIfAborted();
    const updates=z.array(z.strictObject({logical_message_id:z.string().regex(/^mail_[a-f0-9]{64}$/u),expected_revision:z.string().min(1).max(512),
      expected_source_digest:z.string().regex(/^[a-f0-9]{64}$/u),flags:z.strictObject({seen:z.boolean().nullable(),flagged:z.boolean().nullable(),answered:z.boolean().nullable()}),
      expected_checkpoint_revision:z.number().int().min(0).max(2147483647).optional(),expected_storage_revision:z.number().int().min(1).max(2147483647).optional(),folders:z.array(z.string().regex(/^(?:inbox|sent|spam|trash|drafts|starred|archive|label:[a-f0-9]{64})$/u)).min(1).max(100).refine(ids=>new Set(ids).size===ids.length).optional()})
      .refine(update=>!(update.expected_checkpoint_revision!==undefined&&update.expected_storage_revision!==undefined))
      .refine(update=>!update.folders||update.expected_checkpoint_revision!==undefined||update.expected_storage_revision!==undefined)).max(25).parse(updatesRaw);
    if(!updates.length)return {acknowledged:0,stale:0};
    if(new Set(updates.map(update=>update.logical_message_id)).size!==updates.length)throw new EmailMailboxError('EMAIL_PAGE_INVALID');
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const [checkpoint]=await tx.select().from(emailCheckpoints).where(scopeWhere(emailCheckpoints,scope)).limit(1).for('update');
      if(!checkpoint){await guard(tx);signal?.throwIfAborted();return {acknowledged:0,stale:updates.length};}
      if(updates.some(update=>update.expected_checkpoint_revision!==undefined&&update.expected_checkpoint_revision!==checkpoint.revision)){
        await guard(tx);signal?.throwIfAborted();return {acknowledged:0,stale:updates.length};
      }
      let nextRevision=checkpoint.revision+1;const now=this.now();
      if(nextRevision>2147483647||!Number.isFinite(now.getTime()))throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');
      const nextCursor=this.cursor(scope,checkpoint);
      let acknowledged=0;
      for(const update of updates){
        signal?.throwIfAborted();
        const [row]=await tx.select().from(emailMessages).where(and(scopeWhere(emailMessages,scope),eq(emailMessages.logical_message_id,update.logical_message_id),isNull(emailMessages.deleted_at))).limit(1).for('update');
        if(!row||row.revision!==update.expected_revision||!row.source_envelope||update.expected_storage_revision!==undefined&&row.storage_revision!==update.expected_storage_revision)continue;
        const source=this.crypto.open(row.source_envelope,context(scope,'provider_source',row.logical_message_id,row.storage_revision));
        const digest=createHash('sha256').update(canonicalCapabilityJson([scope.account_id,row.logical_message_id,row.revision,source])).digest('hex');
        if(digest!==update.expected_source_digest)continue;
        const flags:{seen?:boolean;flagged?:boolean;answered?:boolean}={...(update.flags.seen===null?{}:{seen:update.flags.seen}),...(update.flags.flagged===null?{}:{flagged:update.flags.flagged}),
          ...(update.flags.answered===null?{}:{answered:update.flags.answered})};
        if(!Object.keys(flags).length&&!update.folders)continue;
        if(!row.summary_envelope||!Number.isSafeInteger(row.storage_revision)||row.storage_revision<1)throw new EmailMailboxError('EMAIL_PAGE_INVALID');
        nextRevision=Math.max(nextRevision,row.storage_revision+1);
        if(nextRevision>2147483647)throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');
        const data=z.record(z.string(),z.union([z.string(),z.number().finite(),z.boolean(),z.null()])).parse(this.crypto.open(row.summary_envelope,context(scope,'summary',row.logical_message_id,row.storage_revision)));
        let summary=data;
        if(update.folders){
          const provider=z.record(z.string(),z.json()).parse(source);if(provider.provider!=='gmail'||provider.account_id!==scope.account_id||provider.logical_message_id!==row.logical_message_id)throw new EmailMailboxError('EMAIL_PAGE_INVALID');
          summary={...data,in_inbox:update.folders.includes('inbox'),in_sent:update.folders.includes('sent'),in_archive:update.folders.includes('archive'),folder_membership_complete:true};
        }
        // Even equal-value ACKs consume a new row version; otherwise a late
        // concurrent operation can pass an ABA comparison and publish old state.
        await tx.update(emailMessages).set({...flags,storage_revision:nextRevision,
          summary_envelope:this.crypto.seal(summary,context(scope,'summary',row.logical_message_id,nextRevision)),
          source_envelope:this.crypto.seal(source,context(scope,'provider_source',row.logical_message_id,nextRevision)),updated_at:now}).where(and(scopeWhere(emailMessages,scope),eq(emailMessages.logical_message_id,update.logical_message_id),
          eq(emailMessages.revision,update.expected_revision),eq(emailMessages.storage_revision,row.storage_revision),isNull(emailMessages.deleted_at)));
        if(update.folders){
          await tx.delete(emailMemberships).where(and(scopeWhere(emailMemberships,scope),eq(emailMemberships.logical_message_id,update.logical_message_id)));
          await tx.insert(emailMemberships).values(update.folders.map(folder=>({...scope,logical_message_id:update.logical_message_id,folder,inventory_generation:row.inventory_generation,updated_at:now})));
        }
        acknowledged++;
      }
      if(acknowledged){
        const cursor_envelope=nextCursor===null?null:this.crypto.seal({cursor:nextCursor},context(scope,'checkpoint','provider-cursor',nextRevision));
        await tx.update(emailCheckpoints).set({revision:nextRevision,cursor_envelope,fresh_until:null,updated_at:now}).where(and(
          scopeWhere(emailCheckpoints,scope),eq(emailCheckpoints.revision,checkpoint.revision)));
      }
      await guard(tx);signal?.throwIfAborted();return {acknowledged,stale:updates.length-acknowledged};
    });
  }
  /** Server-only record lookup for the native reader. The caller must freshly
   * authorize before/after use; encrypted locators never enter a public DTO. */
  async readMessage(scope:EmailScope,logicalId:string,signal?:AbortSignal):Promise<EmailMessageRecord|null>{
    signal?.throwIfAborted();
    const id=z.string().regex(/^mail_[a-f0-9]{64}$/).parse(logicalId);
    return this.database.transaction(async tx=>{
      const [row]=await tx.select().from(emailMessages).where(and(scopeWhere(emailMessages,scope),
        eq(emailMessages.logical_message_id,id),isNull(emailMessages.deleted_at))).limit(1);
      if(!row){signal?.throwIfAborted();return null;}
      if(!row.summary_envelope||!row.source_envelope||!Number.isSafeInteger(row.storage_revision)||row.storage_revision<1)
        throw new EmailMailboxError('EMAIL_PAGE_INVALID');
      const data=z.record(z.string(),z.union([z.string(),z.number().finite(),z.boolean(),z.null()])).parse(
        this.crypto.open(row.summary_envelope,context(scope,'summary',id,row.storage_revision)));
      const provider_source=providerStateValueSchema.parse(this.crypto.open(row.source_envelope,context(scope,'provider_source',id,row.storage_revision)));
      const memberships=await tx.select({folder:emailMemberships.folder}).from(emailMemberships).where(and(
        scopeWhere(emailMemberships,scope),eq(emailMemberships.logical_message_id,id)));
      signal?.throwIfAborted();
      return {account_id:scope.account_id,logical_message_id:id,revision:row.revision,received_at:iso(row.received_at),
        folders:memberships.map(value=>value.folder).sort(),flags:{seen:row.seen,flagged:row.flagged,answered:row.answered},data,provider_source};
    },{accessMode:'read only'});
  }
  async readSyncReceipt(scope: EmailScope, pageId: string, signal?: AbortSignal): Promise<EmailSyncReceipt | null> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      const [row] = await tx.select().from(emailSyncReceipts).where(and(scopeWhere(emailSyncReceipts, scope), eq(emailSyncReceipts.page_id, pageId))).limit(1);
      signal?.throwIfAborted(); return row ? { request_digest: row.request_digest,
        result: { state: 'duplicate', checkpoint_revision: row.checkpoint_revision, observed_at: row.observed_at.toISOString(), complete: row.complete, has_more: row.has_more } } : null;
    }, { accessMode: 'read only' });
  }
  async readProviderState(scope: EmailScope, rawStateKey: string, signal?: AbortSignal): Promise<EmailProviderState | null> {
    signal?.throwIfAborted();
    const state_key = stateKeySchema.parse(rawStateKey);
    return this.database.transaction(async tx => {
      const [row] = await tx.select().from(emailProviderStates).where(and(scopeWhere(emailProviderStates, scope), eq(emailProviderStates.state_key, state_key))).limit(1);
      if (!row) { signal?.throwIfAborted(); return null; }
      const opened = this.crypto.open(row.state_envelope,
        context(scope, 'checkpoint', providerStateRecord(state_key, row.generation), row.storage_revision));
      if (!opened || Array.isArray(opened) || typeof opened !== 'object') throw new EmailMailboxError('EMAIL_PAGE_INVALID');
      const parsed = providerStateSchema.parse({ ...opened, state_key, generation: row.generation });
      if (row.storage_revision < 1) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
      signal?.throwIfAborted();
      return { ...parsed, storage_revision: row.storage_revision };
    }, { accessMode: 'read only' });
  }
  async readStaleRecords(scope: EmailScope, rawGeneration: string, rawAfter: string | null, rawLimit: number,
    signal?: AbortSignal): Promise<EmailStaleRecord[]> {
    signal?.throwIfAborted();
    const generation = generationSchema.parse(rawGeneration), after = staleAfterSchema.parse(rawAfter);
    const limit = z.number().int().min(1).max(100).parse(rawLimit);
    return this.database.transaction(async tx => {
      const rows = await tx.select().from(emailMessages).where(and(scopeWhere(emailMessages, scope), isNull(emailMessages.deleted_at),
        sql`${emailMessages.inventory_generation} IS DISTINCT FROM ${generation}`, after ? sql`${emailMessages.logical_message_id} > ${after}` : undefined))
        .orderBy(asc(emailMessages.logical_message_id)).limit(limit);
      const result = rows.map(row => {
        if (row.source_envelope === null || !Number.isSafeInteger(row.storage_revision) || row.storage_revision <= 0) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
        const provider_source = providerStateValueSchema.parse(this.crypto.open(row.source_envelope,
          context(scope, 'provider_source', row.logical_message_id, row.storage_revision)));
        return { logical_message_id: row.logical_message_id, provider_source };
      });
      signal?.throwIfAborted(); return result;
    }, { accessMode: 'read only' });
  }
  async commitPage(scope: EmailScope, commit: EmailSyncCommit, guard: (transaction: unknown) => Promise<void>, signal?: AbortSignal): Promise<EmailSyncResult> {
    signal?.throwIfAborted();
    return this.database.transaction(async tx => {
      // Guard locks membership, web session, account and its binding first.
      await guard(tx); signal?.throwIfAborted();
      await tx.insert(emailCheckpoints).values({ ...scope }).onConflictDoNothing();
      const [checkpoint] = await tx.select().from(emailCheckpoints).where(scopeWhere(emailCheckpoints, scope)).limit(1).for('update');
      if (!checkpoint) throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');
      await tx.execute(sql`INSERT INTO email_notification_states(org_id,owner_user_id,account_id)
        VALUES(${scope.org_id},${scope.owner_user_id},${scope.account_id}) ON CONFLICT DO NOTHING`);
      const readinessResult = await tx.execute(sql`SELECT initial_inventory_complete FROM email_notification_states
        WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id} FOR UPDATE`);
      const notificationReady = (readinessResult as unknown as { rows?: Array<{ initial_inventory_complete?: boolean }> }).rows?.[0]?.initial_inventory_complete;
      if (typeof notificationReady !== 'boolean') throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');
      const [receipt] = await tx.select().from(emailSyncReceipts).where(and(scopeWhere(emailSyncReceipts, scope), eq(emailSyncReceipts.page_id, commit.page_id))).limit(1);
      if (receipt) {
        if (receipt.request_digest !== commit.request_digest || receipt.page_digest !== commit.page_digest) throw new EmailMailboxError('EMAIL_SYNC_REPLAY_CONFLICT');
        await guard(tx); signal?.throwIfAborted();
        return { state: 'duplicate', checkpoint_revision: receipt.checkpoint_revision, observed_at: receipt.observed_at.toISOString(), complete: receipt.complete, has_more: receipt.has_more };
      }
      if (checkpoint.revision !== commit.expected_checkpoint_revision || this.cursor(scope, checkpoint) !== commit.input_cursor) throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');
      let nextRevision = checkpoint.revision + 1; const now = this.now();
      if (!Number.isFinite(now.getTime()) || nextRevision > 2147483647 || commit.page.account_id !== scope.account_id
        || commit.page.items.some(item => item.account_id !== scope.account_id)
        || commit.page.state_updates.length > 8
        || new Set(commit.page.state_updates.map(update => update.state_key)).size !== commit.page.state_updates.length) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
      const stateUpdates: EmailProviderStateUpdate[] = commit.page.state_updates.map(update => providerStateSchema.parse(update));
      const items=this.options.identities?await this.options.identities.normalizeRecords(tx,scope,commit.page.items):commit.page.items;
      const tombstones=(this.options.identities?await this.options.identities.filterTombstones(tx,scope,commit.page.tombstones,commit.page.tombstone_sources):commit.page.tombstones).filter(id=>!items.some(item=>item.logical_message_id===id));
      const complete=commit.page.complete&&items.length===commit.page.items.length&&tombstones.length===commit.page.tombstones.length;
      const existingRows = items.length ? await tx.select({ logical_message_id: emailMessages.logical_message_id, storage_revision: emailMessages.storage_revision }).from(emailMessages)
        .where(and(scopeWhere(emailMessages, scope), inArray(emailMessages.logical_message_id, items.map(item => item.logical_message_id)))) : [];
      for(const row of existingRows){
        if(!Number.isSafeInteger(row.storage_revision)||row.storage_revision<1)throw new EmailMailboxError('EMAIL_PAGE_INVALID');
        nextRevision=Math.max(nextRevision,row.storage_revision+1);
      }
      if(nextRevision>2147483647)throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');
      const existingIds = new Set(existingRows.map(row=>row.logical_message_id));
      const membershipRows = items.length ? await tx.select({ logical_message_id: emailMemberships.logical_message_id,
        folder: emailMemberships.folder, inventory_generation: emailMemberships.inventory_generation }).from(emailMemberships).where(and(
          scopeWhere(emailMemberships, scope), inArray(emailMemberships.logical_message_id, items.map(item => item.logical_message_id)))) : [];
      const membershipGeneration = new Map(membershipRows.map(row => [`${row.logical_message_id}\0${row.folder}`, row.inventory_generation]));
      for (const item of items) {
        signal?.throwIfAborted();
        const inventoryGeneration = item.inventory_generation === undefined ? undefined : generationSchema.parse(item.inventory_generation);
        const received_at = item.received_at === null ? null : new Date(item.received_at);
        const value = { ...scope, logical_message_id: item.logical_message_id, revision: item.revision, storage_revision: nextRevision,
          received_at, sort_at: received_at ?? new Date(0), seen: item.flags.seen, flagged: item.flags.flagged, answered: item.flags.answered,
          inventory_generation: inventoryGeneration ?? null,
          summary_envelope: this.crypto.seal(item.data, context(scope, 'summary', item.logical_message_id, nextRevision)),
          source_envelope: this.crypto.seal(item.provider_source, context(scope, 'provider_source', item.logical_message_id, nextRevision)),
          deleted_at: null, updated_at: now };
        await tx.insert(emailMessages).values(value).onConflictDoUpdate({ target: [emailMessages.org_id, emailMessages.owner_user_id, emailMessages.account_id, emailMessages.logical_message_id],
          set: { revision: value.revision, storage_revision: nextRevision, received_at, sort_at: value.sort_at, seen: value.seen, flagged: value.flagged,
            answered: value.answered, summary_envelope: value.summary_envelope, source_envelope: value.source_envelope, deleted_at: null, updated_at: now,
            ...(inventoryGeneration === undefined ? {} : { inventory_generation: inventoryGeneration }) } });
        await tx.delete(emailMemberships).where(and(scopeWhere(emailMemberships, scope), eq(emailMemberships.logical_message_id, item.logical_message_id)));
        const folders = [...new Set(item.folders)];
        if (folders.length) await tx.insert(emailMemberships).values(folders.map(folder => ({ ...scope, logical_message_id: item.logical_message_id, folder,
          inventory_generation: inventoryGeneration ?? membershipGeneration.get(`${item.logical_message_id}\0${folder}`) ?? null })));
      }
      if (tombstones.length) {
        await tx.delete(emailMemberships).where(and(scopeWhere(emailMemberships, scope), inArray(emailMemberships.logical_message_id, tombstones)));
        await tx.update(emailMessages).set({ summary_envelope: null, source_envelope: null, deleted_at: now, storage_revision: nextRevision, updated_at: now })
          .where(and(scopeWhere(emailMessages, scope), inArray(emailMessages.logical_message_id, tombstones)));
      }
      const observed_at = new Date(commit.page.observed_at), fresh_until = complete
        ? new Date(Math.min(now.getTime(), observed_at.getTime()) + this.freshnessMs) : null;
      const cursor_envelope = commit.page.next_cursor === null ? null : this.crypto.seal({ cursor: commit.page.next_cursor }, context(scope, 'checkpoint', 'provider-cursor', nextRevision));
      for (const update of stateUpdates) {
        signal?.throwIfAborted();
        const state_envelope = this.crypto.seal({ value: update.value },
          context(scope, 'checkpoint', providerStateRecord(update.state_key, update.generation), nextRevision));
        await tx.insert(emailProviderStates).values({ ...scope, state_key: update.state_key, generation: update.generation, storage_revision: nextRevision,
          state_envelope, updated_at: now })
          .onConflictDoUpdate({ target: [emailProviderStates.org_id, emailProviderStates.owner_user_id, emailProviderStates.account_id, emailProviderStates.state_key],
            set: { generation: update.generation, storage_revision: nextRevision, state_envelope, updated_at: now } });
      }
      // Only arrivals after a successful full initial inventory can notify. The
      // unique account/logical-ID key also suppresses tombstone resurrection.
      if (notificationReady) {
        const candidates = items.filter(item => !existingIds.has(item.logical_message_id) && !item.flags.seen
          && item.folders.some(folder => folder.toLowerCase() === 'inbox'));
        if (candidates.length) {
          const [account] = await tx.select({ authority_revision: emailAccounts.authority_revision }).from(emailAccounts)
            .where(and(eq(emailAccounts.org_id, scope.org_id), eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id))).limit(1);
          if (!account || !Number.isSafeInteger(account.authority_revision) || account.authority_revision < 1) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
          for (const item of candidates) {
            signal?.throwIfAborted();
            const notificationId = randomUUID();
            const eventResult = await tx.execute(sql`INSERT INTO email_notification_events
              (org_id,owner_user_id,account_id,notification_id,logical_message_id,revision,authority_revision,state,created_at)
              VALUES(${scope.org_id},${scope.owner_user_id},${scope.account_id},${notificationId},${item.logical_message_id},1,${account.authority_revision},'pending',${now})
              ON CONFLICT DO NOTHING RETURNING notification_id`);
            const inserted = (eventResult as unknown as { rows?: Array<{ notification_id?: string }> }).rows?.[0];
            if (!inserted) continue;
            const payload = { ...scope, notification_id: notificationId, revision: 1, authority_revision: account.authority_revision };
            await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, 'native-email-notification-dispatch', payload, {
              executor: tx as never, orgId: scope.org_id, dedupeKey: `email-notification:${notificationId}:1`, maxAttempts: 5,
            });
          }
        }
      }
      if (complete && !notificationReady) {
        await tx.execute(sql`UPDATE email_notification_states SET initial_inventory_complete=true,updated_at=${now}
          WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id}`);
      }
      await tx.update(emailCheckpoints).set({ revision: nextRevision, cursor_envelope, observed_at, fresh_until,
        coverage: complete ? 'complete' : 'partial', has_more: commit.page.has_more, sync_state: 'idle', updated_at: now }).where(scopeWhere(emailCheckpoints, scope));
      await tx.insert(emailSyncReceipts).values({ ...scope, page_id: commit.page_id, request_digest: commit.request_digest,
        page_digest: commit.page_digest, checkpoint_revision: nextRevision, observed_at, complete, has_more: commit.page.has_more });
      await guard(tx); signal?.throwIfAborted();
      return { state: 'applied', checkpoint_revision: nextRevision, observed_at: observed_at.toISOString(), complete, has_more: commit.page.has_more };
    });
  }
}
