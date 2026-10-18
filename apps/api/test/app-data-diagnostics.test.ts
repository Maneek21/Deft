import test from 'node:test';
import assert from 'node:assert/strict';
import {withAppDataDiagnostic,measureAppDataPhase} from '../src/lib/app-data-diagnostics.js';

test('app data diagnostics isolate simultaneous requests and never serialize private errors',async()=>{
 const events:unknown[]=[];const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
 await Promise.all([withAppDataDiagnostic('invoke',()=>measureAppDataPhase('current',async()=>1),a,event=>events.push(event)),withAppDataDiagnostic('invoke',()=>measureAppDataPhase('runtime_request',async()=>2),b,event=>events.push(event))]);
 const values=events as Array<{request_id:string;timings:Record<string,{calls:number}>}>;
 assert.equal(values.find(e=>e.request_id===a)?.timings.current.calls,1);assert.equal(values.find(e=>e.request_id===b)?.timings.runtime_request.calls,1);
 const error=new Error('private@example.test Bearer private-secret');await assert.rejects(withAppDataDiagnostic('context',async()=>{throw error;},'private-secret',event=>events.push(event)),value=>value===error);
 assert.ok(!JSON.stringify(events).includes('private'));
});

test('app data diagnostics cannot change operation outcome when the sink fails',async()=>{
 assert.equal(await withAppDataDiagnostic('context',async()=>42,undefined,()=>{throw Error('sink');}),42);
});

test('failed app data operations expose only a closed failure class and preserve their original error',async()=>{
 const cases:Array<[unknown,string]>=[
  [new Error('Connection terminated due to connection timeout'),'database_connection_timeout'],
  [new Error('timeout exceeded when trying to connect'),'database_pool_acquisition_timeout'],
  [new Error('private SQL wrapper',{cause:Object.assign(new Error('private query'),{code:'55P03'})}),'database_lock_timeout'],
  [Object.assign(new Error('private query'),{code:'57014'}),'database_statement_timeout'],
  [Object.assign(new Error('private query'),{code:'23514'}),'database_constraint'],
  [Object.assign(new Error('private address'),{code:'ECONNREFUSED'}),'database_connection_failure'],
  [Object.assign(new Error('private actor'),{code:'APP_ACCESS_DENIED'}),'authority_denied'],
  [new TypeError('private input'),'invalid_request'],
  [Object.assign(new Error('private signal'),{name:'AbortError'}),'request_aborted'],
  [Object.assign(new Error('private message'),{code:'private-token'}),'unclassified'],
  [Object.defineProperty(new Error('private message'),'code',{get(){throw new Error('private getter');}}),'unclassified'],
 ];
 for(const [error,kind] of cases){const events:unknown[]=[];
  await assert.rejects(withAppDataDiagnostic('invoke',async()=>{throw error;},undefined,event=>events.push(event)),value=>value===error);
  assert.equal((events[0] as {failure_kind:string}).failure_kind,kind);
  assert.equal(JSON.stringify(events).includes('private'),false);
 }
 const events:unknown[]=[];await withAppDataDiagnostic('invoke',async()=>42,undefined,event=>events.push(event));
 assert.equal('failure_kind' in (events[0] as object),false);
});
