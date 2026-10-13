import { EmailOperationActorSchema } from './email-agent-actor.js';
import { createHash } from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
import { z } from 'zod';
import { NativeEmailSearchPageSchema, type NativeEmailSearchPage } from './app-connection-contract.js';
import { EmailMailboxError, validateEmailMessageRecords, type EmailOperationActor, type EmailAuthority, type EmailCapability, type EmailMessageRecord, type EmailScope } from './email-mailbox-service.js';
import type { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import {profileEmailSearchPhase} from './email-search-diagnostics.js';

const Identifier = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Scope = z.strictObject({ org_id: Identifier, owner_user_id: Identifier, account_id: Identifier });
const Actor = EmailOperationActorSchema;
const Request = z.strictObject({ query: z.string().min(1).max(2048).refine(value => value.trim().length > 0
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)), limit: z.number().int().min(1).max(100), cursor: z.string().min(1).max(8192).nullable().optional() });
const Unsupported = z.array(z.strictObject({ index: z.number().int().min(0).nullable(), field: z.string().max(128).nullable(), reason: z.string().min(1).max(128) })).max(32);
const Cursor = z.strictObject({ schema_version: z.literal('deft.email.search_cursor.v1'), query_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  original_query: Request.shape.query, limit: Request.shape.limit, provider: z.enum(['gmail', 'microsoft', 'imap_smtp']), resource_binding_id: Identifier,
  authority_version: Identifier, continuation: z.string().min(1).max(8192), expires_at: z.number().finite(), failures:z.number().int().min(0).max(100000) });
const MAX_CURSOR_BYTES = 8192, CURSOR_TTL_MS = 15 * 60_000;

export type EmailSearchRequest = Readonly<z.infer<typeof Request>>;
type EmailSearchUnsupported = ReadonlyArray<z.infer<typeof Unsupported>[number]>;
type EmailSearchHit = Readonly<Pick<EmailMessageRecord, 'logical_message_id' | 'revision' | 'received_at'> & {
  folders: ReadonlyArray<string>; flags: Readonly<EmailMessageRecord['flags']>; data: Readonly<EmailMessageRecord['data']>;
}>;
export type EmailSearchProviderPage = NativeEmailSearchPage;
export type EmailSearchResult = Readonly<{
  account_id: string; query: string; source: 'provider'; coverage: 'complete' | 'partial';
  complete: boolean; exact_total: null; observed_at: string | null; next_cursor: string | null;
  provider_result_cap: null | 1000; limitations: ReadonlyArray<string>; failure_count: number; query_complete: boolean;
  unsupported: EmailSearchUnsupported;
  items: ReadonlyArray<EmailSearchHit>;
}> | Readonly<{ account_id: string; query: string; source: 'provider'; coverage: 'partial'; complete: false; exact_total: null;
  observed_at: null; next_cursor: null; provider_result_cap: null | 1000; limitations: ReadonlyArray<string>; failure_count: 0;
  query_complete: false; unsupported: EmailSearchUnsupported; items: ReadonlyArray<EmailSearchHit> }>;

export class EmailMailboxSearchError extends Error {
  constructor(readonly code: 'EMAIL_ACCESS_DENIED' | 'EMAIL_SEARCH_INVALID' | 'EMAIL_SEARCH_CURSOR_INVALID' | 'EMAIL_SEARCH_UNAVAILABLE') {
    super(code); this.name = 'EmailMailboxSearchError';
  }
}
const denied = () => new EmailMailboxSearchError('EMAIL_ACCESS_DENIED');
const sameScope = (left: EmailScope, right: EmailScope) => left.org_id === right.org_id
  && left.owner_user_id === right.owner_user_id && left.account_id === right.account_id;
const queryDigest = (query: string) => createHash('sha256').update(query, 'utf8').digest('hex');
const envelopeContext = (scope: EmailScope, query: string) => ({ ...scope, kind: 'checkpoint' as const,
  record_id: `search:${queryDigest(query)}`, revision: 1 });

