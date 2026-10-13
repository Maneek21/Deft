import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderDraftStatus,parseProviderDraftStatus,providerDraftStatusText,type ProviderDraftStatus} from './email-provider-draft-status';
const draft='11111111-1111-4111-8111-111111111111';
const status:ProviderDraftStatus={account_id:'account',draft_id:draft,enabled:true,draft_revision:4,state:'unknown',generation:2,desired_revision:4,synced_revision:3,updated_at:'2026-10-04T00:00:00.000Z',recovery_available:true,recovery_pending:false};
const response=(value:unknown,code=200)=>new Response(JSON.stringify(value),{status:code});
test('closed provider status rejects scope substitution, private locators and false recovery eligibility',()=>{
 assert.deepEqual(parseProviderDraftStatus(status,'account',draft),status);
 for(const value of [{...status,account_id:'other'},{...status,provider_draft_ref:'secret'},{...status,enabled:false},{...status,desired_revision:2},{...status,state:'synced'},{...status,generation:null}])assert.throws(()=>parseProviderDraftStatus(value,'account',draft));
 assert.match(providerDraftStatusText({...status,state:'conflict',recovery_available:false}),/will not overwrite/);
 assert.match(providerDraftStatusText({...status,recovery_pending:true}),/not confirmed/);
 assert.doesNotMatch(providerDraftStatusText(status),/11111111|generation|unknown create/i);
});
test('explicit reconciliation uses immutable revision/generation once; accepted response is not a synced claim',async()=>{
 const calls:{path:string;init:RequestInit}[]=[];
 const client=createProviderDraftStatus({accountId:'account',draftId:draft,current:()=>true,change:()=>{},fetch:async(path,init)=>{calls.push({path,init});return response(init.method==='POST'?{account_id:'account',draft_id:draft,state:'queued'}:status,init.method==='POST'?202:200);}});
 await client.check();await client.reconcile();await client.reconcile();assert.equal(calls.length,2);assert.deepEqual(JSON.parse(calls[1].init.body as string),{expected_revision:4,expected_generation:2});assert.match(calls[1].path,/\/provider-sync\/recover$/);assert.equal(client.snapshot().value?.state,'unknown');assert.match(client.snapshot().notice,/not confirmed/);assert.equal(client.snapshot().recoveryPending,true);
 await client.check();await client.reconcile();assert.equal(calls.filter(item=>item.init.method==='POST').length,1);client.dispose();
});
test('lost recovery acknowledgment never re-posts; pending server job and unknown creates disable recovery',async()=>{
 let posts=0;const value={...status};const client=createProviderDraftStatus({accountId:'account',draftId:draft,current:()=>true,change:()=>{},fetch:async(_path,init)=>{if(init.method==='POST'){posts++;throw Error('lost ack');}return response(value);}});
 await client.check();await client.reconcile();await client.check();await client.reconcile();assert.equal(posts,1);assert.equal(client.snapshot().recoveryPending,true);client.dispose();
 for(const candidate of [{...status,recovery_pending:true},{...status,recovery_available:false}]){let writes=0;const next=createProviderDraftStatus({accountId:'account',draftId:draft,current:()=>true,change:()=>{},fetch:async(_path,init)=>{if(init.method==='POST')writes++;return response(candidate);}});await next.check();await next.reconcile();assert.equal(writes,0);next.dispose();}
});
test('held results after scope switch are discarded and denial clears status',async()=>{
 let resolve!:(value:Response)=>void,active=true,changes=0;const client=createProviderDraftStatus({accountId:'account',draftId:draft,current:()=>active,change:()=>changes++,fetch:()=>new Promise(value=>{resolve=value;})});
 const held=client.check();active=false;resolve(response(status));await held;assert.equal(client.snapshot().value,null);assert.equal(changes,1);client.dispose();
 let denied=0;const other=createProviderDraftStatus({accountId:'account',draftId:draft,current:()=>true,change:()=>{},denied:()=>denied++,fetch:async()=>response({},403)});await other.check();assert.equal(denied,1);assert.equal(other.snapshot().value,null);other.dispose();
});
test('oversized and malformed successful responses cannot expose status or authorize recovery',async()=>{
 for(const body of ['x'.repeat(8193),'{bad',JSON.stringify({...status,provider_draft_ref:'private'})]){const client=createProviderDraftStatus({accountId:'account',draftId:draft,current:()=>true,change:()=>{},fetch:async()=>new Response(body)});await client.check();assert.equal(client.snapshot().value,null);assert.match(client.snapshot().notice,/could not be confirmed/);client.dispose();}
});
test('a foreign or private recovery acknowledgment stays uncertain and cannot trigger another POST',async()=>{
 for(const ack of [{account_id:'other',draft_id:draft,state:'queued'},{account_id:'account',draft_id:draft,state:'queued',provider_draft_ref:'private'}]){let writes=0;const client=createProviderDraftStatus({accountId:'account',draftId:draft,current:()=>true,change:()=>{},fetch:async(_path,init)=>{if(init.method==='POST'){writes++;return response(ack,202);}return response(status);}});await client.check();await client.reconcile();await client.reconcile();assert.equal(writes,1);assert.match(client.snapshot().notice,/could not be confirmed/);client.dispose();}
});
