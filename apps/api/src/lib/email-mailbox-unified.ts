import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import { EmailMailboxError, type EmailActor, type EmailMailboxService } from './email-mailbox-service.js';

const identifier = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Scope = z.strictObject({ org_id: identifier, owner_user_id: identifier });
const MAX_CURSOR_BYTES = 256 * 1024, CURSOR_TTL_MS = 15 * 60_000;
const Request = z.strictObject({ account_ids: z.array(identifier).min(2).max(16).refine(ids => new Set(ids).size === ids.length),
  folder: identifier, cursor: z.string().min(1).max(MAX_CURSOR_BYTES).nullable(), limit: z.number().int().min(1).max(100),
  include_total: z.boolean().optional() });
const Position = z.strictObject({ account_id: identifier, cursor: z.string().min(1).max(8192).nullable(), done: z.boolean(), failed: z.boolean() });
const Cursor = z.strictObject({ version: z.literal(1), expires_at: z.number().finite(), positions: z.array(Position).min(2).max(16) });
type MailboxPage = Awaited<ReturnType<EmailMailboxService['list']>>;
type MailboxItem = MailboxPage['items'][number];
type PositionValue = z.infer<typeof Position>;
export type EmailUnifiedScope = Readonly<z.infer<typeof Scope>>;
export type EmailUnifiedListRequest = Readonly<z.infer<typeof Request>>;
export type EmailUnifiedItem = MailboxItem & { account_id: string };
export type EmailUnifiedAccountStatus = Readonly<{ account_id: string; state: 'available' | 'unavailable' | 'restart_required';
  error: 'access_denied' | 'read_failed' | 'restart_required' | null; freshness: MailboxPage['freshness']; observed_at: string | null;
  coverage: MailboxPage['coverage']; sync_state: MailboxPage['sync_state']; exact_total: number | null; checkpoint_revision: number | null }>;
export type EmailUnifiedPage = Readonly<{ items: EmailUnifiedItem[]; next_cursor: string | null;
  accounts: EmailUnifiedAccountStatus[]; coverage: 'partial' | 'complete'; count: { returned: number; exact_total: number | null };
  restart_required: boolean }>;
/** Host-owned, mandatory final human authority checks after all content I/O.
 * Production checks accounts in canonical order using separate transactions and
 * current connected custody. Each account has its own authorization point;
 * this contract does not promise an atomic cross-account snapshot. */
export type EmailUnifiedFinalizer = (actor: EmailActor, scope: EmailUnifiedScope, healthy_account_ids: readonly string[], signal?: AbortSignal) => Promise<void>;
export class EmailUnifiedMailboxError extends Error {
  constructor(readonly code: 'EMAIL_UNIFIED_PAGE_INVALID' | 'EMAIL_UNIFIED_CURSOR_EXPIRED' | 'EMAIL_UNIFIED_PAGE_CHANGED') { super(code); this.name = 'EmailUnifiedMailboxError'; }
}
const invalid = () => new EmailUnifiedMailboxError('EMAIL_UNIFIED_PAGE_INVALID');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stringOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
// Matches the individual SQL store: date descending (null sorts at epoch), then
// logical ID descending. Account ID ascending makes equal keys deterministic.
const order = (a: EmailUnifiedItem, b: EmailUnifiedItem) => Date.parse(b.received_at ?? '1970-01-01T00:00:00.000Z') - Date.parse(a.received_at ?? '1970-01-01T00:00:00.000Z')
  || -stringOrder(a.logical_message_id, b.logical_message_id) || stringOrder(a.account_id, b.account_id);
const samePrefix = (a: MailboxItem[], b: MailboxItem[]) => a.length === b.length && a.every((item, index) => item.logical_message_id === b[index]?.logical_message_id && item.received_at === b[index]?.received_at);
const unavailable = (account_id: string, error: unknown): EmailUnifiedAccountStatus => ({ account_id, state: 'unavailable',
  error: error instanceof EmailMailboxError && error.code === 'EMAIL_ACCESS_DENIED' ? 'access_denied' : 'read_failed',
  freshness: 'unknown', observed_at: null, coverage: 'partial', sync_state: 'paused', exact_total: null, checkpoint_revision: null });
