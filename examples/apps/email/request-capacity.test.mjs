import test from 'node:test';import assert from 'node:assert/strict';import {createRequestJournal} from './request-journal.mjs';import {createDraftController} from './draft-controller.mjs';
const value=i=>({action_key:'send_message',label:'Send',summary:'Metadata only',source_record_id:'',draft_record_id:'draft-'+i,run_id:'run-'+i,state:'succeeded',created_at:new Date(i*1000).toISOString()});
function fixture({states={},deny=[],casFail=[],wrongId=false}={}){const rows=new Map(Array.from({length:10},(_,i)=>['row-'+i,{record_id:'row-'+i,revision:3,value:{...value(i),state:states[i]||'succeeded'}}]));const reads=[],deleted=[],writes=[];const sdk={
async listPrivateState(){return {items:[...rows.values()].map(({value,...r})=>r)}},async readPrivateState(key,id){if(key==='drafts')throw Error('APP_NOT_FOUND');return {item:rows.get(id)}},
async request(operation,_,{run_id}){assert.equal(operation,'run_status');reads.push(run_id);if(deny.includes(run_id))throw Error('DENIED');return {id:wrongId?'foreign-run':run_id,state:states['current-'+run_id]||states[Number(run_id.slice(4))]||'succeeded'}},
async deletePrivateState(_,id,revision){assert.equal(revision,rows.get(id).revision);if(casFail.includes(id))throw Error('CAS');deleted.push(id);rows.delete(id)},
async putPrivateState(_,id,revision,v){assert.equal(revision,0);assert(!rows.has(id));writes.push(id);rows.set(id,{record_id:id,revision:1,value:v});return {item:{revision:1}}}};return {rows,reads,deleted,writes,journal:createRequestJournal(sdk,{uuid:()=> 'new-row'})};}
const entry={actionKey:'send_message',label:'Send',summary:'Next message',draftId:'new-draft'};
test('capacity reclaims only freshly verified oldest terminal metadata before reserving',async()=>{const f=fixture();await f.journal.load();await f.journal.reserve(entry);assert.deepEqual(f.deleted,['row-0']);assert.deepEqual(f.reads,['run-0']);assert.equal(f.rows.size,10);assert(f.rows.has('new-row'));});
test('fresh pending and unknown history stays while a verified terminal row can free capacity',async()=>{const f=fixture({states:{0:'unknown',1:'pending_approval',2:'pending'}});await f.journal.load();await f.journal.reserve(entry);assert.deepEqual(f.deleted,['row-3']);assert.deepEqual(f.reads,['run-0','run-1','run-2','run-3']);assert(f.rows.has('row-0')&&f.rows.has('row-1')&&f.rows.has('row-2'));});
test('all fresh pending or unknown rows keep cap closed without writes',async()=>{const f=fixture({states:Object.fromEntries(Array.from({length:10},(_,i)=>[i,i%2?'unknown':'pending']))});await f.journal.load();await assert.rejects(f.journal.reserve(entry),/REQUEST_JOURNAL_CAP/);assert.equal(f.reads.length,10);assert.deepEqual(f.deleted,[]);assert.deepEqual(f.writes,[]);});
test('denied or nonterminal status and CAS conflicts never delete that history',async()=>{const f=fixture({deny:['run-0'],states:{'current-run-1':'unknown_outcome'},casFail:['row-2']});await f.journal.load();await f.journal.reserve(entry);assert.deepEqual(f.deleted,['row-3']);assert(f.rows.has('row-0')&&f.rows.has('row-1')&&f.rows.has('row-2'));});
test('wrong Run identity never authorizes history deletion or new reservation',async()=>{const f=fixture({wrongId:true});await f.journal.load();await assert.rejects(f.journal.reserve(entry),/REQUEST_JOURNAL_CAP/);assert.equal(f.reads.length,10);assert.deepEqual(f.deleted,[]);assert.deepEqual(f.writes,[]);});
test('ten cached queued Runs that actually succeeded allow the next send reservation',async()=>{const states=Object.fromEntries(Array.from({length:10},(_,i)=>[i,'queued']));for(let i=0;i<10;i++)states['current-run-'+i]='succeeded';const f=fixture({states});await f.journal.load();await f.journal.reserve(entry);assert.deepEqual(f.deleted,['row-0']);assert.deepEqual(f.reads,['run-0']);assert.equal(f.rows.size,10);});
test('unknown entries without Run IDs remain pinned and cannot be discarded',async()=>{const f=fixture();for(const row of f.rows.values()){row.value.run_id='';row.value.state='unknown';}await f.journal.load();await assert.rejects(f.journal.reserve(entry),/REQUEST_JOURNAL_CAP/);assert.deepEqual(f.reads,[]);assert.deepEqual(f.deleted,[]);assert.deepEqual(f.writes,[]);});

