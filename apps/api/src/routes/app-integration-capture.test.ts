import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAppIntegrationCaptureRoutes} from './app-integration-capture.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source={installation_id:id(1),account_ref:'account_a',store_key:'drafts',ref:{resource_key:'inbox',record_id:id(2),content_digest:'sha256:'+'a'.repeat(64)}};
const caller={org_id:id(3),user_id:id(4),kind:'human' as const,principal_id:id(5)};
const policy={enabled:true,destination:{scope:'user',space_id:null},history_days:30,include_bulk:false,excluded_senders:[],excluded_folders:[],expected_revision:0};
function fixture(){let writes=0;const app=createAppIntegrationCaptureRoutes({authenticate:async request=>{if(request.headers.get('authorization')!=='Bearer actual-test-human')throw Error();return caller;},
 settings:async()=>({enabled:false,revision:0}),write:async(c,t,p)=>{assert.deepEqual(c,caller);assert.deepEqual(t,source);assert.deepEqual(p,policy);writes++;return {revision:1,enabled:true};},related:async()=>[],open:async()=>'/apps/'+id(1)+'/main?account_ref=account_a&source_record_id='+id(2)+'&source_digest='+source.ref.content_digest});return {app,writes:()=>writes};}
const request=(name:string,value:unknown,token=true)=>new Request('http://deft.test/'+name,{method:'POST',headers:{'Content-Type':'application/json',...(token?{authorization:'Bearer actual-test-human'}:{})},body:JSON.stringify(value)});
test('mounted capture route admits only real Host human factory and exact durable input; settings never invokes write',async()=>{
 const f=fixture(),settings=await f.app.fetch(request('settings',{source}));assert.equal(settings.status,200);assert.equal(settings.headers.get('cache-control'),'no-store');assert.equal(f.writes(),0);
 assert.equal((await f.app.fetch(request('write',{source,policy}))).status,200);assert.equal(f.writes(),1);
 for(const invalid of [{source:{...source,resource_binding_id:id(9)},policy},{source,policy,principal_id:id(6)},{source,policy:{...policy,model:'author-model'}}])assert.equal((await f.app.fetch(request('write',invalid))).status,400);
 assert.equal((await f.app.fetch(request('write',{source,policy},false))).status,403);assert.equal(f.writes(),1);
});
test('source opening returns authenticated internal nomination JSON and handles revoked source explicitly',async()=>{
 const f=fixture();const response=await f.app.fetch(new Request('http://deft.test/source/'+id(7),{headers:{authorization:'Bearer actual-test-human'}}));assert.equal(response.status,200);assert.match((await response.json()).href,/^\/apps\//u);
 const denied=createAppIntegrationCaptureRoutes({authenticate:async()=>caller,settings:async()=>({}),write:async()=>({}),related:async()=>[],open:async()=>{throw Error('revoked');}});assert.equal((await denied.fetch(new Request('http://deft.test/source/'+id(7)))).status,403);
});
