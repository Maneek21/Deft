import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExperienceBridge, parseExperienceView, type ExperiencePin, type ExperiencePort } from './app-experience-bridge';
import { createDeftExperienceSdk } from '../../../../packages/app-kit/src/experience-core';
import {createExperienceConnection} from './app-experience-connection';
const unavailable=(requestId:string)=>({version:'deft.experience_bridge.v1',kind:'response',session_id:pin.session_id,request_id:requestId,ok:false,code:'UNAVAILABLE'});

test('app-data mailbox read SDK call expires while live authority is unavailable without later dispatch', async () => {
  let available=false,calls=0;
  const connection=createExperienceConnection({current:()=>true,valid:()=>true,read:async()=>available?'available':'unavailable',change:()=>{}});
  const host=new FakePort();
  const worker={onmessage:null as ((event:MessageEvent)=>void)|null,postMessage:(message:unknown)=>host.receive(message),close:()=>{}};
  host.postMessage=(message:unknown)=>{host.sent.push(message);worker.onmessage?.({data:message} as MessageEvent);};
  const bridge=createExperienceBridge({port:host,pin,resourceKeys:[],storeKeys:['drafts'],actionKeys:[],readTimeoutMs:20,
    broker:{isLive:(_pin,signal)=>connection.ensure(signal),appData:async()=>{calls++;return {outcome:'completed'};}},onView:()=>{}});
  const sdk=createDeftExperienceSdk(worker,pin.session_id);
  const result=sdk.listRecords('drafts').then(()=> 'disclosed',error=>error.message);
  assert.equal(await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve('hung'),100))]),'UNAVAILABLE');
  assert.equal(calls,0);assert.equal(bridge.active,true);
  available=true;await connection.check();await delay();assert.equal(calls,0);
  assert.equal(host.sent.length,1);sdk.close();bridge.revoke();connection.dispose();
});

test('mailbox refresh timeout aborts its one call, discards late data and permits a later explicit read', async () => {
  const port=new FakePort();let release!:(value:unknown)=>void,signal!:AbortSignal,calls=0;
  const bridge=createExperienceBridge({port,pin,resourceKeys:[],storeKeys:['drafts'],actionKeys:[],readTimeoutMs:20,
    broker:{isLive:()=>true,appData:async(_pin,_key,_input,activeSignal)=>{calls++;signal=activeSignal;return calls===1?new Promise(resolve=>{release=resolve;}):{outcome:'completed'};}},onView:()=>{}});
  port.receive(message(1,{kind:'request',request_id:'request_1',operation:'app_data',key:'drafts',input:{operation:'resource_refresh',input:{store_key:'drafts',resource_key:'inbox'}}}));
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal(signal.aborted,true);
  assert.equal((port.sent[0] as {code:string}).code,'UNAVAILABLE');assert.equal(calls,1);
  release({secret:'late private data'});await delay();assert.equal(port.sent.length,1);
  port.receive(message(2,{kind:'request',request_id:'request_2',operation:'app_data',key:'drafts',input:{operation:'record_list',input:{store_key:'drafts',cursor:null,limit:10}}}));
  await delay();assert.equal((port.sent[1] as {ok:boolean}).ok,true);assert.equal(calls,2);bridge.revoke();
});

test('mailbox read deadline covers final authority check and never reveals returned stale data', async () => {
  const port=new FakePort();let checks=0,release!:(value:boolean)=>void;
  const bridge=createExperienceBridge({port,pin,resourceKeys:[],storeKeys:['drafts'],actionKeys:[],readTimeoutMs:20,
    broker:{isLive:()=>++checks===1?true:new Promise(resolve=>{release=resolve;}),appData:async()=>({secret:'protected'})},onView:()=>{}});
  port.receive(message(1,{kind:'request',request_id:'request_1',operation:'app_data',key:'drafts',input:{operation:'record_read',input:{store_key:'drafts',record_id:'11111111-1111-4111-8111-111111111111'}}}));
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal((port.sent[0] as {code:string}).code,'UNAVAILABLE');
  release(true);await delay();assert.equal(port.sent.length,1);assert.equal(JSON.stringify(port.sent).includes('protected'),false);bridge.revoke();
});

