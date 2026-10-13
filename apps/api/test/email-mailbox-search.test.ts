import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailMailboxSearchError, EmailMailboxSearchService } from '../src/lib/email-mailbox-search.js';
import type { EmailCapability, EmailMessageRecord, EmailScope } from '../src/lib/email-mailbox-service.js';
import {createEmailSearchDiagnostics,profileEmailSearchPhase} from '../src/lib/email-search-diagnostics.js';

const scope: EmailScope = { org_id: 'org-search-fixture', owner_user_id: 'owner-search-fixture', account_id: 'account-search-fixture' };
const actor = { user_id: scope.owner_user_id, web_session_id: 'sid-search-fixture', access_expires_at: 2_000_000_000_000 };
const capability: EmailCapability = { scope, resource_binding_id: 'binding-search-fixture', authority_version: 'v1', expires_at: 2_000_000_000_000 };
const record = (hex = 'a'): EmailMessageRecord => ({ account_id: scope.account_id, logical_message_id: 'mail_' + hex.repeat(64), revision: 'rev-1',
  received_at: '2026-10-04T12:00:00.000Z', folders: ['inbox'], flags: { seen: false, flagged: false, answered: false },
  data: { subject: 'Fixture result' }, provider_source: { schema_version: 'deft.email_provider_source.v1', account_id: scope.account_id,
    logical_message_id: 'mail_' + hex.repeat(64), provider: 'gmail', thread_id: 'private-thread', message_id: 'private-message' } });
function crypto() {
  return new EmailMailboxCrypto({ current: () => ({ key_id: 'search-fixture-key', key: Buffer.alloc(32, 83) }),
    read: (_purpose, keyId) => keyId === 'search-fixture-key' ? { key_id: keyId, key: Buffer.alloc(32, 83) } : null,
    keyIds: () => ['search-fixture-key'] });
}
function fixture(options: { denyAt?: number; mutateCapability?: (value: EmailCapability) => EmailCapability;
  page?: any; stored?: (items: readonly EmailMessageRecord[]) => Readonly<{ records: readonly EmailMessageRecord[]; dropped: number }> } = {}) {
  let now = Date.parse('2026-10-05T00:00:00.000Z'), authorityCalls = 0, persistCalls = 0, providerCalls = 0;
  let authorityVersion = 'v1';
  const seen: { query: string; cursor: string | null; limit: number }[] = [];
  const authority = { async current(_actor: unknown, selected: EmailScope, operation: string, _tx?: unknown) {
    assert.equal(operation, 'human_read'); if (++authorityCalls === options.denyAt) throw Error('revoked');
    const value = { ...capability, authority_version: authorityVersion, scope: selected };
    return options.mutateCapability ? options.mutateCapability(value) : value;
  } };
  const provider = { async readSearch(_scope: EmailScope, input: { query: string; cursor: string | null; limit: number }, _cap: EmailCapability,
    _recheck: () => Promise<void>) {
    providerCalls++; seen.push(input);
    return options.page ?? { schema_version: 'deft.email_search_page.v1', status: 'supported', account_id: scope.account_id, provider: 'gmail', original_query: input.query,
      items: [record()], next_cursor: null, has_more: false, query_complete: true, provider_result_cap: null, limitations: [], failure_count: 0,
      observed_at: '2026-10-04T12:00:00.000Z', unsupported: [] };
  } };
  const store = { async persistSearchResults(_scope: EmailScope, items: readonly EmailMessageRecord[], guard: (tx: unknown) => Promise<void>) {
    persistCalls++; await guard({ tx: 'fixture' }); return options.stored ? options.stored(items) : { records: items, dropped: 0 };
  } };
  return { service: new EmailMailboxSearchService(authority as any, store as any, provider as any, crypto(), () => now), seen,
    get counts() { return { authorityCalls, persistCalls, providerCalls }; }, advance(ms: number) { now += ms; },
    setAuthorityVersion(value: string) { authorityVersion = value; } };
}

