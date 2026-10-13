import { EmailOperationActorSchema, type EmailOperationActor } from './email-agent-actor.js';
export type { EmailOperationActor } from './email-agent-actor.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const identifier = z.string().min(1).max(256).refine(value => !/[\r\n\0]/.test(value));
const ScopeSchema = z.strictObject({ org_id: identifier, owner_user_id: identifier, account_id: identifier });
const ActorSchema = EmailOperationActorSchema;
const ListSchema = z.strictObject({ folder: identifier, cursor: z.string().min(1).max(8192).nullable(), limit: z.number().int().min(1).max(100),
  include_total: z.boolean().optional() });
const SyncSchema = z.strictObject({ expected_checkpoint_revision: z.number().int().min(0), cursor: z.string().min(1).max(8192).nullable(), page_id: identifier });
const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const generation = z.string().min(1).max(128).refine(value => !/[\r\n\0]/.test(value));
const StateUpdateSchema = z.strictObject({ state_key: z.string().regex(/^[a-f0-9]{64}$/), generation,
  value: z.record(z.string(), z.json()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 65536) });
const MessageSchema = z.strictObject({ account_id: identifier, logical_message_id: z.string().regex(/^mail_[a-f0-9]{64}$/),
  revision: identifier, received_at: z.iso.datetime().nullable(), folders: z.array(identifier).max(100),
  flags: z.strictObject({ seen: z.boolean(), flagged: z.boolean(), answered: z.boolean() }),
  data: z.record(z.string().min(1).max(128), scalar), provider_source: z.record(z.string(), z.json()), inventory_generation: generation.optional() });
export const EmailMessageRecordSchema = MessageSchema;
const PageSchema = z.strictObject({ account_id: identifier, items: z.array(MessageSchema).max(100),
  next_cursor: z.string().min(1).max(8192).nullable(), has_more: z.boolean(), complete: z.boolean(), observed_at: z.iso.datetime(),
  failure_count: z.number().int().min(0).max(100), tombstones: z.array(z.string().regex(/^mail_[a-f0-9]{64}$/)).max(100),
  state_updates: z.array(StateUpdateSchema).max(8),
  tombstone_sources: z.record(z.string().regex(/^mail_[a-f0-9]{64}$/),z.string().regex(/^[a-f0-9]{64}$/)).refine(value=>Object.keys(value).length<=100).optional() });

export type EmailScope = Readonly<z.infer<typeof ScopeSchema>>;
export type EmailActor = Readonly<{user_id:string;web_session_id:string;access_expires_at:number}>;
export type EmailListRequest = Readonly<z.infer<typeof ListSchema>>;
export type EmailSyncRequest = Readonly<z.infer<typeof SyncSchema>>;
export type EmailMessageRecord = z.infer<typeof MessageSchema>;
export type EmailProviderPage = z.infer<typeof PageSchema>;
export type EmailProviderStateUpdate = z.infer<typeof StateUpdateSchema>;
export type EmailProviderState = EmailProviderStateUpdate & { storage_revision: number };
export type EmailStaleRecord = Pick<EmailMessageRecord, 'logical_message_id' | 'provider_source'>;
/** Server-owned callbacks only; each read needs fresh authority before/after I/O. */
export interface EmailProviderStateReader {
  read(state_key: string): Promise<EmailProviderState | null>;
  stale(generation: string, after_logical_message_id: string | null, limit: number): Promise<EmailStaleRecord[]>;
}
export type EmailOperation = 'human_read' | 'human_sync' | 'human_draft' | 'human_modify' | 'human_send';
export type EmailCapability = Readonly<{ scope: EmailScope; resource_binding_id: string; authority_version: string; expires_at: number }>;
export type EmailSyncResult = Readonly<{ checkpoint_revision: number; state: 'applied' | 'duplicate'; observed_at: string; complete: boolean; has_more: boolean }>;
export type EmailSyncReceipt = Readonly<{ request_digest: string; result: EmailSyncResult }>;
export type EmailCachedPage = Readonly<{ account_id: string; items: EmailMessageRecord[]; next_cursor: string | null;
  observed_at: string | null; fresh_until: string | null; coverage: 'partial' | 'complete'; exact_total: number | null;
  sync_state: 'idle' | 'queued' | 'syncing' | 'failed' | 'paused'; checkpoint_revision: number }>;