test('revoked reads and bounded creates settle uncertainty once; ordinary actions retain their lifetime', async () => {
  const port=new FakePort();const bridge=createExperienceBridge({port,pin,resourceKeys:[],storeKeys:['drafts'],actionKeys:[],readTimeoutMs:10,
    broker:{isLive:()=>new Promise(()=>{})},onView:()=>{}});
  port.receive(message(1,{kind:'request',request_id:'request_1',operation:'app_data',key:'drafts',input:{operation:'record_list',input:{store_key:'drafts',cursor:null,limit:10}}}));
  bridge.revoke();await new Promise(resolve=>setTimeout(resolve,25));assert.deepEqual(port.sent,[unavailable('request_1')]);
  for(const operation of ['app_data','action']){
    const target=new FakePort();let release!:(value:unknown)=>void,calls=0;
    const own=createExperienceBridge({port:target,pin,resourceKeys:[],storeKeys:['drafts'],actionKeys:['send_message'],readTimeoutMs:10,
      broker:{isLive:()=>true,appData:async()=>{calls++;return new Promise(resolve=>{release=resolve;});},action:async()=>{calls++;return new Promise(resolve=>{release=resolve;});}},onView:()=>{}});
    target.receive(message(1,{kind:'request',request_id:'request_1',operation,key:operation==='action'?'send_message':'drafts',input:operation==='action'?{}:{operation:'record_create',input:{store_key:'drafts',record_id:'11111111-1111-4111-8111-111111111111',value:{}}}}));
    await new Promise(resolve=>setTimeout(resolve,25));assert.equal(calls,1);
    if(operation==='app_data')assert.deepEqual(target.sent,[unavailable('request_1')]);else assert.equal(target.sent.length,0);
    release({completed:true});await delay();if(operation==='app_data'){assert.deepEqual(target.sent,[unavailable('request_1')]);assert.equal(calls,1);}else assert.equal((target.sent[0] as {ok:boolean}).ok,true);own.revoke();
  }
});

test('resource-document views require an explicit version, negotiated capability and declared key', () => {
  const root = { kind: 'resource_document', id: 'body', profile_version: 'deft.resource_document.v1',
    resource_key: 'messages', record_id: '11111111-1111-4111-8111-111111111111' };
  const view = { schema_version: 'deft.experience_view.v2', capabilities: ['resource_document.v1'], root };
  const options = { capabilities: ['resource_document.v1'] as const, resourceKeys: ['messages'] };
  assert.deepEqual(parseExperienceView(view, options), view);
  assert.equal(parseExperienceView(view), null);
  assert.equal(parseExperienceView({ root }, options), null);
  assert.equal(parseExperienceView(view, { ...options, resourceKeys: ['other'] }), null);
  assert.equal(parseExperienceView({ ...view, schema_version: 'deft.experience_view.v99' }, options), null);
  for (const extra of [{ record_id: 'provider-id' }, { url: 'https://mail.test' }, { content: 'raw body' }])
    assert.equal(parseExperienceView({ ...view, root: { ...root, ...extra } }, options), null);
  const legacy = { root: { kind: 'document', id: 'body', format: 'plain', content: 'Legacy' } };
  assert.deepEqual(parseExperienceView(legacy), legacy);
});

test('bridge revokes resource-document references outside its trusted declaration', async () => {
  const root = { kind: 'resource_document', id: 'body', profile_version: 'deft.resource_document.v1',
    resource_key: 'messages', record_id: '11111111-1111-4111-8111-111111111111' };
  const view = { schema_version: 'deft.experience_view.v2', capabilities: ['resource_document.v1'], root };
  for (const capabilities of [[], ['resource_document.v1']] as const) {
    const port = new FakePort();
    const bridge = createExperienceBridge({ port, pin, resourceKeys: ['other'], capabilities, actionKeys: [],
      broker: { isLive: () => true }, onView: () => assert.fail('Unreviewed resource was mounted') });
    port.receive(message(1, { kind: 'view', view })); await delay();
    assert.equal(bridge.active, false);
  }
});

const nestedView = (depth: number) => {
  let node: unknown = { kind: 'canvas', id: 'canvas', strokes: [{ points: [{ x: 0, y: 1 }] }] };
  for (let i = 0; i < depth; i++) node = { kind: 'stack', id: `stack_${i}`, children: [node] };
  return { root: node };
};

test('view transport accepts the full depth-eight grammar without increasing request depth', async () => {
  const port = new FakePort(), views: unknown[] = [];
  const bridge = createExperienceBridge({ port, pin, resourceKeys: [], actionKeys: [],
    broker: { isLive: () => true }, onView: view => views.push(view) });
  const deepest = nestedView(8);
  assert.ok(parseExperienceView(deepest));
  port.receive(message(1, { kind: 'view', view: deepest }));
  await delay();
  assert.deepEqual(views, [deepest]);
  assert.equal(bridge.active, true);
  bridge.revoke();
});

test('view transport rejects excess node depth, malformed deep views and unknown envelope fields', async () => {
  let deep: unknown = null;
  for (let i = 0; i < 24; i++) deep = { child: deep };
  for (const envelope of [
    { kind: 'view', view: nestedView(9) },
    { kind: 'view', view: { root: deep } },
    { kind: 'view', view: nestedView(8), extra: true },
  ]) {
    const port = new FakePort(), views: unknown[] = [];
    const bridge = createExperienceBridge({ port, pin, resourceKeys: [], actionKeys: [],
      broker: { isLive: () => true }, onView: view => views.push(view) });
    port.receive(message(1, envelope));
    await delay();
    assert.equal(bridge.active, false);
    assert.equal(port.closed, true);
    assert.deepEqual(views, []);
  }
});

