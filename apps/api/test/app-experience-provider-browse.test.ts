import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AppExperienceProviderBrowseService, ProviderBrowseRequestSchema } from '../src/lib/app-experience-provider-browse.js';
import { ExperienceProviderHandles, type ProviderSourceRecord } from '../src/lib/app-experience-provider-handles.js';
import { AppConnectionRegistry } from '../src/lib/app-connection-registry.js';
import type { AppConnectionAdapter, AppConnectionProjection } from '../src/lib/app-connection-contract.js';
import type { AppRunKeyProvider } from '../src/lib/app-run-keyrings.js';
import { exposureUnavailable, exposureDigest } from '../src/lib/app-experience-exposure-contract.js';

const keys: AppRunKeyProvider = { current: () => ({ key_id: 'test', key: Buffer.alloc(32, 7) }),
  read: (_purpose, id) => id === 'test' ? { key_id: 'test', key: Buffer.alloc(32, 7) } : null, keyIds: () => ['test'] };
function fixture() {
  const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID(), access_expires_at: 1000000 }, session = randomUUID();
  const pins = { org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: randomUUID(), app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), target_key: 'personal', resource_key: 'inbox', resource_binding_id: randomUUID(), action_key: null, action_binding_id: null };
  const state = { time: 1000, live: true, sourceCalls: 0, calls: 0, outputMutator: (_page: any) => {}, held: async () => {},
    nomination: { installation_id: pins.installation_id, target_key: pins.target_key, resource_binding_id: pins.resource_binding_id,
      exposure_id: randomUUID(), exposure_epoch: 1, allowed_fields: ['subject'], handle_scope: 'exact-scope', handle_group: 'owner-install',
      max_records_per_page: 25, max_page_bytes: 524288, expires_at: 900000,
      label_field: 'subject',
      record_schema: { type: 'object' as const, properties: { subject: { type: 'string' as const, maxLength: 200 },
        unreviewed: { type: 'string' as const, maxLength: 200 } }, required: ['subject'], additionalProperties: false as const } },
    projection: { ...pins, purpose: 'browse_resource', web_session_id: caller.sid, experience_session_id: session,
      runtime_registration_id: randomUUID(), descriptor_digest: 'sha256:' + '1'.repeat(64), allowed_operations: ['list_summary', 'read_one', 'search'],
      lifecycle_epoch: 1, grant_epoch: 1, runtime_epoch: 1, expires_at: 900000, checked_at: 1000 } as AppConnectionProjection };
  const handles = new ExperienceProviderHandles(1200, 1000, 16777216, () => state.time);
  const allowed = (actual: typeof caller, id: string) => { if (!state.live || actual.org_id !== caller.org_id
    || actual.user_id !== caller.user_id || actual.sid !== caller.sid || id !== session) throw exposureUnavailable(); };
  const authority: ConstructorParameters<typeof AppExperienceProviderBrowseService>[1] = {
    async providerAuthority(actual, id, key) { allowed(actual as typeof caller, id); assert.equal(key, 'inbox'); return structuredClone(state.nomination); },
    async connectionSetup(actual, id, nominated) { allowed(actual as typeof caller, id); assert.deepEqual(nominated, pins); return structuredClone(state.projection); },
    async browseAuthority(actual, id, key, nominated, signal) {
      const [projection, nomination] = await Promise.all([authority.connectionSetup(actual, id, nominated, signal, 'browse_resource'), authority.providerAuthority(actual, id, key, signal)]);
      return { projection:{...projection,descriptor_digest:projection.descriptor_digest as `sha256:${string}`,allowed_operations:[...projection.allowed_operations] as ['list_summary','read_one']|['list_summary','read_one','search'],reviewed_action_keys:projection.reviewed_action_keys?[...projection.reviewed_action_keys]:undefined}, nomination };
    },
    async sourceRecord(actual, id, key, recordId) { allowed(actual as typeof caller, id); assert.equal(key, 'inbox'); state.sourceCalls++;
      const record = handles.read<ProviderSourceRecord>(keys, state.nomination.handle_scope, 'source', recordId); if (!record) throw exposureUnavailable();
      return { ...state.nomination, record: { ...record, record_id: recordId } }; },
  };
  const adapter: AppConnectionAdapter = { handle: async () => { assert.fail('No connection or Send invocation'); },
    async browseResource(input, context) {
      await context.recheck(); context.signal?.throwIfAborted(); state.calls++; await state.held();
      const start = input.cursor === null ? 0 : Number(input.cursor.replace('private-provider-token-', ''));
      const count = Math.min(input.limit, 1107 - start);
      const items = Array.from({ length: count }, (_, index) => ({ revision: 'revision-' + (start + index), label: 'Message',
        data: { subject: 'message-' + (start + index), unreviewed: 'must-not-disclose' },
        provider_source: { account_id: 'private-account', locator: { message_id: 'private-provider-' + (start + index) } } }));
      const page = { schema_version: 'deft.app_provider_browse_page.v1', items, next_cursor: start + count < 1107 ? 'private-provider-token-' + (start + count) : null,
        complete: start + count === 1107, observed_at: new Date(state.time).toISOString(), count: { returned: count, exact_total: null }, failure_count: 0 };
      state.outputMutator(page); await context.recheck(); return page;
    } };
  const registry = new AppConnectionRegistry([{ pins, adapter }]);
  const service = new AppExperienceProviderBrowseService(keys, authority, async () => registry, handles, () => state.time);
  const read = (input: Record<string, unknown> = { operation: 'browse', kind: 'list', folder: 'all' }) => service.read(caller, session, 'inbox', input);
  return { caller, session, pins, state, handles, authority, adapter, registry, service, read };
}

