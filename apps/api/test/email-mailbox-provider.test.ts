import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConnectionAdapter, NativeEmailAccount, NativeEmailConnectionContext,NativeEmailSearchPage } from '../src/lib/app-connection-contract.js';
import { EmailMailboxError, type EmailCapability, type EmailProviderPage, type EmailScope } from '../src/lib/email-mailbox-service.js';
import { RegisteredEmailMailboxProvider, type NativeEmailConnectionResolver } from '../src/lib/email-mailbox-provider.js';

test('native conversation wrapper rebases verified principal epoch and validates all private identities',async()=>{
 const source={schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,provider:'gmail',authority_epoch:1,logical_message_id:'mail_'+'a'.repeat(64),conversation_id:'thread',locator:{kind:'gmail',message_id:'message',thread_id:'thread',label_ids:['INBOX']}};
 const result={schema_version:'deft.email_conversation_page.v1' as const,account_id:scope.account_id,provider:'gmail' as const,anchor_logical_message_id:source.logical_message_id,items:[{account_id:scope.account_id,logical_message_id:source.logical_message_id,revision:'r1',received_at:null,folders:['sent'],flags:{seen:false,flagged:false,answered:false},data:{subject:'Fixture'},provider_source:{...source,authority_epoch:2}}],next_cursor:null,has_more:false,complete:true,failure_count:0,observed_at:new Date(1000).toISOString()};
 const f=fixture();let calls=0;f.adapter.nativeEmailConversation=async(input)=>{calls++;assert.equal(input.source.authority_epoch,2);return result;};
 assert.deepEqual(await f.provider.readConversation(scope,{source,cursor:null,limit:1},capability,f.recheck),result);assert.equal(calls,1);assert.equal(source.authority_epoch,1);
 for(const changed of [{...result,account_id:'foreign'},{...result,anchor_logical_message_id:'mail_'+'b'.repeat(64)},
  {...result,items:result.items.map(row=>({...row,provider_source:{...row.provider_source,conversation_id:'another'}}))},
  {...result,items:result.items.map(row=>({...row,provider_source:{...row.provider_source,authority_epoch:1}}))}]){
  f.adapter.nativeEmailConversation=async()=>changed;await denied(f.provider.readConversation(scope,{source,cursor:null,limit:1},capability,f.recheck));}
});
test('native conversation wrapper rejects held reconnect/principal/revocation and preserves genuine provider failures',async()=>{
 const source={schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,provider:'gmail',authority_epoch:1,logical_message_id:'mail_'+'a'.repeat(64),conversation_id:'thread'};
 const page={schema_version:'deft.email_conversation_page.v1' as const,account_id:scope.account_id,provider:'gmail' as const,anchor_logical_message_id:source.logical_message_id,items:[],next_cursor:null,has_more:false,complete:true,failure_count:0,observed_at:new Date(1000).toISOString()};
 for(const changed of [account({health:'revoked'}),account({connection_revision:4}),account({principal_digest:'b'.repeat(64)})]){let calls=0;const f=fixture({account:()=>++calls===1?account():changed});f.adapter.nativeEmailConversation=async()=>page;
  await denied(f.provider.readConversation(scope,{source,cursor:null,limit:1},capability,f.recheck));}
 const f=fixture(),error=new Error('bounded provider failure');f.adapter.nativeEmailConversation=async()=>{throw error;};
 await assert.rejects(f.provider.readConversation(scope,{source,cursor:null,limit:1},capability,f.recheck),value=>value===error);
 await denied(f.provider.readConversation(scope,{source:{...source,account_id:'foreign'},cursor:null,limit:1},capability,f.recheck));
});

const scope: EmailScope = { org_id: 'org-a', owner_user_id: 'owner-a', account_id: 'account-a' };
const capability: EmailCapability = { scope, resource_binding_id: 'binding-a', authority_version: 'authority-a', expires_at: 5000 };
const context: NativeEmailConnectionContext = { ...scope, installation_id: 'install-a', resource_binding_id: 'binding-a',
  authority_version: 'authority-a', expires_at: 4000, recheck: async () => {} };
