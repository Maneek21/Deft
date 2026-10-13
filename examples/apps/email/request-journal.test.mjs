import test from 'node:test';import assert from 'node:assert/strict';import {createRequestJournal} from './request-journal.mjs';
const base={actionKey:'send_message',label:'Send',summary:'Recipient and subject',sourceId:null,draftId:'draft'};
function fixture(){const rows=new Map(),drafts=new Map([['draft',{record_id:'draft',revision:1,value:{mode:'compose',to:'person@example.test',subject:'Saved subject',body:'Saved body',reply_record_id:''}}]]);let writes=0,actions=0;const store=key=>key==='drafts'?drafts:rows;return {rows,drafts,get writes(){return writes},get actions(){return actions},sdk:{async listPrivateState(key){return {items:[...store(key).values()].map(({value,...meta})=>meta)}},async readPrivateState(key,id){const item=store(key).get(id);if(!item)throw Error('APP_NOT_FOUND');return {item}},async putPrivateState(key,id,revision,value){writes++;const old=store(key).get(id);assert.equal(old?.revision||0,revision);const item={record_id:id,revision:revision+1,value:{...value}};store(key).set(id,item);return {item}},async deletePrivateState(key,id,revision){assert.equal(store(key).get(id)?.revision,revision);store(key).delete(id)},async request(_,__,{run_id}){actions++;return {id:run_id,state:[...rows.values()].find(row=>row.value.run_id===run_id)?.value.state||'succeeded'}}}}}
test('journal preserves two independent Runs across reopen without payload or retry',async()=>{const f=fixture();let n=0;const j=createRequestJournal(f.sdk,{uuid:()=>String(++n)});const a=await j.reserve(base),b=await j.reserve({...base,label:'Reply',actionKey:'reply_message'});await j.update(a,{id:'run1',state:'pending_approval'});await j.update(b,{id:'run2',state:'unknown'});const reopened=createRequestJournal(f.sdk);await reopened.load();assert.equal(reopened.entries[0].runId,'run1');assert.equal(reopened.entries[1].runId,'run2');assert.equal(f.actions,0);assert.equal(JSON.stringify([...f.rows.values()]).includes('body'),false);await assert.rejects(()=>reopened.remove(reopened.entries[1]),/NOT_TERMINAL/);});
test('reservation failure prevents admission; pending rows cannot be deleted',async()=>{const f=fixture();const j=createRequestJournal({...f.sdk,putPrivateState:async()=>{throw Error('CAS')}});await assert.rejects(()=>j.reserve(base),/CAS/);assert.equal(j.entries.length,0);assert.equal(f.actions,0)});
test('terminal removal explicitly verifies current Run first',async()=>{const f=fixture();const j=createRequestJournal(f.sdk,{uuid:()=> 'one'});const entry=await j.reserve(base);await j.update(entry,{id:'run',state:'succeeded'});await j.remove(entry);assert.equal(f.actions,1);assert.equal(f.rows.size,0)});