export type EmailSyncCommit = Readonly<{ request_digest: string; page_digest: string; page_id: string;
  expected_checkpoint_revision: number; input_cursor: string | null; authority_version: string; resource_binding_id: string; page: EmailProviderPage }>;

/** Current human authority only. Background services require their own actor port;
 * an AI read grant or operator JWT must never be substituted here. Transaction is
 * the store's native transaction so the final check shares the revocation locks. */
export interface EmailAuthority {
  current(actor: EmailOperationActor, scope: EmailScope, operation: EmailOperation, transaction?: unknown, signal?: AbortSignal): Promise<EmailCapability>;
}
export interface EmailMailboxStore {
  readPage(scope: EmailScope, request: EmailListRequest, signal?: AbortSignal): Promise<EmailCachedPage>;
  readCheckpoint(scope: EmailScope, signal?: AbortSignal): Promise<{ revision: number; cursor: string | null; has_more: boolean }>;
  readSyncReceipt(scope: EmailScope, pageId: string, signal?: AbortSignal): Promise<EmailSyncReceipt | null>;
  readProviderState(scope: EmailScope, state_key: string, signal?: AbortSignal): Promise<EmailProviderState | null>;
  readStaleRecords(scope: EmailScope, generation: string, after_logical_message_id: string | null, limit: number, signal?: AbortSignal): Promise<EmailStaleRecord[]>;
  /** Acquire account/authority locks before checkpoint lock. Invoke guard inside
   * that transaction after lock acquisition and immediately before commit. Exact
   * request/page replay returns duplicate before comparing checkpoint revision;
   * changed replay is a conflict. Upserts, memberships, tombstones, encrypted
   * cursor, revision and replay receipt commit atomically or all roll back. */
  commitPage(scope: EmailScope, commit: EmailSyncCommit, guard: (transaction: unknown) => Promise<void>, signal?: AbortSignal): Promise<EmailSyncResult>;
}
/** Adapter keeps credentials and provider locators private, calls recheck around
 * each provider operation and preserves the existing LogicalMailIndex identity. */
export interface EmailMailboxProvider {
  readPage(scope: EmailScope, request: { cursor: string | null; limit: number }, capability: EmailCapability,
    recheck: () => Promise<void>, signal?: AbortSignal): Promise<EmailProviderPage>;
}
export class EmailMailboxError extends Error {
  constructor(readonly code: 'EMAIL_ACCESS_DENIED' | 'EMAIL_PAGE_INVALID' | 'EMAIL_CURSOR_EXPIRED' | 'EMAIL_CHECKPOINT_CONFLICT' | 'EMAIL_SYNC_REPLAY_CONFLICT') {
    super(code); this.name = 'EmailMailboxError';
  }
}
const denied = () => new EmailMailboxError('EMAIL_ACCESS_DENIED');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sameScope = (a: EmailScope, b: EmailScope) => a.org_id === b.org_id && a.owner_user_id === b.owner_user_id && a.account_id === b.account_id;
export function validateEmailMessageRecords(scope: EmailScope, items: unknown, limit: number): EmailMessageRecord[] {
  const parsed = z.array(MessageSchema).max(limit).safeParse(items);
  if (!parsed.success || parsed.data.some(item => item.account_id !== scope.account_id)
    || new Set(parsed.data.map(item => item.logical_message_id)).size !== parsed.data.length
    || Buffer.byteLength(JSON.stringify(parsed.data)) > 1024 * 1024) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
  return parsed.data;
}

