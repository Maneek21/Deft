import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailMailboxService, EmailMailboxError, type EmailMailboxStore, type EmailMessageRecord, type EmailActor, type EmailAuthority } from '../src/lib/email-mailbox-service.js';
import { EmailMailboxUnifiedService, EmailUnifiedMailboxError } from '../src/lib/email-mailbox-unified.js';

const actor: EmailActor = { user_id: 'owner', web_session_id: 'sid', access_expires_at: 2000000 }, scope = { org_id: 'org', owner_user_id: 'owner' };
const mail = (account: string, hex: string, day: number | null): EmailMessageRecord => ({ account_id: account, logical_message_id: 'mail_' + hex.repeat(64), revision: 'rev',
  received_at: day === null ? null : `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`, folders: ['inbox'], flags: { seen: false, flagged: false, answered: false },
  data: { subject: account + hex }, provider_source: { private: true } });
const id = (account: string, hex: string) => account + ':' + 'mail_' + hex.repeat(64);
function fixture() {
  let time = 1000000, active = 0, maxActive = 0;
  const messages = new Map([['A', [mail('A', 'f', 4), mail('A', 'a', 3), mail('A', '9', null), mail('A', '1', null)]],
    ['B', [mail('B', 'e', 4), mail('B', 'b', 3), mail('B', '8', 2), mail('B', '0', null)]],
    ['C', [mail('C', 'd', 4), mail('C', 'b', 3), mail('C', '7', 1), mail('C', '2', null)]]]);
  const revoked = new Set<string>(), failed = new Set<string>(), observations = new Map<string, string>(), calls: { account: string; limit: number; include_total?:boolean }[] = [];
  let hook: ((account: string, call: number) => void) | null = null;
  const authority: EmailAuthority = { async current(human, selected) {
    if (human.user_id !== 'owner' || human.web_session_id !== 'sid' || selected.org_id !== 'org' || selected.owner_user_id !== 'owner' || !messages.has(selected.account_id) || revoked.has(selected.account_id)) throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    return { scope: selected, resource_binding_id: 'binding-' + selected.account_id, authority_version: 'v1', expires_at: actor.access_expires_at };
  } };
  const store = { async readPage(selected: { account_id: string }, request: { cursor: string | null; limit: number; folder: string; include_total?:boolean }) {
    active++; maxActive = Math.max(maxActive, active); calls.push({ account: selected.account_id, limit: request.limit,include_total:request.include_total });
    try {
      await new Promise(resolve => setTimeout(resolve, 1)); hook?.(selected.account_id, calls.filter(call => call.account === selected.account_id).length);
      if (failed.has(selected.account_id)) throw Error('Synthetic cache unavailable');
      const all = messages.get(selected.account_id)!, after = request.cursor ? JSON.parse(request.cursor) as { id: string; date: string | null } : null;
      const rows = after ? all.filter(row => Date.parse(row.received_at ?? '1970-01-01T00:00:00.000Z') < Date.parse(after.date ?? '1970-01-01T00:00:00.000Z') || row.received_at === after.date && row.logical_message_id < after.id) : all;
      const items = rows.slice(0, request.limit), last = items.at(-1);
      return { account_id: selected.account_id, items: structuredClone(items), next_cursor: rows.length > request.limit && last ? JSON.stringify({ id: last.logical_message_id, date: last.received_at }) : null,
        observed_at: observations.get(selected.account_id) ?? '1970-01-01T00:00:01.000Z', fresh_until: '1970-01-01T01:00:00.000Z', coverage: 'complete', exact_total: request.include_total===false?null:all.length, sync_state: 'idle', checkpoint_revision: 1 };
    } finally { active--; }
  } } as unknown as EmailMailboxStore;
  const crypto = new EmailMailboxCrypto({ current: () => ({ key_id: 'unified-test', key: Buffer.alloc(32, 41) }), read: (_purpose: unknown, key_id: string) => key_id === 'unified-test' ? { key_id, key: Buffer.alloc(32, 41) } : null, keyIds: () => ['unified-test'] });
  const individual = new EmailMailboxService(authority, store, { async readPage() { throw Error('No provider sync'); } }, () => time);
  const fences: string[][] = [];
  const unified = new EmailMailboxUnifiedService(individual, crypto, async (human, ownerScope, ids) => {
    fences.push([...ids]); assert.deepEqual([...ids], [...ids].sort());
    for (const account_id of ids) await authority.current(human, { ...ownerScope, account_id }, 'human_read');
  }, () => time);
  const list = (cursor: string | null = null, accounts = ['A', 'B', 'C'], limit = 3) => unified.list(actor, scope, { account_ids: accounts, folder: 'inbox', cursor, limit });
  return { messages, revoked, failed, observations, calls, fences, unified, list, get maxActive() { return maxActive; }, set hook(value: typeof hook) { hook = value; }, advance(ms: number) { time += ms; } };
}

