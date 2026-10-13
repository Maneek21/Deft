import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailProviderDraftSettingsRoutes} from '../src/routes/email-provider-draft-settings.js';
import {EmailProviderDraftSettingsError} from '../src/lib/email-provider-draft-settings.js';
import {EmailMailboxError} from '../src/lib/email-mailbox-service.js';
const base='/accounts/account/provider-draft-sync';
function fixture(){
 const calls:any[]=[];let failure:Error|null=null,expiry=10;
 const routes=createEmailProviderDraftSettingsRoutes({now:()=>1000,verify:async()=>({id:'owner',org_id:'org',sid:'sid',exp:expiry}),settings:async()=>({get:async(...input:any[])=>{calls.push(input);if(failure)throw failure;return {account_id:'account',enabled:false,revision:1,supported:true};},update:async(...input:any[])=>{calls.push(input);if(failure)throw failure;return {account_id:'account',enabled:true,revision:2,supported:true};}})});
 return {routes,calls,fail:(error:Error)=>{failure=error;},expire:()=>{expiry=1;}};
}
test('GET/PATCH use exact verified owner/SID scope and closed CAS input, with no-store projection',async()=>{
 const f=fixture();const get=await f.routes.request(base,{headers:{authorization:'Bearer token'}});assert.equal(get.status,200);assert.equal(get.headers.get('cache-control'),'no-store');assert.deepEqual(f.calls[0].slice(0,3),[{user_id:'owner',web_session_id:'sid',access_expires_at:10000},'org','account']);assert.deepEqual(await get.json(),{account_id:'account',enabled:false,revision:1,supported:true});
 const patch=await f.routes.request(base,{method:'PATCH',headers:{authorization:'Bearer token','content-type':'application/json'},body:JSON.stringify({enabled:true,expected_revision:1})});assert.equal(patch.status,200);assert.deepEqual(f.calls[1][3],{enabled:true,expected_revision:1});
});
test('missing/expired human auth and query/body injections never reach the setting service',async()=>{
 const f=fixture();assert.equal((await f.routes.request(base)).status,401);f.expire();assert.equal((await f.routes.request(base,{headers:{authorization:'Bearer token'}})).status,401);assert.equal(f.calls.length,0);
 const fresh=fixture();assert.equal((await fresh.routes.request(base+'?owner=other',{headers:{authorization:'Bearer token'}})).status,400);
 for(const input of [{enabled:true,expected_revision:1,owner_user_id:'other'},{enabled:'true',expected_revision:1},{enabled:true,expected_revision:0}])assert.equal((await fresh.routes.request(base,{method:'PATCH',headers:{authorization:'Bearer token','content-type':'application/json'},body:JSON.stringify(input)})).status,400);
 assert.equal(fresh.calls.length,0);
});
test('conflict, unsupported and denial stay distinct; unexpected SQL/private errors cannot leak',async()=>{
 for(const [error,status,code] of [[new EmailProviderDraftSettingsError('EMAIL_DRAFT_SYNC_CONFLICT'),409,'EMAIL_DRAFT_SYNC_CONFLICT'],[new EmailProviderDraftSettingsError('EMAIL_DRAFT_SYNC_UNSUPPORTED'),422,'EMAIL_DRAFT_SYNC_UNSUPPORTED'],[new EmailMailboxError('EMAIL_ACCESS_DENIED'),403,'EMAIL_ACCESS_DENIED'],[Error('private-provider-locator'),503,'EMAIL_DRAFT_SYNC_UNAVAILABLE']] as const){const f=fixture();f.fail(error);const response=await f.routes.request(base,{headers:{authorization:'Bearer token'}});assert.equal(response.status,status);assert.deepEqual(await response.json(),{code});}
});