test('non-view request transport retains its depth-twelve bound', async () => {
  let deep: unknown = null;
  for (let i = 0; i < 13; i++) deep = { child: deep };
  const port = new FakePort(); let calls = 0;
  const bridge = createExperienceBridge({ port, pin, resourceKeys: ['inbox'], actionKeys: [],
    broker: { isLive: () => true, resource: async () => { calls++; return {}; } }, onView: () => undefined });
  port.receive(message(1, { kind: 'request', request_id: 'request_1', operation: 'resource', key: 'inbox', input: deep }));
  await delay();
  assert.equal(bridge.active, false);
  assert.equal(calls, 0);
});

test('preferences uses the shared view budget and cannot collide with content or navigation IDs',()=>{
 const root={kind:'stack',id:'root',children:[{kind:'text',id:'main_text',text:'Mail'}]};
 const preferences={kind:'stack',id:'preferences',children:[{kind:'input',id:'signature',label:'Signature',value:'Regards'}]};
 assert.ok(parseExperienceView({root,preferences}));
 assert.equal(parseExperienceView({root,preferences:{...preferences,id:'root'}}),null);
 assert.equal(parseExperienceView({root,preferences,navigation:[{kind:'button',id:'signature',label:'Intercept'}]}),null);
 assert.equal(parseExperienceView({root,preferences:{...preferences,children:[{kind:'html',id:'raw',html:'<script>bad</script>'}]}}),null);
});

const pin: ExperiencePin = Object.freeze({
  org_id: 'org_a', user_id: 'user_a', app_installation_id: 'installation_a',
  app_version_id: 'version_a', grant_snapshot_id: 'grant_a',
  lifecycle_epoch: 3, grant_epoch: 4, session_id: 'session_12345678', session_epoch: 1,
});
class FakePort implements ExperiencePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  postMessage(value: unknown) { this.sent.push(value); }
  close() { this.closed = true; }
  receive(value: unknown) { this.onmessage?.({ data: value } as MessageEvent); }
}
const view = { root: { kind:'stack', id:'root', children:[
  { kind:'grid', id:'orders', columns:['Order','Status'],
    rows:[{ id:'alpha', cells:['Alpha','Open'] }] },
  { kind:'canvas', id:'sketch', strokes:[{ points:[{x:0,y:0},{x:1,y:1}] }] },
] } };
const message = (sequence: number, value: Record<string, unknown>) => ({
  version:'deft.experience_bridge.v1', session_id:pin.session_id, sequence, ...value,
});
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('document views transport bounded hostile plain or HTML for independent host sanitization',()=>{
 const document={kind:'document',id:'body',format:'plain',content:'<img src="https://tracker.example.test/pixel" onerror="alert(1)"><script>alert(1)</script>',truncated:false};
 assert.deepEqual(parseExperienceView({root:document}),{root:document});assert.ok(parseExperienceView({root:{...document,content:'x'.repeat(16384)}}));
 const html={...document,format:'html',printable:true,title:'Message'};assert.deepEqual(parseExperienceView({root:html}),{root:html});
 for(const root of [{...document,format:'markdown'},{...document,source_print:true},{...document,content:'x'.repeat(16385)},{...document,truncated:'false'},{...document,content:'a\0b'},{...document,printable:'true'},{...document,title:'x'.repeat(201)}])assert.equal(parseExperienceView({root}),null);
});

test('native print controls reference exactly one same-view button and a printable current document', () => {
 const document={kind:'document',id:'body',format:'plain',content:'Body',printable:true,print_control_id:'print_body'};
 const button={kind:'button',id:'print_body',label:'Print'};
 const root={kind:'stack',id:'root',children:[button,document]};
 assert.ok(parseExperienceView({root}));
 for(const children of [[document],[{kind:'text',id:'print_body',text:'Print'},document],[button,{...document,printable:false}],[button,document,{...document,id:'second_body'}],[button,button,document]])assert.equal(parseExperienceView({root:{...root,children}}),null);
 assert.equal(parseExperienceView({root:document,navigation:[button]}),null,'navigation cannot impersonate a document-local print button');
});