/** This persistence port must atomically make provider hits readable from the
 * normal account cache and invoke guard in that same transaction before commit.
 * Until a production store implements it, this service must not be wired to a route. */
export type EmailMailboxSearchStore = Readonly<{
  persistSearchResults(scope: EmailScope, records: readonly EmailMessageRecord[],
    guard: (transaction: unknown) => Promise<void>, signal?: AbortSignal): Promise<Readonly<{
      records: readonly EmailMessageRecord[]; dropped: number;
    }>>;
}>;
/** Registered adapter owns query parsing, provider compilation and continuation
 * validation. The original human query is passed unchanged; browser code never
 * supplies executable ASTs or raw provider cursors. */
export type EmailMailboxSearchProvider = Readonly<{
  readSearch(scope: EmailScope, input: { query: string; cursor: string | null; limit: number }, capability: EmailCapability,
    recheck: () => Promise<void>, signal?: AbortSignal): Promise<EmailSearchProviderPage>;
}>;

function visible(record: EmailMessageRecord) {
  const { logical_message_id, revision, received_at, folders, flags, data } = record;
  return Object.freeze({ logical_message_id, revision, received_at, folders: Object.freeze([...folders]), flags: Object.freeze({ ...flags }), data: Object.freeze({ ...data }) });
}

export class EmailMailboxSearchService {
  constructor(private readonly authority: EmailAuthority, private readonly store: EmailMailboxSearchStore,
    private readonly provider: EmailMailboxSearchProvider, private readonly crypto: EmailMailboxCrypto,
    private readonly now = Date.now) {}

  private async current(actor: EmailOperationActor, scope: EmailScope, expected?: EmailCapability, signal?: AbortSignal): Promise<EmailCapability> {
    signal?.throwIfAborted(); const before = this.now();
    if (!Number.isFinite(before) || actor.access_expires_at <= before) throw denied();
    let capability: EmailCapability;
    try { capability = structuredClone(await profileEmailSearchPhase('authority_connected',()=>this.authority.current(actor, scope, 'human_read', undefined, signal))); }
    catch (error) { if (signal?.aborted) throw error; throw denied(); }
    signal?.throwIfAborted(); const after = this.now();
    if (!Number.isFinite(after) || !Number.isFinite(capability.expires_at) || capability.expires_at <= after
      || !Scope.safeParse(capability.scope).success || !sameScope(scope, capability.scope)
      || !Identifier.safeParse(capability.resource_binding_id).success || !Identifier.safeParse(capability.authority_version).success
      || expected && (capability.authority_version !== expected.authority_version
        || capability.resource_binding_id !== expected.resource_binding_id)) throw denied();
    return capability;
  }