test('failed journal update retains observed Run in memory and never resends',async()=>{const f=fixture();let fail=false;const j=createRequestJournal({...f.sdk,putPrivateState:async(...args)=>{if(fail)throw Error('CAS');return f.sdk.putPrivateState(...args)}},{uuid:()=> 'one'});const entry=await j.reserve(base);fail=true;await assert.rejects(()=>j.update(entry,{id:'run-known',state:'pending_approval'}),/CAS/);assert.equal(entry.runId,'run-known');assert.equal(entry.state,'pending_approval');assert.equal(f.rows.get('one').value.run_id,'');assert.equal(f.actions,0);});
test('terminal Activity eviction CAS-deletes submitted draft after preserving fields while retained',async()=>{
 const f=fixture(),j=createRequestJournal(f.sdk,{uuid:()=> 'one'});const original={...f.drafts.get('draft').value},entry=await j.reserve(base);await j.update(entry,{id:'run',state:'succeeded'});assert.deepEqual(f.drafts.get('draft').value,{...original,mode:'submitted'});await j.remove(entry);
 assert.equal(f.rows.size,0);assert.equal(f.drafts.has('draft'),false);const reopened=createRequestJournal(f.sdk);await reopened.load();assert.equal(reopened.entries.length,0);await assert.rejects(f.sdk.readPrivateState('drafts','draft'),/APP_NOT_FOUND/);
});
test('draft marker conflict preserves known Run and prevents Activity eviction',async()=>{
 const f=fixture();let fail=true;const sdk={...f.sdk,async putPrivateState(key,...args){if(key==='drafts'&&fail)throw Error('APP_STATE_CONFLICT');return f.sdk.putPrivateState(key,...args);}};const j=createRequestJournal(sdk,{uuid:()=> 'one'}),entry=await j.reserve(base);
 await assert.rejects(()=>j.update(entry,{id:'run',state:'succeeded'}),/APP_STATE_CONFLICT/);assert.equal(f.rows.get('one').value.run_id,'run');assert.equal(entry.runId,'run');await assert.rejects(()=>j.remove(entry),/APP_STATE_CONFLICT/);assert.equal(f.rows.size,1);assert.equal(f.drafts.get('draft').value.mode,'compose');fail=false;await j.remove(entry);assert.equal(f.rows.size,0);assert.equal(f.drafts.has('draft'),false);
});
test('unknown operation without Run ID keeps Activity and saved draft without resend',async()=>{
 const f=fixture(),j=createRequestJournal(f.sdk,{uuid:()=> 'one'}),entry=await j.reserve(base);await j.update(entry,{state:'unknown'});await assert.rejects(()=>j.remove(entry),/REQUEST_NOT_TERMINAL/);assert.equal(f.rows.size,1);assert.equal(f.drafts.get('draft').value.mode,'compose');assert.equal(f.actions,0);
});

test('historical terminal status remains usable and preserves an inaccessible draft',async()=>{
 const f=fixture(),original=structuredClone(f.drafts.get('draft'));let draftWrites=0,draftDeletes=0;
 const sdk={...f.sdk,async listPrivateState(key){return key==='drafts'?{items:[]}:f.sdk.listPrivateState(key);},async readPrivateState(key,...args){if(key==='drafts')throw Object.assign(Error('APP_STALE'),{code:'APP_STALE'});return f.sdk.readPrivateState(key,...args);},async putPrivateState(key,...args){if(key==='drafts')draftWrites++;return f.sdk.putPrivateState(key,...args);},async deletePrivateState(key,...args){if(key==='drafts')draftDeletes++;return f.sdk.deletePrivateState(key,...args);}};
 const j=createRequestJournal(sdk,{uuid:()=> 'one'}),entry=await j.reserve(base);
 await j.update(entry,{id:'old-run',state:'failed'});
 assert.equal(entry.state,'failed');assert.equal(entry.draftPreserved,true);assert.equal(f.rows.get('one').value.run_id,'old-run');assert.equal(f.actions,0);
 assert.deepEqual(await j.remove(entry),{draftPreserved:true});assert.equal(f.actions,1);assert.equal(f.rows.size,0);assert.deepEqual(f.drafts.get('draft'),original);assert.equal(draftWrites,0);assert.equal(draftDeletes,0);
});

test('inaccessible draft never permits pending, unknown or mismatched Run removal',async()=>{
 for(const run of [{id:'old-run',state:'pending'},{id:'old-run',state:'unknown'},{id:'another-run',state:'failed'}]){
  const f=fixture();let draftReads=0;const sdk={...f.sdk,async listPrivateState(key){return key==='drafts'?{items:[]}:f.sdk.listPrivateState(key);},async request(){return run;},async readPrivateState(key,...args){if(key==='drafts'){draftReads++;throw Error('APP_STALE');}return f.sdk.readPrivateState(key,...args);}};
  const j=createRequestJournal(sdk,{uuid:()=> 'one'}),entry=await j.reserve(base);await j.update(entry,{id:'old-run',state:'failed'});draftReads=0;
  await assert.rejects(()=>j.remove(entry),/REQUEST_NOT_TERMINAL/);assert.equal(draftReads,0);assert.equal(f.rows.size,1);assert.equal(f.drafts.size,1);
 }
});