test('document bridge returns bounded plain content through the public SDK and drops late revoked reads',async()=>{
 const hostPort=new FakePort(),authorPort=new FakePort();hostPort.postMessage=value=>{hostPort.sent.push(value);authorPort.receive(structuredClone(value));};authorPort.postMessage=value=>hostPort.receive(structuredClone(value));
 const recordId='12345678-1234-4234-8234-123456789012',document={format:'plain',content:'x'.repeat(16384),truncated:false,metadata:{account_id:'account',verified_sender_identities:'x'.repeat(8192)}};
 let live=true,release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let calls=0;
 const bridge=createExperienceBridge({port:hostPort,pin,resourceKeys:['inbox'],actionKeys:[],broker:{isLive:()=>live,resource:async(_pin,key,input)=>{assert.equal(key,'inbox');assert.deepEqual(input,{operation:'read_document',record_id:recordId});if(++calls===2)await held;return document;}},onView:()=>undefined});
 const sdk=createDeftExperienceSdk(authorPort,pin.session_id);
 try{assert.deepEqual(await sdk.readResourceDocument('inbox',recordId),document);const reading=sdk.readResourceDocument('inbox',recordId).catch(()=>undefined);await delay();live=false;release();await delay();const responses=hostPort.sent.filter(value=>(value as {kind?:string}).kind==='response');assert.equal(responses.length,2);assert.deepEqual(responses[1],unavailable('request_2'));assert.equal((responses[0] as {ok:boolean}).ok,true);assert.equal(bridge.active,false);sdk.close();await reading;}
 finally{sdk.close();bridge.revoke();}
});

test('sidebar navigation accepts bounded buttons and rejects routes, collisions and other nodes', () => {
  const root = { kind: 'text', id: 'content', text: 'Content' };
  const item = { kind: 'button', id: 'inbox', label: 'Inbox', selected: true, disabled: false };
  assert.deepEqual(parseExperienceView({ root, navigation: [item] }), { root, navigation: [item] });
  assert.equal(parseExperienceView({ root, navigation: [{ ...item, href: '/settings' }] }), null);
  assert.equal(parseExperienceView({ root, navigation: [root] }), null);
  assert.equal(parseExperienceView({ root, navigation: [item, item] }), null);
  assert.equal(parseExperienceView({ root, navigation: [{ ...item, id: 'content' }] }), null);
  assert.equal(parseExperienceView({ root, navigation: Array.from({ length: 17 }, (_, i) => ({ ...item, id: `nav_${i}` })) }), null);
  assert.deepEqual(parseExperienceView({ root }), { root });
});

test('public SDK sidebar clicks use the existing live session and stop after revocation', async () => {
  const hostPort = new FakePort(), authorPort = new FakePort();
  hostPort.postMessage = value => { hostPort.sent.push(value); authorPort.receive(structuredClone(value)); };
  authorPort.postMessage = value => hostPort.receive(structuredClone(value));
  let live = true; const views: unknown[] = [], events: unknown[] = [];
  const bridge = createExperienceBridge({ port: hostPort, pin, resourceKeys: [], actionKeys: [],
    broker: { isLive: () => live }, onView: view => views.push(view) });
  const sdk = createDeftExperienceSdk(authorPort, pin.session_id);
  sdk.onEvent(event => events.push(event));
  const view = { root: { kind: 'text', id: 'content', text: 'Inbox' }, navigation: [{ kind: 'button', id: 'sent', label: 'Sent' }] };
  try {
    sdk.render(view); await delay(); assert.deepEqual(views, [view]);
    assert.equal(await bridge.sendUiEvent({ kind: 'click', node_id: 'sent' }), true);
    assert.deepEqual(events, [{ kind: 'click', node_id: 'sent' }]);
    live = false;
    assert.equal(await bridge.sendUiEvent({ kind: 'click', node_id: 'sent' }), false);
    assert.equal(events.length, 1);
  } finally { sdk.close(); bridge.revoke(); }
});

test('public SDK opens declared source through host without receiving a locator or file content', async () => {
  const hostPort = new FakePort(), authorPort = new FakePort();
  hostPort.postMessage = value => { hostPort.sent.push(value); authorPort.receive(structuredClone(value)); };
  authorPort.postMessage = value => { authorPort.sent.push(value); hostPort.receive(structuredClone(value)); };
  const recordId = '12345678-1234-4234-8234-123456789012'; let calls = 0;
  const bridge = createExperienceBridge({ port: hostPort, pin, resourceKeys: ['inbox'], actionKeys: [],
    broker: { isLive: () => true, openResource: async (_pin, key, input) => {
      assert.equal(key, 'inbox'); assert.deepEqual(input, { record_id: recordId }); calls++; return { opened: true };
    } }, onView: () => undefined });
  const sdk = createDeftExperienceSdk(authorPort, pin.session_id);
  try {
    assert.deepEqual(await sdk.openResource('inbox', recordId), { opened: true }); assert.equal(calls, 1);
    assert.equal(JSON.stringify(hostPort.sent).includes(recordId), false);
    await assert.rejects(sdk.openResource('inbox', 'https://example.test/arbitrary'), /Invalid record locator/);
    hostPort.receive(message(2, { kind: 'request', request_id: 'request_2', operation: 'open_resource', key: 'undeclared', input: { record_id: recordId } }));
    await delay(); assert.equal(bridge.active, false); assert.equal(calls, 1);
  } finally { sdk.close(); bridge.revoke(); }
});

