import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeftExperienceSdk } from '../src/experience-sdk.js';

class Port {
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  postMessage(value: unknown) { this.sent.push(value); }
  close() { this.closed = true; }
  receive(value: unknown) { this.onmessage?.({ data:value } as MessageEvent); }
}
test('SDK refresh optionally nominates one account while preserving the default request',async()=>{
 const port=new Port(),sdk=createDeftExperienceSdk(port,'session_12345678');
 for(const [index,target]of [undefined,'secondary'].entries()){
  const pending=sdk.refreshDataResource('drafts','inbox',target);
  assert.deepEqual((port.sent[index] as {input:unknown}).input,{operation:'resource_refresh',input:{store_key:'drafts',resource_key:'inbox'},...(target===undefined?{}:{target_key:target})});
  port.receive({version:'deft.experience_bridge.v1',kind:'response',session_id:'session_12345678',request_id:`request_${index+1}`,ok:true,output:{outcome:'completed'}});await pending;
 }
 assert.throws(()=>sdk.refreshDataResource('drafts','inbox','foreign/account'));sdk.close();
});
test('SDK named triage options and typed search nominate only the exact reviewed resource',async()=>{
 const port=new Port(),sdk=createDeftExperienceSdk(port,'session_12345678'),id='00000000-0000-4000-8000-000000000001';
 const output={schema_version:'deft.experience_triage_options.v1',account_id:'a',provider:'gmail',destinations:[{id:'INBOX',label:'Inbox',kind:'folder'}],labels:[{id:'Label_1',label:'Review queue'}],complete:true,labels_supported:true};
 const read=sdk.readTriageOptions('inbox',id);assert.deepEqual((port.sent[0] as {input:unknown}).input,{operation:'triage_options',record_id:id});
 port.receive({version:'deft.experience_bridge.v1',kind:'response',session_id:'session_12345678',request_id:'request_1',ok:true,output});assert.deepEqual(await read,output);
 const page={schema_version:'deft.experience_provider_page.v1',items:[],next_cursor:null,complete:false,observed_at:'2026-10-03T00:00:00.000Z',count:{returned:0,exact_total:null},failure_count:0};
 const pending=sdk.browseResourceRecords('inbox',{operation:'search',folder:'inbox',filters:{from:'x@example.test',has_attachments:true}});
 assert.deepEqual((port.sent[1] as {input:unknown}).input,{operation:'browse',kind:'search',folder:'inbox',filters:{from:'x@example.test',has_attachments:true}});
 port.receive({version:'deft.experience_bridge.v1',kind:'response',session_id:'session_12345678',request_id:'request_2',ok:true,output:page});assert.deepEqual(await pending,page);
 for(const options of [{operation:'search',folder:'all',query:'x',filters:{from:'x'}},{operation:'search',folder:'all',filters:{provider_query:'in:anywhere'}},{operation:'search',folder:'all',filters:{from:'x" OR in:anywhere'}}])assert.throws(()=>sdk.browseResourceRecords('inbox',options as never));
});

test('SDK provider page uses one bounded browse operation and only UUID sources/cursors', async () => {
  const port = new Port(), sdk = createDeftExperienceSdk(port, 'session_12345678'), id = '00000000-0000-4000-8000-000000000001';
  const page = { schema_version: 'deft.experience_provider_page.v1', items: [{ record_id: id, label: 'Subject', data: { subject: 'Subject' } }],
    next_cursor: id, complete: false, observed_at: '2026-10-02T00:00:00.000Z', count: { returned: 1, exact_total: null }, failure_count: 0 };
  const pending = sdk.browseResourceRecords('inbox', { operation: 'search', folder: 'all', query: 'subject' });
  assert.deepEqual((port.sent[0] as { input: unknown }).input, { operation: 'browse', kind: 'search', folder: 'all', query: 'subject' });
  port.receive({ version: 'deft.experience_bridge.v1', kind: 'response', session_id: 'session_12345678', request_id: 'request_1', ok: true, output: page });
  assert.deepEqual(await pending, page);
  for (const output of [{ ...page, provider_id: 'private' }, { ...page, next_cursor: 'provider-native-cursor' },
    { ...page, complete: true }, { ...page, items: [{ ...page.items[0], provider_source: {} }] },
    { ...page, count: { returned: 1, exact_total: 10000 } }]) {
    const reading = sdk.browseResourceRecords('inbox', { operation: 'list', folder: 'all' });
    port.receive({ version: 'deft.experience_bridge.v1', kind: 'response', session_id: 'session_12345678',
      request_id: (port.sent.at(-1) as { request_id: string }).request_id, ok: true, output });
    await assert.rejects(reading);
  }
  for (const input of [{ operation: 'list', folder: 'all', account_id: 'forged' }, { operation: 'list', folder: 'all', cursor: 'provider-native-cursor' },
    { operation: 'conversation', folder: 'all', record_id: 'provider-id' }, { operation: 'search', folder: 'all', query: ' ' }])
    assert.throws(() => sdk.browseResourceRecords('inbox', input as never));
});

