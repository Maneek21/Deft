import assert from 'node:assert/strict';
import test from 'node:test';
import { AppRequestError, readAppRequestError, appRequestFailureMessage, experienceStartupFailureMessage, reportAppRequestFailure } from './app-request-error';

test('account targets and app-open retain a bounded public Host reason and structured code',async()=>{
 const error=await readAppRequestError(Response.json({error:'App access is busy. Please try again.',code:'APP_EXPERIENCE_BUSY',retryable:true},{status:503}),'Account targets unavailable.');
 assert.ok(error instanceof AppRequestError);assert.equal(error.code,'APP_EXPERIENCE_BUSY');assert.equal(error.retryable,true);
 assert.equal(appRequestFailureMessage(error,'Unavailable.'),'App access is busy. Please try again. (APP_EXPERIENCE_BUSY)');
});

test('unstructured, unknown, malformed and oversized failures never reveal diagnostics',async()=>{
 for(const body of [{error:'private SQL secret',code:'INTERNAL_ERROR'},{error:'private SQL secret',code:'UNKNOWN_VENDOR_CODE'}, {error:'private SQL secret'}, {error:'private SQL secret'.repeat(1000),code:'APP_STALE'}]){
  const error=await readAppRequestError(Response.json(body,{status:500}),'The app could not open.');
  assert.equal(error.message,'The app could not open.');assert.doesNotMatch(appRequestFailureMessage(error,'Unavailable.'),/private|SQL|secret/);
 }
 assert.equal((await readAppRequestError(new Response('<html>secret</html>',{status:502}),'Unavailable.')).message,'Unavailable.');
});

test('network and timeout failures have distinct owner-readable codes without exception text',()=>{
 assert.equal(appRequestFailureMessage(new TypeError('private network URL'),'Unavailable.'),'The request could not reach Deft. (APP_NETWORK_UNAVAILABLE)');
 assert.equal(appRequestFailureMessage(Object.assign(new Error('private SQL'),{name:'AbortError'}),'Unavailable.'),'The request timed out. (APP_REQUEST_TIMEOUT)');
 assert.equal(appRequestFailureMessage(new Error('private SQL'),'Unavailable.'),'Unavailable. (APP_REQUEST_FAILED)');
});

test('startup phase failures give a specific reason and never prescribe reconnecting',()=>{
 for(const phase of ['bootstrap','worker_start','worker_runtime','first_view'] as const){
  const message=experienceStartupFailureMessage(phase);assert.match(message,/APP_EXPERIENCE_STARTUP_FAILED/);assert.doesNotMatch(message,/reconnect/i);
 }
 assert.match(experienceStartupFailureMessage('first_view'),/first screen/);
});

test('Host data failure notice preserves the safe Runtime reason without consuming the Worker response',async()=>{
 const response=Response.json({error:'The selected source changed while the app was reading it. Try the read again.',code:'APP_RUNTIME_SOURCE_CHANGED',details:{runtime_code:'EMAIL_DATA_SOURCE_CHANGED',retryable:true}},{status:409});
 const notices:string[]=[];assert.equal(await reportAppRequestFailure(response,()=>true,message=>notices.push(message)),response);
 assert.match(notices[0],/APP_RUNTIME_SOURCE_CHANGED; EMAIL_DATA_SOURCE_CHANGED/);assert.equal((await response.json()).code,'APP_RUNTIME_SOURCE_CHANGED');
 const retired=Response.json({error:'App access is busy.',code:'APP_EXPERIENCE_BUSY'},{status:503});await reportAppRequestFailure(retired,()=>false,message=>notices.push(message));assert.equal(notices.length,1);
 const oversized=Response.json({error:'secret'.repeat(1000),code:'APP_STALE'},{status:409});
 assert.equal(await reportAppRequestFailure(oversized,()=>true,message=>notices.push(message)),oversized);assert.match(notices[1],/APP_HTTP_409/);
 assert.equal((await oversized.json()).code,'APP_STALE');
});

test('account-target deadlines and unstructured authentication failures give their specific safe reason',async()=>{
 const busy=await readAppRequestError(Response.json({error:'App access is busy.',code:'APP_EXPERIENCE_BUSY',details:{reason:'deadline'}},{status:503}),'Unavailable.');
 assert.match(busy.message,/database deadline/);
 assert.match((await readAppRequestError(new Response('',{status:401}),'Unavailable.')).message,/sign-in/);
 assert.match((await readAppRequestError(new Response('',{status:403}),'Unavailable.')).message,/denied/);
});

test('expected Host store access denial stays with the feature while Runtime denials remain visible',async()=>{
 const notices:string[]=[];
 const optional=Response.json({error:'App access denied',code:'APP_ACCESS_DENIED'},{status:403});
 assert.equal(await reportAppRequestFailure(optional,()=>true,message=>notices.push(message)),optional);assert.equal(notices.length,0);
 assert.equal((await optional.json()).code,'APP_ACCESS_DENIED');
 const runtime=Response.json({error:'The app Runtime could not confirm current permission for this data.',code:'APP_RUNTIME_ACCESS_DENIED',
  details:{runtime_code:'EMAIL_DATA_AUTHORITY_DENIED'}},{status:403});
 await reportAppRequestFailure(runtime,()=>true,message=>notices.push(message));assert.match(notices[0],/APP_RUNTIME_ACCESS_DENIED; EMAIL_DATA_AUTHORITY_DENIED/);
});
