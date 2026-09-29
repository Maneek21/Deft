import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createDraftController, createDraftId} from './draft-controller.mjs';
import {createRequestJournal} from './request-journal.mjs';

async function start({messages=[],drafts=[],requests=[],dialog,statusUnavailable=false}={}) {
  const views=[],checks=[],stores={drafts:new Map(drafts.map(item=>[item.record_id,item])),requests:new Map(requests.map(item=>[item.record_id,item]))};
  let event;
  const sdk={render:view=>views.push(view),onEvent:handler=>{event=handler;},
    searchResourceRecords:async(_key,args)=>{const offset=Number(args.cursor||0),items=messages.slice(offset,offset+10).map(data=>({record_id:data.resource_id,label:data.subject}));return {items,next_cursor:offset+10<messages.length?String(offset+10):null,scan:{complete:offset+10>=messages.length}};},
    readResourceRecord:async(_key,id)=>({item:{data:messages.find(data=>data.resource_id===id)}}),
    listPrivateState:async key=>({items:[...stores[key].values()].map(({record_id,updated_at})=>({record_id,updated_at}))}),
    readPrivateState:async(key,id)=>({item:stores[key].get(id)}),
    putPrivateState:async(key,id,revision,value)=>{const item={record_id:id,revision:revision+1,updated_at:new Date().toISOString(),value};stores[key].set(id,item);return {item};},
    deletePrivateState:async(key,id)=>stores[key].delete(id),
    request:async(kind,_key,input)=>{if(kind==='run_status'){checks.push(input.run_id);if(statusUnavailable)throw Error('Unavailable');return {id:input.run_id,state:'succeeded'};}if(kind==='dialog')return dialog?.(stores,input);throw Error('Unexpected external action');},
  };
  const self={};
  vm.runInNewContext(readFileSync(new URL('./worker.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''),{self,createDeftExperienceSdk:()=>sdk,createDraftController,createDraftId,createRequestJournal,TextEncoder,Map,Promise,Date,setTimeout,clearTimeout,crypto:webcrypto});
  self.onmessage({data:{kind:'start',port:{},session_id:'test'}});
  await new Promise(resolve=>setTimeout(resolve,20));
  const nodes=()=>{const result=[];const walk=node=>{result.push(node);node.children?.forEach(walk);};walk(views.at(-1).root);return result;};
  return {nodes,checks,stores,click:async node_id=>event({kind:'click',node_id})};
}
const message=i=>({resource_id:`mail-${i}`,subject:`Subject ${i}`,folder:'inbox',date:new Date(2026,0,i+1).toISOString(),body:'message'});
const draft=(id,subject)=>({record_id:id,revision:1,updated_at:'2026-09-28T00:00:00Z',value:{mode:'compose',to:'person@example.test',subject,body:'message',reply_record_id:''}});
const request=(action,draftId='')=>({record_id:'request',revision:1,value:{action_key:action,label:action==='archive_message'?'Archive':'Send',summary:'Old summary',source_record_id:'',draft_record_id:draftId,run_id:'run-1',state:'pending_approval',created_at:'2026-09-28T00:00:00Z'}});

test('folder count covers index and newest dated message leads first page',async()=>{
  const ui=await start({messages:Array.from({length:26},(_,i)=>message(i))});
  assert.equal(ui.nodes().find(node=>node.id==='mail_0').label,'Subject 25');
  assert.match(ui.nodes().find(node=>node.id==='loaded_count').text,/26/);
  await ui.click('more');assert.equal(ui.nodes().find(node=>node.id==='mail_0').label,'Subject 15');
});
test('private draft labels use saved subjects and exclude submitted drafts',async()=>{
  const ui=await start({drafts:[draft('first','Saved subject'),draft('submitted','Already sent')],requests:[request('send_message','submitted')]});
  await ui.click('drafts');assert.equal(ui.nodes().find(node=>node.id==='draft_open_0').label,'Saved subject');
  assert.equal(ui.nodes().filter(node=>node.id.startsWith('draft_open_')).length,1);
});
test('Activity refreshes known Runs on entry and archive success avoids delivery copy',async()=>{
  const ui=await start({requests:[request('archive_message')]});await ui.click('requests');
  assert.equal(ui.checks.length,1);const text=ui.nodes().find(node=>node.id==='action_state_0').text;
  assert.match(text,/Archiv/i);assert.doesNotMatch(text,/delivery|Mail server/);
});
test('partial folder index stops at100 records and does not claim total or global newest',async()=>{
  const ui=await start({messages:Array.from({length:126},(_,i)=>message(i))});
  assert.match(ui.nodes().find(node=>node.id==='loaded_count').text,/100 loaded messages.*partial index/);
  assert.match(ui.nodes().find(node=>node.id==='index_limit').text,/within the loaded set/);
  assert.equal(ui.nodes().find(node=>node.id==='mail_0').label,'Subject 99');
});
test('submitted summary uses exact host input rather than initial or subsequently edited draft',async()=>{
  const ui=await start({drafts:[draft('first','Initial subject')],dialog:stores=>{
    const saved=stores.drafts.get('first');saved.value={...saved.value,to:'later-edit@example.test',subject:'Later mutable draft edit'};
    return {run:{id:'run-2',state:'succeeded',submitted_input:{to:'actual@example.test',subject:'Actual submitted subject'}}};
  }});
  await ui.click('drafts');await ui.click('draft_open_0');await ui.click('requests');
  assert.match(ui.nodes().find(node=>node.id==='action_summary_0').text,/actual@example.test · Actual submitted subject/);
});
test('known Run is retained when submitted draft read cannot confirm details',async()=>{
  const ui=await start({drafts:[draft('first','Initial subject')],dialog:stores=>{
    stores.drafts.get('first').value=null;return {run:{id:'run-2',state:'succeeded'}};
  }});
  await ui.click('drafts');await ui.click('draft_open_0');
  const saved=[...ui.stores.requests.values()][0].value;
  assert.equal(saved.run_id,'run-2');assert.equal(saved.summary,'Submitted message details unavailable.');
});
test('unavailable Activity refresh preserves last known state without external retries',async()=>{
  const ui=await start({requests:[request('archive_message')],statusUnavailable:true});await ui.click('requests');
  assert.equal(ui.checks.length,1);
  assert.match(ui.nodes().find(node=>node.id==='action_state_0').text,/Waiting for your approval/);
  assert.equal(ui.stores.requests.get('request').value.state,'pending_approval');
});
