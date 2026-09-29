import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
const id='00000000-0000-4000-8000-000000000001',views=[],calls=[];let failures=2;
const entry={record_id:id,revision:1,value:{action_key:'send_message',label:'Send',summary:'Retained unknown send',source_record_id:'',draft_record_id:'',run_id:'',state:'unknown',created_at:new Date().toISOString()}};
const port={onmessage:null,close(){},postMessage(m){if(m.kind==='view'){views.push(m.view);return;}calls.push(m);let output;
 if(m.operation==='private_state'&&m.input.operation==='list')output={operation:'list',items:[{record_id:id,revision:1}]};
 else if(m.operation==='private_state'&&m.input.operation==='read'){assert.equal(m.input.record_id,id);if(failures-->0){setTimeout(()=>port.onmessage({data:{version:m.version,session_id:m.session_id,kind:'response',request_id:m.request_id,ok:false,error:{code:'UNAVAILABLE',message:'Unavailable'}}}),1);return;}output={operation:'read',item:entry};}
 else if(m.operation==='resource')output={schema_version:'deft.experience_resource_search_page.v1',operation:'search',items:[],next_cursor:null,scan:{records_scanned:0,complete:true},freshness:'unknown'};
 else throw Error('Unexpected mutation');
 setTimeout(()=>port.onmessage({data:{version:m.version,session_id:m.session_id,kind:'response',request_id:m.request_id,ok:true,output}}),1);
}};
const self={};vm.runInNewContext(readFileSync('worker.bundle.js','utf8'),{self,TextEncoder,Map,Promise,setTimeout,clearTimeout,crypto:{getRandomValues:b=>webcrypto.getRandomValues(b)}});self.onmessage({data:{kind:'start',port,session_id:'recovery_smoke'}});
const wait=()=>new Promise(r=>setTimeout(r,450));const nodes=()=>{const all=[];const visit=n=>{all.push(n);n.children?.forEach(visit)};visit(views.at(-1).root);return all;};const node=id=>nodes().find(n=>n.id===id);
const click=async node_id=>{port.onmessage({data:{version:'deft.experience_bridge.v1',session_id:'recovery_smoke',kind:'ui_event',event:{kind:'click',node_id}}});await wait();};
await wait();assert.equal(node('compose').disabled,true);assert.match(node('status').text,/Activity could not be loaded/);assert.equal(calls.filter(m=>m.operation==='private_state'&&m.input.operation==='read').length,2,'Initial failed record retried exactly once');
await click('refresh');assert.equal(node('compose').disabled,false,'Refresh recovers history before enabling Compose');await click('requests');assert(nodes().some(n=>n.text?.includes('Retained unknown send')),'Unknown history was not dropped to enable Compose');
assert.equal(calls.filter(m=>m.operation==='private_state'&&!['read','list'].includes(m.input.operation)).length,0);assert.equal(calls.filter(m=>['action','dialog'].includes(m.operation)).length,0);
console.log(JSON.stringify({passed:true,initial_retry_once:true,refresh_recovered_same_record:true,unknown_retained:true,writes:0,effects:0,views:views.length}));