test('public SDK optional undefined request fields preserve Run status and keyed action dispatch', async () => {
  const hostPort = new FakePort(), authorPort = new FakePort();
  hostPort.postMessage = value => { hostPort.sent.push(value); authorPort.receive(structuredClone(value)); };
  authorPort.postMessage = value => { authorPort.sent.push(value); hostPort.receive(structuredClone(value)); };
  let statusCalls = 0, actionCalls = 0;
  const run = { id: 'run_test', state: 'succeeded' };
  const bridge = createExperienceBridge({ port: hostPort, pin, resourceKeys: [], actionKeys: ['send_message'],
    broker: { isLive: () => true, runStatus: async () => { statusCalls += 1; return run; },
      action: async (_pin, key, input) => { assert.equal(key, 'send_message'); assert.equal(input, undefined); actionCalls += 1; return run; } },
    onView: () => undefined });
  const sdk = createDeftExperienceSdk(authorPort, pin.session_id);
  try {
    assert.deepEqual(await sdk.request('run_status', undefined, { run_id: run.id }), run);
    assert.deepEqual(await sdk.request('action', 'send_message'), run);
    assert.equal(statusCalls, 1); assert.equal(actionCalls, 1); assert.equal(bridge.active, true);
    assert.ok(Object.hasOwn(authorPort.sent[0] as object, 'key'));
    assert.ok(Object.hasOwn(authorPort.sent[1] as object, 'input'));
  } finally { sdk.close(); bridge.revoke(); }
});

test('optional envelope normalization still denies unknown undefined fields nested undefined and Run status keys', async () => {
  for (const fields of [{ extra: undefined, key: undefined, input: { run_id: 'run_test' } },
    { key: undefined, input: { run_id: 'run_test', nested: undefined } },
    { key: 'send_message', input: { run_id: 'run_test' } }]) {
    const port = new FakePort(); let calls = 0;
    const bridge = createExperienceBridge({ port, pin, resourceKeys: [], actionKeys: ['send_message'],
      broker: { isLive: () => true, runStatus: async () => { calls += 1; return {}; } }, onView: () => undefined });
    port.receive(structuredClone(message(1, { kind: 'request', request_id: 'request_1', operation: 'run_status', ...fields })));
    await delay(); assert.equal(bridge.active, false); assert.equal(port.closed, true); assert.equal(calls, 0);
  }
});

test('bounded rich view accepted; spoofed session and replay close the port', async () => {
  const port = new FakePort();
  const views: unknown[] = [];
  const bridge = createExperienceBridge({
    port, pin, resourceKeys:[], actionKeys:[],
    broker:{ isLive:()=>true }, onView:(value)=>views.push(value),
  });
  port.receive(message(1, { kind:'view', view }));
  await delay();
  assert.equal(views.length, 1);
  port.receive(message(1, { kind:'view', view }));
  assert.equal(bridge.active, false);
  assert.equal(port.closed, true);
  const other = new FakePort();
  const spoof = createExperienceBridge({
    port:other, pin, resourceKeys:[], actionKeys:[],
    broker:{ isLive:()=>true }, onView:()=>undefined,
  });
  other.receive({ ...message(1, {kind:'view', view}), session_id:'session_foreign' });
  assert.equal(spoof.active, false);
});

test('host stamps exact pin and drops late resource response after revocation', async () => {
  const port = new FakePort();
  let finish!: (value: unknown) => void;
  let suppliedPin: ExperiencePin | undefined;
  let suppliedSignal: AbortSignal | undefined;
  const pending = new Promise<unknown>((resolve) => { finish = resolve; });
  const bridge = createExperienceBridge({
    port, pin, resourceKeys:['orders'], actionKeys:[],
    broker:{ isLive:()=>true, resource:async (authority, key, input, signal) => {
      suppliedPin = authority; suppliedSignal = signal;
      assert.equal(key, 'orders'); assert.deepEqual(input, { page:1 });
      return pending;
    } }, onView:()=>undefined,
  });
  port.receive(message(1, { kind:'request', request_id:'request_1',
    operation:'resource', key:'orders', input:{page:1} }));
  await delay();
  assert.deepEqual(suppliedPin, pin);
  bridge.revoke();
  finish({ records:['late'] });
  await delay();
  assert.equal(suppliedSignal?.aborted, true);
  assert.deepEqual(port.sent,[unavailable('request_1')]);
  assert.equal(JSON.stringify(port.sent).includes('late'),false);
});