test('SDK lazy document uses only a host UUID and rejects source bytes, HTML and unbounded metadata',async()=>{
  const port=new Port(),sdk=createDeftExperienceSdk(port,'session_12345678'),id='00000000-0000-4000-8000-000000000001';
  const output={format:'plain',content:'private body'.repeat(800),truncated:false,metadata:{title:'Reviewed title'}};
  const read=sdk.readResourceDocument('documents',id);
  assert.deepEqual((port.sent[0] as {input:unknown}).input,{operation:'read_document',record_id:id});
  port.receive({version:'deft.experience_bridge.v1',kind:'response',session_id:'session_12345678',request_id:'request_1',ok:true,output});
  assert.deepEqual(await read,output);
  for(const invalid of [{...output,format:'html'},{...output,content:'x'.repeat(16385)},{...output,bytes:'provider raw'},
    {...output,metadata:{title:'x'.repeat(16385)}},{...output,metadata:{provider_locator:{id:'foreign'}}}]){
    const pending=sdk.readResourceDocument('documents',id);
    port.receive({version:'deft.experience_bridge.v1',kind:'response',session_id:'session_12345678',request_id:(port.sent.at(-1) as {request_id:string}).request_id,ok:true,output:invalid});
    await assert.rejects(pending,/Document unavailable/);
  }
  await assert.rejects(sdk.readResourceDocument('documents','provider-native-id'),/Invalid record locator/);
});

test('SDK search uses closed request v2 and rejects private metadata or unselected fields in replies', async () => {
  const port = new Port(), sdk = createDeftExperienceSdk(port, 'session_12345678');
  const reply = { schema_version: 'deft.experience_resource_search_page.v1', operation: 'search',
    items: [{ record_id: '00000000-0000-4000-8000-000000000001', label: 'Subject', snippet: 'literal needle', field_key: 'subject' }],
    scan: { records_scanned: 100, complete: false }, next_cursor: 'signed_cursor', freshness: 'unknown' };
  const first = sdk.searchResourceRecords('inbox', { query: 'needle', field_keys: ['subject'] });
  assert.deepEqual((port.sent[0] as { input: unknown }).input,
    { schema_version: 'deft.experience_resource_request.v2', operation: 'search', query: 'needle', field_keys: ['subject'] });
  port.receive({ version: 'deft.experience_bridge.v1', kind: 'response', session_id: 'session_12345678', request_id: 'request_1', ok: true, output: reply });
  assert.deepEqual(await first, reply);
  for (const output of [{ ...reply, provider_id: 'secret' }, { ...reply, items: [{ ...reply.items[0], field_key: 'body' }] },
    { ...reply, scan: { records_scanned: 100, complete: true } }]) {
    const promise = sdk.searchResourceRecords('inbox', { query: 'needle', field_keys: ['subject'] });
    port.receive({ version: 'deft.experience_bridge.v1', kind: 'response', session_id: 'session_12345678',
      request_id: (port.sent.at(-1) as { request_id: string }).request_id, ok: true, output });
    await assert.rejects(promise, /Invalid Experience search response/);
  }
  assert.throws(() => sdk.searchResourceRecords('inbox', { query: ' ', field_keys: ['subject'] }));
  assert.throws(() => sdk.searchResourceRecords('inbox', { query: 'needle', field_keys: ['subject', 'subject'] }));
});

