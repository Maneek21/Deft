import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailProviderDraftStatusRoutes} from '../src/routes/email-provider-draft-status.js';
import {EmailMailboxError} from '../src/lib/email-mailbox-service.js';
const draft='11111111-1111-4111-8111-111111111111',base='/accounts/account/drafts/'+draft+'/provider-sync';
const status={account_id:'account',draft_id:draft,enabled:true,draft_revision:4,state:'unknown' as const,desired_revision:4,synced_revision:3,generation:2,updated_at:'2026-10-04T00:00:00.000Z',recovery_available:true,recovery_pending:false};
function fixture(){const calls:unknown[][]=[];let fail:Error|null=null,clock=1000,view:unknown=status;
 const routes=createEmailProviderDraftStatusRoutes({now:()=>clock,verify:async()=>({id:'owner',org_id:'org',sid:'sid',exp:10}),read:async(...input)=>{calls.push(input);if(fail)throw fail;return view as typeof status;},recover:async(...input)=>{calls.push(input);if(fail)throw fail;return {account_id:'account',draft_id:draft,state:'queued'};}});
 return {routes,calls,fail:(error:Error)=>{fail=error;},view:(value:unknown)=>{view=value;},expire:()=>{clock=10000;}};
}
const headers={authorization:'Bearer token','content-type':'application/json'};
test('status and explicit enqueue use exact human scope and closed projection; queued is 202',async()=>{
 const f=fixture(),get=await f.routes.request(base,{headers});assert.equal(get.status,200);assert.equal(get.headers.get('cache-control'),'no-store');assert.deepEqual(await get.json(),status);assert.deepEqual(f.calls[0]!.slice(0,4),[{user_id:'owner',web_session_id:'sid',access_expires_at:10000},'org','account',draft]);
 const post=await f.routes.request(base+'/recover',{method:'POST',headers,body:JSON.stringify({expected_revision:4,expected_generation:2})});assert.equal(post.status,202);assert.deepEqual(f.calls[1]![4],{expected_revision:4,expected_generation:2});assert.deepEqual(await post.json(),{account_id:'account',draft_id:draft,state:'queued'});
});
test('missing auth, query nominations and private/body input never reach service',async()=>{
 const f=fixture();assert.equal((await f.routes.request(base)).status,401);assert.equal((await f.routes.request(base+'?owner=other',{headers})).status,400);
 for(const input of [{expected_revision:4,expected_generation:2,provider_draft_ref:'secret'},{expected_revision:4,expected_generation:0},{expected_revision:'4',expected_generation:2}])assert.equal((await f.routes.request(base+'/recover',{method:'POST',headers,body:JSON.stringify(input)})).status,400);assert.equal(f.calls.length,0);
});
test('denial/conflict stay explicit and provider/private failures and leaked service projections fail closed',async()=>{
 for(const [error,code] of [[new EmailMailboxError('EMAIL_ACCESS_DENIED'),403],[Error('EMAIL_DRAFT_SYNC_CONFLICT'),409],[Error('private-provider-ref'),503]] as const){const f=fixture();f.fail(error);const result=await f.routes.request(base,{headers});assert.equal(result.status,code);assert.doesNotMatch(await result.text(),/private-provider-ref/);}
 for(const view of [{...status,provider_draft_ref:'secret'},{...status,account_id:'other'}]){const f=fixture();f.view(view);assert.equal((await f.routes.request(base,{headers})).status,503);}
});
test('expiry sampled after held status prevents disclosing its result',async()=>{
 let clock=1000;const routes=createEmailProviderDraftStatusRoutes({now:()=>clock,verify:async()=>({id:'owner',org_id:'org',sid:'sid',exp:10}),read:async()=>{clock=10000;return status;},recover:async()=>({account_id:'account',draft_id:draft,state:'queued'})});
 const result=await routes.request(base,{headers});assert.equal(result.status,403);assert.deepEqual(await result.json(),{code:'EMAIL_ACCESS_DENIED'});
});
