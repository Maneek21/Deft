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
