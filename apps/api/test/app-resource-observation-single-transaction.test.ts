import assert from 'node:assert/strict';
import test,{mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {drizzle} from 'drizzle-orm/node-postgres';
import {getTableColumns} from 'drizzle-orm';
import {appRuns,appRunAttempts,appSyncIntents,appSyncCheckpoints} from '@deft/db/schema';
// S6-a: the observation authority projection must be decided in the SAME
// transaction as the lease heartbeat whose authority it relies on. No database
// is used; every query is answered by a fixed fake client, and no provider or
// external service is reachable.
process.env.DATABASE_URL='postgresql://fixture@127.0.0.1:1/observation_single_transaction_no_database';
process.env.ENCRYPTION_KEY='synthetic-single-transaction-key32';
const ring=(name:string)=>({current:name,keys:{[name]:Buffer.alloc(32,name.charCodeAt(0)).toString('base64')}});
process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',
 run_encryption:ring('enc'),receipt_signing:ring('sign'),fingerprint:ring('fingerprint')});
Object.assign(process.env,{DEFT_APPS_ENABLED:'true',DEFT_APP_RUNS_ENABLED:'true',DEFT_APP_ATTACHMENT_BROKER_ENABLED:'true',
 DEFT_APP_OWNER_CONNECTIONS_ENABLED:'true',DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true'});
const digest='sha256:'+'a'.repeat(64);
let f:any;
const denied=()=>Object.assign(Error('synthetic denied'),{code:'APP_ACCESS_DENIED'});
const unavailable=async()=>{throw Error('unexpected entrance');};
mock.module(new URL('../src/lib/app-attachment-sync-authority.ts',import.meta.url).href,{namedExports:{
 loadLiveAttachmentSyncAuthority:async()=>{f.events.push(['full-authority',f.tx]);return f.authority;},
 loadLiveAttachmentSyncBindingAuthority:unavailable,loadAttachmentSyncClosureBindingAuthority:unavailable,
 loadConsentContinuationBindingIdentity:unavailable,attachmentSyncParticipantsAreHuman:async()=>true,
}});
const hasPin=(raw:any,binding:string)=>raw.authority_refs.some((ref:any)=>ref.authority_kind==='policy'&&ref.authority_id!==binding);
const observedAuthorization=(base:any,row:any)=>({...base,authority_refs:[...base.authority_refs,
 {authority_kind:'policy',authority_id:row.consent_id,version:row.consent_digest}]});
const current=()=>{f.events.push(['observation',f.tx]);if(!f.link)return null;
 if(f.failLateObservation&&f.updates>0)throw denied();
 return {row:{consent_id:f.snapshot.consent_id,consent_digest:digest},snapshot:f.snapshot};};
mock.module(new URL('../src/lib/app-resource-observation-authority.ts',import.meta.url).href,{namedExports:{
 hasResourceObservationPin:hasPin,observedResourceAuthorization:observedAuthorization,observationDenied:denied,
 currentResourceObservationRun:async()=>current(),
 requireCurrentResourceObservationRun:async()=>{const value=current();if(!value)throw denied();return value;},
 assertObservationMetadataCatalogAbsent:async()=>{},assertResourceObservationEnabled:()=>{},observationPolicyDigest:async()=>digest,
 loadObservationConnection:unavailable,resolveObservationConnectionReceipt:unavailable,observationSnapshotIsCurrent:unavailable,
 repairObservationSnapshot:unavailable,activeResourceObservation:unavailable,resourceObservationBindingAuthority:unavailable,
}});
// Resource-wide fence: an unfinished upgrade, credential repair, pending form or
// continuation on the SAME resource binding blocks every effect on it.
mock.module(new URL('../src/lib/app-connection-upgrade-fence.ts',import.meta.url).href,{namedExports:{
 appConnectionUpgradeSourceIsAvailable:async(_tx:unknown,scope:{session_id?:string;resource_binding_id?:string})=>{
  const kind=scope.session_id?'session-fence':'resource-fence';f.events.push([kind,f.tx]);
  return kind==='resource-fence'?!f.resourceBlocked:true;
 },
}});
const fakeDb=()=>drizzle({client:{async query(config:{text:string}){
 const text=config.text,v=f,row=(table:any,record:any)=>Object.keys(getTableColumns(table)).map(key=>record[key]??null);
 if(text.startsWith('select "org_id" from "app_runtime_sessions"'))return {rows:[[v.org]]};
 if(text.includes('from "app_runtime_sessions"'))return {rows:[[v.org,v.authority.binding.id,'synthetic-hash']]};
 if(text.startsWith('SELECT id FROM app_run_attempts')||text.startsWith('SELECT id FROM app_sync_checkpoints'))return {rows:[]};
 if(text.startsWith('update "app_run_attempts"')){v.updates++;v.events.push(['lease-update',v.tx]);return {rows:[[v.attempt.id]]};}
 if(text.startsWith('select "authorization_snapshot"'))return {rows:[[v.run.authorization_snapshot]]};
 if(text.includes('from "app_runs"'))return {rows:[row(appRuns,v.run)]};
 if(text.includes('from "app_sync_intents"'))return {rows:[row(appSyncIntents,v.intent)]};
 if(text.includes('from "app_run_attempts"'))return {rows:[row(appRunAttempts,v.attempt)]};
 if(text.includes('from "app_sync_checkpoints"'))return {rows:[row(appSyncCheckpoints,v.checkpoint)]};
 if(text.includes('from "users"'))return {rows:[[v.owner,v.human===false?'agent':'human',v.human===false]]};
 throw Error('unexpected fixture query: '+text.slice(0,80));
}} as never});
const database:any=fakeDb();
mock.module(new URL('../src/lib/db.ts',import.meta.url).href,{namedExports:{
 db:database,withDbAdvisoryLock:unavailable,closeDb:async()=>{},
}});
let runtime:any;
mock.module(new URL('../src/lib/app-attachment-runtime.ts',import.meta.url).href,{namedExports:{
 getAppAttachmentRuntime:async()=>runtime,shutdownAppAttachmentRuntime:async()=>{},
}});
const {AppRunAttemptRunner}=await import('../src/lib/app-run-attempt-runner.js');
const {AppAttachmentSyncChannel}=await import('../src/lib/app-attachment-sync-channel.js');
const {buildAttachmentSyncAuthorizationSnapshot}=await import('../src/lib/app-attachment-sync-run.js');
const {resourceObservationRuntimeAuthority}=await import('../src/lib/app-resource-observation-runtime.js');

function fixture(){
 const org=randomUUID(),owner=randomUUID(),bindingId=randomUUID(),runId=randomUUID(),attemptId=randomUUID(),runtimeSession=randomUUID();
 const future=(ms:number)=>new Date(Date.now()+ms);
 const authority:any={binding:{id:bindingId,org_id:org,owner_user_id:owner,reviewed_by_user_id:owner,reviewed_at:future(-1000),
  consent_expires_at:future(3600000),attachment_consent_digest:digest,operation_name:'sync_inbox',risk_class:'read_only',review_requirement:'none',
  review_scope:'reviewed_resource_sync',retry_class:'unsafe_or_unknown',retention_class:'standard',max_records_per_page:25,max_page_bytes:524288,
  max_retained_records:100,max_retained_bytes:1048576,min_interval_seconds:300},
  installation:{id:randomUUID(),lifecycle_epoch:1,grant_epoch:1},version:{id:randomUUID(),package_digest:digest},
  grant:{id:randomUUID(),snapshot_digest:digest},registration:{id:randomUUID(),operator_user_id:owner,runtime_epoch:1,owner_connection_admission_id:null},
  descriptor_digest:digest,provider_snapshot:{id:randomUUID(),snapshot_digest:digest},
  session:{id:runtimeSession,operator_user_id:owner,session_epoch:2,expires_at:future(600000),renewal_lifetime:null}};
 const scope={org_id:org,owner_user_id:owner,installation_id:authority.installation.id,app_version_id:authority.version.id,
  grant_snapshot_id:authority.grant.id,package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,
  target_key:'mailbox',resource_key:'inbox',resource_binding_id:bindingId,runtime_registration_id:authority.registration.id,
  operator_user_id:owner,runtime_epoch:1,profile_digest:digest,consent_expires_at:authority.binding.consent_expires_at.toISOString()};
 const snapshot={schema_version:'deft.app_resource_observation_consent.v1',consent_id:randomUUID(),scope,
  connection:{session_id:randomUUID(),runtime_session_ref:'synthetic-custody',account_ref:'synthetic-account',expected_custody_generation:null,receipt_digest:null},
  resource_policy_digest:digest,interval_seconds:300,expires_at:future(300000).toISOString()};
 const base=buildAttachmentSyncAuthorizationSnapshot(authority);
 const run:any={id:runId,org_id:org,origin_kind:'app',provider_kind:'app_runtime',origin_resource_binding_id:bindingId,origin_runtime_binding_id:null,
  initiating_actor_type:'system',execution_actor_type:'system',initiating_actor_id:bindingId,execution_actor_id:bindingId,
  origin_app_installation_id:authority.installation.id,origin_app_version_id:authority.version.id,origin_app_grant_snapshot_id:authority.grant.id,
  provider_instance_id:authority.registration.id,provider_snapshot_id:authority.provider_snapshot.id,operation_name:'sync_inbox',risk_class:'read_only',
  review_requirement:'none',review_scope:'reviewed_resource_sync',retry_class:'unsafe_or_unknown',retention_class:'standard',state:'running',
  input_expires_at:future(300000),result_expires_at:future(600000),execution_released_at:future(-1000),cancel_requested_at:null,
  authorization_snapshot:observedAuthorization(base,{consent_id:snapshot.consent_id,consent_digest:digest})};
 const intent:any={org_id:org,run_id:runId,resource_binding_id:bindingId,app_installation_id:authority.installation.id,app_version_id:authority.version.id,
  grant_snapshot_id:authority.grant.id,provider_snapshot_id:authority.provider_snapshot.id,owner_user_id:owner,descriptor_digest:digest,
  checkpoint_id:randomUUID(),generation:1,expected_cursor_sequence:0,expected_cursor_hmac_key_version:null,expected_cursor_hmac:null};
 const attempt:any={id:attemptId,org_id:org,run_id:runId,state:'provider_call_started',claim_token:randomUUID(),runtime_session_id:runtimeSession,
  resource_binding_id:bindingId,runtime_session_epoch:2,runtime_epoch:1,runtime_sequence:1,lease_expires_at:future(5000)};
 const checkpoint:any={id:intent.checkpoint_id,org_id:org,resource_binding_id:bindingId,state:'active',generation:1,cursor_sequence:0,
  cursor_hmac_key_version:null,cursor_hmac:null};
 const value:any={org,owner,authority,run,intent,attempt,checkpoint,snapshot,events:[],tx:0,transactions:0,updates:0,link:true,
  resourceBlocked:false,afterCommit:()=>{}};
 f=value;
 const repository={async lockRun(){return run;},async transaction(work:(tx:any)=>Promise<any>){
  value.transactions++;value.tx=value.transactions;
  const result=await work(database);value.events.push(['commit',value.tx]);value.tx=0;value.afterCommit();return result;
 }};
 const runner=new AppRunAttemptRunner(repository as never,{} as never,{} as never,{execute:unavailable} as never,undefined,
  ()=>new Date(),60000,20000,undefined,undefined,undefined,null,'attachment_v3');
 const bounded={transaction:async(work:(tx:any)=>Promise<any>)=>work(database)};
 runtime={repository,runner,channel:new AppAttachmentSyncChannel(runner,bounded as never)};
 value.request=()=>({schema_version:'deft.app_resource_observation_authority.v1',audience:'app_resource_sync',session_id:runtimeSession,
  run_id:runId,attempt_id:attemptId,claim_token:attempt.claim_token,sequence:1,expires_at:future(15000).toISOString()});
 value.authorize=()=>resourceObservationRuntimeAuthority(value.request(),'AppRuntime '+'a'.repeat(43));
 return value;
}

test('S6-a: projection is decided in the same transaction that checked the resource-wide fence',async()=>{
 const v=fixture(),result=await v.authorize();
 assert.equal(result.allowed,true);assert.equal(v.updates,1,'one lease renewal');
 const fenced=v.events.filter(([kind]:any)=>kind==='resource-fence').map(([,tx]:any)=>tx);
 const observed=v.events.filter(([kind]:any)=>kind==='observation').map(([,tx]:any)=>tx);
 assert.ok(fenced.length>0);
 assert.equal(v.transactions,1,'heartbeat, authority checks and projection share ONE transaction (got '+v.transactions+')');
 assert.deepEqual([...new Set([...fenced,...observed])],[1]);
});

test('S6-a: a resource exclusion committed right after the lease renewal is not honoured by a later projection',async()=>{
 // Owner starts an upgrade / repair / form / continuation on the same resource
 // just after the heartbeat commits. The first transaction is the only point
 // at which the resource-wide fence was consulted.
 const v=fixture();let committed=0;v.afterCommit=()=>{if(++committed===1)v.resourceBlocked=true;};
 let outcome:'allowed'|'denied';
 try{const result=await v.authorize();outcome=result.allowed===true?'allowed':'denied';}
 catch(error:any){assert.equal(error.code,'APP_ACCESS_DENIED');outcome='denied';}
 const projectedAfterExclusion=outcome==='allowed'&&v.transactions>1;
 assert.equal(projectedAfterExclusion,false,'projection was granted in transaction '+v.transactions
  +' after a resource exclusion committed following transaction 1');
});

test('S6-a: an exclusion present before the call is still denied',async()=>{
 const v=fixture();v.resourceBlocked=true;
 await assert.rejects(v.authorize(),(error:any)=>error.code==='APP_ACCESS_DENIED');
 assert.equal(v.updates,0,'no lease is renewed for a denied projection');
});

test('S6-a: strict projection states remain enforced (pending Run, claimed attempt, missing observation link)',async()=>{
 for(const change of [(v:any)=>v.run.state='pending',(v:any)=>v.attempt.state='claimed',(v:any)=>v.link=false]){
  const v=fixture();change(v);
  await assert.rejects(v.authorize(),(error:any)=>error.code==='APP_ACCESS_DENIED');
  assert.equal(v.updates,0,'refused before any lease renewal');
 }
});

test('S6-a: a refusal after the lease renewal rolls the renewal back with the projection',async()=>{
 for(const change of [(v:any)=>v.failLateObservation=true,(v:any)=>v.human=false,
  (v:any)=>v.authority.session.expires_at=new Date(Date.now()+1)]){
  const v=fixture();change(v);
  await assert.rejects(v.authorize(),(error:any)=>error.code==='APP_ACCESS_DENIED');
  if(v.updates>0)assert.ok(!v.events.some(([kind]:any)=>kind==='commit'),'renewed lease is not committed');
 }
});

test('S6-a: projected authority never exceeds the requested expiry',async()=>{
 const v=fixture(),request=v.request();v.request=()=>request;
 const result=await v.authorize();assert.ok(Date.parse(result.expires_at)<=Date.parse(request.expires_at));
 assert.equal(result.snapshot.consent_id,v.snapshot.consent_id);
});

test('S6-a: generic v3 heartbeat keeps its ACK shape and pending/claimed acceptance',async()=>{
 const v=fixture();v.run.state='pending';v.attempt.state='claimed';
 const {expires_at,schema_version,...value}=v.request();
 const ack=await runtime.channel.heartbeat({...value,schema_version:'deft.app_runtime_channel.v3',session_token:'a'.repeat(43)});
 assert.deepEqual(Object.keys(ack).sort(),['attempt_id','lease_expires_at','run_id','sequence']);
 assert.equal(v.transactions,1);assert.equal(v.updates,1);
});