export type EmailMailboxSyncDependencies = Readonly<{
  /** Server-owned human/session or durable account-service authority closure.
   * No HTTP grant, operator token or synthetic human identity belongs here. */
  current(transaction?: unknown, signal?: AbortSignal): Promise<EmailCapability>;
  store: EmailMailboxStore; provider: EmailMailboxProvider; now?: () => number;
}>;

/** One account-scoped sync engine for human sync and durable leased jobs. The
 * supplied current closure must freshly validate its own actor/lease and native
 * consent/custody on every call, including inside the final commit transaction. */
export async function syncEmailMailboxPage(scope: EmailScope, raw: EmailSyncRequest, dependencies: EmailMailboxSyncDependencies,
  signal?: AbortSignal): Promise<EmailSyncResult> {
  const account = Object.freeze(ScopeSchema.parse(scope)), request = Object.freeze(SyncSchema.parse(raw));
  const now = dependencies.now ?? Date.now, { store, provider } = dependencies;
  const live = (capability?: EmailCapability) => { signal?.throwIfAborted(); const time = now(); if (!Number.isFinite(time) || capability && capability.expires_at <= time) throw denied(); };
  const current = async (expected?: EmailCapability, transaction?: unknown) => {
    live(expected); const capability = structuredClone(await dependencies.current(transaction, signal)); live(capability);
    if (!capability?.scope || !sameScope(account, capability.scope) || !identifier.safeParse(capability.resource_binding_id).success
      || !identifier.safeParse(capability.authority_version).success || !Number.isFinite(capability.expires_at)
      || expected && (expected.authority_version !== capability.authority_version || expected.resource_binding_id !== capability.resource_binding_id)) throw denied();
    return Object.freeze({ ...capability, scope: Object.freeze({ ...capability.scope }) });
  };
  const capability = await current();
  const request_digest = digest({ scope: account, request, authority_version: capability.authority_version, resource_binding_id: capability.resource_binding_id });
  const receipt = await store.readSyncReceipt(account, request.page_id, signal); await current(capability);
  if (receipt) {
    if (receipt.request_digest !== request_digest) throw new EmailMailboxError('EMAIL_SYNC_REPLAY_CONFLICT');
    return { ...receipt.result, state: 'duplicate' };
  }
  const checkpoint = await store.readCheckpoint(account, signal); await current(capability);
  if (checkpoint.revision !== request.expected_checkpoint_revision || checkpoint.cursor !== request.cursor) throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');
  const recheck = async () => { await current(capability); };
  const parsed = PageSchema.safeParse(await provider.readPage(account, { cursor: request.cursor, limit: 100 }, capability, recheck, signal)); await recheck();
  if (!parsed.success) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
  const page = parsed.data; validateEmailMessageRecords(account, page.items, 100);
  // Advancing past failed entries without durable recovery silently loses mail.
  if (page.account_id !== account.account_id || Date.parse(page.observed_at) > now() || page.failure_count !== 0
    || page.complete && page.has_more || page.has_more && (page.next_cursor === null || page.next_cursor === request.cursor)
    || new Set(page.state_updates.map(update => update.state_key)).size !== page.state_updates.length
    || new Set(page.tombstones).size !== page.tombstones.length
    || page.tombstones.some(id => page.items.some(item => item.logical_message_id === id))) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
  const result = await store.commitPage(account, { ...request, input_cursor: request.cursor, request_digest,
    page_digest: digest(page), authority_version: capability.authority_version, resource_binding_id: capability.resource_binding_id, page },
    async transaction => { await current(capability, transaction); }, signal);
  await recheck(); return result;
}

/** Mail-specific read/sync policy behind one interface. Content is cached;
 * permission is freshly evaluated before and after every held I/O. This service
 * intentionally owns neither credentials nor Send intent/journal state. */
export class EmailMailboxService {
  constructor(private readonly authority: EmailAuthority, private readonly store: EmailMailboxStore,
    private readonly provider: EmailMailboxProvider, private readonly now = Date.now) {}