test('wrong action key, malformed payload and flood fail closed before callbacks', async () => {
  let calls = 0;
  const port = new FakePort();
  const bridge = createExperienceBridge({
    port, pin, resourceKeys:[], actionKeys:['submit'],
    broker:{ isLive:()=>true, action:async()=>{ calls++; return {run_id:'run_a'}; } },
    onView:()=>undefined,
  });
  port.receive(message(1, { kind:'request', request_id:'request_1',
    operation:'action', key:'other', input:{} }));
  assert.equal(bridge.active, false);
  assert.equal(calls, 0);

  const cycle: {self?: unknown} = {}; cycle.self = cycle;
  const cyclePort = new FakePort();
  const cycleBridge = createExperienceBridge({
    port:cyclePort, pin, resourceKeys:[], actionKeys:[],
    broker:{ isLive:()=>true }, onView:()=>undefined,
  });
  cyclePort.receive(message(1, { kind:'view', view:cycle }));
  assert.equal(cycleBridge.active, false);

  const floodPort = new FakePort();
  const flood = createExperienceBridge({
    port:floodPort, pin, resourceKeys:[], actionKeys:[],
    broker:{ isLive:()=>true }, onView:()=>undefined, now:()=>1000,
  });
  for (let sequence=1; sequence<=101; sequence++) {
    floodPort.receive(message(sequence, { kind:'view', view }));
  }
  assert.equal(flood.active, false);
});

test('missing action callback fails closed and stale live authority drops result', async () => {
  const port = new FakePort();
  let live = true;
  const bridge = createExperienceBridge({
    port, pin, resourceKeys:[], actionKeys:['submit'],
    broker:{ isLive:()=>live }, onView:()=>undefined,
  });
  port.receive(message(1, { kind:'request', request_id:'request_1',
    operation:'action', key:'submit', input:{} }));
  await delay();
  assert.deepEqual(port.sent[0], {
    version:'deft.experience_bridge.v1', kind:'response',
    session_id:pin.session_id, request_id:'request_1', ok:false, code:'UNAVAILABLE',
  });
  live = false;
  port.receive(message(2, {kind:'view', view}));
  await delay();
  assert.equal(bridge.active, false);
});

test('UI events are dropped when the live pin is revoked', async () => {
  const port = new FakePort();
  let live = true;
  const bridge = createExperienceBridge({
    port, pin, resourceKeys:[], actionKeys:[],
    broker:{ isLive:()=>live }, onView:()=>undefined,
  });
  assert.equal(await bridge.sendUiEvent({ kind:'click', node_id:'submit' }), true);
  assert.equal(port.sent.length, 1);
  live = false;
  assert.equal(await bridge.sendUiEvent({ kind:'click', node_id:'submit' }), false);
  assert.equal(port.sent.length, 1);
  assert.equal(bridge.active, false);
});

test('input change reaches the Worker before a rapid submit click', async () => {
  const port = new FakePort();
  let releaseFirst!: () => void;
  const firstLive = new Promise<boolean>((resolve) => { releaseFirst = () => resolve(true); });
  let checks = 0;
  const bridge = createExperienceBridge({
    port, pin, resourceKeys: [], actionKeys: [],
    broker: { isLive: () => ++checks === 1 ? firstLive : true },
    onView: () => undefined,
  });
  const changed = bridge.sendUiEvent({ kind: 'input', node_id: 'shipment', value: 'parcel-1' });
  const clicked = bridge.sendUiEvent({ kind: 'click', node_id: 'submit' });
  await delay();
  assert.equal(port.sent.length, 0);
  releaseFirst();
  assert.equal(await changed, true);
  assert.equal(await clicked, true);
  assert.deepEqual((port.sent as Array<{event: {kind: string}}>).map((item) => item.event.kind),
    ['input', 'click']);
});

test('resource response bounds cover the entire envelope and withdrawal drops late data', async () => {
  const port = new FakePort();
  let resolveRead!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveRead = resolve; });
  const bridge = createExperienceBridge({ port, pin, resourceKeys: ['inbox'], actionKeys: [],
    broker: { isLive: () => true, resource: () => pending }, onView: () => undefined });
  port.receive(message(1, { kind: 'request', request_id: 'request_1', operation: 'resource', key: 'inbox', input: {} }));
  await delay();
  bridge.revoke();
  resolveRead({ private_body: 'late' });
  await delay();
  assert.deepEqual(port.sent,[unavailable('request_1')]);
  assert.equal(JSON.stringify(port.sent).includes('private_body'),false);
  const boundedPort = new FakePort();
  createExperienceBridge({ port: boundedPort, pin, resourceKeys: ['inbox'], actionKeys: [],
    broker: { isLive: () => true, resource: async () => Array.from({ length: 15 }, () => 'x'.repeat(4095)) }, onView: () => undefined });
  boundedPort.receive(message(1, { kind: 'request', request_id: 'request_1', operation: 'resource', key: 'inbox', input: {} }));
  await delay();
  assert.equal((boundedPort.sent[0] as any).code, 'RESOURCE_PAYLOAD_TOO_LARGE');
  assert.equal((boundedPort.sent[0] as any).output, undefined);
});


