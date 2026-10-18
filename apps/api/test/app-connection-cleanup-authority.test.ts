import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import * as s from '@deft/db/schema';
import type {ExperienceExposureTransaction} from '../src/lib/app-experience-exposure-db.js';
process.env.DATABASE_URL??='postgres://postgres:postgres@localhost:5432/deft';
const {loadOwnerConnectionCleanup}=await import('../src/lib/app-connection-cleanup-authority.js');

function fixture(){
 const now=Date.now(),caller={org_id:randomUUID(),user_id:randomUUID(),sid:randomUUID(),access_expires_at:now+60_000};
 const pins={org_id:caller.org_id,owner_user_id:caller.user_id,installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
  target_key:'personal',resource_key:'inbox',resource_binding_id:randomUUID(),action_binding_id:randomUUID(),action_key:'send_message'};
 const common={org_id:caller.org_id,app_installation_id:pins.installation_id,app_version_id:pins.app_version_id,grant_snapshot_id:pins.grant_snapshot_id};
 const rows=new Map<unknown,any>([
  [s.orgMembers,{is_active:true,role:'member'}],[s.users,{kind:'human'}],
  [s.appInstallations,{org_id:caller.org_id,id:pins.installation_id,state:'disabled',lifecycle_epoch:4,grant_epoch:3}],
  [s.appVersions,{org_id:caller.org_id,id:pins.app_version_id,installation_id:pins.installation_id,protocol_version:'7',state:'superseded'}],
  [s.appGrantSnapshots,{...common,id:pins.grant_snapshot_id,snapshot_kind:'effective',state:'revoked',revoked_at:new Date(now-1000)}],
  [s.appRuntimeRegistrations,{...common,id:randomUUID(),state:'revoked',runtime_epoch:9,revoked_at:new Date(now-1000)}],
  [s.appResourceBindings,{...common,id:pins.resource_binding_id,owner_user_id:caller.user_id,target_key:pins.target_key,resource_key:pins.resource_key,
   state:'revoked',consent_expires_at:new Date(now-1000),descriptor_digest:'sha256:'+'1'.repeat(64)}],
  [s.appRuntimeBindings,{...common,id:pins.action_binding_id,action_key:pins.action_key,owner_resource_binding_id:pins.resource_binding_id,state:'revoked',consent_expires_at:new Date(now-1000)}],
  [s.webSessions,{id:caller.sid,org_id:caller.org_id,user_id:caller.user_id,expires_at:new Date(now+60_000),revoked_at:null}],
 ]);
 rows.get(s.appResourceBindings).runtime_registration_id=rows.get(s.appRuntimeRegistrations).id;
 const tx={execute:async()=>({rows:[{now_ms:String(Date.now())}]}),select:()=>{
  let table:unknown;const query:any={from(t:unknown){table=t;return query;},where(){return query;},limit(){return query;},for(){return query;},
   then(resolve:any,reject:any){return Promise.resolve(rows.has(table)?[rows.get(table)]:[]).then(resolve,reject);}};return query;
 }} as unknown as ExperienceExposureTransaction;
 return{rows,tx,caller,pins};
}
test('retained owner cleanup survives expired consent, revoked read/Send and disabled installation without provider operations',async()=>{
 const f=fixture();for(const purpose of ['status','disconnect'] as const){
  const projection=await loadOwnerConnectionCleanup(f.tx,f.caller,f.pins,purpose);
  assert.equal(projection.purpose,purpose);assert.equal(projection.web_session_id,f.caller.sid);
  assert.deepEqual(projection.allowed_operations,[]);assert.equal(projection.content_policy,undefined);
  assert.equal(projection.expires_at,f.caller.access_expires_at);
 }
 // A new authenticated SID can discard its owner's retained credentials.
 f.caller.sid=randomUUID();f.rows.get(s.webSessions).id=f.caller.sid;
 assert.equal((await loadOwnerConnectionCleanup(f.tx,f.caller,f.pins,'disconnect')).web_session_id,f.caller.sid);
});
test('cleanup denies foreign owner/org, changed retained account pins, missing custody and nonhuman/inactive members',async()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.caller.user_id=randomUUID();},(f:ReturnType<typeof fixture>)=>{f.caller.org_id=randomUUID();},
  (f:ReturnType<typeof fixture>)=>{f.rows.get(s.appResourceBindings).owner_user_id=randomUUID();},
  (f:ReturnType<typeof fixture>)=>{f.rows.get(s.appResourceBindings).target_key='work';},
  (f:ReturnType<typeof fixture>)=>{f.rows.get(s.appRuntimeRegistrations).grant_snapshot_id=randomUUID();},
  (f:ReturnType<typeof fixture>)=>{f.rows.get(s.appRuntimeBindings).owner_resource_binding_id=randomUUID();},
  (f:ReturnType<typeof fixture>)=>{f.rows.delete(s.appResourceBindings);},
  (f:ReturnType<typeof fixture>)=>{f.rows.get(s.orgMembers).role='guest';},
  (f:ReturnType<typeof fixture>)=>{f.rows.get(s.orgMembers).is_active=false;},
  (f:ReturnType<typeof fixture>)=>{f.rows.get(s.users).kind='agent';},
 ]){const f=fixture();mutate(f);await assert.rejects(loadOwnerConnectionCleanup(f.tx,f.caller,f.pins,'disconnect'));}
});
test('revoked/expired current web authority still blocks cleanup',async()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.rows.get(s.webSessions).revoked_at=new Date();},
  (f:ReturnType<typeof fixture>)=>{f.rows.get(s.webSessions).expires_at=new Date(Date.now()-1000);},
  (f:ReturnType<typeof fixture>)=>{f.caller.access_expires_at=Date.now()-1000;},
 ]){const f=fixture();mutate(f);await assert.rejects(loadOwnerConnectionCleanup(f.tx,f.caller,f.pins,'status'));}
});
