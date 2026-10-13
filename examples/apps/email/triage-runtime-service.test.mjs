import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runEmailTriage,parseTriageRuntimeInput} from './triage-runtime-service.mjs';
import {LogicalMailIndex} from './logical-mail-index.mjs';
import {providerSourceForParent} from './providers/provider-browser.mjs';
import {projectEmailMetadata} from './metadata-resource.mjs';
import {createEmailFileCustodyStore} from './providers/custody-file-store.mjs';
import {createEncryptedEmailCustody} from './providers/custody-encrypted.mjs';
import {createEmailTriageJournal} from './providers/triage-journal.mjs';
import {createSupervisedSyncStateStore} from './providers/supervised-sync-state.mjs';
import {oauthClientFingerprint,validateOAuthClient} from './providers/oauth-provider.mjs';
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),posix={skip:process.platform==='win32'};
async function fixture({count=2}={}){
 const root=await mkdtemp(join(tmpdir(),'deft-triage-runtime-'));for(const name of ['oauth','journal','state'])await mkdir(join(root,name),{mode:0o700});
 const scope={org_id:uuid(1),owner_id:uuid(2),installation_id:uuid(3)},account={account_id:'personal-gmail',provider:'gmail',display_label:'Personal Gmail',primary_address:'owner@example.test',verified_sender_identities:['owner@example.test'],capabilities:['read','modify','permanent_delete'],connection_target:'personal',resource_binding_id:uuid(4),action_binding_id:uuid(40),authority_epoch:1,health:'connected'},binding={scope,account,action_binding_id:uuid(5),operations:['mark_read','archive','labels','permanent_delete']};
 const oauth_binding={scope,account_id:account.account_id,provider:account.provider,connection_target:account.connection_target,resource_binding_id:account.resource_binding_id,action_binding_id:uuid(40),authority_epoch:1,capabilities:['read','modify','permanent_delete']},clients={gmail:{client_id:'controlled-client',client_secret:'controlled-private-secret',redirect_uri:'https://host.example.test/apps/connections/callback'}};
 const pin={org_id:scope.org_id,app_installation_id:scope.installation_id,app_version_id:uuid(6),grant_snapshot_id:uuid(7),lifecycle_epoch:1,grant_epoch:1,runtime_registration_id:uuid(8),runtime_binding_id:binding.action_binding_id,runtime_epoch:1,session_id:uuid(9),session_epoch:1,audience:'app_runtime',operation_name:'triage_message'};
 const config={schema_version:'deft.email_triage_runtime.v1',channel_url:'https://host.example.test/api/app-runtime/channel',credential:{session_id:pin.session_id,session_token:'s'.repeat(43)},expected_run_id:uuid(10),binding,runtime_pin:pin,oauth_binding,clients,resource_key:'mail_index',expires_at:new Date(Date.now()+600000).toISOString()};
 const index=new LogicalMailIndex(scope),messages=new Map(),records=[];for(let i=0;i<count;i++){const id='private-native-'+i,locator={kind:'gmail',message_id:id,thread_id:'private-thread-'+i,label_ids:['INBOX','UNREAD']};messages.set(id,{id,threadId:locator.thread_id,labelIds:[...locator.label_ids]});const record=index.upsert(scope,{account_id:account.account_id,provider:'gmail',locator,subject:'Metadata '+i,flags:{seen:false}}),projected=projectEmailMetadata(record);records.push({record_id:uuid(20+i),label:'Metadata '+i,revision:projected.revision,data:projected.data});}
 const state=await createSupervisedSyncStateStore({root:join(root,'state'),scope,account_id:account.account_id,encryption_key:Buffer.alloc(32,6),key_id:'state-test'});await state.withSupervisorLock(async()=>{await state.beginAttempt({fixture:true});await state.stage({index_state:index.exportState(scope)});await state.commit();});
 const oauthCustody=createEncryptedEmailCustody({store:await createEmailFileCustodyStore({root:join(root,'oauth')}),encryption_key:Buffer.alloc(32,7),key_id:'oauth-test'}),journal=createEmailTriageJournal({store:await createEmailFileCustodyStore({root:join(root,'journal')}),encryption_key:Buffer.alloc(32,8),key_id:'triage-test'});
 let refreshScopes=null,scopes=['https://www.googleapis.com/auth/gmail.modify'];const saveToken=async()=>oauthCustody.withAccount(oauth_binding,async tx=>{if(tx.read()===null)await tx.advanceSetup();await tx.write({health:'connected',secret:{access_token:'private-provider-token',refresh_token:'private-refresh',expires_at:Date.now()+600000,scopes,identity:{provider_subject:'private-subject',primary_address:account.primary_address,display_label:account.display_label,verified_sender_identities:account.verified_sender_identities},client_fingerprint:oauthClientFingerprint('gmail',validateOAuthClient('gmail',clients.gmail))}});});await saveToken();
 let input={record_ids:records.map(row=>row.record_id).join(','),operation:'mark_read',destination:'',add_labels:'',remove_labels:''},wrongActor=false,wrongRun=false,wrongResource=false,revoked=false,lostProvider=false,lostAck=false,malformedAck=false;const calls=[];
 const fetch=async(url,init)=>{const parsed=new URL(url),headers=new Headers(init.headers),body=init.body instanceof URLSearchParams?null:init.body?JSON.parse(init.body):null;if(parsed.hostname==='host.example.test'){
  const kind=parsed.pathname.split('/').at(-1);calls.push({host:kind,body});assert.equal(headers.get('Authorization'),'AppRuntime '+config.credential.session_token);assert.equal(init.credentials,'omit');
  const claim={schema_version:'deft.app_runtime_channel.v1',...config.runtime_pin,run_id:wrongRun?uuid(999):config.expected_run_id,attempt_id:uuid(11),claim_token:uuid(12),sequence:1,operation_name:config.runtime_pin.operation_name,initiating_actor_type:wrongActor?'agent_employee':'human',initiating_actor_id:scope.owner_id,lease_expires_at:new Date(Date.now()+60000).toISOString()};
  if(kind==='claim')return Response.json({claim});if(kind==='start')return Response.json({started:{schema_version:claim.schema_version,run_id:claim.run_id,attempt_id:claim.attempt_id,lease_expires_at:claim.lease_expires_at,input}});
  if(kind==='heartbeat')return revoked?Response.json({code:'APP_RUNTIME_ACCESS_DENIED'},{status:403}):Response.json({renewed:true});
  if(kind==='resources'){assert.equal(body.action_resources_version,'deft.app_action_resources.v1');return Response.json({resources:{schema_version:'deft.app_action_resources.v1',scope,resource_key:'mail_index',resource_binding_id:wrongResource?uuid(999):account.resource_binding_id,input_key:'record_ids',records:records.filter(row=>input.record_ids.split(',').includes(row.record_id))}});}
  if(kind==='result'){if(lostAck)throw Error('host response lost');return Response.json({run:{id:malformedAck?uuid(999):claim.run_id,state:body.status==='indeterminate'?'unknown_outcome':body.provider_succeeded?'succeeded':'failed'}});}assert.fail(kind);
 }
 if(parsed.hostname==='oauth2.googleapis.com'){calls.push({oauth:'refresh'});assert.equal(init.body.get('grant_type'),'refresh_token');assert.equal(init.body.get('refresh_token'),'private-refresh');return Response.json({access_token:'private-provider-token',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:['openid','email',...(refreshScopes??scopes)].join(' ')});}
 if(parsed.hostname==='openidconnect.googleapis.com'){calls.push({oauth:'identity'});return Response.json({sub:'private-subject',email:account.primary_address,email_verified:true,name:account.display_label});}
 if(parsed.pathname.endsWith('/labels')){calls.push({provider:parsed.hostname,path:parsed.pathname,method:init.method});return Response.json({labels:[{id:'Label_A',type:'user'}]});}
 if(parsed.pathname.endsWith('/profile')){calls.push({oauth:'profile'});return Response.json({emailAddress:account.primary_address});}
 calls.push({provider:parsed.hostname,path:parsed.pathname,method:init.method});assert.equal(headers.get('Authorization'),'Bearer private-provider-token');const id=/\/messages\/([^/]+)/.exec(parsed.pathname)?.[1],message=messages.get(id);if(!message)return Response.json({},{status:404});if(init.method==='GET')return Response.json(message);
 if(init.method==='DELETE'){messages.delete(id);return Response.json({});}message.labelIds=message.labelIds.filter(label=>!body.removeLabelIds.includes(label));message.labelIds.push(...body.addLabelIds);if(lostProvider)throw Error('provider response lost after mutation');return Response.json(message);
 };
 return {config,indexStore:state,oauthCustody,journal,fetch,calls,records,messages,setInput:value=>input=value,setWrongActor:value=>wrongActor=value,setWrongRun:value=>wrongRun=value,setWrongResource:value=>wrongResource=value,setRevoked:value=>revoked=value,setLostProvider:value=>lostProvider=value,setLostAck:value=>lostAck=value,setMalformedAck:value=>malformedAck=value,setRefreshScopes:value=>{refreshScopes=value;},async expireToken(){await oauthCustody.withAccount(oauth_binding,async tx=>{const row=tx.read();await tx.write({health:'connected',secret:{...row.secret,expires_at:Date.now()-1}});});},async setScopes(value){scopes=value;await saveToken();},async run(){return runEmailTriage(this);},async close(){await rm(root,{recursive:true,force:true});}};
}
test('actual Runtime SDK releases scoped host UUIDs; encrypted private index resolves locators and bulk journal resists replay',posix,async()=>{
 const f=await fixture();try{const first=await f.run();assert.equal(first.state,'triage_settled');assert.equal(first.succeeded_count,2);assert.equal(first.undo_available,true);assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,2);assert.ok(first.items.includes(f.records[0].record_id));assert.ok(!first.items.includes('private-native'));const result=f.calls.find(call=>call.host==='result').body;assert.equal(result.status,'returned');assert.equal(result.output.automatic_retry,false);assert.ok(!JSON.stringify(result.output).includes('private-thread'));const second=await f.run();assert.equal(second.succeeded_count,2);assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,2);}finally{await f.close();}
});
test('actual Runtime native source companion resolves exact locators without consulting the retained index',posix,async()=>{
 const f=await fixture();try{for(const row of f.records){const state=await f.indexStore.load(f.config.binding.scope),index=new LogicalMailIndex(f.config.binding.scope,{state}),parent=index.get(f.config.binding.scope,f.config.binding.account.account_id,row.data.logical_message_id);row.provider_source=providerSourceForParent(f.config.binding.account,parent);}f.indexStore={async load(){assert.fail('Native sources must not require retained index');}};const result=await f.run();assert.equal(result.state,'triage_settled');assert.equal(result.succeeded_count,2);assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,2);}finally{await f.close();}
});
test('wrong released Run or nonhuman initiator refuses before Start; wrong binding refuses before provider access',posix,async()=>{
 const f=await fixture();try{f.setWrongRun(true);await assert.rejects(()=>f.run(),/CLAIM_DENIED/);assert.equal(f.calls.length,1);f.setWrongRun(false);f.setWrongActor(true);await assert.rejects(()=>f.run(),/CLAIM_DENIED/);assert.equal(f.calls.filter(call=>call.host==='start').length,0);f.setWrongActor(false);f.setWrongResource(true);assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.calls.filter(call=>call.provider).length,0);}finally{await f.close();}
});
test('Read/Send actual scopes cannot mutate; malformed scalar/native IDs and stale host authority stop before provider I/O',posix,async()=>{
 const f=await fixture();try{await f.setScopes(['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']);assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.calls.filter(call=>call.provider).length,0);await f.setScopes(['https://www.googleapis.com/auth/gmail.modify']);f.setInput({record_ids:'private-native-0',operation:'mark_read',destination:'',add_labels:'',remove_labels:''});assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.calls.filter(call=>call.provider).length,0);f.setInput({record_ids:f.records[0].record_id,operation:'mark_read',destination:'',add_labels:'',remove_labels:''});f.setRevoked(true);assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.calls.filter(call=>call.provider).length,0);}finally{await f.close();}
});
test('uncertain provider outcome and lost host acknowledgement never resend started/terminal items on same Run restart',posix,async()=>{
 for(const kind of ['provider','host']){const f=await fixture();try{if(kind==='provider')f.setLostProvider(true);else f.setLostAck(true);assert.equal((await f.run()).state,'outcome_unknown');const writes=f.calls.filter(call=>call.provider&&call.method==='POST').length;assert.equal(writes,2);f.setLostProvider(false);f.setLostAck(false);const replay=await f.run();assert.equal(replay.state,kind==='provider'?'outcome_unknown':'triage_settled');assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,writes);}finally{await f.close();}}
});
test('permanent deletion requires distinct released human action plus already granted full-mail scope',posix,async()=>{
 const f=await fixture();try{f.setInput({record_ids:f.records[0].record_id,operation:'permanent_delete',destination:'',add_labels:'',remove_labels:''});assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.calls.filter(call=>call.provider).length,0);f.config.runtime_pin.operation_name='permanent_delete_message';await f.setScopes(['https://mail.google.com/']);const result=await f.run();assert.equal(result.state,'triage_settled');assert.equal(result.succeeded_count,1);assert.equal(result.undo_available,false);assert.equal(f.calls.filter(call=>call.provider&&call.method==='DELETE').length,1);}finally{await f.close();}
});
test('scalar parser denies more than25, duplicates and unexpected confirmation/account fields',()=>{
 const input={record_ids:uuid(1),operation:'archive',destination:'',add_labels:'',remove_labels:''};assert.throws(()=>parseTriageRuntimeInput({...input,record_ids:Array.from({length:26},(_,i)=>uuid(i+1)).join(',')}));assert.throws(()=>parseTriageRuntimeInput({...input,record_ids:uuid(1)+','+uuid(1)}));assert.throws(()=>parseTriageRuntimeInput({...input,confirm:true}));assert.throws(()=>parseTriageRuntimeInput({...input,account_id:'browser-owned'}));
});
test('a mismatched host acknowledgement cannot certify settlement or authorize repeat effects',posix,async()=>{
 const f=await fixture();try{f.setMalformedAck(true);assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,2);f.setMalformedAck(false);assert.equal((await f.run()).state,'triage_settled');assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,2);}finally{await f.close();}
});
test('fresh reviewed undo restores only the exact original host messages and never repeats a settled restoration',posix,async()=>{
 const f=await fixture();try{
  const original=f.config.expected_run_id;assert.equal((await f.run()).succeeded_count,2);
  for(const message of f.messages.values())assert.ok(!message.labelIds.includes('UNREAD'));
  f.config.expected_run_id=uuid(30);f.setInput({record_ids:f.records.map(row=>row.record_id).join(','),operation:'undo',destination:original,add_labels:'',remove_labels:''});
  const restored=await f.run();assert.equal(restored.state,'triage_settled');assert.equal(restored.succeeded_count,2);assert.equal(restored.undo_available,false);
  for(const message of f.messages.values())assert.ok(message.labelIds.includes('UNREAD'));
  const writes=f.calls.filter(call=>call.provider&&call.method==='POST').length;assert.equal(writes,4);
  assert.equal((await f.run()).succeeded_count,2);assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,writes);
  f.config.expected_run_id=uuid(31);const changed=await f.run();assert.equal(changed.failed_count,2);assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,writes);
 }finally{await f.close();}
});
test('undo denies changed source sets, foreign action bindings and unknown original outcomes without restoration writes',posix,async()=>{
 for(const kind of ['set','binding','unknown']){const f=await fixture();try{
  const original=f.config.expected_run_id;if(kind==='unknown')f.setLostProvider(true);await f.run();f.setLostProvider(false);
  const writes=f.calls.filter(call=>call.provider&&call.method==='POST').length;f.config.expected_run_id=uuid(30);
  if(kind==='binding'){f.config.binding.action_binding_id=uuid(40);f.config.runtime_pin.runtime_binding_id=uuid(40);}
  f.setInput({record_ids:(kind==='set'?[f.records[0]]:f.records).map(row=>row.record_id).join(','),operation:'undo',destination:original,add_labels:'',remove_labels:''});
  assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,writes);
 }finally{await f.close();}}
});
test('undo nominations remain closed host UUIDs with no caller digest or labels',()=>{
 const input={record_ids:uuid(1),operation:'undo',destination:uuid(2),add_labels:'',remove_labels:''};
 assert.deepEqual(parseTriageRuntimeInput(input),{record_ids:[uuid(1)],undo_of:uuid(2)});
 for(const patch of [{destination:'private-provider-id'},{add_labels:'INBOX'},{expected_digest:'a'.repeat(64)}])assert.throws(()=>parseTriageRuntimeInput({...input,...patch}));
});