test('M29 actual search active/inactive phases preserve zero/21/partial results and every final authority fence',async()=>{
 for(const count of [0,21]){
  const items=Array.from({length:count},(_,i)=>{const r=record();const id='mail_'+i.toString(16).padStart(64,'0');return {...r,logical_message_id:id,provider_source:{...r.provider_source,logical_message_id:id,message_id:'private-'+i}};});
  const page={schema_version:'deft.email_search_page.v1',status:'supported',account_id:scope.account_id,provider:'gmail',original_query:'private exact query',items,next_cursor:null,has_more:false,query_complete:true,provider_result_cap:null,limitations:[],failure_count:0,observed_at:'2026-10-04T12:00:00.000Z',unsupported:[]};
  for(const drop of [false,true]){
   const options={page,...(drop?{stored:(rows:readonly EmailMessageRecord[])=>({records:rows.slice(1),dropped:rows.length?1:0})}:{})},off=fixture(options),on=fixture(options),reports:any[]=[];
   const c=createEmailSearchDiagnostics({enabled:()=>true,emit:r=>reports.push(r)});
   const expected=await off.service.search(actor,scope,{query:page.original_query,limit:50});
   const actual=await c.run(scope.account_id,()=>profileEmailSearchPhase('search',()=>on.service.search(actor,scope,{query:page.original_query,limit:50})));
   assert.deepEqual(actual,expected);assert.deepEqual(on.counts,off.counts);assert.deepEqual(on.seen,off.seen);
   const intervals=reports[0].intervals;assert.equal(intervals.filter((r:any)=>r.phase==='provider').length,1);assert.equal(intervals.filter((r:any)=>r.phase==='persist').length,count?1:0);assert.equal(intervals.filter((r:any)=>r.phase==='authority_connected').length,on.counts.authorityCalls);
  }
 }
 for(const denyAt of [2,3,5]){const off=fixture({denyAt}),on=fixture({denyAt}),reports:any[]=[];const c=createEmailSearchDiagnostics({enabled:()=>true,emit:r=>reports.push(r)});
  await assert.rejects(off.service.search(actor,scope,{query:'private exact query',limit:25}),e=>e instanceof EmailMailboxSearchError&&e.code==='EMAIL_ACCESS_DENIED');
  await assert.rejects(c.run(scope.account_id,()=>on.service.search(actor,scope,{query:'private exact query',limit:25})),e=>e instanceof EmailMailboxSearchError&&e.code==='EMAIL_ACCESS_DENIED');assert.deepEqual(on.counts,off.counts);assert.equal(reports[0].outcome,'error');
 }
});

test('preserves original query, persists readable records under transaction authority, and omits provider source', async () => {
  const f = fixture(), query = 'from:"Álice@example.test" after:2026-10-01';
  const result = await f.service.search(actor, scope, { query, limit: 25 });
  assert.equal(f.seen[0]?.query, query); assert.equal(f.seen[0]?.cursor, null);
  assert.equal(result.source, 'provider'); assert.equal(result.coverage, 'complete'); assert.equal(result.exact_total, null);
  assert.deepEqual(result.items[0]?.logical_message_id, record().logical_message_id);
  assert.equal(Object.hasOwn(result.items[0]!, 'provider_source'), false);
  assert.equal(f.counts.persistCalls, 1); assert.ok(f.counts.authorityCalls >= 4);
});

test('encrypts opaque provider continuation and binds it to account, exact query, authority and expiry', async () => {
  const f = fixture({ page: { schema_version: 'deft.email_search_page.v1', status: 'supported', account_id: scope.account_id, provider: 'gmail', original_query: 'subject:invoice',
    items: [record()], next_cursor: 'provider-secret-cursor', has_more: true, query_complete: false, provider_result_cap: null, limitations: [], failure_count: 0,
    observed_at: '2026-10-04T12:00:00.000Z', unsupported: [] } });
  const first = await f.service.search(actor, scope, { query: 'subject:invoice', limit: 10 });
  assert.ok(first.next_cursor); assert.equal(first.next_cursor!.includes('provider-secret-cursor'), false);
  await f.service.search(actor, scope, { query: 'subject:invoice', limit: 10, cursor: first.next_cursor });
  assert.equal(f.seen[1]?.cursor, 'provider-secret-cursor');
  await assert.rejects(f.service.search(actor, { ...scope, account_id: 'other-account' }, { query: 'subject:invoice', limit: 10, cursor: first.next_cursor }),
    error => error instanceof EmailMailboxSearchError && error.code === 'EMAIL_SEARCH_CURSOR_INVALID');
  await assert.rejects(f.service.search(actor, scope, { query: 'subject:receipt', limit: 10, cursor: first.next_cursor }),
    error => error instanceof EmailMailboxSearchError && error.code === 'EMAIL_SEARCH_CURSOR_INVALID');
  await assert.rejects(f.service.search(actor, scope, { query: 'subject:invoice', limit: 11, cursor: first.next_cursor }),
    error => error instanceof EmailMailboxSearchError && error.code === 'EMAIL_SEARCH_CURSOR_INVALID');
  f.setAuthorityVersion('v2');
  await assert.rejects(f.service.search(actor, scope, { query: 'subject:invoice', limit: 10, cursor: first.next_cursor }),
    error => error instanceof EmailMailboxSearchError && error.code === 'EMAIL_SEARCH_CURSOR_INVALID');
  f.advance(16 * 60_000);
  await assert.rejects(f.service.search(actor, scope, { query: 'subject:invoice', limit: 10, cursor: first.next_cursor }),
    error => error instanceof EmailMailboxSearchError && error.code === 'EMAIL_SEARCH_CURSOR_INVALID');
});