test('unified public service merges three accounts through four pages with independent tie oracle and no leftovers skipped', async () => {
  const f = fixture(), expected = [id('A', 'f'), id('B', 'e'), id('C', 'd'), id('B', 'b'), id('C', 'b'), id('A', 'a'), id('B', '8'), id('C', '7'), id('A', '9'), id('C', '2'), id('A', '1'), id('B', '0')];
  const actual: string[] = []; let cursor: string | null = null, pages = 0;
  do {
    const before = f.calls.length, page = await f.list(cursor, pages % 2 ? ['C', 'A', 'B'] : ['A', 'B', 'C']); pages++;
    assert.ok(f.calls.length - before <= 6); assert.ok(f.maxActive <= 4); assert.equal(page.coverage, 'complete'); assert.equal(page.count.exact_total, 12);
    for (const item of page.items) { actual.push(item.account_id + ':' + item.logical_message_id); assert.equal(Object.hasOwn(item, 'provider_source'), false); }
    cursor = page.next_cursor; if (cursor) { assert.equal(Buffer.from(cursor, 'base64url').toString().includes('mail_'), false); assert.equal(Buffer.from(cursor, 'base64url').toString().includes('subject'), false); }
  } while (cursor && pages < 10);
  assert.equal(pages, 4); assert.deepEqual(actual, expected); assert.equal(cursor, null);
});

test('unified count omission reaches initial and fenced reads across continuation without weakening coverage or final authority',async()=>{
  const f=fixture();let cursor:string|null=null;
  for(let n=0;n<2;n++){
    const page=await f.unified.list(actor,scope,{account_ids:['A','B','C'],folder:'inbox',cursor,limit:3,include_total:false});
    assert.equal(page.coverage,'complete');assert.equal(page.count.exact_total,null);assert.equal(page.items.length,3);
    assert.ok(page.accounts.every(account=>account.exact_total===null));assert.deepEqual(f.fences.at(-1),['A','B','C']);
    cursor=page.next_cursor;assert.ok(cursor);
  }
  assert.equal(f.calls.length,12);assert.ok(f.calls.every(call=>call.include_total===false));
});

test('revocation between pages removes that account without exposing buffered content or inventing a total', async () => {
  const f = fixture(), first = await f.list(); f.revoked.add('B'); const next = await f.list(first.next_cursor);
  assert.ok(next.items.every(item => item.account_id !== 'B')); assert.equal(next.coverage, 'partial'); assert.equal(next.count.exact_total, null);
  assert.deepEqual(next.accounts.find(account => account.account_id === 'B'), { account_id: 'B', state: 'unavailable', error: 'access_denied', freshness: 'unknown', observed_at: null, coverage: 'partial', sync_state: 'paused', exact_total: null, checkpoint_revision: null });
});

test('a failure stays independent and recovery asks for fresh traversal before restoring newer messages', async () => {
  const f = fixture(); f.failed.add('B'); const partial = await f.list(); assert.equal(partial.coverage, 'partial'); assert.equal(partial.count.exact_total, null);
  assert.ok(partial.items.every(item => item.account_id !== 'B')); f.failed.delete('B'); const recovered = await f.list(partial.next_cursor);
  assert.equal(recovered.restart_required, true); assert.equal(recovered.accounts.find(account => account.account_id === 'B')!.state, 'restart_required'); assert.ok(recovered.items.every(item => item.account_id !== 'B'));
  const refreshed = await f.list(); assert.equal(refreshed.restart_required, false); assert.ok(refreshed.items.some(item => item.account_id === 'B'));
});