test('broad provider scopes never bypass the configured or stored OAuth capability ceiling',posix,async()=>{
 for(const narrowed of ['account','oauth','stored']){const f=await fixture();try{
  await f.setScopes(['https://mail.google.com/']);
  if(narrowed==='account')f.config.binding.account.capabilities=['read'];
  if(narrowed==='oauth')f.config.oauth_binding.capabilities=['read'];
  if(narrowed==='stored'){const actual=f.oauthCustody;f.oauthCustody={...actual,withAccount:async(binding,read)=>actual.withAccount(binding,tx=>read({read:()=>({...tx.read(),binding:{...binding,capabilities:['read']}})}))};}
  assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.calls.filter(call=>call.provider).length,0);
 }finally{await f.close();}}
});

test('triage independently refreshes an expired credential through exact reviewed Runtime authority',posix,async()=>{
 const f=await fixture();try{await f.expireToken();const result=await f.run();assert.equal(result.state,'triage_settled');assert.equal(result.succeeded_count,2);assert.deepEqual(f.calls.filter(call=>call.oauth).map(call=>call.oauth),['refresh','identity','profile']);assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,2);const stored=await f.oauthCustody.withAccount(f.config.oauth_binding,tx=>tx.read());assert.equal(stored.health,'connected');assert.ok(stored.secret.expires_at>Date.now()+60000);}finally{await f.close();}
});

