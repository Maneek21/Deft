import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseAttachmentAppManifest} from '@deft/app-kit/core';

const manifest=JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json',import.meta.url),'utf8'));
manifest.owner_connections=[{key:'mailbox',resource_key:'inbox',action_keys:[],max_consent_seconds:86400,
 provider_profile_key:'provider',runtime_requirement_key:'sync_provider'}];
manifest.record_stores=[{schema_version:'deft.app_record_store.v1',key:'messages',resource_key:'inbox',runtime_requirement_key:'sync_provider',
 max_record_bytes:4096,max_files:0,max_file_bytes:1,max_total_file_bytes:1}];
const parsed=parseAttachmentAppManifest(manifest),calls:string[]=[];
let manifestPreludeReads=0;
let current:any,credential=true,live=true,final=true,revokeAfterCurrent=false,journalChanged=false;
mock.module(new URL('../src/lib/db.ts',import.meta.url).href,{namedExports:{db:{select:()=>{manifestPreludeReads++;
 const query:any={from:()=>query,where:()=>query,then:(resolve:any,reject:any)=>Promise.resolve([{manifest}]).then(resolve,reject)};return query;
},transaction:async(work:any)=>work({})}}});
mock.module(new URL('../src/lib/env.ts',import.meta.url).href,{namedExports:{isAppOwnerConnectionsEnabled:()=>true}});
mock.module(new URL('../src/lib/app-data-diagnostics.ts',import.meta.url).href,{namedExports:{withAppDataDiagnostic:(_operation:any,work:any)=>work(),measureAppDataPhase:(_phase:any,work:any)=>work()}});
mock.module(new URL('../src/lib/app-integration-runtime-gateway.ts',import.meta.url).href,{namedExports:{maybeAppIntegrationDataRuntimeAuthority:async()=>null}});
mock.module(new URL('../src/lib/app-connection-session-registry.ts',import.meta.url).href,{namedExports:{
 preauthenticateAppConnectionTransport:async()=>{calls.push('entry');if(!credential)throw Error('entry denied');},
 getAppConnectionSessionRegistry:async()=>({authenticate:()=>{calls.push('full');if(!credential||!final)throw Error('full denied');}}),
}});
mock.module(new URL('../src/lib/app-data-connection-read.ts',import.meta.url).href,{namedExports:{readSavedAppDataConnection:async()=>({...current.session})}});
mock.module(new URL('../src/lib/app-connection-session-authority.ts',import.meta.url).href,{namedExports:{currentAppConnectionReadAuthority:async(...args:any[])=>{
 calls.push('current');if(!live)throw Error('current revoked');args[5]?.({scope:current.scope,manifest:parsed,grant_record_stores:parsed.record_stores});
 if(revokeAfterCurrent)final=false;return {scope:current.scope,profile:current.profile,expires_at:current.deadline,connection_protocol:'v2'};
}}});
mock.module(new URL('../src/lib/app-connection-upgrade-fence.ts',import.meta.url).href,{namedExports:{appConnectionUpgradeSourceIsAvailable:async()=>true}});
mock.module(new URL('../src/lib/app-connection-form-fence.ts',import.meta.url).href,{namedExports:{validateStoredFormConnection:async()=>null}});
mock.module(new URL('../src/lib/app-connection-consent-continuation-fence.ts',import.meta.url).href,{namedExports:{validateContinuationCarrier:async()=>null}});
mock.module(new URL('../src/lib/app-data-consent-repair.ts',import.meta.url).href,{namedExports:{appDataConsentConnections:async()=>[current.session]}});
mock.module(new URL('../src/lib/app-data-store.ts',import.meta.url).href,{namedExports:{PostgresAppDataStore:class {async invocation(){
 calls.push('journal');return {...current.row,...(journalChanged&&calls.filter(item=>item==='journal').length>1?{state:'completed'}:{})};
}}}});
mock.module(new URL('../src/lib/app-data-prepared-effect.ts',import.meta.url).href,{namedExports:{verifiedRetainedPreparedRecordAction:()=>{throw Error('unexpected action path');}}});
mock.module(new URL('../src/lib/app-data-record-change-guards.ts',import.meta.url).href,{namedExports:{sameRecordChangeAuthority:()=>{throw Error('unexpected v2 path');}}});
process.env.DEFT_APPS_ENABLED='true';
const {appDataRuntimeAuthority,appDataDigest}=await import('../src/lib/app-data-authority.js');
function fixture(){
 const org=randomUUID(),owner=randomUUID(),digest='sha256:'+'a'.repeat(64),deadline=Date.now()+600_000;
 const profile={schema_version:'deft.app_connection_profile.v1',key:'provider',provider_id:'provider',operator_user_id:owner,
  runtime_requirement_key:'sync_provider',resource_key:'inbox',action_keys:[],authorization_origin:'https://provider.example.test',credential_custody:'runtime',executable:false};
 const scope={org_id:org,owner_user_id:owner,installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
  package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,target_key:'primary',resource_key:'inbox',resource_binding_id:randomUUID(),
  runtime_registration_id:randomUUID(),operator_user_id:owner,runtime_epoch:1,profile_digest:digest,consent_expires_at:new Date(deadline).toISOString()};
 const session={session_id:randomUUID(),revision:1,state:'connected',runtime_session_ref:'runtime',account:{account_ref:'account'},scope,profile};
 const context={schema_version:'deft.app_data_authority.v1',request_id:randomUUID(),scope,connection:{session_id:session.session_id,session_revision:1,runtime_session_ref:'runtime',account_ref:'account'},
  authority:{consent_id:null,consent_digest:null,data_policy_digest:appDataDigest(parsed.record_stores![0])},operation:'resource_read_presentation',input_digest:digest,expires_at:new Date(deadline).toISOString()};
 current={scope,profile,session,context,deadline,row:{state:'inflight',context,web_session_id:randomUUID(),access_expires_at:new Date(deadline),expires_at:new Date(deadline)}};
 credential=live=final=true;revokeAfterCurrent=journalChanged=false;calls.length=0;manifestPreludeReads=0;return context;
}