test('nonterminal update does not translate a stale draft into successful status',async()=>{
 const f=fixture(),sdk={...f.sdk,async readPrivateState(key,...args){if(key==='drafts')throw Error('APP_STALE');return f.sdk.readPrivateState(key,...args);}};
 const j=createRequestJournal(sdk,{uuid:()=> 'one'}),entry=await j.reserve(base);await assert.rejects(()=>j.update(entry,{id:'old-run',state:'pending'}),/APP_STALE/);assert.equal(f.rows.get('one').value.state,'pending');assert.equal(entry.draftPreserved,undefined);assert.equal(f.actions,0);
});

test('terminal draft write stale and unrelated read denials still block removal',async()=>{
 for(const failure of [{stage:'read',code:'APP_STALE'},{stage:'write',code:'APP_STALE'},{stage:'write',code:'APP_STATE_CONFLICT'},{stage:'read',code:'APP_PERMISSION_DENIED'},{stage:'read',code:'APP_SESSION_EXPIRED'}]){
  const f=fixture(),sdk={...f.sdk,async readPrivateState(key,...args){if(key==='drafts'&&failure.stage==='read')throw Error(failure.code);return f.sdk.readPrivateState(key,...args);},async putPrivateState(key,...args){if(key==='drafts'&&failure.stage==='write')throw Error(failure.code);return f.sdk.putPrivateState(key,...args);}};
  const j=createRequestJournal(sdk,{uuid:()=> 'one'}),entry=await j.reserve(base);await assert.rejects(()=>j.update(entry,{id:'run',state:'failed'}),new RegExp(failure.code));await assert.rejects(()=>j.remove(entry),new RegExp(failure.code));assert.equal(f.rows.size,1);assert.equal(f.drafts.get('draft').value.mode,'compose');
 }
});

test('request CAS denial after inaccessible draft preserves both records',async()=>{
 const f=fixture(),sdk={...f.sdk,async listPrivateState(key){return key==='drafts'?{items:[]}:f.sdk.listPrivateState(key);},async readPrivateState(key,...args){if(key==='drafts')throw Error('APP_STALE');return f.sdk.readPrivateState(key,...args);},async deletePrivateState(key,...args){if(key==='requests')throw Error('APP_STATE_CONFLICT');return f.sdk.deletePrivateState(key,...args);}};
 const j=createRequestJournal(sdk,{uuid:()=> 'one'}),entry=await j.reserve(base);await j.update(entry,{id:'run',state:'failed'});await assert.rejects(()=>j.remove(entry),/APP_STATE_CONFLICT/);assert.equal(j.entries.length,1);assert.equal(f.rows.size,1);assert.equal(f.drafts.size,1);
});
test('terminal cleanup refuses failed or incomplete draft visibility lists',async()=>{
 for(const listed of [null,{items:Array.from({length:33},(_,i)=>({record_id:String(i)}))},{items:[{record_id:'draft'},{record_id:'draft'}]},{items:[],next_cursor:'more'}]){
  const f=fixture(),sdk={...f.sdk,async listPrivateState(key){if(key!=='drafts')return f.sdk.listPrivateState(key);if(listed===null)throw Error('APP_SESSION_EXPIRED');return listed;}};
  const j=createRequestJournal(sdk,{uuid:()=> 'one'}),entry=await j.reserve(base);await assert.rejects(()=>j.update(entry,{id:'run',state:'failed'}),/APP_SESSION_EXPIRED|DRAFT_LIST_INVALID/);await assert.rejects(()=>j.remove(entry),/APP_SESSION_EXPIRED|DRAFT_LIST_INVALID/);assert.equal(f.rows.size,1);assert.equal(f.drafts.get('draft').value.mode,'compose');
 }
});
