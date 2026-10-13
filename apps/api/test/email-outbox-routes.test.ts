import assert from 'node:assert/strict';
import test from 'node:test';
import {createEmailOutboxRoutes} from '../src/routes/email-outbox.js';
const id='00000000-0000-4000-8000-000000000001',requestId='00000000-0000-4000-8000-000000000002';
const body={draft_id:id,expected_revision:4,request_id:requestId,undo_delay_seconds:10};
function fixture(){
 const calls:any[]=[];let failure='';const service=new Proxy({},{get:(_target,action)=>action==='then'?undefined:async(...args:any[])=>{calls.push({action,args});if(failure)throw Error(failure);return {outbox_id:id,state:'queued'};}});
 return {calls,route:createEmailOutboxRoutes({verify:async()=>({id:'owner',org_id:'org',sid:'sid',exp:Date.now()/1000+600}),service:async()=>service as any}),fail:(code:string)=>{failure=code;}};
}
const post=(value:unknown)=>({method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify(value)});
test('Outbox enqueue pins owner and immutable request; reads do not dispatch and private responses are no-store',async()=>{
 const f=fixture(),response=await f.route.request('/accounts/account/outbox',post(body));assert.equal(response.status,202);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(f.calls[0].args.slice(1,3),[{org_id:'org',owner_user_id:'owner',account_id:'account'},body]);assert.equal(f.calls[0].action,'enqueue');
 assert.equal((await f.route.request('/accounts/account/outbox/'+id,{headers:{authorization:'Bearer fixture'}})).status,200);assert.equal(f.calls[1].action,'read');
 assert.equal((await f.route.request('/accounts/account/outbox?limit=10',{headers:{authorization:'Bearer fixture'}})).status,200);assert.equal(f.calls[2].action,'list');
 const lookup=await f.route.request('/accounts/account/outbox/requests/'+requestId,{headers:{authorization:'Bearer fixture'}});assert.equal(lookup.status,200);assert.equal(f.calls[3].action,'readRequest');assert.ok((await lookup.json()).operation);
 const draft=await f.route.request('/accounts/account/drafts/'+id+'/outbox/4',{headers:{authorization:'Bearer fixture'}});assert.equal(draft.status,200);assert.equal(f.calls[4].action,'readDraft');assert.deepEqual(f.calls[4].args.slice(2,4),[id,4]);
});
test('Outbox rejects injected content, sender, unknown query, invalid session and future implicit consent',async()=>{
 const f=fixture();for(const extra of [{owner_user_id:'other'},{body:'injected'},{from:'sender@example.test'},{schedule:{instant:new Date().toISOString()}}]){
  assert.equal((await f.route.request('/accounts/account/outbox',post({...body,...extra}))).status,400);
 }
 assert.equal((await f.route.request('/accounts/account/outbox?owner=other',post(body))).status,400);
 assert.equal((await f.route.request('/accounts/account/outbox',{method:'POST'})).status,401);assert.equal(f.calls.length,0);
});
test('Outbox cancellation and rescheduling require exact revision and surface race/ambiguous-time outcomes',async()=>{
 const f=fixture();assert.equal((await f.route.request('/accounts/account/outbox/'+id+'/cancel',post({expected_revision:1}))).status,200);
 assert.deepEqual(f.calls[0].args[2],{outbox_id:id,expected_revision:1});
 f.fail('EMAIL_OUTBOX_CONFLICT');assert.equal((await f.route.request('/accounts/account/outbox/'+id+'/cancel',post({expected_revision:1}))).status,409);
 f.fail('EMAIL_OUTBOX_SCHEDULE_AMBIGUOUS');const schedule={wall_time:'2026-11-01T01:30',zone:'America/New_York',ambiguity:'reject',missed_policy:'pause_if_late'};
 const result=await f.route.request('/accounts/account/outbox/'+id+'/reschedule',post({expected_revision:2,schedule}));assert.equal(result.status,422);assert.deepEqual(await result.json(),{code:'EMAIL_OUTBOX_SCHEDULE_AMBIGUOUS'});
});
test('Outbox strips unexpected provider failures from HTTP',async()=>{const f=fixture();f.fail('private-provider-error');const result=await f.route.request('/accounts/account/outbox',post(body));assert.equal(result.status,503);assert.deepEqual(await result.json(),{code:'EMAIL_OUTBOX_UNAVAILABLE'});});