test('ordinary data callback keeps full fresh current authority and final authentication after credential entry admission',async()=>{
 const context=fixture();assert.equal((await appDataRuntimeAuthority(context,'Bearer service')).allowed,true);
 assert.deepEqual(calls,['entry','journal','current','journal','full']);
 assert.equal(manifestPreludeReads,0,'policy digest resolves only from the fresh validated current declarations');
});

test('entry failure, fresh current revoke and final deployment revoke withhold ordinary data authority',async()=>{
 let context=fixture();credential=false;await assert.rejects(appDataRuntimeAuthority(context,'Bearer service'));assert.deepEqual(calls,['entry']);
 context=fixture();live=false;await assert.rejects(appDataRuntimeAuthority(context,'Bearer service'));assert.deepEqual(calls,['entry','journal','current']);
 context=fixture();revokeAfterCurrent=true;await assert.rejects(appDataRuntimeAuthority(context,'Bearer service'));assert.deepEqual(calls,['entry','journal','current','journal','full']);
 context=fixture();journalChanged=true;await assert.rejects(appDataRuntimeAuthority(context,'Bearer service'));assert.deepEqual(calls,['entry','journal','current','journal']);
});

test('Send/review/lifecycle/status/inspection callbacks retain full entry authentication',async()=>{
 for(const operation of ['prepare_action','read_prepared','prepared_action_commit','prepared_action_restore','prepare_resource_action','read_prepared_resource_action','request_status','run_inspect','run_inspection_status']){
  const context={...fixture(),operation};final=false;
  await assert.rejects(appDataRuntimeAuthority(context,'Bearer service'));assert.deepEqual(calls,['full'],operation);
 }
});


test('callback policy resolution cannot nominate a different current declaration or bypass current version fencing',async()=>{
 let context=fixture();context.authority.data_policy_digest='sha256:'+'b'.repeat(64);
 await assert.rejects(appDataRuntimeAuthority(context,'Bearer service'));assert.deepEqual(calls,['entry','journal','current']);
 assert.equal(manifestPreludeReads,0);
 context=fixture();current.scope={...current.scope,app_version_id:randomUUID()};
 await assert.rejects(appDataRuntimeAuthority(context,'Bearer service'));assert.deepEqual(calls,['entry','journal','current']);
});