const available = (page: MailboxPage): EmailUnifiedAccountStatus => ({ account_id: page.account_id, state: 'available', error: null,
  freshness: page.freshness, observed_at: page.observed_at, coverage: page.coverage, sync_state: page.sync_state,
  exact_total: page.count.exact_total, checkpoint_revision: page.checkpoint_revision });

async function boundedMap<T, R>(values: T[], work: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(values.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    for (;;) { const current = index++; if (current >= values.length) return; result[current] = await work(values[current]!, current); }
  })); return result;
}

/** Combines explicitly nominated owner-account caches through the ordinary human
 * list service. A cursor records consumed positions, never permission or cached
 * message contents. Underlying keyset traversal remains weakly consistent as
 * background sync progresses; changes within a held merge are retried safely. */
export class EmailMailboxUnifiedService {
  constructor(private readonly mailboxes: Pick<EmailMailboxService, 'list'>, private readonly crypto: EmailMailboxCrypto,
    private readonly finalize: EmailUnifiedFinalizer, private readonly now: () => number = Date.now) {}

  async list(actor: EmailActor, rawScope: EmailUnifiedScope, raw: EmailUnifiedListRequest, signal?: AbortSignal): Promise<EmailUnifiedPage> {
    const parsedScope = Scope.safeParse(rawScope), parsedRequest = Request.safeParse(raw);
    if (!parsedScope.success || !parsedRequest.success) throw invalid();
    const scope = parsedScope.data, request = parsedRequest.data, ids = [...request.account_ids].sort(stringOrder);
    const live = () => { signal?.throwIfAborted(); if (actor.user_id !== scope.owner_user_id || !Number.isFinite(actor.access_expires_at) || actor.access_expires_at <= this.now()) throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); };
    live();
    const binding = hash([scope.org_id, scope.owner_user_id, ids, request.folder]);
    const context = { ...scope, account_id: 'unified:' + binding, kind: 'checkpoint' as const, record_id: 'unified-list:' + binding, revision: 1 };
    let positions: PositionValue[];
    if (request.cursor === null) positions = ids.map(account_id => ({ account_id, cursor: null, done: false, failed: false }));
    else {
      try {
        if (!/^[A-Za-z0-9_-]+$/u.test(request.cursor)) throw invalid();
        const bytes = Buffer.from(request.cursor, 'base64url'); if (bytes.toString('base64url') !== request.cursor || bytes.byteLength > MAX_CURSOR_BYTES) throw invalid();
        const cursor = Cursor.parse(this.crypto.open(JSON.parse(bytes.toString('utf8')), context));
        if (cursor.expires_at <= this.now()) throw new EmailUnifiedMailboxError('EMAIL_UNIFIED_CURSOR_EXPIRED');
        if (cursor.positions.map(value => value.account_id).join('\0') !== ids.join('\0')) throw invalid(); positions = cursor.positions;
      } catch (error) { if (error instanceof EmailUnifiedMailboxError) throw error; throw invalid(); }
    }
    const original = structuredClone(positions), pages = new Map<string, MailboxPage>(), statuses = new Map<string, EmailUnifiedAccountStatus>();
    const fetch = (position: PositionValue, limit: number) => this.mailboxes.list(actor, { ...scope, account_id: position.account_id },
      { folder: request.folder, cursor: position.cursor, limit, ...(request.include_total===undefined?{}:{include_total:request.include_total}) }, signal);
    await boundedMap(positions, async position => {
      try {
        // Even exhausted streams get a fresh read; done is a traversal position,
        // not authorization. Recovered failed accounts require a new traversal.
        const page = await fetch(position, position.done || position.failed ? 1 : request.limit); live();
        if (page.account_id !== position.account_id || page.items.some((item, index) => index > 0 && order({ ...page.items[index - 1]!, account_id: position.account_id }, { ...item, account_id: position.account_id }) > 0)) throw invalid();
        if (position.failed) statuses.set(position.account_id, { ...available(page), state: 'restart_required', error: 'restart_required', coverage: 'partial', exact_total: null });
        else { statuses.set(position.account_id, available(page)); if (!position.done) pages.set(position.account_id, page); }
      } catch (error) { live(); position.failed = true; statuses.set(position.account_id, unavailable(position.account_id, error)); }
    });
    live();
    const candidates: EmailUnifiedItem[] = [];
    for (const [account_id, page] of pages) for (const item of page.items) candidates.push({ ...item, account_id });
    if (Buffer.byteLength(JSON.stringify(candidates)) > 16 * 1024 * 1024) throw invalid();
    candidates.sort(order); const selected = candidates.slice(0, request.limit), consumed = new Map<string, number>();
    for (const item of selected) consumed.set(item.account_id, (consumed.get(item.account_id) ?? 0) + 1);
    const fenced = new Map<string, MailboxPage>();
    await boundedMap(positions.filter(position => !position.failed), async position => {
      const count = consumed.get(position.account_id) ?? 0;
      try {
        const page = await fetch(original.find(value => value.account_id === position.account_id)!, Math.max(1, count)); live();
        if (page.account_id !== position.account_id) throw invalid();
        const before = pages.get(position.account_id);
        if (count && (!before || !samePrefix(before.items.slice(0, count), page.items))) throw new EmailUnifiedMailboxError('EMAIL_UNIFIED_PAGE_CHANGED');
        if (!count && before && !samePrefix(before.items.slice(0, 1), page.items)) throw new EmailUnifiedMailboxError('EMAIL_UNIFIED_PAGE_CHANGED');
        fenced.set(position.account_id, page); statuses.set(position.account_id, available(page));
        if (count) { position.cursor = page.next_cursor; position.done = page.next_cursor === null; }
        else if (!position.done && before?.items.length === 0 && before.next_cursor === null) position.done = true;
      } catch (error) {
        live(); if (error instanceof EmailUnifiedMailboxError && error.code === 'EMAIL_UNIFIED_PAGE_CHANGED') throw error;
        Object.assign(position, original.find(value => value.account_id === position.account_id)); position.failed = true;
        statuses.set(position.account_id, unavailable(position.account_id, error));
      }
    });
    live();
    const offsets = new Map<string, number>(), items: EmailUnifiedItem[] = [];
    for (const item of selected) {
      const page = fenced.get(item.account_id); if (!page || statuses.get(item.account_id)?.state !== 'available') continue;
      const index = offsets.get(item.account_id) ?? 0; offsets.set(item.account_id, index + 1); items.push({ ...page.items[index]!, account_id: item.account_id });
    }
    const accounts = ids.map(id => statuses.get(id)!), healthy = accounts.every(account => account.state === 'available');
    const coverage = healthy && accounts.every(account => account.coverage === 'complete') ? 'complete' as const : 'partial' as const;
    // Different provider observations are not one global count snapshot. Expose
    // each exact account count and only sum matching stable observations.
    let exact_total: number | null = null;
    if (coverage === 'complete' && accounts.every(account => account.exact_total !== null && account.observed_at !== null && account.observed_at === accounts[0]!.observed_at
      && (!pages.has(account.account_id) || pages.get(account.account_id)!.checkpoint_revision === account.checkpoint_revision))) {
      const sum = accounts.reduce((total, account) => total + account.exact_total!, 0); if (Number.isSafeInteger(sum)) exact_total = sum;
    }
    const hasMore = positions.some(position => !position.done || position.failed); let next_cursor: string | null = null;
    if (hasMore) {
      const envelope = this.crypto.seal({ version: 1, expires_at: this.now() + CURSOR_TTL_MS, positions }, context);
      next_cursor = Buffer.from(JSON.stringify(envelope)).toString('base64url'); if (next_cursor.length > MAX_CURSOR_BYTES) throw invalid();
    }
    const result = { items, accounts, next_cursor, coverage, count: { returned: items.length, exact_total }, restart_required: accounts.some(account => account.state === 'restart_required') };
    // All list/cache I/O and cursor encryption happen before this fence. Its
    // failure rejects the whole held page; no content or cursor is published.
    await this.finalize(actor, scope, accounts.filter(account => account.state === 'available').map(account => account.account_id), signal);
    live(); return result;
  }
}