test('declared non-mail search fields reach the provider and undeclared fields do not', async () => {
  const f = fixture(), input = { operation: 'browse', kind: 'search', folder: 'all', filters: { stage: 'review', active: true } };
  await assert.rejects(f.read(input)); assert.equal(f.state.calls, 0);
  f.state.projection = { ...f.state.projection, content_policy: { document: { max_characters: 100 }, search_filters: ['stage', 'active'] } };
  const original = f.adapter.browseResource!;
  f.adapter.browseResource = async (request, context) => { assert.deepEqual(request.filters, input.filters); return original(request, context); };
  await f.read(input); assert.equal(f.state.calls, 1);
  await assert.rejects(f.read({ ...input, filters: { undeclared: 'value' } })); assert.equal(f.state.calls, 1);
  for (const filters of [{ stage: 'line\nbreak' }, { stage: {} }, { constructor: 'bad' }])
    assert.equal(ProviderBrowseRequestSchema.safeParse({ ...input, filters }).success, false);
});

test('provider cursor fixture pages cross1000 without projection writes or exposing provider IDs', async () => {
  const f = fixture(); let cursor: string | undefined, count = 0, first = '', last = '';
  do {
    const page = (await f.read({ operation: 'browse', kind: 'list', folder: 'all', ...(cursor ? { cursor } : {}) })).output;
    if (!first) first = page.items[0]!.record_id; last = page.items.at(-1)!.record_id;
    count += page.items.length; cursor = page.next_cursor ?? undefined;
    assert.equal(JSON.stringify(page).includes('private-provider'), false); assert.equal(JSON.stringify(page).includes('unreviewed'), false);
  } while (cursor);
  assert.equal(count, 1107); assert.equal(f.state.calls, 111);
  await assert.rejects(f.authority.sourceRecord(f.caller, f.session, 'inbox', first));
  const current = await f.authority.sourceRecord(f.caller, f.session, 'inbox', last);
  assert.equal(current.record.data.subject, 'message-1106'); assert.ok('provider_source' in current.record&&current.record.provider_source);
});
test('forged owner, session, handle kind and altered query cannot dispatch provider I/O', async () => {
  const f = fixture(), page = (await f.read()).output, before = f.state.calls;
  await assert.rejects(f.service.read({ ...f.caller, user_id: randomUUID() }, f.session, 'inbox', { operation: 'browse', kind: 'list', folder: 'all' }));
  for (const input of [ { kind: 'list', folder: 'inbox', cursor: page.next_cursor },
    { kind: 'search', folder: 'all', query: 'changed', cursor: page.next_cursor },
    { kind: 'list', folder: 'all', cursor: page.items[0]!.record_id },
    { kind: 'conversation', folder: 'all', record_id: randomUUID() } ]) await assert.rejects(f.read({ operation: 'browse', ...input }));
  assert.equal(f.state.calls, before);
  for (const field of ['owner_user_id', 'org_id', 'account_id', 'url', 'source', 'limit'])
    assert.equal(ProviderBrowseRequestSchema.safeParse({ operation: 'browse', kind: 'list', folder: 'all', [field]: 'forged' }).success, false);
});
test('current scope, revoked permission and held-I/O expiry withhold page handles', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.state.live = false; },
    (f: ReturnType<typeof fixture>) => { f.state.nomination.handle_scope = 'changed'; },
    (f: ReturnType<typeof fixture>) => { f.state.projection = { ...f.state.projection, runtime_epoch: 2 }; },
    (f: ReturnType<typeof fixture>) => { f.state.time = 61001; }]) {
    const f = fixture(); f.state.held = async () => change(f); await assert.rejects(f.read());
  }
  const denied = fixture(); denied.state.projection = { ...denied.state.projection, allowed_operations: ['list_summary', 'read_one'] };
  await assert.rejects(denied.read({ operation: 'browse', kind: 'search', folder: 'all', query: 'hello' })); assert.equal(denied.state.calls, 0);
});
test('admitted page limits and bytes are preserved; malformed result never emits source handles', async () => {
  const f = fixture(); f.state.nomination.max_records_per_page = 1; assert.equal((await f.read()).output.items.length, 1);
  const bytes = fixture(); bytes.state.nomination.max_page_bytes = 1; await assert.rejects(bytes.read());
  const bad = fixture(); bad.state.outputMutator = page => { page.complete = true; }; await assert.rejects(bad.read());
});
test('undisclosed label field cannot leak through native label and terminal partial stays partial', async () => {
  const hidden = fixture(); hidden.state.nomination.allowed_fields = ['unreviewed'];
  const page = (await hidden.read()).output; assert.equal(page.items[0]!.label, ''); assert.equal(page.items[0]!.data.subject, undefined);
  for (const mutate of [(page: any) => { page.schema_version = 'other.contract'; },
    (page: any) => { page.items[0].provider_source = { constructor: 'bad' }; },
    (page: any) => { page.items[0].provider_source = { raw: () => 'not-json' }; }]) {
    const f = fixture(); f.state.outputMutator = mutate; await assert.rejects(f.read());
  }
  const partial = fixture(); partial.state.outputMutator = page => { page.complete = false; page.next_cursor = null; page.failure_count = 1; };
  const end = (await partial.read()).output; assert.equal(end.complete, false); assert.equal(end.next_cursor, null); assert.equal(end.failure_count, 1);
});
test('transient ciphertext is purpose/scope-bound, finite, expires and fails closed after restart', () => {
  let now = 1000; const store = new ExperienceProviderHandles(3, 2, 500, () => now);
  const one = store.put(keys, 'scope', 'owner', 'source', { locator: 'secret' }, 2000);
  assert.throws(() => store.read(keys, 'foreign', 'source', one)); assert.throws(() => store.read(keys, 'scope', 'cursor', one));
  assert.deepEqual(store.read(keys, 'scope', 'source', one), { locator: 'secret' });
  store.put(keys, 'scope', 'owner', 'source', {}, 2000); store.put(keys, 'scope', 'owner', 'source', {}, 2000);
  assert.equal(store.read(keys, 'scope', 'source', one), null);
  assert.equal(new ExperienceProviderHandles().read(keys, 'scope', 'source', one), null);
  const expiring = store.put(keys, 'scope', 'owner', 'source', {}, 2000);
  now = 2000; assert.throws(() => store.read(keys, 'scope', 'source', expiring));
  assert.throws(() => new ExperienceProviderHandles(0));
});

