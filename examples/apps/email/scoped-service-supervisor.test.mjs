import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmailScopedSupervisor,runEmailScopedSupervisorCli,emailScopedChildDeadline} from './scoped-service-supervisor.mjs';
const binding={id:'binding-send',registration_id:'registration',installation_id:'installation',app_version_id:'version',grant_snapshot_id:'grant',action_key:'send_message',runtime_epoch:1,operator_user_id:'owner'};
const clone=structuredClone;
function fixture(){
 let state=null,time=1000000,run=1,sessionMs=120000;const calls=[],current={binding:{...binding,state:'active',registration_state:'active'}};
 const ports={binding,now:()=>time,store:{load:async()=>clone(state),save:async value=>{state=clone(value);calls.push('save:'+value.phase);}},
  inspect:async()=>{calls.push('inspect');return clone(current);},
  issueSession:async()=>{calls.push('issue');return {session_id:'scoped-session',session_token:'x'.repeat(32),expires_at:new Date(time+sessionMs).toISOString()};},
  createClient:credential=>{assert.deepEqual(Object.keys(credential).sort(),['session_id','session_token']);return {claim:async()=>{calls.push('claim');return {operation_name:'send_message',run_id:'run-'+run++,attempt_id:'attempt-1',audience:'app_runtime',runtime_binding_id:ports.binding.id,
   runtime_registration_id:ports.binding.registration_id,runtime_epoch:ports.binding.runtime_epoch,app_installation_id:ports.binding.installation_id,app_version_id:ports.binding.app_version_id,
   grant_snapshot_id:ports.binding.grant_snapshot_id,session_id:credential.session_id,lifecycle_epoch:1,grant_epoch:1,session_epoch:1,lease_expires_at:new Date(time+60000).toISOString()};}};},
  runChild:async message=>{calls.push('child');assert.deepEqual(Object.keys(message).sort(),['claim','credential','session_expires_at']);assert.equal(message.session_expires_at,new Date(time+sessionMs).toISOString());assert.deepEqual(Object.keys(message.credential).sort(),['session_id','session_token']);assert.equal(state.phase,'claimed');assert.equal(state.inflight.run_id,message.claim.run_id);return {state:'provider_accepted',run_id:message.claim.run_id,automatic_retry:false};}};
 return {ports,calls,current,advance:value=>{time+=value;},setSessionMs:value=>{sessionMs=value;},read:()=>clone(state)};
}
test('normal dispatch persists exact claim before child and continues after settled restart',async()=>{
 const f=fixture(),supervisor=await createEmailScopedSupervisor(f.ports);
 assert.equal((await supervisor.step()).phase,'idle');assert.equal(f.read().last_run_id,'run-1');
 const restarted=await createEmailScopedSupervisor(f.ports);assert.equal((await restarted.step()).last_run_id,'run-2');
 assert.equal(f.calls.filter(call=>call==='child').length,2);assert.equal(f.calls.filter(call=>call==='issue').length,2);
});
test('only technical scoped lease renews under unchanged reviewed identity',async()=>{
 const f=fixture(),supervisor=await createEmailScopedSupervisor(f.ports);await supervisor.step();await supervisor.step();
 assert.equal(f.calls.filter(call=>call==='issue').length,1);f.advance(61000);await supervisor.step();
 assert.equal(f.calls.filter(call=>call==='issue').length,2);
});
test('every reviewed binding pin and revocation stop before claim or renewal',async()=>{
 for(const field of [...Object.keys(binding),'state','registration_state']){
  const f=fixture();f.current.binding[field]=field==='runtime_epoch'?2:'changed';const supervisor=await createEmailScopedSupervisor(f.ports);
  const status=await supervisor.step();assert.equal(status.phase,'paused',field);assert.equal(status.code,'EMAIL_SERVICE_REVIEW_CHANGED');
  assert.equal(f.calls.includes('claim'),false);assert.equal(f.calls.includes('issue'),false);
 }
});
test('unknown, timeout and result mismatch durably pause across restart without resend',async()=>{
 for(const outcome of ['unknown','throw','mismatch']){
  const f=fixture();f.ports.runChild=async({claim})=>{f.calls.push('child');if(outcome==='throw')throw Error('child died');
   return {state:outcome==='unknown'?'outcome_unknown':'provider_accepted',run_id:outcome==='mismatch'?'wrong':claim.run_id,automatic_retry:false};};
  const first=await createEmailScopedSupervisor(f.ports);assert.equal((await first.step()).phase,'paused');
  const before=f.calls.length,restarted=await createEmailScopedSupervisor(f.ports);assert.equal((await restarted.step()).phase,'paused');
  assert.equal(f.calls.length,before+1);assert.equal(f.calls.filter(call=>call==='child').length,1);
 }
});
test('interrupted durable claim remains unknown after loading retained state from disk',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'email-supervisor-'));try{
  const path=join(directory,'state.json'),f=fixture();f.ports.store={load:async()=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}},save:value=>writeFile(path,JSON.stringify(value))};
  const supervisor=await createEmailScopedSupervisor(f.ports);f.ports.runChild=async()=>new Promise(()=>{});
  void supervisor.step();for(let n=0;n<20;n++){await new Promise(ok=>setTimeout(ok,5));const state=await f.ports.store.load();if(state?.inflight)break;}
  const restarted=await createEmailScopedSupervisor(f.ports),status=await restarted.step();assert.equal(status.phase,'paused');assert.equal(status.code,'EMAIL_SERVICE_INTERRUPTED_UNKNOWN');
  assert.equal(status.inflight.run_id,'run-1');assert.equal(f.calls.filter(call=>call==='claim').length,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('expired or extra credentials fail closed and never reach child',async()=>{
 for(const change of [value=>{value.expires_at=new Date(999999).toISOString();},value=>{value.expires_at='2099';},value=>{value.owner_bearer='private-owner';},value=>{value.session_token='invalid';}]){
  const f=fixture(),issue=f.ports.issueSession;f.ports.issueSession=async()=>{const value=await issue();change(value);return value;};
  assert.equal((await (await createEmailScopedSupervisor(f.ports)).step()).code,'EMAIL_SERVICE_SESSION_INVALID');assert.equal(f.calls.includes('child'),false);
 }
});

test('authenticated claim must preserve the exact binding, registration, session and lease',async()=>{
 for(const field of ['runtime_binding_id','runtime_registration_id','runtime_epoch','app_installation_id','app_version_id','grant_snapshot_id','session_id','audience','lifecycle_epoch','grant_epoch','session_epoch','lease_expires_at']){
  const f=fixture(),client=f.ports.createClient;f.ports.createClient=credential=>{const sdk=client(credential);return {claim:async()=>{const claim=await sdk.claim();claim[field]='wrong';return claim;}};};
  assert.equal((await (await createEmailScopedSupervisor(f.ports)).step()).code,'EMAIL_SERVICE_CLAIM_INVALID',field);assert.equal(f.calls.includes('child'),false);
 }
});

test('triage uses a separately reviewed exact binding and settled outcomes resume after restart',async()=>{
 const f=fixture();f.setSessionMs(900000);f.ports.binding={...binding,action_key:'triage_message'};f.current.binding.action_key='triage_message';const client=f.ports.createClient;
 f.ports.createClient=credential=>{const sdk=client(credential);return {claim:async()=>({...await sdk.claim(),operation_name:'triage_message'})};};
 f.ports.runChild=async({claim})=>({state:'triage_settled',run_id:claim.run_id,automatic_retry:false});
 const first=await createEmailScopedSupervisor(f.ports);assert.equal((await first.step()).phase,'idle');
 assert.equal((await (await createEmailScopedSupervisor(f.ports)).step()).last_run_id,'run-2');
});
test('cached triage sessions renew before claim when they cannot cover the full wall budget and dispatch',async()=>{
 for(const remaining of [61000,299000,319000]){const f=fixture();f.setSessionMs(900000);f.ports.binding={...binding,action_key:'triage_message'};f.current.binding.action_key='triage_message';const client=f.ports.createClient,expiries=[];
  f.ports.createClient=credential=>{const sdk=client(credential);return {claim:async()=>({...await sdk.claim(),operation_name:'triage_message'})};};
  f.ports.runChild=async({claim,session_expires_at})=>{expiries.push(session_expires_at);return {state:'triage_settled',run_id:claim.run_id,automatic_retry:false};};
  const supervisor=await createEmailScopedSupervisor(f.ports);await supervisor.step();f.advance(900000-remaining);await supervisor.step();assert.equal(f.calls.filter(call=>call==='issue').length,2);assert.notEqual(expiries[0],expiries[1]);assert.equal(f.read().last_run_id,'run-2');
 }
 const f=fixture();f.setSessionMs(300000);f.ports.binding={...binding,action_key:'triage_message'};f.current.binding.action_key='triage_message';const stopped=await (await createEmailScopedSupervisor(f.ports)).step();assert.equal(stopped.code,'EMAIL_SERVICE_SESSION_INVALID');assert.equal(f.calls.includes('claim'),false);assert.equal(f.calls.includes('child'),false);
});
test('retained manager state cannot transplant across an account binding or registration',async()=>{
 const f=fixture();await createEmailScopedSupervisor(f.ports);for(const field of ['id','registration_id','installation_id','app_version_id','grant_snapshot_id','operator_user_id']){
  await assert.rejects(createEmailScopedSupervisor({...f.ports,binding:{...binding,[field]:'other'}}),/EMAIL_SERVICE_STATE_INVALID/);
 }
});
test('Windows or non-root CLI refuses before reading private credentials',async()=>{
 if(process.platform==='linux'&&process.getuid?.()===0)return;
 await assert.rejects(runEmailScopedSupervisorCli(['/no-private-secret-read']),/EMAIL_SERVICE_TRUSTED_MANAGER_REQUIRED/);
});
test('only triage extends the local wall cap and authenticated session expiry remains an upper bound',()=>{
 const time=1000000,input={operation_name:'triage_message',lease_expires_at:new Date(time+60000).toISOString(),session_expires_at:new Date(time+900000).toISOString()};
 assert.equal(emailScopedChildDeadline(input,time),time+300000);
 assert.equal(emailScopedChildDeadline({...input,operation_name:'permanent_delete_message'},time),time+300000);
 assert.equal(emailScopedChildDeadline({...input,operation_name:'send_message'},time),time+60000);
 assert.equal(emailScopedChildDeadline({...input,session_expires_at:new Date(time+90000).toISOString()},time),time+90000);
 for(const change of [{session_expires_at:undefined},{session_expires_at:'unknown'},{session_expires_at:new Date(time-1).toISOString()},{session_expires_at:new Date(time+59999).toISOString()},{lease_expires_at:new Date(time).toISOString()},{operation_name:'unreviewed'}])assert.throws(()=>emailScopedChildDeadline({...input,...change},time),/EMAIL_SERVICE_SESSION_INVALID/);
});