const account = (patch: Partial<NativeEmailAccount> = {}): NativeEmailAccount => ({ account_id: scope.account_id,
  provider: 'gmail', resource_binding_id: capability.resource_binding_id, authority_epoch: 2, connection_revision: 3,
  principal_digest: 'a'.repeat(64),
  health: 'connected', capabilities: ['read'], primary_address: 'mail@example.invalid', display_label: 'Fixture', ...patch });
const page: EmailProviderPage = { account_id: scope.account_id, items: [], next_cursor: null, has_more: false,
  complete: false, observed_at: new Date(1000).toISOString(), failure_count: 0, tombstones: [],state_updates:[] };
function fixture(options: { account?: () => NativeEmailAccount; read?: (ctx: NativeEmailConnectionContext, input: {cursor:string|null;limit:number}) => Promise<EmailProviderPage> } = {}) {
  let accountCalls = 0, reads = 0, resolveCalls = 0, rechecks = 0;
  const adapter: AppConnectionAdapter = {
    handle: async () => new Response(),
    nativeEmailAccount: async () => { accountCalls++; return options.account?.() ?? account(); },
    nativeEmailPage: async (input, ctx) => { reads++; return options.read ? options.read(ctx, input) : page; },
  };
  const resolver: NativeEmailConnectionResolver = async (s, cap, recheck, signal) => {
    resolveCalls++; assert.deepEqual(s, scope); assert.deepEqual(cap, capability);
    return { adapter, context: { ...context, recheck: async () => {}, signal } };
  };
  const provider = new RegisteredEmailMailboxProvider(resolver, () => 1000);
  const recheck = async () => { rechecks++; };
  return { provider, adapter, recheck, counts: () => ({ accountCalls, reads, resolveCalls, rechecks }) };
}
async function denied(promise: Promise<unknown>) {
  await assert.rejects(promise, (error: unknown) => error instanceof EmailMailboxError && error.code === 'EMAIL_ACCESS_DENIED');
}

test('native email provider reads only after live status checks and returns the matching account page', async () => {
  const f = fixture();
  assert.deepEqual(await f.provider.readPage(scope, { cursor: 'opaque', limit: 25 }, capability, f.recheck), page);
  assert.deepEqual(f.counts(), { accountCalls: 2, reads: 1, resolveCalls: 1, rechecks: 2 });
  assert.equal((await f.provider.assertConnected(scope, capability, f.recheck)).health, 'connected');
});

test('held reads reject disconnect, same-account reconnect and principal changes', async () => {
  for (const changed of [account({ health: 'held' }), account({ connection_revision: 4 }), account({ principal_digest: 'b'.repeat(64) }),account({implementation_digest:'c'.repeat(64)})]) {
    let calls = 0;
    const f = fixture({ account: () => ++calls === 1 ? account() : changed });
    await denied(f.provider.readPage(scope, { cursor: null, limit: 10 }, capability, f.recheck));
  }
});

test('native status rejects a malformed principal digest', async () => {
  const f = fixture({ account: () => account({ principal_digest: 'not-a-digest' }) });
  await denied(f.provider.assertConnected(scope, capability, f.recheck));
});

test('foreign resolver context and expired capability fail before provider access', async () => {
  const base = fixture();
  const foreign = new RegisteredEmailMailboxProvider(async () => ({ adapter: base.adapter,
    context: { ...context, account_id: 'account-b' } }), () => 1000);
  await denied(foreign.assertConnected(scope, capability, base.recheck));
  const expired = { ...capability, expires_at: 999 };
  await denied(base.provider.readPage(scope, { cursor: null, limit: 10 }, expired, base.recheck));
  assert.equal(base.counts().reads, 0);
});

test('cancellation before or during provider work rejects without returning a page', async () => {
  const before = fixture(); const already = new AbortController(); already.abort();
  await assert.rejects(before.provider.readPage(scope, { cursor: null, limit: 10 }, capability, before.recheck, already.signal));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ read: async () => { await held; return page; } });
  const controller = new AbortController();
  const pending = f.provider.readPage(scope, { cursor: null, limit: 10 }, capability, f.recheck, controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); release();
  await assert.rejects(pending);
});

