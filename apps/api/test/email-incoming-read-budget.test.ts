import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {get as httpGet} from 'node:http';
import {serve} from '@hono/node-server';
import {createEmailIncomingReadBudget,EmailIncomingReadBusyError,acquireEmailIncomingBinaryResponse,emailIncomingProviderBudget} from '../src/lib/email-incoming-read-budget.js';
import {RegisteredEmailMailboxProvider} from '../src/lib/email-mailbox-provider.js';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const gate=()=>{let release:()=>void=()=>{};const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
test('resource FIFO bounds queue, removes canceled/time-limited waiters and releases exactly once',async()=>{
 const budget=createEmailIncomingReadBudget({active:2,queued:2,waitMs:20}),a=await budget.acquire(),b=await budget.acquire(),order:string[]=[],abort=new AbortController();
 const canceled=budget.acquire(abort.signal);const canceledResult=assert.rejects(canceled);const waiting=budget.acquire().then(release=>{order.push('waiting');return release;});
 await assert.rejects(budget.acquire(),EmailIncomingReadBusyError);abort.abort();await canceledResult;assert.deepEqual(budget.snapshot(),{active:2,queued:1});
 a();a();const c=await waiting;assert.deepEqual(order,['waiting']);assert.deepEqual(budget.snapshot(),{active:2,queued:0});
 await assert.rejects(budget.acquire(),EmailIncomingReadBusyError);b();c();c();assert.deepEqual(budget.snapshot(),{active:0,queued:0});
});
test('independent binary lease owns response until finish/close and zeroes the exact outgoing clone',async()=>{
 class Outgoing extends EventEmitter{destroyed=false;destroy(){this.destroyed=true;this.emit('close');return this;}}
 const budget=createEmailIncomingReadBudget({active:1,waitMs:30}),outgoing=new Outgoing(),abort=new AbortController();
 const lease=await acquireEmailIncomingBinaryResponse({signal:abort.signal,deadline:Date.now()+60_000,outgoing},{budget});
 const original=new Uint8Array([1,2,3]),response=lease.response(original,{'Content-Type':'application/octet-stream'}),owned=new Uint8Array(await response.arrayBuffer());
 assert.deepEqual([...owned],[1,2,3]);assert.deepEqual(budget.snapshot(),{active:1,queued:0});
 const queued=budget.acquire();outgoing.emit('finish');const release=await queued;assert.deepEqual([...original],[1,2,3]);outgoing.emit('close');lease.dispose();release();assert.deepEqual(budget.snapshot(),{active:0,queued:0});
});
test('close/abort before bytes and deadline cancellation free binary capacity without accepting later noncooperative bytes',async()=>{
 for(const mode of ['close','abort','deadline']){
  class Outgoing extends EventEmitter{destroyed=false;destroy(){this.destroyed=true;this.emit('close');return this;}}
  const budget=createEmailIncomingReadBudget({active:1,waitMs:50}),outgoing=new Outgoing(),abort=new AbortController();
  const lease=await acquireEmailIncomingBinaryResponse({signal:abort.signal,deadline:Date.now()+60_000,outgoing},{budget,lifetimeMs:mode==='deadline'?5:1000});
  if(mode==='close')outgoing.emit('close');else if(mode==='abort')abort.abort();else await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(lease.signal.aborted,true);assert.throws(()=>lease.response(new Uint8Array([1]),{}));assert.deepEqual(budget.snapshot(),{active:0,queued:0});lease.dispose();
 }
});
test('non-Node owned stream is chunk bounded and retains capacity until read completion or cancellation',async()=>{
 const budget=createEmailIncomingReadBudget({active:1,waitMs:30}),signal=new AbortController().signal;
 const lease=await acquireEmailIncomingBinaryResponse({signal,deadline:Date.now()+60_000},{budget}),input=new Uint8Array(65537).fill(73),response=lease.response(input,{}),reader=response.body!.getReader();
 assert.equal((await reader.read()).value!.length,65536);assert.equal(budget.snapshot().active,1);assert.equal((await reader.read()).value!.length,1);assert.equal(budget.snapshot().active,1);
 assert.equal((await reader.read()).done,true);assert.equal(budget.snapshot().active,0);reader.releaseLock();
 const second=await acquireEmailIncomingBinaryResponse({signal,deadline:Date.now()+60_000},{budget}),body=second.response(input,{});await body.body!.cancel();assert.equal(budget.snapshot().active,0);assert.ok(input.every(byte=>byte===73));
});
test('real registered provider gate holds begun noncooperative IO after abort; fresh post-queue authority prevents a third allocation',async()=>{
 const scope={org_id:'budget-org',owner_user_id:'budget-owner',account_id:'budget-account'},cap={scope,resource_binding_id:'budget-binding',authority_version:'v1',expires_at:Date.now()+60_000};
 const source={schema_version:'deft.email_provider_source.v1',account_id:scope.account_id,provider:'gmail',logical_message_id:'mail_'+'a'.repeat(64),authority_epoch:1};
 const held=gate(),started=gate();let calls=0,denied=false;const buffers:Uint8Array[]=[];
 const status={account_id:scope.account_id,provider:'gmail',resource_binding_id:cap.resource_binding_id,authority_epoch:1,connection_revision:1,principal_digest:'b'.repeat(64),health:'connected',capabilities:['read'],primary_address:'owner@example.test',display_label:'Synthetic'};
 const adapter={handle:async()=>new Response(),nativeEmailAccount:async()=>status,nativeEmailSource:async()=>{calls++;if(calls===2)started.release();await held.promise;const bytes=new Uint8Array([1,2,3]);buffers.push(bytes);return {schema_version:'deft.email_source.v1',account_id:scope.account_id,provider:'gmail',source_kind:'provider_original',media_type:'message/rfc822',byte_length:3,digest:'c'.repeat(64),mime_bytes:bytes};}};
 const recheck=async()=>{if(denied)throw Error('current authority denied');};
 const provider=new RegisteredEmailMailboxProvider(async(_s,_c,check,signal)=>({adapter,context:{...scope,installation_id:'budget-install',resource_binding_id:cap.resource_binding_id,authority_version:cap.authority_version,expires_at:cap.expires_at,recheck:check,signal}}) as any);
 const firstAbort=new AbortController(),first=provider.readSource(scope,{source},cap,recheck,firstAbort.signal),second=provider.readSource(scope,{source},cap,recheck);const begun=Promise.allSettled([first,second]);
 await started.promise;firstAbort.abort();await tick();assert.equal(emailIncomingProviderBudget.snapshot().active,2);
 const third=provider.readSource(scope,{source},cap,recheck),thirdResult=assert.rejects(third);await tick();assert.equal(calls,2);assert.equal(emailIncomingProviderBudget.snapshot().queued,1);
 // Routine status uses no heavy slot even while both are occupied.
 await provider.assertConnected(scope,cap,recheck);denied=true;held.release();await begun;await thirdResult;
 assert.equal(calls,2);assert.ok(buffers.every(bytes=>bytes.every(byte=>byte===0)));assert.deepEqual(emailIncomingProviderBudget.snapshot(),{active:0,queued:0});
});
