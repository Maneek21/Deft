import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { appRuntimeResponseError } from '../src/lib/app-runtime-response-error.js';
import { appHttpFailure } from '../src/routes/app-http-errors.js';

test('structured Runtime denial crosses the Host HTTP boundary with safe code and owner-readable message',async()=>{
 const app=new Hono();app.post('/data',async c=>appHttpFailure(c,await appRuntimeResponseError(
  Response.json({code:'EMAIL_DATA_SOURCE_CHANGED',error:'private provider response secret',stack:'private stack'},{status:403}),
  new AbortController().signal),'App action','app-actions'));
 const response=await app.request('/data',{method:'POST'});assert.equal(response.status,409);
 const body=await response.json();assert.deepEqual(body,{error:'The selected source changed while the app was reading it. Try the read again.',
  code:'APP_RUNTIME_SOURCE_CHANGED',details:{runtime_code:'EMAIL_DATA_SOURCE_CHANGED',retryable:true}});
 assert.doesNotMatch(JSON.stringify(body),/private|provider response|stack|secret/);
});

test('malformed, oversize, non-JSON, redirect and arbitrary Runtime failures retain closed unavailable response',async()=>{
 for(const response of [Response.json({code:'EMAIL_DATA_SOURCE_CHANGED',error:'x'.repeat(5000)},{status:403}),
  Response.json({error:'private provider secret'},{status:403}),Response.json({code:'PRIVATE_DATA_SOURCE_CHANGED_SECRET'},{status:403}),
  Response.json({code:'EMAIL_DATA_SOURCE_CHANGED'},{status:502}),new Response('private',{status:403}),
  new Response('private',{status:302,headers:{'content-type':'application/json'}})]){
  const error=await appRuntimeResponseError(response,new AbortController().signal);
  assert.equal(error.code,'APP_CONNECTION_PROFILE_UNAVAILABLE');assert.equal(error.details,undefined);assert.doesNotMatch(error.message,/private/);
 }
});

test('Runtime response parsing cancels an oversized or aborted body',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(4097));},cancel(){cancelled=true;}}),{status:403,headers:{'content-type':'application/json'}});
 assert.equal((await appRuntimeResponseError(response,new AbortController().signal)).code,'APP_CONNECTION_PROFILE_UNAVAILABLE');assert.equal(cancelled,true);
 cancelled=false;const controller=new AbortController(),pending=appRuntimeResponseError(new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:403,headers:{'content-type':'application/json'}}),controller.signal);
 controller.abort();await pending;assert.equal(cancelled,true);
});
