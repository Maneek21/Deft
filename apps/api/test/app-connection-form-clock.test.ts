import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {AppConnectionFormService,type FormPorts,type FormAuthority} from '../src/lib/app-connection-form-service.js';
import {AppConnectionFormRecordSchema,type AppConnectionFormRecord} from '../../../packages/app-kit/src/connection-form.js';

function fixture(consentDuration=3600000){
 const start=Date.parse('2026-10-10T07:00:00.000Z');let clock=start,calls=0;
 const scope={org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:randomUUID(),package_digest:'sha256:'+'a'.repeat(64),grant_snapshot_digest:'sha256:'+'b'.repeat(64),profile_digest:'sha256:'+'c'.repeat(64),lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1,target_key:'fixture',resource_key:'source',consent_expires_at:new Date(start+consentDuration).toISOString()};
 const authority:FormAuthority={scope,action_consents:[],transport_digest:'sha256:'+'d'.repeat(64),authorization_origin:'https://runtime.example.test',connection_protocol:'credential_form.v1',expires_at:start+3600000};
 const caller={org_id:scope.org_id,user_id:scope.owner_user_id,sid:randomUUID(),access_expires_at:start+3600000};
 const records=new Map<string,AppConnectionFormRecord>();
 const ports:FormPorts={sourceAvailable:async()=>true,current:async()=>authority,store:{
  async create(record){if(records.has(record.session_id))return false;records.set(record.session_id,structuredClone(record));return true;},
  async read(locator){return structuredClone(records.get(locator.session_id)??null);},
  async compareAndSet(prior,next){if(records.get(prior.session_id)?.revision!==prior.revision)return false;records.set(next.session_id,structuredClone(next));return true;},
 },async request(record,input){calls++;return {schema_version:'deft.app_connection_form_runtime.v1',session_id:record.session_id,runtime_session_ref:'fixture_reference',state:'awaiting_input',input_consumed:false,receipt:null,setup_expires_at:input.setup_expires_at};}};
 const service=new AppConnectionFormService(ports,()=>clock++),input={schema_version:'deft.app_connection_form_begin.v1',installation_id:scope.installation_id,target_key:scope.target_key,request_id:randomUUID(),source_session_id:null};
 return {service,caller,input,records,scope,get calls(){return calls;}};
}

test('Begin uses one creation instant even when the clock advances between calls',async()=>{
 const f=fixture(),reply=await f.service.begin(f.caller,f.input);
 assert.equal(reply.session.state,'awaiting_input');
 assert.equal(Date.parse(reply.session.input_expires_at)-Date.parse(reply.session.created_at),300000);
 assert.equal(f.calls,1);
 const again=await f.service.begin(f.caller,f.input);
 assert.equal(again.session.input_expires_at,reply.session.input_expires_at);
 assert.equal(f.calls,1,'original Begin is not repeated or renewed');
});

test('the same creation instant still clamps to owner consent and strict maximum lease',async()=>{
 const f=fixture(60000),reply=await f.service.begin(f.caller,f.input);
 assert.equal(reply.session.input_expires_at,f.scope.consent_expires_at);
 const current=f.records.get(f.input.request_id)!;
 assert.throws(()=>AppConnectionFormRecordSchema.parse({...current,input_expires_at:new Date(Date.parse(current.created_at)+300001).toISOString()}));
});
