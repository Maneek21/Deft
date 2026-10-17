import assert from 'node:assert/strict';import test from 'node:test';
import {createRecordChanges,RecordChangeNotApplied} from './app-experience-record-changes';
import {createExperienceRecordWriter} from './app-experience-record-writer';
import {fixture,uuid} from './app-experience-record-changes-test-fixture';
function harness(lost=false){const f=fixture(),control={operation_key:'template_replace',source_store_key:'templates',label:'Use template'},choice={...f.input.source,label:'Own template'};
 let live=true,saves=0,applies=0,checks=0,revision=f.row.revision,original='';const signal=new AbortController();
 const writer=createExperienceRecordWriter({initial:f.row,current:()=>live,signal:signal.signal,validate:()=>{},read:async()=>f.row,
 save:async()=>{saves++;throw Error('unexpected save');},change:()=>{}});
 const ports={listChanges:async()=>({choices:[choice],next_cursor:null}),prepareChange:async()=>f.prepare(),applyChange:async(_n:any,_r:any,prepared:any,id:string)=>{applies++;original=id;revision++;if(lost)throw Error('lost ack');return {...f.row,revision,value:prepared.value};},
 changeStatus:async(_n:any,_r:any,prepared:any,id:string)=>{checks++;assert.equal(id,original);return {...f.row,revision,value:prepared.value};}};
 const states:any[]=[];const controller=createRecordChanges({node:{record_changes:[control],store_key:'drafts',record_id:f.row.record_id} as any,writer:()=>writer,ports,current:()=>live,locked:()=>false,signal:signal.signal,change:state=>states.push(state)});
 return {f,control,choice,writer,controller,signal,states,counts:()=>({saves,applies,checks}),revoke:()=>live=false};}
test('clean saved draft prepares once, applies one CAS, and lost Apply reconciles original status without another mutation',async()=>{for(const lost of [false,true]){const h=harness(lost);assert.ok(await h.controller.choose(h.control));assert.ok(await h.controller.prepare(h.choice));const result=await h.controller.apply();assert.equal(result,!lost);
 if(lost){assert.equal(h.writer.snapshot.state,'blocked');assert.equal(await h.controller.apply(),false);assert.ok(await h.controller.check());}assert.equal(h.writer.snapshot.row.revision,2);assert.deepEqual(h.writer.snapshot.value,h.f.value);assert.equal(h.counts().applies,1);assert.equal(h.counts().saves,0);}});
test('dirty or authoritative read-only drafts do not enter prepared apply; changed source, stale scope and disposed previews deny',async()=>{
 const h=harness();h.writer.edit({...h.f.row.value,subject:'Unsaved'});assert.equal(await h.controller.choose(h.control),false);assert.equal(h.counts().applies,0);assert.equal(h.counts().saves,1);
 assert.throws(()=>createExperienceRecordWriter({initial:{...h.f.row,status:'submitted'},current:()=>true,signal:h.signal.signal,validate:()=>{},read:async()=>h.f.row,save:async()=>h.f.row,change:()=>{}}));
 for(const method of ['revoke','dispose','abort'] as const){const next=harness();await next.controller.choose(next.control);await next.controller.prepare(next.choice);if(method==='revoke')next.revoke();else if(method==='dispose')next.controller.dispose();else next.signal.abort();assert.equal(await next.controller.apply(),false);assert.equal(next.counts().applies,0);}
 const foreign=harness();await foreign.controller.choose(foreign.control);assert.equal(await foreign.controller.prepare({...foreign.choice,record_id:uuid()}),false);
});
test('lost Prepare creates no applicable preview and never secretly applies; new explicit nomination remains a fresh read intent',async()=>{
 const h=harness();let plans=0,applies=0;const choice=h.choice,control=h.control;
 const owner=createRecordChanges({node:{record_changes:[control],store_key:'drafts',record_id:h.f.row.record_id} as any,writer:()=>h.writer,ports:{listChanges:async()=>({choices:[choice],next_cursor:null}),prepareChange:async()=>{plans++;throw Error('lost prepare');},applyChange:async()=>{applies++;return h.f.row;},changeStatus:async()=>null},current:()=>true,locked:()=>false,signal:h.signal.signal,change:()=>{}});
 await owner.choose(control);assert.equal(await owner.prepare(choice),false);assert.equal(owner.snapshot.prepared,null);assert.equal(await owner.apply(),false);assert.equal(plans,1);assert.equal(applies,0);assert.equal(await owner.choose(control),true);assert.equal(plans,1);
});

test('known conflict releases only control lock and requires explicit writer reopen; it never retries Apply',async()=>{const h=harness(),choice=h.choice,control=h.control;let calls=0;const owner=createRecordChanges({node:{record_changes:[control],store_key:'drafts',record_id:h.f.row.record_id} as any,writer:()=>h.writer,ports:{listChanges:async()=>({choices:[choice],next_cursor:null}),prepareChange:async()=>h.f.prepare(),applyChange:async()=>{calls++;throw new RecordChangeNotApplied();},changeStatus:async()=>null},current:()=>true,locked:()=>false,signal:h.signal.signal,change:()=>{}});await owner.choose(control);await owner.prepare(choice);assert.equal(await owner.apply(),false);assert.equal(owner.snapshot.phase,'idle');assert.equal(h.writer.snapshot.state,'blocked');assert.equal(calls,1);assert.equal(await owner.apply(),false);assert.equal(await h.writer.reopen(),true);});
