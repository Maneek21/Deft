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
