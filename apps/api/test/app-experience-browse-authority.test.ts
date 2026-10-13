import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AppExperienceExposureService } from '../src/lib/app-experience-exposure.js';
import { exposureUnavailable } from '../src/lib/app-experience-exposure-contract.js';
function fixture() {
 const caller={org_id:randomUUID(),user_id:randomUUID(),sid:randomUUID(),access_expires_at:1000000},session=randomUUID();
 const pins={org_id:caller.org_id,owner_user_id:caller.user_id,installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),target_key:'personal',resource_key:'inbox',resource_binding_id:randomUUID(),action_key:null,action_binding_id:null};
 const state={contexts:0,transactions:0,finals:0,live:true,role:'owner',time:1000,afterTransaction:()=>{}};
 const resource={resource_key:'inbox',binding_id:pins.resource_binding_id,allowed_operations:['list_summary','read_one','search'],allowed_fields:['subject'],content_policy:{document:{max_chars:16384}}};
 const context={verified:{manifest:{schema_version:'7'}},installation:{id:pins.installation_id,lifecycle_epoch:14,grant_epoch:14},version:{id:pins.app_version_id},grant:{id:pins.grant_snapshot_id},session:{resource_target_key:'personal',expires_at:new Date(850000)},web:{expires_at:new Date(900000)},exposure:{id:randomUUID(),exposure_epoch:3,expires_at:new Date(800000)},authorities:[{binding:{id:pins.resource_binding_id,resource_key:'inbox',consent_expires_at:new Date(900000),max_records_per_page:25,max_page_bytes:524288,max_retained_records:1000,max_retained_bytes:16777216,attachment_consent_digest:'sha256:test'},registration:{id:randomUUID(),runtime_epoch:1},descriptor_digest:'sha256:test',descriptor:{key:'inbox',label_field:'subject',record_schema:{type:'object',properties:{subject:{type:'string'}}}}}]};
 const snapshot={org_id:caller.org_id,owner_user_id:caller.user_id,web_session_id:caller.sid,experience_session_id:session,installation_id:pins.installation_id,app_version_id:pins.app_version_id,grant_snapshot_id:pins.grant_snapshot_id,artifact_digest:'sha256:test',lifecycle_epoch:14,grant_epoch:14,expires_at:new Date(700000).toISOString(),resources:[resource]};
 const tx={select:()=>({from:()=>({where:()=>({limit:async()=>[{role:state.role}]})})}),execute:async()=>({rows:[{now_ms:String(state.time)}]})};
 const service:any=new AppExperienceExposureService({} as any,{transaction:async(fn:any)=>{state.transactions++;const value=await fn(tx);state.afterTransaction();return value;}} as any,()=>new Date(state.time));
 service.enabled=(actual:any,signal:any)=>{signal?.throwIfAborted();if(!state.live||actual.org_id!==caller.org_id||actual.user_id!==caller.user_id||actual.sid!==caller.sid)throw exposureUnavailable();};
 service.locked=async(_tx:any,actual:any,id:string)=>{service.enabled(actual);assert.equal(id,session);state.contexts++;return context;};
 service.assertStored=()=>snapshot;service.snapshot=()=>snapshot;
 service.final=async()=>{state.finals++;if(!state.live)throw exposureUnavailable();};
 return{service,state,caller,session,pins,context};
}
const stable=(value:any)=>{const {checked_at,...rest}=value;return rest;};
test('combined browse authority has exact field parity with separate snapshots and one fresh context',async()=>{
 const f=fixture();const projection=await f.service.connectionSetup(f.caller,f.session,f.pins,undefined,'browse_resource');const nomination=await f.service.providerAuthority(f.caller,f.session,'inbox');assert.equal(f.state.contexts,2);assert.equal(f.state.transactions,2);
 f.state.contexts=0;f.state.transactions=0;const both=await f.service.browseAuthority(f.caller,f.session,'inbox',f.pins);
 assert.deepEqual(stable(both.projection),stable(projection));assert.deepEqual(both.nomination,nomination);assert.equal(f.state.contexts,1);assert.equal(f.state.transactions,1);
 await f.service.browseAuthority(f.caller,f.session,'inbox',f.pins);assert.equal(f.state.contexts,2,'later call must acquire a fresh context');
});
test('revocation between paired derivations is rejected by final guard',async()=>{
 const f=fixture(),derive=f.service.providerNomination.bind(f.service);f.service.providerNomination=(...args:any[])=>{const value=derive(...args);f.state.live=false;return value;};
 await assert.rejects(f.service.browseAuthority(f.caller,f.session,'inbox',f.pins));assert.equal(f.state.contexts,1);assert.equal(f.state.finals,2);
});
test('combined browse authority denies owner resource key pins and member mismatches',async()=>{
 for(const patch of [{owner_user_id:randomUUID()},{resource_binding_id:randomUUID()},{installation_id:randomUUID()},{target_key:'other'},{resource_key:'other'}]){const f=fixture();await assert.rejects(f.service.browseAuthority(f.caller,f.session,'inbox',{...f.pins,...patch}));}
 const f=fixture();f.state.role='viewer';await assert.rejects(f.service.browseAuthority(f.caller,f.session,'inbox',f.pins));
});
test('expiry and abort after paired derivations are rejected without extending deadline',async()=>{
 const f=fixture(),derive=f.service.providerNomination.bind(f.service);f.service.providerNomination=(...args:any[])=>{const value=derive(...args);f.state.time=700001;return value;};await assert.rejects(f.service.browseAuthority(f.caller,f.session,'inbox',f.pins));
 const g=fixture(),controller=new AbortController();controller.abort();await assert.rejects(g.service.browseAuthority(g.caller,g.session,'inbox',g.pins,controller.signal));assert.equal(g.state.contexts,0);
});

test('abort after derivation and expiry after transaction settle withhold paired output',async()=>{
 const f=fixture(),controller=new AbortController(),derive=f.service.providerNomination.bind(f.service);f.service.providerNomination=(...args:any[])=>{const value=derive(...args);controller.abort();return value;};await assert.rejects(f.service.browseAuthority(f.caller,f.session,'inbox',f.pins,controller.signal));
 const g=fixture();g.state.afterTransaction=()=>{g.state.time=700001;};await assert.rejects(g.service.browseAuthority(g.caller,g.session,'inbox',g.pins));
});
