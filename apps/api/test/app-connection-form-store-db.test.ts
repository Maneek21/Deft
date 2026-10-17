import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import * as schema from '../../../packages/db/src/schema.js';
import {PostgresAppConnectionFormStore} from '../src/lib/app-connection-form-store.js';
import {formDigest,validateFormCarrierPair} from '../src/lib/app-connection-form-carrier.js';
import {appConnectionFormPredecessorIsAvailable} from '../src/lib/app-connection-form-fence.js';
import {AppConnectionFormRecordSchema,type AppConnectionFormRecord} from '../../../packages/app-kit/src/connection-form.js';

const raw=process.env.DEFT_IMAP_FORM_TEST_DATABASE_URL;
test('real PostgreSQL paired form CAS, source reservation and current effect fences',{skip:!raw},async()=>{
 const url=new URL(raw!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5432');assert.equal(url.pathname,'/e3_imap_sql101');assert.equal(url.username,'postgres');
 assert.equal(process.env.DEFT_IMAP_FORM_LOCAL_FIXTURE,'network_none_container');
 const pool=new pg.Pool({connectionString:raw,max:6}),database=drizzle(pool,{schema});
 try{
  const scope={...Object.fromEntries(['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','resource_binding_id','runtime_registration_id','operator_user_id'].map(key=>[key,randomUUID()])),package_digest:'sha256:'+'a'.repeat(64),grant_snapshot_digest:'sha256:'+'b'.repeat(64),profile_digest:'sha256:'+'c'.repeat(64),lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1,target_key:'imap_fixture',resource_key:'inbox',consent_expires_at:new Date(Date.now()+3600000).toISOString()};
  const caller={org_id:scope.org_id!,user_id:scope.owner_user_id!,sid:randomUUID(),access_expires_at:Date.now()+3600000};
  await pool.query('INSERT INTO org_members VALUES($1,$2)',[caller.org_id,caller.user_id]);await pool.query('INSERT INTO web_sessions VALUES($1,$2,$3)',[caller.sid,caller.org_id,caller.user_id]);
  const profile={schema_version:'deft.app_connection_profile.v1' as const,key:'imap_account',provider_id:'imap_smtp',operator_user_id:scope.operator_user_id!,runtime_requirement_key:'mail_runtime',resource_key:'inbox',action_keys:[],authorization_origin:'https://runtime.example.test',credential_custody:'runtime' as const,executable:false as const};
  const store=new PostgresAppConnectionFormStore(database,async()=>profile);
  const fresh=(nextScope:unknown=scope,source:AppConnectionFormRecord['source']=null)=>{const at=new Date().toISOString();return AppConnectionFormRecordSchema.parse({schema_version:'deft.app_connection_form_record.v1',session_id:randomUUID(),revision:1,scope:nextScope,action_consents:[],source,transport_digest:'sha256:'+'d'.repeat(64),authorization_origin:profile.authorization_origin,state:'starting',runtime_session_ref:null,begin_consumed:false,input_consumed:false,input_expires_at:new Date(Date.now()+300000).toISOString(),account:null,receipt:null,created_at:at,updated_at:at});};
  const next=(prior:AppConnectionFormRecord,change:Partial<AppConnectionFormRecord>)=>AppConnectionFormRecordSchema.parse({...prior,...change,revision:prior.revision+1,updated_at:new Date().toISOString()});
  const q=(r:AppConnectionFormRecord)=>({org_id:caller.org_id,owner_user_id:caller.user_id,session_id:r.session_id});
  let source=fresh();const competitor=fresh();const raced=await Promise.all([store.create(source,caller),store.create(competitor,caller)]);assert.equal(raced.filter(Boolean).length,1);if(!raced[0])source=competitor;
  assert.equal(await store.read({...q(source),owner_user_id:randomUUID()}),null);
  const advance=async(prior:AppConnectionFormRecord,change:Partial<AppConnectionFormRecord>)=>{const value=next(prior,change);try{assert.equal(await store.compareAndSet(prior,value,caller),true);}catch(error){const cause=(error as {cause?:{code?:string;constraint?:string;message?:string}}).cause;console.error(JSON.stringify({fixture_phase:'paired_cas',state:value.state,code:cause?.code,constraint:cause?.constraint,message:cause?.message?.slice(0,200)}));throw error;}return value;};
  const initial=source;source=await advance(source,{begin_consumed:true});assert.equal(await store.compareAndSet(initial,next(initial,{begin_consumed:true}),caller),false);
  source=await advance(source,{state:'awaiting_input',runtime_session_ref:'synthetic_form_ref'});source=await advance(source,{state:'checking'});
  const account={account_ref:randomUUID(),label:'Owner-declared fixture',address:'owner@example.test',capabilities:['read'],identity_assurance:'owner_declared_authenticated' as const};
  const receipt={schema_version:'deft.app_connection_form_receipt.v1' as const,account_ref:account.account_ref,custody_generation:1,principal_digest:'sha256:'+'e'.repeat(64),custody_digest:'sha256:'+'f'.repeat(64),scope_digest:formDigest(source.scope),committed_at:new Date().toISOString()};
  source=await advance(source,{state:'connected',input_consumed:true,account,receipt:{...receipt,digest:formDigest(receipt)}});
  const pair=await pool.query('SELECT c.record carrier,f.record form FROM app_connection_sessions c JOIN app_connection_forms f USING(org_id,owner_user_id,session_id) WHERE c.session_id=$1',[source.session_id]);assert.equal(validateFormCarrierPair(pair.rows[0].form,pair.rows[0].carrier).form.receipt!.digest,source.receipt!.digest);
  assert.throws(()=>validateFormCarrierPair({...source,receipt:{...source.receipt,digest:'sha256:'+'0'.repeat(64)}},pair.rows[0].carrier),/RECEIPT_INVALID/);
  const upgradedScope={...scope,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),grant_epoch:2};
  const predecessor={session_id:source.session_id,session_revision:source.revision,scope:source.scope,runtime_session_ref:source.runtime_session_ref!,account_ref:account.account_ref};
  const runID=randomUUID();await pool.query('INSERT INTO app_runs(id,org_id,origin_app_installation_id,origin_resource_binding_id,state) VALUES($1,$2,$3,$4,$5)',[runID,caller.org_id,scope.installation_id,scope.resource_binding_id,'pending']);
  assert.equal(await store.create(fresh(upgradedScope,predecessor),caller),false);
  await pool.query('UPDATE app_runs SET state=$1 WHERE id=$2',['unknown_outcome',runID]);assert.equal(await store.create(fresh(upgradedScope,predecessor),caller),false);
  await pool.query('UPDATE app_runs SET state=$1 WHERE id=$2',['failed',runID]);await pool.query('INSERT INTO app_run_attempts(id,org_id,run_id,state) VALUES($1,$2,$3,$4)',[randomUUID(),caller.org_id,runID,'unknown_outcome']);
  const mutationID=randomUUID();await pool.query('INSERT INTO app_data_invocations(request_id,org_id,owner_user_id,connection_session_id,state,operation) VALUES($1,$2,$3,$4,$5,$6)',[mutationID,caller.org_id,caller.user_id,source.session_id,'indeterminate','file_upload']);assert.equal(await store.create(fresh(upgradedScope,predecessor),caller),false);
  await pool.query('UPDATE app_data_invocations SET state=$1 WHERE request_id=$2',['completed',mutationID]);
  let successor=fresh(upgradedScope,predecessor);assert.equal(await store.create(successor,caller),true);successor=await advance(successor,{begin_consumed:true});
  assert.equal(await database.transaction(tx=>appConnectionFormPredecessorIsAvailable(tx,q(source))),false);
  await assert.rejects(store.compareAndSet(source,next(source,{state:'checking'}),caller),error=>String(error).includes('update')||String(error).includes('SOURCE_RESERVED'));
  assert.equal((await store.read(q(source)))!.revision,source.revision);
  assert.equal(await store.create(fresh({...upgradedScope,grant_epoch:3},predecessor),caller),false);
  assert.equal((await pool.query('SELECT state FROM app_run_attempts WHERE run_id=$1',[runID])).rows[0].state,'unknown_outcome');
  // No provider or runtime dispatch exists in this store test; old rows remain.
 }finally{await pool.end();}
});