  private inputs(actor: EmailOperationActor, scope: EmailScope, signal?: AbortSignal) {
    const host = Object.freeze(ActorSchema.parse(actor)), account = Object.freeze(ScopeSchema.parse(scope));
    this.live(host, signal);
    if (host.user_id !== account.owner_user_id) throw denied();
    return { host, account };
  }
  private live(actor: EmailOperationActor, signal?: AbortSignal, capability?: EmailCapability) {
    signal?.throwIfAborted();
    const now = this.now();
    if (!Number.isFinite(now) || actor.access_expires_at <= now || capability && capability.expires_at <= now) throw denied();
  }
  private async current(actor: EmailOperationActor, scope: EmailScope, operation: EmailOperation, signal?: AbortSignal,
    expected?: EmailCapability, transaction?: unknown): Promise<EmailCapability> {
    this.live(actor, signal, expected);
    const capability = structuredClone(await this.authority.current(actor, scope, operation, transaction, signal));
    this.live(actor, signal, capability);
    if (!sameScope(scope, capability.scope) || !identifier.safeParse(capability.resource_binding_id).success
      || !identifier.safeParse(capability.authority_version).success || !Number.isFinite(capability.expires_at)
      || expected && (expected.authority_version !== capability.authority_version || expected.resource_binding_id !== capability.resource_binding_id)) throw denied();
    return Object.freeze({ ...capability, scope: Object.freeze({ ...capability.scope }) });
  }
  async list(actor: EmailOperationActor, scope: EmailScope, raw: EmailListRequest, signal?: AbortSignal) {
    const { host, account } = this.inputs(actor, scope, signal), request = Object.freeze(ListSchema.parse(raw));
    const capability = await this.current(host, account, 'human_read', signal);
    const page = structuredClone(await this.store.readPage(account, request, signal));
    const items = validateEmailMessageRecords(account, page.items, request.limit);
    if (page.account_id !== account.account_id || !['partial', 'complete'].includes(page.coverage)
      || !['idle', 'queued', 'syncing', 'failed', 'paused'].includes(page.sync_state)
      || !Number.isSafeInteger(page.checkpoint_revision) || page.checkpoint_revision < 0
      || page.next_cursor !== null && !z.string().min(1).max(8192).safeParse(page.next_cursor).success
      || page.exact_total !== null && (!Number.isSafeInteger(page.exact_total) || page.exact_total < items.length || page.coverage !== 'complete')
      || page.observed_at !== null && !z.iso.datetime().safeParse(page.observed_at).success
      || page.fresh_until !== null && !z.iso.datetime().safeParse(page.fresh_until).success
      || page.observed_at !== null && Date.parse(page.observed_at) > this.now()) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
    await this.current(host, account, 'human_read', signal, capability);
    return { account_id: account.account_id, items: items.map(({ logical_message_id, revision, received_at, folders, flags, data }) =>
      ({ logical_message_id, revision, received_at, folders, flags, data })), next_cursor: page.next_cursor,
      freshness: page.observed_at === null ? 'unknown' as const : page.fresh_until !== null && Date.parse(page.fresh_until) > this.now() ? 'fresh' as const : 'stale' as const,
      observed_at: page.observed_at, coverage: page.coverage, count: { returned: items.length, exact_total: page.exact_total },
      sync_state: page.sync_state, checkpoint_revision: page.checkpoint_revision };
  }
  async syncPage(actor: EmailOperationActor, scope: EmailScope, raw: EmailSyncRequest, signal?: AbortSignal): Promise<EmailSyncResult> {
    const { host, account } = this.inputs(actor, scope, signal);
    return syncEmailMailboxPage(account, raw, { store: this.store, provider: this.provider, now: this.now,
      current: (transaction, currentSignal) => this.current(host, account, 'human_sync', currentSignal, undefined, transaction) }, signal);
  }
}