test('SDK sequences views and requests and ignores foreign-session responses', async () => {
  const port = new Port();
  const sdk = createDeftExperienceSdk(port, 'session_12345678');
  sdk.render({ root:{kind:'text',id:'intro',text:'Hi'} });
  const pending = sdk.request('resource','records',{page:1});
  assert.deepEqual(port.sent.map((value) => (value as {sequence:number}).sequence), [1,2]);
  assert.equal((port.sent[1] as {request_id:string}).request_id, 'request_2');
  port.receive({ version:'deft.experience_bridge.v1', kind:'response',
    session_id:'session_foreign', request_id:'request_2', ok:true, output:'wrong' });
  port.receive({ version:'deft.experience_bridge.v1', kind:'response',
    session_id:'session_12345678', request_id:'request_2', ok:true, output:{rows:[]} });
  assert.deepEqual(await pending, {rows:[]});
  sdk.close();
  assert.equal(port.closed, true);
});

test('SDK closes pending calls without leaking reusable credentials', async () => {
  const port = new Port();
  const sdk = createDeftExperienceSdk(port, 'session_12345678');
  const pending = sdk.request('action','submit',{value:'x'});
  sdk.close();
  await assert.rejects(pending, /closed/);
  assert.equal(JSON.stringify(port.sent).includes('token'), false);
  assert.throws(() => sdk.render({root:{kind:'text',id:'x',text:'late'}}), /closed/);
});

test('resource helpers bound locators and validate whole scalar replies', async () => {
  const port = new Port();
  const sdk = createDeftExperienceSdk(port, 'session_12345678');
  const recordId = '11111111-1111-4111-8111-111111111111';
  assert.throws(() => sdk.listResourceSummaries('inbox', { limit: 11 }), /Invalid/);
  assert.throws(() => sdk.readResourceRecord('inbox', 'provider-id'), /Invalid/);
  const listing = sdk.listResourceSummaries('inbox', { limit: 10 });
  assert.deepEqual((port.sent[0] as any).input, { schema_version: 'deft.experience_resource_request.v1', operation: 'list_summary', limit: 10 });
  const reply = (requestId: string, output: unknown) => port.receive({ version: 'deft.experience_bridge.v1', kind: 'response',
    session_id: 'session_12345678', request_id: requestId, ok: true, output });
  reply('request_1', { schema_version: 'deft.experience_resource_payload.v1', operation: 'list_summary',
    items: [{ record_id: recordId, label: 'Saved' }], next_cursor: null, freshness: 'unknown' });
  assert.equal((await listing).items.length, 1);
  const detail = sdk.readResourceRecord('inbox', recordId);
  reply('request_2', { schema_version: 'deft.experience_resource_payload.v1', operation: 'read_one',
    item: { record_id: recordId, label: 'Saved', data: { body: 'x'.repeat(4096), count: 2, read: true }, freshness: 'unknown' } });
  assert.equal((await detail).item.data.body?.toString().length, 4096);
  for (const data of [{ body: 'x'.repeat(4097) }, { nested: {} }, { count: Infinity }]) {
    const rejected = sdk.readResourceRecord('inbox', recordId);
    const requestId = (port.sent.at(-1) as any).request_id;
    reply(requestId, { schema_version: 'deft.experience_resource_payload.v1', operation: 'read_one',
      item: { record_id: recordId, label: 'Saved', data, freshness: 'unknown' } });
    await assert.rejects(rejected, /Invalid Experience resource response/);
  }
  sdk.close();
});

test('SDK saved source nomination is bounded and carries no private locator',async()=>{
  const port=new Port(),sdk=createDeftExperienceSdk(port,'session_12345678'),id='00000000-0000-4000-8000-000000000001';
  const ref={field:'reply_record_id',action_key:'send_message',input_field:'parent_record_id',record_id:id};
  const value={reply_record_id:id,body:'Saved reply'};
  const saved=sdk.putPrivateState('drafts',id,0,value,{source_refs:[ref]});
  assert.deepEqual((port.sent[0] as {input:unknown}).input,{operation:'put',record_id:id,expected_revision:0,value,source_refs:[ref]});
  port.receive({version:'deft.experience_bridge.v1',kind:'response',session_id:'session_12345678',request_id:'request_1',ok:true,
    output:{operation:'put',item:{record_id:id,revision:1,updated_at:'2026-10-02T00:00:00Z',expires_at:'2026-10-03T00:00:00Z'}}});
  await saved;
  for(const options of [{source_refs:[{...ref,provider_source:{}}]},{source_refs:[{...ref,record_id:'provider-id'}]},
    {source_refs:[ref,ref]},{source_refs:[]},{source_refs:[{...ref,field:'body'}]}])assert.throws(()=>sdk.putPrivateState('drafts',id,1,value,options as never));
});
