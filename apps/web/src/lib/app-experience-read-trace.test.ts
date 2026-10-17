import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceReadTracer,type ExperienceReadSpan} from './app-experience-read-trace';
const id='11111111-1111-4111-8111-111111111111';
const held=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
test('read trace correlates overlapping child signals without retaining caller values',async()=>{
 const spans:ExperienceReadSpan[]=[];let now=100;const trace=createExperienceReadTracer({enabled:()=>true,emit:span=>spans.push(span),id:()=>id,now:()=>now});
 const root=new AbortController(),child=new AbortController(),wait=held();const finish=trace.begin(root.signal,'source.open');trace.inherit(root.signal,child.signal);
 const first=trace.run(root.signal,'source.candidate',async()=>{await wait.promise;return 'private first';});
 const second=trace.run(child.signal,'data.request',async()=>{await wait.promise;return {private:'second'};},id);
 now=125;wait.release();assert.deepEqual(await Promise.all([first,second]),['private first',{private:'second'}]);finish('completed');
 assert.equal(spans.length,3);assert.equal(new Set(spans.map(row=>row.trace_id)).size,1);assert.equal(new Set(spans.map(row=>row.span_id)).size,3);
 assert.deepEqual(spans.map(row=>row.duration_ms),[25,25,25]);assert.equal(spans.find(row=>row.phase==='data.request')?.request_id,id);
 assert.equal(JSON.stringify(spans).includes('private'),false);assert.ok(spans.every(row=>Object.isFrozen(row)));
});
test('read trace is off by default and instrumentation failures preserve exact result and error',async()=>{
 const signal=new AbortController().signal,secret=Error('private provider URL and token'),value={body:'private'};let calls=0;
 const disabled=createExperienceReadTracer({enabled:()=>false,emit:()=>calls++});assert.equal(await disabled.run(signal,'data.request',async()=>value),value);assert.equal(calls,0);
 for(const option of [{emit:()=>{throw secret;}},{now:()=>{throw secret;}},{id:()=>{throw secret;}},{enabled:()=>{throw secret;}}]){
  const t=createExperienceReadTracer({enabled:()=>true,emit:()=>{},id:()=>id,...option});assert.equal(await t.run(signal,'data.request',async()=>value),value);
  await assert.rejects(t.run(signal,'data.request',async()=>{throw secret;}),error=>error===secret);
 }
});
test('abort ends a diagnostic promptly and late noncooperative completion does not change the operation',async()=>{
 const spans:ExperienceReadSpan[]=[],controller=new AbortController(),wait=held(),value={private:'late'};
 const trace=createExperienceReadTracer({enabled:()=>true,emit:row=>spans.push(row),id:()=>id});
 const work=trace.run(controller.signal,'data.request',async()=>{await wait.promise;return value;});controller.abort(Error('private reason'));
 assert.equal(spans.length,1);assert.equal(spans[0].outcome,'aborted');wait.release();assert.equal(await work,value);assert.equal(spans.length,1);assert.equal(JSON.stringify(spans).includes('private'),false);
});
test('trace phases and optional request correlation are closed; output has lifetime and capture bounds',async()=>{
 const spans:ExperienceReadSpan[]=[],signal=new AbortController().signal,trace=createExperienceReadTracer({enabled:()=>true,emit:row=>spans.push(row),id:()=>id});
 await trace.run(signal,'private content' as never,async()=>{});assert.equal(spans.length,0);
 await trace.run(signal,'data.request',async()=>{},'https://private/token');assert.equal(spans[0].request_id,undefined);
 const finish=trace.begin(signal,'source.open');for(let i=0;i<200;i++)await trace.run(signal,'data.resolve',async()=>{});finish('completed');assert.equal(spans.length,129,'128 spans per root plus previous independent span');
 for(let i=0;i<1200;i++)await trace.run(new AbortController().signal,'data.resolve',async()=>{});assert.equal(spans.length,1024,'bounded console capture');
 assert.ok(spans.every(row=>Object.keys(row).sort().join(',')==='duration_ms,outcome,phase,schema_version,span_id,start_ms,trace_id'));
});