  async search(rawActor: EmailOperationActor, rawScope: EmailScope, rawRequest: EmailSearchRequest, signal?: AbortSignal): Promise<EmailSearchResult> {
    const actor = Object.freeze(Actor.parse(rawActor)), scope = Object.freeze(Scope.parse(rawScope));
    const parsed = Request.safeParse(rawRequest); if (!parsed.success) throw new EmailMailboxSearchError('EMAIL_SEARCH_INVALID');
    const request = parsed.data;
    if (actor.user_id !== scope.owner_user_id) throw denied();
    let capability: EmailCapability;
    try { capability = await this.current(actor, scope, undefined, signal); }
    catch (error) { if (error instanceof EmailMailboxSearchError) throw error; if (signal?.aborted) throw error; throw denied(); }
    let continuation: string | null = null, cursorProvider: string | null = null,failures=0;
    if (request.cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/u.test(request.cursor)) throw new Error('encoding');
        const raw = Buffer.from(request.cursor, 'base64url');
        if (raw.toString('base64url') !== request.cursor || raw.byteLength > MAX_CURSOR_BYTES) throw new Error('encoding');
        const decoded = Cursor.parse(this.crypto.open(JSON.parse(raw.toString('utf8')), envelopeContext(scope, request.query)));
        if (decoded.query_digest !== queryDigest(request.query) || decoded.original_query !== request.query || decoded.limit !== request.limit
          || decoded.resource_binding_id !== capability.resource_binding_id || decoded.authority_version !== capability.authority_version
          || !Number.isFinite(this.now()) || decoded.expires_at <= this.now() || decoded.expires_at > capability.expires_at) throw new Error('binding');
        continuation = decoded.continuation; cursorProvider = decoded.provider;failures=decoded.failures;
      } catch { throw new EmailMailboxSearchError('EMAIL_SEARCH_CURSOR_INVALID'); }
    }
    const recheck = async () => { await this.current(actor, scope, capability, signal); };
    let rawPage: EmailSearchProviderPage;
    try {
      rawPage = NativeEmailSearchPageSchema.parse(await profileEmailSearchPhase('provider',()=>this.provider.readSearch(
        scope, { query: request.query, cursor: continuation, limit: request.limit }, capability, recheck, signal)));
    }
    catch (error) { if (signal?.aborted) throw error; if (error instanceof EmailMailboxSearchError || error instanceof EmailMailboxError) throw error; throw new EmailMailboxSearchError('EMAIL_SEARCH_UNAVAILABLE'); }
    await recheck();
    if (rawPage?.status === 'unsupported') {
      const unsupported = Unsupported.safeParse(rawPage.unsupported);
      if (!unsupported.success || unsupported.data.length === 0 || rawPage.schema_version !== 'deft.email_search_page.v1'
        || rawPage.account_id !== scope.account_id || rawPage.original_query !== request.query || !Array.isArray(rawPage.items)
        || rawPage.items.length !== 0 || rawPage.next_cursor !== null || rawPage.has_more !== false
        || rawPage.query_complete !== false || rawPage.failure_count !== 0 || !Array.isArray(rawPage.limitations)
        || cursorProvider !== null && rawPage.provider !== cursorProvider)
        throw new EmailMailboxSearchError('EMAIL_SEARCH_UNAVAILABLE');
      return Object.freeze({ account_id: scope.account_id, query: request.query, source: 'provider', coverage: 'partial', complete: false,
        exact_total: null, observed_at: rawPage.observed_at, next_cursor: null, provider_result_cap: rawPage.provider_result_cap,
        limitations: Object.freeze([...rawPage.limitations]), failure_count: 0, query_complete: false,
        unsupported: Object.freeze(unsupported.data.map(value => Object.freeze(value))), items: Object.freeze([]) });
    }
    if (!rawPage || rawPage.schema_version !== 'deft.email_search_page.v1' || rawPage.status !== 'supported'
      || !Array.isArray(rawPage.items) || !Array.isArray(rawPage.unsupported)
      || rawPage.account_id !== scope.account_id || rawPage.original_query !== request.query
      || !['gmail', 'microsoft', 'imap_smtp'].includes(rawPage.provider) || cursorProvider !== null && cursorProvider !== rawPage.provider
      || rawPage.items.length > request.limit || rawPage.unsupported.length !== 0
      || !z.iso.datetime().safeParse(rawPage.observed_at).success || Date.parse(rawPage.observed_at) > this.now()
      || !Number.isSafeInteger(rawPage.failure_count) || rawPage.failure_count < 0 || rawPage.failure_count > 100_000
      || rawPage.provider_result_cap !== null && rawPage.provider_result_cap !== 1000
      || !Array.isArray(rawPage.limitations) || rawPage.limitations.length > 32 || rawPage.limitations.some(value => typeof value !== 'string' || value.length > 128)
      || typeof rawPage.has_more !== 'boolean' || typeof rawPage.query_complete !== 'boolean'
      || rawPage.has_more !== (rawPage.next_cursor !== null)
      || rawPage.next_cursor !== null && (typeof rawPage.next_cursor !== 'string' || rawPage.next_cursor.length < 1 || rawPage.next_cursor.length > 8192))
      throw new EmailMailboxSearchError('EMAIL_SEARCH_UNAVAILABLE');
    let items: EmailMessageRecord[];
    try { items = validateEmailMessageRecords(scope, rawPage.items, request.limit); }
    catch { throw new EmailMailboxSearchError('EMAIL_SEARCH_UNAVAILABLE'); }
    let accepted: Readonly<{ records: readonly EmailMessageRecord[]; dropped: number }> = { records: [], dropped: 0 };
    if (items.length) {
      try {
        accepted = await profileEmailSearchPhase('persist',()=>this.store.persistSearchResults(scope, items, async transaction => {
          let current: EmailCapability;
          try { current = await profileEmailSearchPhase('authority_connected',()=>this.authority.current(actor, scope, 'human_read', transaction, signal)); }
          catch (error) { if (signal?.aborted) throw error; throw denied(); }
        if (!sameScope(scope, current.scope) || current.resource_binding_id !== capability.resource_binding_id
          || current.authority_version !== capability.authority_version || !Number.isFinite(current.expires_at)
          || current.expires_at <= this.now()) throw denied();
        }, signal));
      } catch (error) {
        if (signal?.aborted || error instanceof EmailMailboxSearchError || error instanceof EmailMailboxError) throw error;
        throw new EmailMailboxSearchError('EMAIL_SEARCH_UNAVAILABLE');
      }
    }
    await recheck();
    let persisted: EmailMessageRecord[];
    try { persisted = validateEmailMessageRecords(scope, accepted.records, request.limit); }
    catch { throw new EmailMailboxSearchError('EMAIL_SEARCH_UNAVAILABLE'); }
    const inputIds = new Set(items.map(item => item.logical_message_id));
    if (!Number.isSafeInteger(accepted.dropped) || accepted.dropped < 0
      || accepted.dropped !== items.length - persisted.length
      || persisted.some(record => !inputIds.has(record.logical_message_id)&&!(rawPage.provider==='imap_smtp'&&record.provider_source.provider==='imap_smtp'
        &&items.some(item=>item.provider_source.provider==='imap_smtp'&&canonicalCapabilityJson(item.provider_source.locator)===canonicalCapabilityJson(record.provider_source.locator))))) throw new EmailMailboxSearchError('EMAIL_SEARCH_UNAVAILABLE');
    failures+=rawPage.failure_count+accepted.dropped;if(failures>100000)throw new EmailMailboxSearchError('EMAIL_SEARCH_UNAVAILABLE');
    let next_cursor: string | null = null;
    if (rawPage.has_more && rawPage.next_cursor !== null) {
      const now = this.now(); if (!Number.isFinite(now)) throw denied();
      const envelope = this.crypto.seal(Cursor.parse({ schema_version: 'deft.email.search_cursor.v1', query_digest: queryDigest(request.query),
        original_query: request.query, limit: request.limit, provider: rawPage.provider, resource_binding_id: capability.resource_binding_id,
        authority_version: capability.authority_version, continuation: rawPage.next_cursor, expires_at: Math.min(capability.expires_at, now + CURSOR_TTL_MS),failures }),
      envelopeContext(scope, request.query));
      next_cursor = Buffer.from(JSON.stringify(envelope)).toString('base64url');
      if (next_cursor.length > MAX_CURSOR_BYTES) throw new EmailMailboxSearchError('EMAIL_SEARCH_UNAVAILABLE');
    }
    await recheck();
    const complete = rawPage.query_complete && !rawPage.has_more && failures === 0;
    return Object.freeze({ account_id: scope.account_id, query: request.query, source: 'provider', coverage: complete ? 'complete' : 'partial',
      complete, exact_total: null, observed_at: rawPage.observed_at, next_cursor, provider_result_cap: rawPage.provider_result_cap,
      limitations: Object.freeze([...rawPage.limitations]), failure_count: failures, query_complete: rawPage.query_complete&&failures===0,
      unsupported: Object.freeze([]) as readonly [], items: Object.freeze(persisted.map(visible)) });
  }
}