test('simultaneous native rechecks share only the pending paired authority operation',async()=>{
 const f=fixture(),original=f.adapter.browseResource!;let active=false,started:string[]=[],setupReads=0;
 const setup=f.authority.connectionSetup,scope=f.authority.providerAuthority;
 f.authority.connectionSetup=async(...args)=>{if(active){setupReads++;started.push('setup');await new Promise(resolve=>setTimeout(resolve,5));}return setup(...args);};
 f.authority.providerAuthority=async(...args)=>{if(active)started.push('scope');return scope(...args);};
 f.adapter.browseResource=async(input,context)=>{active=true;const pending=Promise.all(Array.from({length:4},()=>context.recheck()));await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(started,['setup','scope']);await pending;assert.equal(setupReads,1);await context.recheck();assert.equal(setupReads,2);active=false;return original(input,context);};
 await f.read();
});

test('revoked concurrent snapshot cannot disclose page after another snapshot settles',async()=>{
 const f=fixture(),original=f.adapter.browseResource!;let active=false,finished=0;
 const scope=f.authority.providerAuthority;
 f.authority.providerAuthority=async(...args)=>{if(active){await new Promise(resolve=>setTimeout(resolve,5));finished++;}return scope(...args);};
 const setup=f.authority.connectionSetup;
  f.authority.connectionSetup=async(...args)=>{const result=await setup(...args);if(active){f.state.live=false;return {...result,runtime_epoch:result.runtime_epoch+1};}return result;};
 f.adapter.browseResource=async(input,context)=>{active=true;await Promise.all(Array.from({length:4},()=>context.recheck()));return original(input,context);};
 await assert.rejects(f.read());assert.equal(finished,1);
});

