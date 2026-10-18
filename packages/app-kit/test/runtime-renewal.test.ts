import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppRuntimeClient} from '../src/runtime-client.js';
const credential={session_id:'same_session',session_token:'s'.repeat(43)};
const dates=()=>({expected_expires_at:new Date(Date.now()+60_000).toISOString(),expires_at:new Date(Date.now()+900_000).toISOString(),renewable_until:new Date(Date.now()+3_600_000).toISOString()});
test('renewal uses the existing scoped credential and preserves exact closed DTO',async()=>{
 const d=dates();let calls=0;
 const client=createAppRuntimeClient({channel_url:'https://host.test/channel',credential,fetch:async(url,init)=>{
  calls++;assert.equal(String(url),'https://host.test/channel/renew');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
  assert.equal((init?.headers as Record<string,string>).authorization,`AppRuntime ${credential.session_token}`);
  assert.deepEqual(JSON.parse(String(init?.body)),{schema_version:'deft.app_runtime_channel.v1',session_id:credential.session_id,expected_expires_at:d.expected_expires_at});
  return Response.json({renewed:{session_id:credential.session_id,expires_at:d.expires_at,renewable_until:d.renewable_until}});
 }});
 assert.deepEqual(await client.renew({expected_expires_at:d.expected_expires_at}),{session_id:credential.session_id,expires_at:d.expires_at,renewable_until:d.renewable_until});assert.equal(calls,1);
});
test('renewal rejects foreign identity, extra fields, stale expiry, malformed dates and ceiling overflow',async()=>{
 const d=dates(),good={session_id:credential.session_id,expires_at:d.expires_at,renewable_until:d.renewable_until};
 for(const renewed of [{...good,session_id:'foreign'},{...good,token:'extra'},{...good,expires_at:new Date(0).toISOString()},{...good,expires_at:'tomorrow'},{...good,renewable_until:d.expected_expires_at}]){
  const client=createAppRuntimeClient({channel_url:'https://host.test/channel',credential,fetch:async()=>Response.json({renewed})});
  await assert.rejects(client.renew({expected_expires_at:d.expected_expires_at}),/INVALID_RENEWAL/);
 }
});
test('renewal never retries denial and bounds stalled response bodies and caller cancellation',async()=>{
 const d=dates();let calls=0;
 const denied=createAppRuntimeClient({channel_url:'https://host.test/channel',credential,fetch:async()=>{calls++;return Response.json({code:'APP_RUNTIME_ACCESS_DENIED'},{status:403});}});
 await assert.rejects(denied.renew({expected_expires_at:d.expected_expires_at}),/ACCESS_DENIED/);assert.equal(calls,1);
 let cancelled=0;const stalled=createAppRuntimeClient({channel_url:'https://host.test/channel',credential,timeout_ms:20,fetch:async()=>new Response(new ReadableStream({cancel(){cancelled++;}}))});
 await assert.rejects(stalled.renew({expected_expires_at:d.expected_expires_at}));assert.equal(cancelled,1);
 const abort=new AbortController();abort.abort();await assert.rejects(denied.renew({expected_expires_at:d.expected_expires_at},abort.signal));assert.equal(calls,1);
 const huge=createAppRuntimeClient({channel_url:'https://host.test/channel',credential,fetch:async()=>new Response('x'.repeat(4097))});await assert.rejects(huge.renew({expected_expires_at:d.expected_expires_at}),/TOO_LARGE/);
});
