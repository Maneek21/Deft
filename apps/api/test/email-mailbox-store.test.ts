import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts } from '@deft/db/schema';
import { PostgresEmailMailboxStore } from '../src/lib/email-mailbox-store.js';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailMailboxError, type EmailScope, type EmailSyncCommit, type EmailListRequest } from '../src/lib/email-mailbox-service.js';

// This uses the real Drizzle SQL mapper with a scripted driver. It verifies SQL,
// scope, encryption and rollback commands; it is deliberately not PG proof.
const scope: EmailScope = { org_id: 'org-a', owner_user_id: 'owner-a', account_id: 'account-a' };
const schema = { emailAccounts, emailCheckpoints, emailMessages, emailMemberships, emailProviderStates, emailSyncReceipts };
const id = (n: number) => 'mail_' + n.toString(16).padStart(64, '0');
const crypto = () => new EmailMailboxCrypto({ current: () => ({ key_id: 'test', key: Buffer.alloc(32, 7) }),
  read: (_purpose, version) => version === 'test' ? { key_id: 'test', key: Buffer.alloc(32, 7) } : null, keyIds: () => ['test'] });
type Step = { sql: RegExp; rows?: Record<string, unknown>[]; check?: (values: unknown[], sql: string) => void; fail?: string };
function fixture(steps: Step[], clock = 1000) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const pending = [...steps];
  const client = { async query(query: string | { text: string; rowMode?: string }, values: unknown[] = []) {
    const sql = typeof query === 'string' ? query : query.text; statements.push({ sql, values });
    if (/^(begin|commit|rollback)/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO email_notification_states\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^SELECT initial_inventory_complete FROM email_notification_states\b/i.test(sql)) return { rows: [{ initial_inventory_complete: false }], rowCount: 1 };
    if (/^UPDATE email_notification_states\b/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/^select "logical_message_id"(?:, "storage_revision")? from "email_messages" where/i.test(sql)&&!pending[0]?.sql.test(sql)) return { rows: [], rowCount: 0 };
    const step = pending.shift(); assert.ok(step, `Unexpected SQL: ${sql}`); assert.match(sql, step.sql);
    step.check?.(values, sql); if (step.fail) throw new Error(step.fail);
    const rows = step.rows ?? [];
    const selected = sql.toLowerCase().includes(' returning ')?sql.slice(sql.toLowerCase().lastIndexOf(' returning ')+11):sql.slice(0, sql.toLowerCase().indexOf(' from '));
    const fields = [...selected.matchAll(/(?:"[^"]+"\.)?"([^"]+)"/g)].map(match => match[1]!);
    const result = typeof query !== 'string' && query.rowMode === 'array'
      ? rows.map(row => /count\(\*\)/i.test(selected) ? [row.value] : fields.map(field => {
        const value = row[field]; return value instanceof Date ? value.toISOString() : value;
      })) : rows;
    return { rows: result, rowCount: rows.length };
  } };
  const cipher = crypto(), database = drizzle(client as never, { schema });
  const store = new PostgresEmailMailboxStore(database, cipher, { now: () => new Date(clock), freshnessMs: 1000 });
  return { store, cipher, statements, done: () => assert.equal(pending.length, 0, 'Every expected SQL step ran') };
}
function checkpoint(revision = 3, coverage = 'partial') {
  return { ...scope, revision, cursor_envelope: null, observed_at: new Date(900), fresh_until: coverage === 'complete' ? new Date(1900) : null,
    coverage, has_more: false, sync_state: 'idle', created_at: new Date(0), updated_at: new Date(900) };
}
function message(cipher: EmailMailboxCrypto, n: number) {
  const bind = { ...scope, record_id: id(n), revision: 3 };
  return { ...scope, logical_message_id: id(n), revision: 'r1', storage_revision: 3, received_at: new Date(500), sort_at: new Date(500),
    seen: false, flagged: true, answered: false,
    summary_envelope: cipher.seal({ subject: 'Private Subject' }, { ...bind, kind: 'summary' }),
    source_envelope: cipher.seal({ locator: 'secret-locator' }, { ...bind, kind: 'provider_source' }),
    inventory_generation: null, deleted_at: null, created_at: new Date(0), updated_at: new Date(900) };
}
function commit(overrides: Partial<EmailSyncCommit> = {}): EmailSyncCommit {
  return { page_id: 'page-one', request_digest: 'a'.repeat(64), page_digest: 'b'.repeat(64), expected_checkpoint_revision: 0, input_cursor: null,
    authority_version: 'authority-one', resource_binding_id: 'binding-one', page: { account_id: scope.account_id, items: [{
      account_id: scope.account_id, logical_message_id: id(1), revision: 'r1', received_at: new Date(500).toISOString(), folders: ['INBOX'],
      flags: { seen: false, flagged: true, answered: false }, data: { subject: 'Private Subject' }, provider_source: { locator: 'secret-locator' } }],
      next_cursor: 'secret-next-cursor', has_more: true, observed_at: new Date(900).toISOString(), complete: false, failure_count: 0, tombstones: [], state_updates: [] }, ...overrides };
}
const scoped = (values: unknown[]) => { for (const value of Object.values(scope)) assert.ok(values.includes(value), `Missing scope parameter ${value}`); };

test('M25 actual store SQL atomically replaces confirmed Gmail membership and consistent encrypted metadata',async()=>{
 const cipher=crypto(),row=message(cipher,1),source={schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,logical_message_id:id(1),provider:'gmail',locator:{message_id:'private-locator'}};
 row.source_envelope=cipher.seal(source,{...scope,kind:'provider_source',record_id:id(1),revision:3});row.summary_envelope=cipher.seal({subject:'Private Subject',in_inbox:true,in_sent:false,in_archive:false,folder_membership_complete:true,custom:'retained'},{...scope,kind:'summary',record_id:id(1),revision:3});
 let summary:unknown=null,guards=0;const f=fixture([{sql:/from "email_checkpoints"/,rows:[checkpoint()]},{sql:/from "email_messages"/,rows:[row]},
  {sql:/update "email_messages"/,check:values=>{for(const value of values)if(typeof value==='string'&&value.startsWith('{'))try{summary=cipher.open(JSON.parse(value),{...scope,kind:'summary',record_id:id(1),revision:4});}catch{}}},
  {sql:/delete from "email_memberships"/,check:scoped},{sql:/insert into "email_memberships"/,check:values=>{scoped(values);assert.ok(values.includes('spam'));assert.ok(values.includes('label:'+'c'.repeat(64)));assert.ok(!values.includes('inbox'));}},
  {sql:/update "email_checkpoints"/,check:scoped}]);
 const digest=createHash('sha256').update(canonicalCapabilityJson([scope.account_id,id(1),'r1',source])).digest('hex');const result=await f.store.acknowledgeFlags(scope,[{logical_message_id:id(1),expected_revision:'r1',expected_source_digest:digest,flags:{seen:false,flagged:true,answered:null},folders:['spam','label:'+'c'.repeat(64)],expected_checkpoint_revision:3}],async()=>{guards++;});
 assert.deepEqual(result,{acknowledged:1,stale:0});assert.equal(guards,2);assert.deepEqual(summary,{subject:'Private Subject',in_inbox:false,in_sent:false,in_archive:false,folder_membership_complete:true,custom:'retained'});assert.ok(f.statements.some(row=>/^commit/i.test(row.sql)));f.done();
});
test('M25 stale account checkpoint skips all ACK rows before any message write and retains both authority guards',async()=>{
 const f=fixture([{sql:/from "email_checkpoints".*for update/,rows:[checkpoint(4)]}]);let guards=0;
 const result=await f.store.acknowledgeFlags(scope,[{logical_message_id:id(1),expected_revision:'r1',expected_source_digest:'a'.repeat(64),expected_checkpoint_revision:3,flags:{seen:null,flagged:null,answered:null},folders:['spam']}],async()=>{guards++;});
 assert.deepEqual(result,{acknowledged:0,stale:1});assert.equal(guards,2);assert.ok(!f.statements.some(row=>/email_messages|email_memberships/.test(row.sql)));f.done();
});
test('M25 guarded revision read requires a bounded checkpoint or explicit missing state and checks authority after SQL',async()=>{
 const present=fixture([{sql:/select "revision" from "email_checkpoints"/,rows:[{revision:9}],check:scoped}]);let guards=0;assert.equal(await present.store.readAcknowledgementRevision(scope,async()=>{guards++;}),9);assert.equal(guards,2);present.done();
 const missing=fixture([{sql:/from "email_checkpoints"/,rows:[]}]);assert.equal(await missing.store.readAcknowledgementRevision(scope,async()=>{}),null);missing.done();
 const invalid=fixture([{sql:/from "email_checkpoints"/,rows:[{revision:2147483648}]}]);await assert.rejects(invalid.store.readAcknowledgementRevision(scope,async()=>{}));assert.equal(invalid.statements.at(-1)!.sql,'rollback');invalid.done();
});

test('M32 per-message guarded pins are scoped/bounded and reject malformed/foreign SQL output',async()=>{
 const f=fixture([{sql:/select "logical_message_id", "storage_revision" from "email_messages"/,rows:[{logical_message_id:id(1),storage_revision:3}],check:values=>{scoped(values);assert.ok(values.includes(id(1)));}}]);let guards=0;
 assert.deepEqual(await f.store.readAcknowledgementVersions(scope,[id(1)],async()=>{guards++;}),[{logical_message_id:id(1),storage_revision:3}]);assert.equal(guards,2);f.done();
 for(const row of [{logical_message_id:id(2),storage_revision:3},{logical_message_id:id(1),storage_revision:0}]){const invalid=fixture([{sql:/from "email_messages"/,rows:[row]}]);await assert.rejects(invalid.store.readAcknowledgementVersions(scope,[id(1)],async()=>{}));assert.equal(invalid.statements.at(-1)!.sql,'rollback');invalid.done();}
 const noQuery=fixture([]);await assert.rejects(noQuery.store.readAcknowledgementVersions(scope,[id(1),id(1)],async()=>{}));await assert.rejects(noQuery.store.readAcknowledgementVersions(scope,Array.from({length:26},(_,i)=>id(i)),async()=>{}));assert.equal(noQuery.statements.length,0);
});
test('M32 unrelated checkpoint change permits exact row ACK and equal-value flags advance/reseal BOTH envelopes',async()=>{
 const cipher=crypto(),row=message(cipher,1),source=cipher.open(row.source_envelope,{...scope,kind:'provider_source',record_id:id(1),revision:3});
 const digest=createHash('sha256').update(canonicalCapabilityJson([scope.account_id,id(1),'r1',source])).digest('hex');let sourceAfter:unknown,summaryAfter:unknown;
 const f=fixture([{sql:/from "email_checkpoints".*for update/,rows:[checkpoint(8)]},{sql:/from "email_messages".*for update/,rows:[row]},
  {sql:/update "email_messages".*"storage_revision"/,check:values=>{scoped(values);assert.ok(values.includes(9));for(const value of values)if(typeof value==='string'&&value.startsWith('{')){try{sourceAfter=cipher.open(JSON.parse(value),{...scope,kind:'provider_source',record_id:id(1),revision:9});}catch{}try{summaryAfter=cipher.open(JSON.parse(value),{...scope,kind:'summary',record_id:id(1),revision:9});}catch{}}}},
  {sql:/update "email_checkpoints"/,check:scoped}]);
 const update={logical_message_id:id(1),expected_revision:'r1',expected_source_digest:digest,expected_storage_revision:3,flags:{seen:false,flagged:true,answered:null}};
 assert.deepEqual(await f.store.acknowledgeFlags(scope,[update],async()=>{}),{acknowledged:1,stale:0});assert.deepEqual(sourceAfter,source);assert.deepEqual(summaryAfter,{subject:'Private Subject'});f.done();
 const stale=fixture([{sql:/from "email_checkpoints"/,rows:[checkpoint(9)]},{sql:/from "email_messages"/,rows:[{...row,storage_revision:9}]}]);assert.deepEqual(await stale.store.acknowledgeFlags(scope,[update],async()=>{}),{acknowledged:0,stale:1});assert.ok(!stale.statements.some(s=>/^update|^insert|^delete/.test(s.sql)));stale.done();
});

test('scripted SQL: complete mailbox list omits the full-folder count when explicitly not requested', async () => {
  const f = fixture([
    { sql: /from "email_checkpoints"/, rows: [checkpoint(3, 'complete')], check: scoped },
    { sql: /from "email_messages" inner join "email_memberships"/, rows: [message(crypto(), 2), message(crypto(), 1)], check: scoped },
    { sql: /from "email_memberships"/, rows: [{ logical_message_id: id(2), folder: 'INBOX' }] },
  ]);
  const page = await f.store.readPage(scope, { folder: 'INBOX', cursor: null, limit: 1, include_total: false } as EmailListRequest);
  assert.equal(page.coverage, 'complete'); assert.equal(page.exact_total, null);
  assert.equal(page.items.length, 1); assert.ok(page.next_cursor);
  assert.equal(f.statements.some(statement => /count\(\*\)/i.test(statement.sql)), false);
  assert.equal(f.statements.at(-1)?.sql, 'commit'); f.done();
  const continuation = fixture([
    { sql: /from "email_checkpoints"/, rows: [checkpoint(4, 'complete')] },
    { sql: /from "email_messages" inner join "email_memberships"/, rows: [message(crypto(), 1)],
      check: values => { scoped(values); assert.ok(values.includes(id(2))); } },
    { sql: /from "email_memberships"/, rows: [{ logical_message_id: id(1), folder: 'INBOX' }] },
  ]);
  const second = await continuation.store.readPage(scope, { folder: 'INBOX', cursor: page.next_cursor, limit: 1, include_total: false });
  assert.equal(second.items[0]!.logical_message_id, id(1)); assert.equal(second.next_cursor, null);
  assert.equal(second.coverage, 'complete'); assert.equal(second.exact_total, null); continuation.done();
});

test('scripted SQL: omitted totals skip counts for all/starred views and partial coverage never claims an exact total', async () => {
  for (const [folder, coverage, include_total] of [['all','complete',false],['starred','complete',false],['INBOX','partial',true]] as const) {
    const f=fixture([
      {sql:/from "email_checkpoints"/,rows:[checkpoint(3,coverage)]},
      {sql:/from "email_messages"/,rows:[],check:(_values,sql)=>{if(folder==='starred')assert.match(sql,/"flagged" =/);}},
    ]);
    const page=await f.store.readPage(scope,{folder,cursor:null,limit:50,include_total});
    assert.equal(page.coverage,coverage);assert.equal(page.exact_total,null);assert.equal(page.next_cursor,null);
    assert.equal(f.statements.some(statement=>/count\(\*\)/i.test(statement.sql)),false);f.done();
  }
});

test('scripted SQL: cached list uses a scoped repeatable-read snapshot and decrypts private rows', async () => {
  const cipher = crypto(), f = fixture([
    { sql: /from "email_checkpoints"/, rows: [checkpoint(3, 'complete')], check: scoped },
    { sql: /from "email_messages" inner join "email_memberships"/, rows: [message(cipher, 2), message(cipher, 1)], check: (values, sql) => {
      scoped(values); assert.ok(values.includes('INBOX')); assert.match(sql, /order by .*sort_at.* desc, .*logical_message_id.* desc/);
    } },
    { sql: /from "email_memberships"/, rows: [{ logical_message_id: id(2), folder: 'INBOX' }], check: scoped },
    { sql: /count\(\*\)/, rows: [{ value: 2 }], check: scoped },
  ]);
  const page = await f.store.readPage(scope, { folder: 'INBOX', cursor: null, limit: 1 });
  assert.equal(page.items[0]!.data.subject, 'Private Subject'); assert.equal(page.items[0]!.provider_source.locator, 'secret-locator');
  assert.equal(page.exact_total, 2); assert.equal(page.checkpoint_revision, 3); assert.ok(page.next_cursor);
  assert.equal(page.next_cursor.includes(id(2)), false);
  assert.match(f.statements[0]!.sql, /repeatable read read only/); assert.equal(f.statements.at(-1)!.sql, 'commit'); f.done();
});
test('scripted SQL: authenticated list cursor continues across checkpoint advancement but remains account/folder bound', async () => {
  const cipher = crypto(), first = fixture([
    { sql: /from "email_checkpoints"/, rows: [checkpoint()] },
    { sql: /from "email_messages"/, rows: [message(cipher, 2), message(cipher, 1)] },
    { sql: /from "email_memberships"/, rows: [{ logical_message_id: id(2), folder: 'INBOX' }] },
  ]);
  const token = (await first.store.readPage(scope, { folder: 'all', cursor: null, limit: 1 })).next_cursor!; first.done();
  const changed = fixture([
    { sql: /from "email_checkpoints"/, rows: [checkpoint(4)] },
    { sql: /from "email_messages"/, rows: [message(crypto(), 1)], check: values => { scoped(values); assert.ok(values.includes(id(2)), 'continuation stays after its sealed keyset anchor'); } },
    { sql: /from "email_memberships"/, rows: [] },
  ], 2000);
  const continued = await changed.store.readPage(scope, { folder: 'all', cursor: token, limit: 1 });
  assert.equal(continued.checkpoint_revision, 4);
  assert.deepEqual(continued.items.map(item => item.logical_message_id), [id(1)]);
  assert.match(changed.statements.find(statement => /from "email_messages"/i.test(statement.sql))!.sql, /sort_at.*</s);
  changed.done();
  const other = { ...scope, account_id: 'account-b' }, isolated = fixture([{ sql: /from "email_checkpoints"/, rows: [{ ...checkpoint(), ...other }] }]);
  await assert.rejects(isolated.store.readPage(other, { folder: 'all', cursor: token, limit: 1 }), (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_PAGE_INVALID');
  isolated.done();
  const otherFolder = fixture([{ sql: /from "email_checkpoints"/, rows: [checkpoint(4)] }]);
  await assert.rejects(otherFolder.store.readPage(scope, { folder: 'INBOX', cursor: token, limit: 1 }), (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_PAGE_INVALID');
  otherFolder.done();
  const expired = fixture([{ sql: /from "email_checkpoints"/, rows: [checkpoint(4)] }], 16 * 60_000 + 1000);
  await assert.rejects(expired.store.readPage(scope, { folder: 'all', cursor: token, limit: 1 }), (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_CURSOR_EXPIRED');
  expired.done();
});
test('scripted SQL: checkpoint provider cursor is encrypted and scoped, missing checkpoint starts at zero', async () => {
  const cipher = crypto(), envelope = cipher.seal({ cursor: 'provider-private-next' }, { ...scope, kind: 'checkpoint', record_id: 'provider-cursor', revision: 3 });
  const f = fixture([{ sql: /from "email_checkpoints"/, rows: [{ ...checkpoint(), cursor_envelope: envelope }], check: scoped },
    { sql: /from "email_checkpoints"/, rows: [], check: scoped }]);
  assert.deepEqual(await f.store.readCheckpoint(scope), { revision: 3, cursor: 'provider-private-next', has_more: false });
  assert.deepEqual(await f.store.readCheckpoint(scope), { revision: 0, cursor: null, has_more: false }); f.done();
});
test('scripted SQL: provider state and stale reconciliation reads are strictly account-scoped and decrypt server-only values', async () => {
  const cipher = crypto(), stateKey = 'c'.repeat(64), generation = 'inventory-9', secretState = { cursor: 'private-cursor', page: 7 };
  const stateEnvelope = cipher.seal({ value: secretState }, { ...scope, kind: 'checkpoint',
    record_id: `provider-state:${stateKey}:${generation}`, revision: 4 });
  const state = fixture([{ sql: /from "email_provider_states"/, rows: [{ ...scope, state_key: stateKey, generation,
    storage_revision: 4, state_envelope: stateEnvelope }], check: values => { scoped(values); assert.ok(values.includes(stateKey)); } }]);
  assert.deepEqual(await state.store.readProviderState(scope, stateKey), { state_key: stateKey, generation, value: secretState, storage_revision: 4 }); state.done();
  const staleRow = message(cipher, 3); staleRow.inventory_generation = null;
  const stale = fixture([{ sql: /from "email_messages".*is distinct from.*order by .*logical_message_id.*asc.*limit/i,
    rows: [staleRow], check: values => { scoped(values); assert.ok(values.includes(generation)); assert.ok(values.includes(id(1))); assert.ok(values.includes(17)); } }]);
  assert.deepEqual(await stale.store.readStaleRecords(scope, generation, id(1), 17), [
    { logical_message_id: id(3), provider_source: { locator: 'secret-locator' } },
  ]); stale.done();
  const other = { ...scope, account_id: 'account-other' }, isolated = fixture([{ sql: /from "email_provider_states"/, rows: [], check: values => {
    for (const value of Object.values(other)) assert.ok(values.includes(value)); assert.ok(values.includes(stateKey));
  } }]);
  assert.equal(await isolated.store.readProviderState(other, stateKey), null); isolated.done();
  const malformed = fixture([]);
  await assert.rejects(malformed.store.readProviderState(scope, 'not-a-hash'));
  assert.deepEqual(malformed.statements, []); malformed.done();
});
function commitSteps(failReceipt = false): Step[] {
  return [
    { sql: /insert into "email_checkpoints"/, check: scoped },
    { sql: /from "email_checkpoints".*for update/, rows: [checkpoint(0)], check: scoped },
    { sql: /from "email_sync_receipts"/, rows: [], check: scoped },
    { sql: /from "email_memberships"/, rows: [], check: scoped },
    { sql: /insert into "email_messages".*on conflict.*do update/, check: values => {
      scoped(values); const serialized = JSON.stringify(values); assert.equal(serialized.includes('Private Subject'), false); assert.equal(serialized.includes('secret-locator'), false);
      assert.ok(serialized.includes('deft.secret.v1'));
    } },
    { sql: /delete from "email_memberships"/, check: scoped },
    { sql: /insert into "email_memberships"/, check: scoped },
    { sql: /update "email_checkpoints"/, check: values => { scoped(values); assert.equal(JSON.stringify(values).includes('secret-next-cursor'), false); } },
    { sql: /insert into "email_sync_receipts"/, check: scoped, ...(failReceipt ? { fail: 'receipt write failed' } : {}) },
  ];
}
test('scripted SQL: commit guards precede checkpoint locking and precede final transaction commit', async () => {
  const f = fixture(commitSteps()); let guards = 0;
  const result = await f.store.commitPage(scope, commit(), async () => {
    guards++; if (guards === 1) assert.equal(f.statements.length, 1);
    if (guards === 2) assert.match(f.statements.at(-1)!.sql, /insert into "email_sync_receipts"/);
  });
  assert.equal(result.checkpoint_revision, 1); assert.equal(result.state, 'applied'); assert.equal(guards, 2);
  assert.equal(f.statements.at(-1)!.sql, 'commit'); f.done();
});
test('scripted SQL: receipt insertion failure requests full rollback, with no final commit', async () => {
  const f = fixture(commitSteps(true)); let guards = 0;
  await assert.rejects(f.store.commitPage(scope, commit(), async () => { guards++; }), (error: unknown) =>
    error instanceof Error && error.cause instanceof Error && error.cause.message === 'receipt write failed');
  assert.equal(f.statements.at(-1)!.sql, 'rollback'); assert.equal(f.statements.some(item => item.sql === 'commit'), false); assert.equal(guards, 1); f.done();
});
test('scripted SQL: inventory generation and encrypted provider state share the page transaction and roll back together', async () => {
  const stateKey = 'd'.repeat(64), generation = 'inventory-new', privateCursor = 'opaque-private-state-cursor';
  const page = commit().page; page.items[0]!.inventory_generation = generation;
  page.state_updates = [{ state_key: stateKey, generation, value: { cursor: privateCursor } }];
  const f = fixture([
    { sql: /insert into "email_checkpoints"/ }, { sql: /from "email_checkpoints".*for update/, rows: [checkpoint(2)] },
    { sql: /from "email_sync_receipts"/, rows: [] },
    { sql: /from "email_memberships"/, rows: [{ logical_message_id: id(1), folder: 'INBOX', inventory_generation: 'inventory-old' }] },
    { sql: /insert into "email_messages".*on conflict.*do update/, check: (values, statement) => {
      scoped(values); assert.match(statement, /"inventory_generation"/); assert.ok(values.includes(generation));
      assert.equal(JSON.stringify(values).includes(privateCursor), false);
    } },
    { sql: /delete from "email_memberships"/ },
    { sql: /insert into "email_memberships"/, check: values => { scoped(values); assert.ok(values.includes(generation)); } },
    { sql: /insert into "email_provider_states".*on conflict.*do update/, check: (values, statement) => {
      scoped(values); assert.match(statement, /"state_envelope"/); assert.ok(JSON.stringify(values).includes('deft.secret.v1'));
      assert.equal(JSON.stringify(values).includes(privateCursor), false);
    } },
    { sql: /update "email_checkpoints"/ },
    { sql: /insert into "email_sync_receipts"/, fail: 'receipt write failed after provider state and generation writes' },
  ]);
  await assert.rejects(f.store.commitPage(scope, commit({ page, expected_checkpoint_revision: 2 }), async () => {}), (error: unknown) =>
    error instanceof Error && error.cause instanceof Error && error.cause.message.includes('after provider state'));
  assert.equal(f.statements.at(-1)!.sql, 'rollback'); assert.equal(f.statements.some(item => item.sql === 'commit'), false); f.done();
});
test('scripted SQL: exact replay precedes stale checkpoint rejection and altered page replay fails', async () => {
  const replay = { ...scope, page_id: 'page-one', request_digest: 'a'.repeat(64), page_digest: 'b'.repeat(64), checkpoint_revision: 1,
    observed_at: new Date(900), complete: false, has_more: true, created_at: new Date(900), updated_at: new Date(900) };
  const steps = () => [{ sql: /insert into "email_checkpoints"/ }, { sql: /from "email_checkpoints".*for update/, rows: [checkpoint(8)] },
    { sql: /from "email_sync_receipts"/, rows: [replay] }];
  const exact = fixture(steps()); assert.equal((await exact.store.commitPage(scope, commit(), async () => {})).state, 'duplicate'); exact.done();
  const edited = fixture(steps()); await assert.rejects(edited.store.commitPage(scope, commit({ page_digest: 'c'.repeat(64) }), async () => {}),
    (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_SYNC_REPLAY_CONFLICT'); edited.done();
});
test('scripted SQL: stale checkpoint and revoked guard perform no message writes', async () => {
  const stale = fixture([{ sql: /insert into "email_checkpoints"/ }, { sql: /from "email_checkpoints".*for update/, rows: [checkpoint(2)] },
    { sql: /from "email_sync_receipts"/, rows: [] }]);
  await assert.rejects(stale.store.commitPage(scope, commit(), async () => {}), (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_CHECKPOINT_CONFLICT'); stale.done();
  const revoked = fixture([]); await assert.rejects(revoked.store.commitPage(scope, commit(), async () => { throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); }));
  assert.deepEqual(revoked.statements.map(statement => statement.sql), ['begin', 'rollback']); revoked.done();
});
test('scripted SQL: tombstones clear encrypted summary/source and folder memberships under exact scope', async () => {
  const f = fixture([{ sql: /insert into "email_checkpoints"/ }, { sql: /from "email_checkpoints".*for update/, rows: [checkpoint(0)] },
    { sql: /from "email_sync_receipts"/, rows: [] }, { sql: /delete from "email_memberships"/, check: scoped },
    { sql: /update "email_messages"/, check: (values, sql) => {
      scoped(values); assert.match(sql, /"summary_envelope" = \$\d+, "source_envelope" = \$\d+/); assert.ok(values.filter(value => value === null).length >= 2);
    } }, { sql: /update "email_checkpoints"/, check: scoped }, { sql: /insert into "email_sync_receipts"/, check: scoped }]);
  const page = commit().page; page.items = []; page.tombstones = [id(1)]; page.complete = true; page.has_more = false; page.next_cursor = null;
  await f.store.commitPage(scope, commit({ page }), async () => {}); f.done();
});


test('M32 search insertion advances/reseals retained checkpoint cursor; cached-only search leaves version unchanged',async()=>{
 const cipher=crypto(),row=message(cipher,1),retained=checkpoint(2),item=commit().page.items[0]!;
 retained.cursor_envelope=cipher.seal({cursor:'retained-private-cursor'},{...scope,kind:'checkpoint',record_id:'provider-cursor',revision:2});
 const inserted=fixture([{sql:/insert into "email_checkpoints"/},{sql:/from "email_checkpoints"/,rows:[retained]},
  {sql:/insert into "email_messages"/,rows:[{logical_message_id:id(1)}]},{sql:/insert into "email_memberships"/},
  {sql:/update "email_checkpoints"/,check:values=>{assert.ok(values.includes(3));const envelope=values.find(v=>typeof v==='string'&&v.includes('deft.secret.v1')) as string;assert.deepEqual(cipher.open(JSON.parse(envelope),{...scope,kind:'checkpoint',record_id:'provider-cursor',revision:3}),{cursor:'retained-private-cursor'});}},
  {sql:/from "email_messages"/,rows:[row]},{sql:/from "email_memberships"/,rows:[{logical_message_id:id(1),folder:'INBOX'}]}]);
 assert.equal((await inserted.store.persistSearchResults(scope,[item],async()=>{})).records.length,1);inserted.done();
 const cached=fixture([{sql:/insert into "email_checkpoints"/},{sql:/from "email_checkpoints"/,rows:[checkpoint()]},
  {sql:/select "logical_message_id" from "email_messages"/,rows:[{logical_message_id:id(1)}]},{sql:/from "email_messages"/,rows:[row]},
  {sql:/from "email_memberships"/,rows:[{logical_message_id:id(1),folder:'INBOX'}]}]);
 await cached.store.persistSearchResults(scope,[item],async()=>{});assert.ok(!cached.statements.some(s=>/^update "email_checkpoints"/.test(s.sql)));cached.done();
});
test('M32 legacy ahead-of-checkpoint ACK advances above target and seals cursor at final written revision; overflow rolls back',async()=>{
 const cipher=crypto(),row=message(cipher,1),source=cipher.open(row.source_envelope,{...scope,kind:'provider_source',record_id:id(1),revision:3}),cp=checkpoint(2);
 cp.cursor_envelope=cipher.seal({cursor:'private-cursor'},{...scope,kind:'checkpoint',record_id:'provider-cursor',revision:2});
 const update={logical_message_id:id(1),expected_revision:'r1',expected_source_digest:createHash('sha256').update(canonicalCapabilityJson([scope.account_id,id(1),'r1',source])).digest('hex'),expected_storage_revision:3,flags:{seen:true,flagged:null,answered:null}};
 const f=fixture([{sql:/from "email_checkpoints"/,rows:[cp]},{sql:/from "email_messages"/,rows:[row]},
  {sql:/update "email_messages"/,check:values=>assert.ok(values.includes(4))},{sql:/update "email_checkpoints"/,check:values=>{assert.ok(values.includes(4));const envelope=values.find(v=>typeof v==='string'&&v.includes('deft.secret.v1')) as string;assert.deepEqual(cipher.open(JSON.parse(envelope),{...scope,kind:'checkpoint',record_id:'provider-cursor',revision:4}),{cursor:'private-cursor'});}}]);
 assert.deepEqual(await f.store.acknowledgeFlags(scope,[update],async()=>{}),{acknowledged:1,stale:0});f.done();
 const maximum={...row,storage_revision:2147483647,summary_envelope:cipher.seal({subject:'Private Subject'},{...scope,kind:'summary',record_id:id(1),revision:2147483647}),source_envelope:cipher.seal(source,{...scope,kind:'provider_source',record_id:id(1),revision:2147483647})};
 const overflow=fixture([{sql:/from "email_checkpoints"/,rows:[checkpoint()]},{sql:/from "email_messages"/,rows:[maximum]}]);
 await assert.rejects(overflow.store.acknowledgeFlags(scope,[{...update,expected_storage_revision:2147483647}],async()=>{}),(e:unknown)=>e instanceof EmailMailboxError&&e.code==='EMAIL_CHECKPOINT_CONFLICT');assert.equal(overflow.statements.at(-1)!.sql,'rollback');overflow.done();
});
test('M32 first sync exceeds legacy search-created row version and all cursor/state/receipt envelopes use final revision',async()=>{
 const cipher=crypto(),steps=commitSteps();steps[1]={sql:/from "email_checkpoints"/,rows:[checkpoint(2)]};
 steps.splice(3,0,{sql:/select "logical_message_id", "storage_revision" from "email_messages"/,rows:[{logical_message_id:id(1),storage_revision:3}]});
 steps[5]!.check=values=>{assert.ok(values.includes(4));const envelopes=[...new Set(values.filter(v=>typeof v==='string'&&v.includes('deft.secret.v1')))] as string[];assert.equal(envelopes.length,2);assert.deepEqual(cipher.open(JSON.parse(envelopes[0]!),{...scope,kind:'summary',record_id:id(1),revision:4}),{subject:'Private Subject'});};
 steps[8]!.check=values=>{assert.ok(values.includes(4));const envelope=values.find(v=>typeof v==='string'&&v.includes('deft.secret.v1')) as string;assert.deepEqual(cipher.open(JSON.parse(envelope),{...scope,kind:'checkpoint',record_id:'provider-cursor',revision:4}),{cursor:'secret-next-cursor'});};
 const f=fixture(steps);assert.equal((await f.store.commitPage(scope,commit({expected_checkpoint_revision:2}),async()=>{})).checkpoint_revision,4);f.done();
 const overflow=fixture([{sql:/insert into "email_checkpoints"/},{sql:/from "email_checkpoints"/,rows:[checkpoint()]},{sql:/from "email_sync_receipts"/,rows:[]},{sql:/select "logical_message_id", "storage_revision" from "email_messages"/,rows:[{logical_message_id:id(1),storage_revision:2147483647}]}]);
 await assert.rejects(overflow.store.commitPage(scope,commit({expected_checkpoint_revision:3}),async()=>{}),(e:unknown)=>e instanceof EmailMailboxError&&e.code==='EMAIL_CHECKPOINT_CONFLICT');assert.equal(overflow.statements.at(-1)!.sql,'rollback');overflow.done();
});