test('browse diagnostics contain aggregate timing counts and outcome only',async()=>{
 const f=fixture(),events:unknown[]=[];const service=new AppExperienceProviderBrowseService(keys,f.authority,async()=>f.registry,f.handles,()=>f.state.time,60000,event=>events.push(event));
 await service.read(f.caller,f.session,'inbox',{operation:'browse',kind:'list',folder:'all'});
 const result=events[0] as Record<string,unknown>;assert.deepEqual(Object.keys(result).sort(),['authority_phase','code','elapsed_ms','outcome','provider_ms','recheck_calls','recheck_ms','recheck_reads']);assert.equal(result.outcome,'success');assert.equal(result.code,null);assert.equal(JSON.stringify(result).includes(f.caller.user_id),false);
});

test('phase collectors stay request scoped and never enter provider response payloads',async()=>{
 const f=fixture(),g=fixture(),events:any[]=[],other:any[]=[];const phase={locked_ms:1,package_verify_ms:2,package_verify_calls:2,projection_ms:3,final_ms:4,db_query_ms:5,db_query_count:6,db_acquisition_ms:7};
 const wrap=(fixture:any,mult:number)=>{const old=fixture.authority.browseAuthority;fixture.authority.browseAuthority=async(...args:any[])=>{const result=await old(...args.slice(0,5));args[5]?.(Object.fromEntries(Object.entries(phase).map(([k,v])=>[k,(v as number)*mult])));return result;};};wrap(f,1);wrap(g,10);
 const one=new AppExperienceProviderBrowseService(keys,f.authority,async()=>f.registry,f.handles,()=>f.state.time,60000,x=>events.push(x));const two=new AppExperienceProviderBrowseService(keys,g.authority,async()=>g.registry,g.handles,()=>g.state.time,60000,x=>other.push(x));const results=await Promise.all([one.read(f.caller,f.session,'inbox',{operation:'browse',kind:'list',folder:'all'}),two.read(g.caller,g.session,'inbox',{operation:'browse',kind:'list',folder:'all'})]);
 assert.equal(other[0].authority_phase.locked_ms,events[0].authority_phase.locked_ms*10);assert.equal(JSON.stringify(results).includes('authority_phase'),false);assert.equal(JSON.stringify(events[0].authority_phase).includes(f.caller.user_id),false);
});

test('timeout timing event is detached from a later unsettled authority collector',async()=>{
 const f=fixture(),events:any[]=[];let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const old=f.authority.browseAuthority;f.authority.browseAuthority=async(...args:any[])=>{await held;args[5]?.({locked_ms:99,package_verify_ms:99,package_verify_calls:2,projection_ms:1,final_ms:1,db_query_ms:99,db_query_count:10,db_acquisition_ms:1});return old(...args.slice(0,5) as Parameters<typeof old>);};
 const service=new AppExperienceProviderBrowseService(keys,f.authority,async()=>f.registry,f.handles,()=>f.state.time,10,x=>events.push(x));await assert.rejects(service.read(f.caller,f.session,'inbox',{operation:'browse',kind:'list',folder:'all'}));assert.equal(events[0].authority_phase.locked_ms,0);release();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(events[0].authority_phase.locked_ms,0);
});
