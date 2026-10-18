import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mock,test} from 'node:test';
import {PgDialect} from 'drizzle-orm/pg-core';

test('shared custody fence preserves generic reviews, managed custody and all reservations',async()=>{
 const manifest=JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json',import.meta.url),'utf8'));
 const target={org_id:'2f41c731-c1a6-47da-83ee-3fa58cfd2609',resource_binding_id:'94bf1b65-bb10-4d58-a321-6c866a18848b'};
 const owner='0c58a597-372e-46b6-941d-4652fbcf8667';
 let required:unknown=false,missing=false,classifications=0,policy:unknown=undefined;
 let sources=false,repair=false,upgrade=false,form=true,continuation=true,superseded=false;
 const unavailable=()=>{throw Error('UNEXPECTED_CUSTODY_FIXTURE_OPERATION');};
 mock.module(new URL('../src/lib/app-attachment-sync-authority.ts',import.meta.url).href,{namedExports:{
  loadConsentContinuationBindingIdentity:async()=>{classifications++;return missing?null:{
   connection_profile_required:required,binding:{owner_user_id:owner,resource_key:'inbox'},
   version:{manifest:{...manifest,...(policy===undefined?{}:{owner_connections:[policy]})}}};},
  loadLiveAttachmentSyncAuthority:unavailable,loadLiveAttachmentSyncBindingAuthority:unavailable,
  loadAttachmentSyncClosureBindingAuthority:unavailable,attachmentSyncParticipantsAreHuman:unavailable,
 }});
 mock.module(new URL('../src/lib/app-connection-form-fence.ts',import.meta.url).href,{namedExports:{
  appConnectionFormSourceIsAvailable:async()=>form,
  validateStoredFormConnection:unavailable,appConnectionFormPredecessorIsAvailable:unavailable,
 }});
 mock.module(new URL('../src/lib/app-connection-consent-continuation-fence.ts',import.meta.url).href,{namedExports:{
  continuationSourceIsAvailable:async()=>continuation,validateContinuationCarrier:unavailable,
 }});
 const {appConnectionUpgradeSourceIsAvailable}=await import('../src/lib/app-connection-upgrade-fence.js');
 const dialect=new PgDialect();
 const tx={select:(selection:Record<string,unknown>)=>{
  let text='';
  const rows=()=>{
   if(text.includes("->'upgrade'"))return upgrade?[{id:'pending-upgrade'}]:[];
   if(text.includes('deft.app_connection_credential_repair.v1'))return repair?[{id:'pending-repair'}]:[];
   if(text.includes("->'credential_repair'->'receipt'"))return superseded?[{id:'superseded'}]:[];
   if('record' in selection)return sources?[{record:{scope:{resource_binding_id:target.resource_binding_id}}}]:[];
   return sources?[{id:'current-session'}]:[];
  };
  const chain={from:()=>chain,where:(value:Parameters<PgDialect['sqlToQuery']>[0])=>{text=dialect.sqlToQuery(value).sql;return chain;},
   limit:()=>chain,for:()=>Promise.resolve(rows()),then:(resolve:(value:unknown)=>unknown)=>Promise.resolve(rows()).then(resolve)};
  return chain;
 }};
 const invoke=(extra:Record<string,unknown>={})=>appConnectionUpgradeSourceIsAvailable(tx as never,{...target,...extra});
 const reset=()=>{required=false;missing=false;sources=false;repair=false;upgrade=false;form=true;continuation=true;superseded=false;policy=undefined;classifications=0;};
 try{
  assert.equal(await invoke(),true,'a fully reviewed generic registration has no managed custody prerequisite');
  assert.equal(classifications,1);
  policy={key:'legacy',resource_key:'inbox',action_keys:['send_message'],max_consent_seconds:3600};
  assert.equal(await invoke(),true,'legacy owner admission without an external profile stays supported');
  reset();required=true;assert.equal(await invoke(),false,'managed profile with missing custody remains denied');
  reset();sources=true;required=true;assert.equal(await invoke(),true);assert.equal(classifications,0,'current managed custody keeps its fast path');
  for(const [name,change] of [
   ['unfound/currentness rejected identity',()=>{missing=true;}],
   ['missing classification',()=>{required=undefined;}],
   ['malformed classification',()=>{required='false';}],
   ['generic active repair',()=>{repair=true;}],['generic pending upgrade',()=>{upgrade=true;}],
   ['generic unfinished form',()=>{form=false;}],['generic unfinished continuation',()=>{continuation=false;}],
   ['external policy without admission',()=>{policy={key:'external',resource_key:'inbox',action_keys:['send_message'],max_consent_seconds:3600,provider_profile_key:'mail',runtime_requirement_key:'sync'};}],
  ] as Array<[string,()=>void]>){reset();change();assert.equal(await invoke(),false,name);}
  reset();assert.equal(await invoke({owner_user_id:'foreign-owner'}),false,'foreign owner cannot classify another binding');
  reset();assert.equal(await invoke({session_id:'missing-session'}),false,'explicit session operations never enter generic fallback');assert.equal(classifications,0);
  reset();sources=true;repair=true;assert.equal(await invoke(),false,'managed effects remain reserved during repair');
  assert.equal(await invoke({purpose:'saved_read'}),true,'existing current-custody saved reads remain allowed during repair');
  for(const [name,change] of [['pending upgrade',()=>{upgrade=true;}],['unfinished form',()=>{form=false;}],
   ['unfinished continuation',()=>{continuation=false;}]] as Array<[string,()=>void]>){reset();sources=true;change();assert.equal(await invoke(),false,name);}
 }finally{mock.restoreAll();}
});