test('provider errors propagate and are never converted into empty successful pages', async () => {
  const failure = new Error('provider fixture failure');
  const f = fixture({ read: async () => { throw failure; } });
  await assert.rejects(f.provider.readPage(scope, { cursor: null, limit: 10 }, capability, f.recheck), error => error === failure);
});

test('provider custody uses its distinct SQL-only recheck while outer authority checks stay outside held I/O', async () => {
  let insideProvider = false, outerCalls = 0, nativeChecks = 0;
  const adapter: AppConnectionAdapter = {
    handle: async () => new Response(), nativeEmailAccount: async () => account(),
    nativeEmailPage: async (_input, nativeContext) => {
      insideProvider = true;
      try {
        await nativeContext.recheck(); nativeChecks++;
        return page;
      } finally { insideProvider = false; }
    },
  };
  const resolver: NativeEmailConnectionResolver = async (_scope, _capability, _outer, signal) => ({ adapter,
    context: { ...context, recheck: async () => {}, signal } });
  const provider = new RegisteredEmailMailboxProvider(resolver, () => 1000);
  const outerRecheck = async () => { outerCalls++; if (insideProvider) throw new Error('outer authority check ran under custody lock'); };
  assert.deepEqual(await provider.readPage(scope, { cursor: null, limit: 10 }, capability, outerRecheck), page);
  assert.equal(nativeChecks, 1);
  assert.equal(outerCalls, 2);
  assert.equal(insideProvider, false);
});

test('native source rebases only current enrolled account epoch and destroys bytes on late custody change',async()=>{
  const source={schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,provider:'gmail',
    logical_message_id:'mail_'+'b'.repeat(64),authority_epoch:1,locator:{message_id:'private-id'}};
  for(const change of [false,true]){
    let calls=0;const f=fixture({account:()=>++calls>1&&change?account({connection_revision:4}):account()});
    const bytes=new Uint8Array([1,2,3]);
    f.adapter.nativeEmailSource=async input=>{
      assert.equal(input.source.authority_epoch,2);assert.equal(source.authority_epoch,1);
      return {schema_version:'deft.email_source.v1',account_id:scope.account_id,provider:'gmail',source_kind:'provider_original',
        media_type:'message/rfc822',byte_length:3,digest:'d'.repeat(64),mime_bytes:bytes};
    };
    const result=f.provider.readSource(scope,{source},capability,f.recheck);
    if(change){await denied(result);assert.deepEqual([...bytes],[0,0,0]);}
    else assert.equal((await result).mime_bytes,bytes);
    await denied(f.provider.readSource(scope,{source:{...source,account_id:'another'}},capability,f.recheck));
  }
});

const searchQuery='from:alice subject:"résumé"';
const searchRecord={account_id:scope.account_id,logical_message_id:'mail_'+'b'.repeat(64),revision:'native-search-revision',received_at:null,
  folders:['inbox'],flags:{seen:false,flagged:false,answered:false},data:{subject:'résumé'},provider_source:{schema_version:'deft.email_provider_source.v1',
    account_id:scope.account_id,provider:'gmail',logical_message_id:'mail_'+'b'.repeat(64),authority_epoch:2,locator:{message_id:'private-search-message'}}};
const searchPage=():NativeEmailSearchPage=>({schema_version:'deft.email_search_page.v1',status:'supported',account_id:scope.account_id,provider:'gmail',original_query:searchQuery,
  items:[structuredClone(searchRecord)],next_cursor:null,has_more:false,query_complete:true,observed_at:new Date(1000).toISOString(),failure_count:0,provider_result_cap:null,
  limitations:['provider_tokenization'],unsupported:[]});