test('unsupported compilation returns explicit unsupported terms and never executes partial results', async () => {
  const f = fixture({ page: { schema_version: 'deft.email_search_page.v1', status: 'unsupported', account_id: scope.account_id,
    provider: 'gmail', original_query: 'subject:hello after:2026-10-01', items: [], next_cursor: null, has_more: false,
    observed_at: '2026-10-04T12:00:00.000Z', failure_count: 0, query_complete: false, provider_result_cap: null, limitations: [],
    unsupported: [{ index: 1, field: 'after', reason: 'unsupported_provider_date_range' }] } });
  const result = await f.service.search(actor, scope, { query: 'subject:hello after:2026-10-01', limit: 10 });
  assert.deepEqual(result.unsupported, [{ index: 1, field: 'after', reason: 'unsupported_provider_date_range' }]);
  assert.deepEqual(result.items, []); assert.equal(result.next_cursor, null); assert.equal(f.counts.persistCalls, 0);
});

test('held revocation prevents publishing provider hits and failing persistence authority guard aborts the write', async () => {
  const held = fixture({ denyAt: 2 });
  await assert.rejects(held.service.search(actor, scope, { query: 'subject:hello', limit: 10 }),
    error => error instanceof EmailMailboxSearchError && error.code === 'EMAIL_ACCESS_DENIED');
  assert.equal(held.counts.persistCalls, 0);
  const persistDenied = fixture({ denyAt: 3 });
  await assert.rejects(persistDenied.service.search(actor, scope, { query: 'subject:hello', limit: 10 }),
    error => error instanceof EmailMailboxSearchError && error.code === 'EMAIL_ACCESS_DENIED');
});

test('rejects foreign identities, duplicates, exact totals and persisted record mismatch', async () => {
  const foreign = fixture({ page: { schema_version: 'deft.email_search_page.v1', status: 'supported', account_id: 'foreign', provider: 'gmail', original_query: 'subject:hello', items: [record()],
    next_cursor: null, has_more: false, query_complete: true, provider_result_cap: null, limitations: [], failure_count: 0,
    observed_at: '2026-10-04T12:00:00.000Z', unsupported: [] } });
  await assert.rejects(foreign.service.search(actor, scope, { query: 'subject:hello', limit: 10 }),
    error => error instanceof EmailMailboxSearchError && error.code === 'EMAIL_SEARCH_UNAVAILABLE');
  const duplicate = record();
  const dup = fixture({ page: { schema_version: 'deft.email_search_page.v1', status: 'supported', account_id: scope.account_id, provider: 'gmail', original_query: 'subject:hello', items: [duplicate, duplicate],
    next_cursor: null, has_more: false, query_complete: true, provider_result_cap: null, limitations: [], failure_count: 0,
    observed_at: '2026-10-04T12:00:00.000Z', unsupported: [] } });
  await assert.rejects(dup.service.search(actor, scope, { query: 'subject:hello', limit: 10 }),
    error => error instanceof EmailMailboxSearchError && error.code === 'EMAIL_SEARCH_UNAVAILABLE');
  const staleSkipped = fixture({ stored: items => ({ records: [], dropped: items.length }) });
  const result = await staleSkipped.service.search(actor, scope, { query: 'subject:hello', limit: 10 });
  assert.deepEqual(result.items, []); assert.equal(result.coverage, 'partial'); assert.equal(result.complete, false); assert.equal(result.exact_total, null);
});