// Model the host's active quotas and revisioned retained tombstones, rather than
// physically removing identifiers as the smaller journal fixtures do.
function quotaFixture(){
 const stores={drafts:new Map(),requests:new Map()},runs=new Map(),calls=[];
 const active=key=>[...stores[key].values()].filter(row=>!row.deleted);
 const sdk={
  async listPrivateState(key){return {items:active(key).map(({value,deleted,...meta})=>meta)};},
  async readPrivateState(key,id){const row=stores[key].get(id);if(!row||row.deleted)throw Error('APP_NOT_FOUND');return {item:structuredClone(row)};},
  async putPrivateState(key,id,revision,value){const old=stores[key].get(id);if((old?.revision??0)!==revision||old?.deleted)throw Error('APP_STATE_CONFLICT');const rows=active(key),bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>16384||rows.length+(old?0:1)>(key==='drafts'?32:10)||rows.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row.value)),0)-(old?Buffer.byteLength(JSON.stringify(old.value)):0)+bytes>131072)throw Error('APP_STATE_CONFLICT');const row={record_id:id,revision:revision+1,value:structuredClone(value),deleted:false};stores[key].set(id,row);calls.push(['put',key,id,row.revision]);return {item:{record_id:id,revision:row.revision}};},
  async deletePrivateState(key,id,revision){const row=stores[key].get(id);if(!row)throw Error('APP_NOT_FOUND');if(row.revision!==revision)throw Error('APP_STATE_CONFLICT');if(!row.deleted)stores[key].set(id,{record_id:id,revision:revision+1,value:null,deleted:true});calls.push(['delete',key,id,revision]);return {operation:'delete',record_id:id,revision:stores[key].get(id).revision};},
  async request(operation,_,{run_id}){assert.equal(operation,'run_status');calls.push(['status',run_id]);return runs.get(run_id)??{id:run_id,state:'unknown'};},
 };return {sdk,stores,runs,calls,active};
}
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('33 sequential known Sends reclaim terminal submitted draft quota before Activity eviction',async()=>{
 const f=quotaFixture();let draftNumber=0,requestNumber=1000;
 const controller=createDraftController(f.sdk,{snapshot:()=>({mode:'compose',to:'person@example.test',subject:'Sequential send',body:'Saved message',reply_record_id:''}),onChange(){},uuid:()=>id(++draftNumber)}),journal=createRequestJournal(f.sdk,{uuid:()=>id(++requestNumber)});
 for(let number=1;number<=33;number++){
  controller.use();await controller.save();assert.equal(controller.current.status,'Saved privately',`Send ${number} must remain saveable after terminal Activity eviction`);
  const reserved=await journal.reserve({actionKey:'send_message',label:'Send',summary:'Sequential send',draftId:controller.current.id}),run={id:id(2000+number),state:'succeeded'};f.runs.set(run.id,run);await journal.update(reserved,run);controller.close();
 }
 assert.equal(f.active('drafts').length,10);assert.equal(journal.entries.length,10);assert.equal(f.active('requests').length,10);
 const first=f.stores.drafts.get(id(1));assert.equal(first.deleted,true);assert.equal(first.value,null);assert.equal(first.revision,3);
 await assert.rejects(f.sdk.readPrivateState('drafts',id(1)),/APP_NOT_FOUND/);
 for(const revision of [0,1,2,3])await assert.rejects(f.sdk.putPrivateState('drafts',id(1),revision,{mode:'compose'}),/APP_STATE_CONFLICT/);
 const reopened=createRequestJournal(f.sdk);await reopened.load();assert.equal(reopened.entries.some(row=>row.draftId===id(1)),false);assert.equal((await f.sdk.listPrivateState('drafts')).items.some(row=>row.record_id===id(1)),false);
 for(const call of f.calls.filter(row=>row[0]==='delete'&&row[1]==='drafts')){
  const draftId=call[2],draftIndex=Number(draftId.slice(-12)),proof=f.calls.findIndex(row=>row[0]==='status'&&row[1]===id(2000+draftIndex)),draftDelete=f.calls.indexOf(call),activityDelete=f.calls.findIndex(row=>row[0]==='delete'&&row[1]==='requests'&&row[2]===id(1000+draftIndex));assert.ok(proof>=0&&proof<draftDelete&&draftDelete<activityDelete);
 }
});
test('fresh pending, wrong Run proof and unknown-without-Run retain draft bytes and Activity',async()=>{
 for(const proof of [{id:id(2001),state:'pending'},{id:id(2999),state:'succeeded'}]){
  const f=quotaFixture(),journal=createRequestJournal(f.sdk,{uuid:()=>id(1001)});await f.sdk.putPrivateState('drafts',id(1),0,{mode:'compose',to:'person@example.test',subject:'Keep',body:'Retained bytes',reply_record_id:''});const reserved=await journal.reserve({actionKey:'send_message',label:'Send',summary:'Keep',draftId:id(1)});await journal.update(reserved,{id:id(2001),state:'succeeded'});f.runs.set(id(2001),proof);
  await assert.rejects(journal.remove(reserved),/REQUEST_NOT_TERMINAL/);assert.equal(f.stores.drafts.get(id(1)).value.body,'Retained bytes');assert.equal(f.active('drafts').length,1);assert.equal(f.active('requests').length,1);assert.equal(f.calls.some(row=>row[0]==='delete'),false);
 }
 const unknown=quotaFixture(),journal=createRequestJournal(unknown.sdk,{uuid:()=>id(1001)});await unknown.sdk.putPrivateState('drafts',id(1),0,{mode:'compose',to:'person@example.test',subject:'Keep',body:'Unknown bytes',reply_record_id:''});const reserved=await journal.reserve({actionKey:'send_message',label:'Send',summary:'Unknown',draftId:id(1)});await journal.update(reserved,{state:'unknown'});await assert.rejects(journal.remove(reserved),/REQUEST_NOT_TERMINAL/);assert.equal(unknown.stores.drafts.get(id(1)).value.mode,'compose');assert.equal(unknown.calls.some(row=>row[0]==='delete'||row[0]==='status'),false);
});
test('draft delete CAS failure retains the changed draft and known terminal Run evidence',async()=>{
 const f=quotaFixture();let raced=false;const sdk={...f.sdk,async deletePrivateState(key,draftId,revision){if(key==='drafts'&&!raced){raced=true;await f.sdk.putPrivateState(key,draftId,revision,{...f.stores.drafts.get(draftId).value,body:'Changed elsewhere'});}return f.sdk.deletePrivateState(key,draftId,revision);}},journal=createRequestJournal(sdk,{uuid:()=>id(1001)});
 await sdk.putPrivateState('drafts',id(1),0,{mode:'compose',to:'person@example.test',subject:'Keep',body:'Saved bytes',reply_record_id:''});const reserved=await journal.reserve({actionKey:'send_message',label:'Send',summary:'Keep',draftId:id(1)}),run={id:id(2001),state:'succeeded'};f.runs.set(run.id,run);await journal.update(reserved,run);await assert.rejects(journal.remove(reserved),/APP_STATE_CONFLICT/);
 assert.equal(f.stores.drafts.get(id(1)).value.body,'Changed elsewhere');assert.equal(f.active('drafts').length,1);assert.equal(f.stores.requests.get(id(1001)).value.run_id,run.id);assert.equal(journal.entries.length,1);assert.equal(f.calls.some(row=>row[0]==='delete'),false);
});
test('lost draft delete acknowledgement preserves Activity and retries only terminal cleanup; orphans stay retained',async()=>{
 const f=quotaFixture();let loseAck=true;const sdk={...f.sdk,async deletePrivateState(key,...args){const result=await f.sdk.deletePrivateState(key,...args);if(key==='drafts'&&loseAck){loseAck=false;throw Error('DELETE_UNCONFIRMED');}return result;}},journal=createRequestJournal(sdk,{uuid:()=>id(1001)});
 await sdk.putPrivateState('drafts',id(1),0,{mode:'compose',to:'person@example.test',subject:'Keep',body:'Saved bytes',reply_record_id:''});const reserved=await journal.reserve({actionKey:'send_message',label:'Send',summary:'Keep',draftId:id(1)}),run={id:id(2001),state:'succeeded'};f.runs.set(run.id,run);await journal.update(reserved,run);await assert.rejects(journal.remove(reserved),/DELETE_UNCONFIRMED/);
 assert.equal(f.active('drafts').length,0);assert.equal(f.active('requests').length,1);assert.equal(journal.entries.length,1);await journal.remove(reserved);assert.equal(f.active('requests').length,0);assert.equal(f.calls.filter(row=>row[0]==='delete'&&row[1]==='drafts').length,1);
 await sdk.putPrivateState('drafts',id(2),0,{mode:'submitted',to:'person@example.test',subject:'Orphan',body:'No Run evidence',reply_record_id:''});const reopened=createRequestJournal(sdk);await reopened.load();assert.equal(reopened.entries.length,0);assert.equal(f.stores.drafts.get(id(2)).value.body,'No Run evidence');assert.equal(f.active('drafts').length,1);
});
test('a retained pending or unknown Activity reference keeps shared submitted draft bytes',async()=>{
 for(const peerHasRun of [true,false]){
  const f=quotaFixture();let nextRequest=1000;const journal=createRequestJournal(f.sdk,{uuid:()=>id(++nextRequest)});
  await f.sdk.putPrivateState('drafts',id(1),0,{mode:'compose',to:'person@example.test',subject:'Shared',body:'Shared saved bytes',reply_record_id:''});
  const first=await journal.reserve({actionKey:'send_message',label:'Send',summary:'First',draftId:id(1)}),peer=await journal.reserve({actionKey:'send_message',label:'Send',summary:'Peer',draftId:id(1)}),firstRun={id:id(2001),state:'succeeded'};
  f.runs.set(firstRun.id,firstRun);await journal.update(first,firstRun);
  if(peerHasRun){const peerRun={id:id(2002),state:'pending'};f.runs.set(peerRun.id,peerRun);await journal.update(peer,peerRun);}
  await journal.remove(first);assert.equal(f.active('requests').length,1);assert.equal(f.stores.drafts.get(id(1)).value.body,'Shared saved bytes');assert.equal(f.stores.drafts.get(id(1)).value.mode,'submitted');assert.equal(f.calls.some(row=>row[0]==='delete'&&row[1]==='drafts'),false);
  if(peerHasRun){await assert.rejects(journal.remove(peer),/REQUEST_NOT_TERMINAL/);f.runs.set(peer.runId,{id:peer.runId,state:'succeeded'});await journal.remove(peer);assert.equal(f.active('drafts').length,0);assert.equal(f.active('requests').length,0);}else{await assert.rejects(journal.remove(peer),/REQUEST_NOT_TERMINAL/);assert.equal(f.active('drafts').length,1);}
 }
});