test('native search wrapper preserves exact query, stable records and honest unsupported result under fresh statuses',async()=>{
  const f=fixture();let calls=0;f.adapter.nativeEmailSearch=async input=>{calls++;assert.deepEqual(input,{query:searchQuery,cursor:null,limit:10});return searchPage();};
  const result=await f.provider.readSearch(scope,{query:searchQuery,cursor:null,limit:10},capability,f.recheck);
  assert.equal(result.items[0]!.logical_message_id,searchRecord.logical_message_id);assert.equal(result.query_complete,true);assert.equal(result.original_query,searchQuery);assert.equal(calls,1);
  f.adapter.nativeEmailSearch=async()=>({...searchPage(),status:'unsupported',items:[],query_complete:false,unsupported:[{index:0,field:'in',reason:'unknown_operator'}]});
  const unsupported=await f.provider.readSearch(scope,{query:searchQuery,cursor:null,limit:10},capability,f.recheck);assert.equal(unsupported.status,'unsupported');assert.deepEqual(unsupported.items,[]);
});
test('native search held credential revision/principal/revocation and abort deny matches',async()=>{
  for(const change of [account({connection_revision:4}),account({principal_digest:'e'.repeat(64)}),account({health:'revoked'})]){
    let statuses=0;const f=fixture({account:()=>++statuses>1?change:account()});f.adapter.nativeEmailSearch=async()=>searchPage();
    await denied(f.provider.readSearch(scope,{query:searchQuery,cursor:null,limit:10},capability,f.recheck));
  }
  const controller=new AbortController(),f=fixture();f.adapter.nativeEmailSearch=async()=>{controller.abort();return searchPage();};
  await assert.rejects(f.provider.readSearch(scope,{query:searchQuery,cursor:null,limit:10},capability,f.recheck,controller.signal));
});
test('native search rejects foreign/duplicate/private-source records, false coverage, ignored query, stalled cursor and over-limit pages',async()=>{
  const changes=[(page:any)=>({...page,original_query:'different'}),(page:any)=>({...page,account_id:'other'}),
    (page:any)=>({...page,items:[{...page.items[0],account_id:'other'}]}),(page:any)=>({...page,items:[page.items[0],page.items[0]]}),
    (page:any)=>({...page,items:[{...page.items[0],provider_source:{...page.items[0].provider_source,logical_message_id:'mail_'+'c'.repeat(64)}}]}),
    (page:any)=>({...page,items:[{...page.items[0],provider_source:{...page.items[0].provider_source,authority_epoch:1}}]}),
    (page:any)=>({...page,provider:'microsoft',provider_result_cap:1000}),
    (page:any)=>({...page,status:'unsupported',unsupported:[{index:0,field:'in',reason:'unknown_operator'}]}),
    (page:any)=>({...page,next_cursor:'held-cursor',has_more:true,query_complete:false}),
    (page:any)=>({...page,query_complete:false,failure_count:10})];
  for(const change of changes){const f=fixture();f.adapter.nativeEmailSearch=async()=>change(searchPage());
    await assert.rejects(f.provider.readSearch(scope,{query:searchQuery,cursor:'held-cursor',limit:10},capability,f.recheck));}
});
test('native search invalid request or unsupported adapter fails before search; provider failure is preserved',async()=>{
  const f=fixture();let calls=0;f.adapter.nativeEmailSearch=async()=>{calls++;return searchPage();};
  for(const request of [{query:searchQuery,cursor:null,limit:101},{query:searchQuery,cursor:null,limit:10,url:'https://attacker.invalid'},{query:'',cursor:null,limit:10}])
    await assert.rejects(f.provider.readSearch(scope,request as any,capability,f.recheck));
  assert.equal(calls,0);assert.equal(f.counts().resolveCalls,0);
  const failure=new Error('synthetic search failure');f.adapter.nativeEmailSearch=async()=>{throw failure;};
  await assert.rejects(f.provider.readSearch(scope,{query:searchQuery,cursor:null,limit:10},capability,f.recheck),error=>error===failure);
  delete f.adapter.nativeEmailSearch;await denied(f.provider.readSearch(scope,{query:searchQuery,cursor:null,limit:10},capability,f.recheck));
});