test('safe presentation options round-trip without admitting author HTML or CSS', () => {
  const rich = { root: { kind: 'stack', id: 'root', layout: 'split', surface: 'panel', mobile: 'only', children: [
    { kind: 'text', id: 'title', text: '<b>Literal title</b>', tone: 'heading' },
    { kind: 'button', id: 'message', label: 'Sender', variant: 'list', description: 'Preview', meta: '10:00', selected: true, disabled: false },
    { kind: 'input', id: 'body', label: 'Message', value: 'Draft', multiline: true, placeholder: 'Write a message' },
  ] } };
  assert.deepEqual(parseExperienceView(rich), rich);
  assert.deepEqual(parseExperienceView(view), view);
  assert.deepEqual(parseExperienceView({ root: { kind: 'stack', id: 'list', layout: 'list', children: [] } }),
    { root: { kind: 'stack', id: 'list', layout: 'list', children: [] } });
  const cases = [
    { kind: 'text', id: 'title', text: 'Hello', tone: 'html' },
    { kind: 'text', id: 'title', text: 'Hello', html: '<b>Hello</b>' },
    { kind: 'button', id: 'send', label: 'Send', style: { color: 'red' } },
    { kind: 'button', id: 'send', label: 'Send', variant: 'link' },
    { kind: 'button', id: 'send', label: 'Send', selected: 'true' },
    { kind: 'button', id: 'send', label: 'Send', disabled: 1 },
    { kind: 'button', id: 'send', label: 'Send', description: 'x'.repeat(513) },
    { kind: 'button', id: 'send', label: 'Send', meta: 'x'.repeat(81) },
    { kind: 'input', id: 'body', label: 'Body', value: '', multiline: 'true' },
    { kind: 'input', id: 'body', label: 'Body', value: '', placeholder: 'x'.repeat(129) },
    { kind: 'stack', id: 'root', children: [], layout: 'absolute' },
    { kind: 'stack', id: 'root', children: [], surface: 'glass' },
    { kind: 'stack', id: 'root', children: [], mobile: 'always' },
    { kind: 'stack', id: 'root', children: [], layout: { toString: () => 'split' } },
  ];
  for (const root of cases) assert.equal(parseExperienceView({ root }), null);
});


test('flat workspace presentation stays symbolic and bounded', () => {
  const workspace = { root: { kind: 'stack', id: 'root', layout: 'workspace', children: [
    { kind: 'stack', id: 'toolbar', layout: 'toolbar', children: [
      { kind: 'button', id: 'compose', label: 'Compose', icon: 'compose' },
      { kind: 'input', id: 'search', label: 'Search', value: '', appearance: 'search' },
    ] },
    { kind: 'stack', id: 'split', layout: 'split', children: [
      { kind: 'stack', id: 'sidebar', surface: 'sidebar', children: [
        { kind: 'button', id: 'message', label: 'Subject', eyebrow: 'Sender', variant: 'list' },
      ] },
      { kind: 'stack', id: 'document', surface: 'document', children: [
        { kind: 'text', id: 'body', text: 'Literal body', tone: 'body' },
        { kind: 'input', id: 'to', label: 'To', value: '', appearance: 'inline' },
        { kind: 'input', id: 'draft', label: 'Message', value: '', multiline: true, appearance: 'body' },
      ] },
    ] },
  ] } };
  assert.deepEqual(parseExperienceView(workspace), workspace);
  for (const extra of [{ icon: '<svg onload=alert(1)>' }, { icon: 'https://example.test/icon.svg' },
    { icon: { toString: () => 'send' } }, { eyebrow: 'x'.repeat(129) }, { icon_only: true }]) {
    assert.equal(parseExperienceView({ root: { kind: 'button', id: 'send', label: 'Send', ...extra } }), null);
  }
  assert.equal(parseExperienceView({ root: { kind: 'input', id: 'body', label: 'Body', value: '', appearance: 'html' } }), null);
});


test('private state dispatch requires an explicitly declared key and live pin', async () => {
  const port = new FakePort(); let calls = 0;
  const bridge = createExperienceBridge({ port, pin, resourceKeys: [], actionKeys: [], stateKeys: ['drafts'],
    broker: { isLive: () => true, privateState: async (_pin, key, input) => { calls++; assert.equal(key, 'drafts');
      assert.deepEqual(input, { operation: 'list' }); return { operation: 'list', items: [] }; } }, onView: () => undefined });
  port.receive(message(1, { kind: 'request', request_id: 'request_1', operation: 'private_state', key: 'drafts', input: { operation: 'list' } }));
  await delay(); assert.equal(calls, 1); assert.equal(bridge.active, true);
  port.receive(message(2, { kind: 'request', request_id: 'request_2', operation: 'private_state', key: 'undeclared', input: { operation: 'list' } }));
  await delay(); assert.equal(calls, 1); assert.equal(bridge.active, false);
});


