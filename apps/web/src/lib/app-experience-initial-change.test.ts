import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialRecordChange,type InitialChangePorts} from './app-experience-initial-change';
import {createExperienceRecordWriter,type ExperienceRecordRow} from './app-experience-record-writer';
import type {DeftExperienceRecordFormNode} from '../../../../packages/app-kit/src/app-data';
const id='11111111-1111-4111-8111-111111111111',hash='sha256:'+'a'.repeat(64);
const row:ExperienceRecordRow={record_id:id,revision:1,content_revision:1,content_digest:hash,status:'draft',value:{body:'untouched'},files:[]};
const source={store_key:'signatures',record_id:'22222222-2222-4222-8222-222222222222',expected_revision:3,expected_content_digest:hash,label:'own@example.test'};
const node={kind:'record_form',id:'form',store_key:'drafts',record_id:id,initial_change:{operation_key:'signature_default',source_store_key:'signatures',source_identity_field:'address'}} as DeftExperienceRecordFormNode;
const prepared={schema_version:'deft.app_prepared_record_change.v1',prepared_id:id,prepared_digest:hash,operation_key:'signature_default',invocation_mode:'initial',account_ref:id,destination:{store_key:'drafts',record_id:id,expected_revision:1,expected_content_digest:hash},source,authorization_digest:hash,value:{body:'untouched\n\nSignature'},preview:{title:'Saved default',description:'',warnings:[]},expires_at:new Date(Date.now()+60000).toISOString()} as Awaited<ReturnType<InitialChangePorts['prepareChange']>>;
function fixture(overrides:Partial<InitialChangePorts>={},initial=row){let current=true,saves=0,applies=0;const signal=new AbortController().signal,changes:unknown[]=[];
 const writer=createExperienceRecordWriter({initial,current:()=>current,signal,validate:()=>{},read:async()=>initial,save:async()=>{saves++;throw Error('No autosave');},change:()=>{}});
 const ports:InitialChangePorts={listChanges:async()=>({choices:[source],next_cursor:null}),initialSource:async()=>source,prepareChange:async()=>prepared,applyChange:async()=>{applies++;return {...row,revision:2,content_revision:2,value:prepared.value};},changeStatus:async()=>null,...overrides};
 const control=createInitialRecordChange({node,writer:()=>writer,ports,current:()=>current,signal,change:(...args)=>changes.push(args)});
 return {writer,control,changes,counts:()=>({saves,applies}),revoke:()=>{current=false;}};
}
test('one initial nomination applies through the actual CAS writer, never autosaves or repeats',async()=>{
 const f=fixture();try{assert.equal(await f.control.start(),true);assert.equal(await f.control.start(),false);assert.equal(f.writer.snapshot.row.revision,2);assert.equal(f.writer.snapshot.value.body,prepared.value.body);assert.deepEqual(f.counts(),{saves:0,applies:1});}finally{f.control.dispose();f.writer.dispose();}
});
test('dirty, restored or noninitial revision cannot nominate an automatic change',async()=>{
 for(const kind of ['dirty','revision','content'] as const){let read=0;const f=fixture({initialSource:async()=>{read++;return source;}},kind==='revision'?{...row,revision:2}:kind==='content'?{...row,content_revision:2}:row);try{if(kind==='dirty')f.writer.edit({body:'my edit'});assert.equal(await f.control.start(),false);assert.equal(read,0);assert.equal(f.counts().applies,0);assert.equal(f.counts().saves,0);}finally{f.control.dispose();f.writer.dispose();}}
});
test('unavailable source and lost read-only preview leave a usable clean draft',async()=>{
 for(const ports of [{initialSource:async()=>null},{prepareChange:async()=>{throw Error('lost preview');}}]){const f=fixture(ports);try{assert.equal(await f.control.start(),false);assert.equal(f.writer.snapshot.state,'saved');assert.equal(f.writer.edit({body:'usable'}),true);assert.deepEqual(f.counts(),{saves:0,applies:0});}finally{f.control.dispose();f.writer.dispose();}}
});
test('a delayed preview cannot replace new typing or disclose across a revoked lifetime',async()=>{
 for(const kind of ['typing','revoke'] as const){let release!:(value:typeof prepared)=>void;const f=fixture({prepareChange:()=>new Promise(resolve=>{release=resolve;})});try{const pending=f.control.start();await new Promise(resolve=>setImmediate(resolve));if(kind==='typing')f.writer.edit({body:'new typing'});else f.revoke();release(prepared);assert.equal(await pending,false);assert.equal(f.counts().applies,0);if(kind==='typing')assert.equal(f.writer.snapshot.value.body,'new typing');}finally{f.control.dispose();f.writer.dispose();}}
});
test('lost Apply blocks mutation and reconciles only its original UUID, without a second Apply',async()=>{
 let original='',statusId='',calls=0;const f=fixture({applyChange:async(_node,_row,_prepared,id)=>{original=id;calls++;throw Error('lost');},changeStatus:async(_node,_row,_prepared,id)=>{statusId=id;return {...row,revision:2,content_revision:2,value:prepared.value};}});
 try{assert.equal(await f.control.start(),false);assert.equal(f.writer.snapshot.state,'blocked');assert.equal(await f.control.start(),false);assert.equal(await f.control.check(),true);assert.equal(statusId,original);assert.equal(calls,1);assert.equal(f.writer.snapshot.state,'saved');}finally{f.control.dispose();f.writer.dispose();}
});


test('initial control rejects manual-mode or cross-nomination previews before Apply',async()=>{
 for(const changed of [{invocation_mode:undefined},{operation_key:'signature_apply'},{source:{...source,store_key:'templates'}},{destination:{...prepared.destination,record_id:source.record_id}}]){
  const f=fixture({prepareChange:async()=>({...prepared,...changed})});try{assert.equal(await f.control.start(),false);assert.equal(f.counts().applies,0);assert.equal(f.writer.snapshot.state,'saved');}finally{f.control.dispose();f.writer.dispose();}
 }
});
