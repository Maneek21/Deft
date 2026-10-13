import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailMailboxServicePageRunner} from '../src/lib/email-mailbox-service-runtime.js';
import {EmailMailboxError,type EmailMailboxStore,type EmailSyncCommit} from '../src/lib/email-mailbox-service.js';

const scope={org_id:'org',owner_user_id:'owner',account_id:'account',authority_revision:1};
const lease={job_id:'job',lock_token:'lease'};
function fixture(){
  let revision=0,revoked=false,reads=0,commits=0;const calls:unknown[]=[];
  const account={account_id:'account',resource_binding_id:'binding',provider:'gmail' as const,authority_epoch:1,connection_revision:1,
    principal_digest:'a'.repeat(64),health:'connected',capabilities:['read'],primary_address:'fixture@example.test',display_label:'Fixture'};
  const store={readCheckpoint:async()=>({revision,cursor:null,has_more:false}),readSyncReceipt:async()=>null,
    commitPage:async(_scope:unknown,commit:EmailSyncCommit,guard:(tx:unknown)=>Promise<void>)=>{
      await guard({commit:true});commits++;revision++;
      assert.equal(commit.page_id,`sync:job:${revision-1}`);
      return {checkpoint_revision:revision,state:'applied' as const,observed_at:new Date(1000).toISOString(),complete:true,has_more:false};
    }} as unknown as EmailMailboxStore;
  const run=createEmailMailboxServicePageRunner({now:()=>1000,currentSql:async(accountScope,delivery,transaction)=>{
    calls.push({accountScope,delivery,transaction});if(revoked)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
    assert.deepEqual(delivery,lease);assert.deepEqual(accountScope,{org_id:'org',owner_user_id:'owner',account_id:'account'});
    return {scope:accountScope,resource_binding_id:'binding',authority_version:'authority',expires_at:10000};
  },components:async currentSql=>({store,provider:{assertConnected:async(_scope,_cap,recheck)=>{await recheck();return account;},
    readPage:async(actual,_request,_cap,recheck)=>{reads++;await currentSql(actual);await recheck();return {
      account_id:'account',items:[],next_cursor:null,has_more:false,complete:true,observed_at:new Date(1000).toISOString(),failure_count:0,tombstones:[],state_updates:[]};}}})});
  return {run,calls,counts:()=>({reads,commits}),revoke:()=>{revoked=true;}};
}
test('background runtime commits one page with real lease authority, resumes checkpoint, and never supplies a human actor',async()=>{
  const f=fixture();assert.equal((await f.run(scope,lease)).checkpoint_revision,1);
  assert.equal((await f.run(scope,lease)).checkpoint_revision,2);
  assert.deepEqual(f.counts(),{reads:2,commits:2});
  assert.ok(f.calls.some(value=>(value as {transaction?:unknown}).transaction));
  assert.equal(JSON.stringify(f.calls).includes('web_session_id'),false);
});
test('revoked service authority prevents provider reads and commits',async()=>{
  const f=fixture();f.revoke();await assert.rejects(f.run(scope,lease),/EMAIL_ACCESS_DENIED/);
  assert.deepEqual(f.counts(),{reads:0,commits:0});
});