test('document print headers are bounded literal text and closed rows', () => {
 const root = {kind:'document',id:'mail_body',format:'html',content:'<p>Body</p>',printable:true,title:'Subject',metadata:[{label:'From',value:'<sender@example.test>'},{label:'Subject',value:'<script>literal</script>'}]};
 assert.deepEqual(parseExperienceView({root}),{root});
 for(const metadata of [Array(17).fill({label:'From',value:'a'}),[{label:'x'.repeat(201),value:'a'}],[{label:'From',value:'x'.repeat(2001)}],[{label:'From',value:'x\0'}],[{label:'From',value:'a',html:'<b>a</b>'}]]) assert.equal(parseExperienceView({root:{...root,metadata}}),null);
});

test('actual SDK account catalog and readonly target nominations reach the bridge without permitting target writes',async()=>{const host=new FakePort(),calls:unknown[]=[];const worker={onmessage:null as ((event:MessageEvent)=>void)|null,postMessage:(value:unknown)=>host.receive(value),close:()=>{}};host.postMessage=(value:unknown)=>{host.sent.push(value);worker.onmessage?.({data:value} as MessageEvent);};const bridge=createExperienceBridge({port:host,pin,resourceKeys:[],storeKeys:['drafts'],actionKeys:[],broker:{isLive:()=>true,appData:async(_pin,_key,input)=>{calls.push(input);return {targets:[{key:'personal',label:'Primary'}],selected_target_key:'personal'};}},onView:()=>{}});const sdk=createDeftExperienceSdk(worker,pin.session_id);const catalog=await Promise.race([sdk.listAccountTargets('drafts'),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('catalog not dispatched')),100))]).catch(error=>{sdk.close();bridge.revoke();throw error;});assert.equal(catalog.targets[0]?.key,'personal');assert.equal(bridge.active,true);await sdk.listDataResources('drafts','inbox',null,'in:inbox','secondary');assert.equal((calls[1] as {target_key:string}).target_key,'secondary');await sdk.request('app_data','drafts',{operation:'record_list',input:{store_key:'drafts',cursor:null,limit:10},target_key:'secondary'});assert.equal((calls[2] as {target_key:string}).target_key,'secondary');assert.equal(calls.length,3);sdk.close();bridge.revoke();});

test('actual bridge denies target nominations on record writes before dispatch',async()=>{const port=new FakePort();let calls=0;const bridge=createExperienceBridge({port,pin,resourceKeys:[],storeKeys:['drafts'],actionKeys:[],broker:{isLive:()=>true,appData:async()=>{calls++;return {}; }},onView:()=>{}});port.receive(message(1,{kind:'request',request_id:'request_1',operation:'app_data',key:'drafts',input:{operation:'record_create',target_key:'secondary',input:{store_key:'drafts',record_id:'11111111-1111-4111-8111-111111111111',value:{}}}}));await delay();assert.equal(bridge.active,false);assert.equal(calls,0);});

test('generic original Run inspection dispatch is bounded and passes only its UUID', async()=>{const host=new FakePort(),author=new FakePort();host.postMessage=value=>author.receive(structuredClone(value));author.postMessage=value=>host.receive(structuredClone(value));let calls=0;const bridge=createExperienceBridge({port:host,pin,resourceKeys:[],actionKeys:[],readTimeoutMs:20,broker:{isLive:()=>true,runInspect:async(_pin,input,signal)=>{calls++;assert.deepEqual(input,{run_id:'original_run'});return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}},onView:()=>{}});const sdk=createDeftExperienceSdk(author,pin.session_id);try{await assert.rejects(sdk.request('run_inspect',undefined,{run_id:'original_run'}));assert.equal(calls,1);}finally{sdk.close();bridge.revoke();}});


test('actual bridge admits a nominated resource refresh without widening record writes',async()=>{
 const port=new FakePort(),calls:unknown[]=[];
 const bridge=createExperienceBridge({port,pin,resourceKeys:['inbox'],storeKeys:['drafts'],actionKeys:[],broker:{isLive:()=>true,appData:async(_pin,_key,input)=>{calls.push(input);return {outcome:'completed'};}},onView:()=>{}});
 const input={operation:'resource_refresh',target_key:'secondary',input:{store_key:'drafts',resource_key:'inbox'}};
 port.receive(message(1,{kind:'request',request_id:'request_1',operation:'app_data',key:'drafts',input}));
 await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(calls,[input]);assert.equal(bridge.active,true);bridge.revoke();
});