test('an expired credential with reduced scopes cannot refresh or mutate under a broader configured ceiling',posix,async()=>{
 const f=await fixture();try{await f.setScopes(['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']);await f.expireToken();assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.calls.filter(call=>call.oauth||call.provider).length,0);}finally{await f.close();}
});

test('a refresh that returns reduced provider scopes cannot perform any mailbox mutation',posix,async()=>{
 const f=await fixture();try{f.setRefreshScopes(['https://www.googleapis.com/auth/gmail.readonly']);await f.expireToken();assert.equal((await f.run()).state,'outcome_unknown');assert.equal(f.calls.filter(call=>call.oauth==='refresh').length,1);assert.equal(f.calls.filter(call=>call.provider).length,0);const stored=await f.oauthCustody.withAccount(f.config.oauth_binding,tx=>tx.read());assert.equal(stored.health,'connected');assert.ok(!stored.secret.scopes.includes('https://www.googleapis.com/auth/gmail.modify'));}finally{await f.close();}
});

test('renewed triage authority permits25 labels across initial60s lease within capped300s wall time',posix,async()=>{
 const f=await fixture({count:25});try{
  let time=Date.now();const begin=time;f.config.expires_at=new Date(time+300000).toISOString();
  f.setInput({record_ids:f.records.map(row=>row.record_id).join(','),operation:'labels',destination:'',add_labels:'Label_A',remove_labels:''});
  const fetch=async(url,init)=>{time+=new URL(url).hostname==='host.example.test'?50:200;return f.fetch(url,init);};
  const result=await runEmailTriage({...f,fetch,now:()=>time});assert.equal(result.state,'triage_settled');assert.equal(result.succeeded_count,25);assert.ok(time-begin>60000&&time-begin<300000);assert.equal(f.calls.filter(call=>call.provider&&call.method==='POST').length,25);
 }finally{await f.close();}
});
test('technical session expiry and bounded300s wall time stop triage even while heartbeats renew',posix,async()=>{
 for(const mode of ['session','wall']){const f=await fixture({count:25});try{
  let time=Date.now();const begin=time;f.config.expires_at=new Date(time+(mode==='session'?75000:600000)).toISOString();
  f.setInput({record_ids:f.records.map(row=>row.record_id).join(','),operation:'labels',destination:'',add_labels:'Label_A',remove_labels:''});
  const fetch=async(url,init)=>{time+=new URL(url).hostname==='host.example.test'?(mode==='wall'?500:50):200;return f.fetch(url,init);};
  const result=await runEmailTriage({...f,fetch,now:()=>time});assert.equal(result.state,'outcome_unknown');assert.equal(result.automatic_retry,false);assert.ok(f.calls.filter(call=>call.provider&&call.method==='POST').length<25);const bound=mode==='session'?75000:300000;assert.ok(time-begin>=bound&&time-begin<=bound+1000);
 }finally{await f.close();}}
});
test('authority revocation after initial lease renewal prevents any following provider dispatch',posix,async()=>{
 const f=await fixture({count:25});try{
  let time=Date.now(),revokedAt=null,providerAtRevocation=null;const begin=time;f.config.expires_at=new Date(time+300000).toISOString();
  f.setInput({record_ids:f.records.map(row=>row.record_id).join(','),operation:'labels',destination:'',add_labels:'Label_A',remove_labels:''});
  const fetch=async(url,init)=>{const host=new URL(url).hostname==='host.example.test';time+=host?50:200;if(host&&time-begin>=70000&&revokedAt===null){revokedAt=time;providerAtRevocation=f.calls.filter(call=>call.provider).length;f.setRevoked(true);}return f.fetch(url,init);};
  const result=await runEmailTriage({...f,fetch,now:()=>time});assert.equal(result.state,'outcome_unknown');assert.ok(revokedAt!==null);assert.equal(f.calls.filter(call=>call.provider).length,providerAtRevocation);assert.ok(f.calls.filter(call=>call.provider&&call.method==='POST').length<25);assert.equal(result.automatic_retry,false);
 }finally{await f.close();}
});