test('final fresh read strips an account revoked during another account read and retains its old consumed position', async () => {
  const f = fixture(); f.hook = (account, count) => { if (account === 'B' && count === 2) f.revoked.add('B'); };
  const page = await f.list(); assert.ok(page.items.every(item => item.account_id !== 'B')); assert.equal(page.count.exact_total, null);
  f.hook = null; f.revoked.delete('B'); const next = await f.list(page.next_cursor); assert.equal(next.restart_required, true); assert.ok(next.items.every(item => item.account_id !== 'B'));
});

test('a deleted selected prefix produces recoverable conflict, while checkpoint-independent later pages remain keyset based', async () => {
  const f = fixture(); f.hook = (account, count) => { if (account === 'A' && count === 2) f.messages.get('A')!.shift(); };
  await assert.rejects(f.list(), (error: unknown) => error instanceof EmailUnifiedMailboxError && error.code === 'EMAIL_UNIFIED_PAGE_CHANGED');
  f.hook = null; const fresh = await f.list(); assert.ok(fresh.items.every(item => item.logical_message_id !== 'mail_' + 'f'.repeat(64)));
});

test('cursor binds owner/org/account set/folder, rejects tamper/expiry and permits reordered account input', async () => {
  const f = fixture(), page = await f.list(); await f.list(page.next_cursor, ['B', 'C', 'A']);
  await assert.rejects(f.list(page.next_cursor, ['A', 'B']), /EMAIL_UNIFIED_PAGE_INVALID/);
  await assert.rejects(f.unified.list(actor, { ...scope, org_id: 'another' }, { account_ids: ['A', 'B', 'C'], folder: 'inbox', cursor: page.next_cursor, limit: 3 }), /EMAIL_UNIFIED_PAGE_INVALID/);
  await assert.rejects(f.unified.list(actor, scope, { account_ids: ['A', 'B', 'C'], folder: 'sent', cursor: page.next_cursor, limit: 3 }), /EMAIL_UNIFIED_PAGE_INVALID/);
  const token = page.next_cursor!, bad = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'BB' : 'AA'); await assert.rejects(f.list(bad), /EMAIL_UNIFIED_PAGE_INVALID/);
  f.advance(900001); await assert.rejects(f.list(page.next_cursor), /EMAIL_UNIFIED_CURSOR_EXPIRED/);
});

test('aggregate exact count is withheld for different observations and account bounds are enforced', async () => {
  const f = fixture(); f.observations.set('B', '1970-01-01T00:00:02.000Z'); const page = await f.list(); assert.equal(page.count.exact_total, null); assert.equal(page.accounts.find(account => account.account_id === 'B')!.exact_total, 4);
  await assert.rejects(f.list(null, ['A', 'A']), /EMAIL_UNIFIED_PAGE_INVALID/); await assert.rejects(f.list(null, Array.from({ length: 17 }, (_, index) => String(index))), /EMAIL_UNIFIED_PAGE_INVALID/);
});

test('an initially empty unconsumed account becoming nonempty during final fence requires retry', async () => {
  const f = fixture(); f.messages.set('C', []); f.hook = (account, count) => { if (account === 'C' && count === 2) f.messages.set('C', [mail('C', 'f', 9)]); };
  await assert.rejects(f.list(), (error: unknown) => error instanceof EmailUnifiedMailboxError && error.code === 'EMAIL_UNIFIED_PAGE_CHANGED');
});

test('mandatory aggregate fence rejects A revoked while B final cache I/O is held after A completed', async () => {
  const f = fixture(); f.hook = (account, count) => { if (account === 'B' && count === 2) f.revoked.add('A'); };
  await assert.rejects(f.list(), (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_ACCESS_DENIED');
  assert.deepEqual(f.fences.at(-1), ['A', 'B', 'C']);
});

test('sixteen-account merge uses two list calls per account and at most four concurrent cache reads', async () => {
  const f = fixture(), accounts = ['A', 'B', 'C'];
  for (let index = 0; index < 13; index++) { const name = 'extra-' + index; accounts.push(name); f.messages.set(name, [mail(name, 'c', 4)]); }
  const page = await f.list(null, accounts, 1); assert.equal(page.items.length, 1); assert.equal(f.calls.length, 32); assert.equal(f.maxActive, 4); assert.deepEqual(f.fences.at(-1), [...accounts].sort());
});
