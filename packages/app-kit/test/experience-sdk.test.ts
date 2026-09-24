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
