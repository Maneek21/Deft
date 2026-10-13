import assert from 'node:assert/strict';
import test from 'node:test';
import {createEmailSentCopyRoutes} from '../src/routes/email-sent-copy.js';
const id='00000000-0000-4000-8000-000000000001';
function fixture(){const calls:Array<{method:string;args:any[]}>=[];let failure='';const invoke=async(method:string,args:any[],result:unknown)=>{calls.push({method,args});if(failure)throw Error(failure);return result;};
 const settings={account_id:'account',revision:3,sent_copy_mode:'server_managed' as const,provider:'imap_smtp' as const,append_available:true};
 const route=createEmailSentCopyRoutes({verify:async()=>({id:'owner',org_id:'org',sid:'exact-human-sid',exp:Date.now()/1000+600}),controls:async actor=>({
  settings:{read:async(...args)=>invoke('read-settings',[actor,...args],settings) as any,update:async(...args)=>invoke('update-settings',[actor,...args],settings) as any},
  read:async(...args)=>invoke('read',[actor,...args],{outbox_id:id,operation_id:id,outcome:'unknown',delivery_status:'unknown'}) as any,
  reconcile:async(...args)=>invoke('reconcile',[actor,...args],{outbox_id:id,operation_id:id,outcome:'pending',delivery_status:'unknown'}) as any})});return {route,calls,fail:(code:string)=>failure=code};}
const headers={authorization:'Bearer fixture'},json=(method:string,body:unknown)=>({method,headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
test('Sent-copy settings/status use exact session owner/account and no-store JSON; manual recovery is separate from send',async()=>{
 const f=fixture(),read=await f.route.request('/accounts/account/sent-copy-settings',{headers});assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert.equal(read.headers.get('pragma'),'no-cache');
 assert.deepEqual(f.calls[0]!.args[0],{user_id:'owner',web_session_id:'exact-human-sid',access_expires_at:f.calls[0]!.args[0].access_expires_at});assert.deepEqual(f.calls[0]!.args[2],{org_id:'org',owner_user_id:'owner',account_id:'account'});
 assert.equal((await f.route.request('/accounts/account/sent-copy-settings',json('PATCH',{expected_revision:3,sent_copy_mode:'append'}))).status,200);assert.equal(f.calls[1]!.method,'update-settings');
 assert.deepEqual(f.calls[1]!.args[3],{expected_revision:3,sent_copy_mode:'append'});
 assert.equal((await f.route.request('/accounts/account/outbox/'+id+'/sent-copy',{headers})).status,200);assert.equal(f.calls[2]!.method,'read');assert.deepEqual(f.calls[2]!.args[1],{org_id:'org',owner_user_id:'owner',account_id:'account'});
 assert.equal((await f.route.request('/accounts/account/outbox/'+id+'/sent-copy/reconcile',json('POST',{}))).status,202);assert.equal(f.calls[3]!.method,'reconcile');assert.equal(f.calls[3]!.args[2],id);
});
test('Sent-copy HTTP cannot nominate credentials, scopes, provider folders, MIME or worker leases',async()=>{
 const f=fixture();for(const extra of [{password:'caller-secret'},{org_id:'foreign'},{mailbox:'Guessed Sent'},{mime_bytes:'raw'},{job_id:id,lock_token:id}]){
  assert.equal((await f.route.request('/accounts/account/sent-copy-settings',json('PATCH',{expected_revision:3,sent_copy_mode:'append',...extra}))).status,400);
  assert.equal((await f.route.request('/accounts/account/outbox/'+id+'/sent-copy/reconcile',json('POST',extra))).status,400);
 }
 assert.equal((await f.route.request('/accounts/account/sent-copy-settings?owner=foreign',{headers})).status,400);assert.equal((await f.route.request('/accounts/account/outbox/not-a-uuid/sent-copy',{headers})).status,400);
 assert.equal((await f.route.request('/accounts/account/sent-copy-settings')).status,401);assert.equal(f.calls.length,0);
 assert.equal((await f.route.request('/accounts/account/sent-copy-settings',json('PATCH',{expected_revision:3,sent_copy_mode:'append',oversize:'x'.repeat(5000)}))).status,413);assert.equal(f.calls.length,0);
});
test('current revocation, CAS conflict and unavailable append stay explicit while private provider errors are stripped',async()=>{
 const f=fixture();f.fail('EMAIL_ACCESS_DENIED');assert.equal((await f.route.request('/accounts/account/outbox/'+id+'/sent-copy',{headers})).status,403);
 f.fail('EMAIL_IMAP_CUSTODY_CONFLICT');assert.equal((await f.route.request('/accounts/account/sent-copy-settings',json('PATCH',{expected_revision:3,sent_copy_mode:'append'}))).status,409);
 f.fail('EMAIL_SENT_COPY_APPEND_UNAVAILABLE');assert.equal((await f.route.request('/accounts/account/sent-copy-settings',json('PATCH',{expected_revision:3,sent_copy_mode:'append'}))).status,422);
 f.fail('private password/host details');const response=await f.route.request('/accounts/account/sent-copy-settings',{headers});assert.equal(response.status,503);assert.deepEqual(await response.json(),{code:'EMAIL_SENT_COPY_UNAVAILABLE'});
});
