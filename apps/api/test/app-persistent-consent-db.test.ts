import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {securityTestDatabaseIsSafe} from './fixtures/security-test-database.js';

const isolated=process.env.DATABASE_URL==='postgresql://e2_connection_test@127.0.0.1:33954/e3_reattach_process_20261010'
 && process.env.DEFT_E2_TEST_DATABASE_URL===process.env.DATABASE_URL;
const upgrade=(name:string)=>readFileSync(new URL('../../../packages/db/upgrades/'+name,import.meta.url),'utf8');

test('persistent consent requires explicit mode, preserves finite consent, and keeps technical renewal bounded',
 {skip:!isolated&&!securityTestDatabaseIsSafe(),timeout:30000},async()=>{
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{
  await c.query('BEGIN');
  const legacy=upgrade('0.3.0-preview.101-app-connection-forms.sql');
  const start=legacy.indexOf('CREATE OR REPLACE FUNCTION deft_app_connection_form_scope_valid');
  const end=legacy.indexOf('$$;',start)+3;
  assert.ok(start>=0&&end>start);
  await c.query(legacy.slice(start,end).replace('FUNCTION deft_app_connection_form_scope_valid','FUNCTION pg_temp.legacy_scope_valid'));
  const digest='sha256:'+'a'.repeat(64),owner=randomUUID();
  const scope={org_id:randomUUID(),owner_user_id:owner,installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
   package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,target_key:'mailbox',resource_key:'messages',
   resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:owner,runtime_epoch:1,profile_digest:digest,
   consent_expires_at:new Date(Date.now()+3600000).toISOString()};
  const persistent={...scope,consent_expires_at:null,consent_lifetime:'until_revoked'};
  assert.equal((await c.query('SELECT pg_temp.legacy_scope_valid($1) AS valid',[scope])).rows[0].valid,true);
  assert.equal((await c.query('SELECT pg_temp.legacy_scope_valid($1) AS valid',[persistent])).rows[0].valid,false,'119 RED: same explicit persistent scope denied');
  // Exercise the installed forward migration. Only pg_temp objects are written;
  // ordinary concurrent API tests never see replacement public functions.
  for(const value of [scope,persistent])for(const fn of ['deft_app_connection_form_scope_valid','deft_resource_observation_scope_valid'])
   assert.equal((await c.query(`SELECT ${fn}($1) AS valid`,[value])).rows[0].valid,true);
  const wrongScopes=[{...scope,consent_expires_at:null},{...scope,consent_lifetime:'until_revoked'},
   {...persistent,consent_lifetime:'forever'},{...persistent,consent_lifetime:null},{...persistent,extra:true},
   {...scope,consent_expires_at:'infinity'},{...persistent,grant_epoch:-1}];
  for(const value of wrongScopes)for(const fn of ['deft_app_connection_form_scope_valid','deft_resource_observation_scope_valid'])
   assert.equal((await c.query(`SELECT ${fn}($1) AS valid`,[value])).rows[0].valid,false,JSON.stringify(value));
  const action={action_binding_id:randomUUID(),action_key:'send_message',authority_epoch:1,consent_id:'',consent_digest:digest,expires_at:null,consent_lifetime:'until_revoked'};
  action.consent_id=action.action_binding_id;
  assert.equal((await c.query('SELECT deft_app_connection_actions_v2_valid($1,$2) AS valid',[JSON.stringify([action]),persistent])).rows[0].valid,true);
  assert.equal((await c.query('SELECT deft_app_connection_actions_v2_valid($1,$2) AS valid',[JSON.stringify([action]),scope])).rows[0].valid,false);
  const now=new Date(),review=new Date(now.getTime()+240000).toISOString();
  const reattachment={schema_version:'deft.app_connection_reattachment.v1',source:{session_id:randomUUID(),session_revision:1,scope,
   runtime_session_ref:'old_runtime_ref',account_ref:'synthetic_account'},transport_digest:digest,review_expires_at:review,review:null,receipt:null};
  assert.equal((await c.query('SELECT deft_app_connection_reattachment_valid($1,$2) AS valid',[reattachment,persistent])).rows[0].valid,true);
  assert.equal((await c.query('SELECT deft_app_connection_reattachment_valid($1,$2) AS valid',[
   {...reattachment,source:{...reattachment.source,scope:{...scope,consent_expires_at:'tomorrow'}}},persistent])).rows[0].valid,false);
  assert.equal((await c.query('SELECT deft_app_connection_reattachment_valid($1,$2) AS valid',[
   {...reattachment,source:{...reattachment.source,scope:persistent}},persistent])).rows[0].valid,true);
  const connection={session_id:randomUUID(),runtime_session_ref:'synthetic_ref',account_ref:'synthetic_account',expected_custody_generation:null,receipt_digest:null};
  const snapshot={schema_version:'deft.app_resource_observation_consent.v1',consent_id:randomUUID(),scope:persistent,connection,
   resource_policy_digest:digest,interval_seconds:60,expires_at:null,consent_lifetime:'until_revoked',review_expires_at:review};
  const consentCheck=(await c.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='app_resource_observation_identity'")).rows[0].definition;
  await c.query(`CREATE TEMP TABLE persistent_observation(org_id text,owner_user_id text,consent_id text,resource_binding_id text,connection_session_id text,
   snapshot jsonb,expires_at timestamptz,created_at timestamptz,updated_at timestamptz,${consentCheck})`);
  const insert=(s:unknown,expiry:unknown=null)=>c.query('INSERT INTO persistent_observation VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)',
   [scope.org_id,owner,snapshot.consent_id,scope.resource_binding_id,connection.session_id,s,expiry,now]);
  const denied=async(fn:()=>Promise<unknown>,pattern:RegExp=/check constraint|APP_CONSENT_LIFETIME_INVALID|APP_RUNTIME_IMMUTABLE_FIELD/)=>{
   await c.query('SAVEPOINT negative');await assert.rejects(fn,pattern);await c.query('ROLLBACK TO SAVEPOINT negative');
  };
  await insert(snapshot);
  const finite={...snapshot,scope,expires_at:scope.consent_expires_at} as Record<string,unknown>;delete finite.consent_lifetime;delete finite.review_expires_at;
  await insert(finite,scope.consent_expires_at);
  for(const mutate of [
   (s:Record<string,unknown>)=>{delete s.consent_lifetime;},(s:Record<string,unknown>)=>{s.consent_lifetime='forever';},
   (s:Record<string,unknown>)=>{s.expires_at=scope.consent_expires_at;},(s:Record<string,unknown>)=>{delete s.review_expires_at;},
   (s:Record<string,unknown>)=>{s.review_expires_at=new Date(now.getTime()+300001).toISOString();},
   (s:Record<string,unknown>)=>{s.review_expires_at=now.toISOString();},(s:Record<string,unknown>)=>{s.review_expires_at='infinity';},
   (s:Record<string,unknown>)=>{s.scope=scope;},(s:Record<string,unknown>)=>{s.scope={...persistent,owner_user_id:randomUUID()};},
  ]){const wrong:Record<string,unknown>=structuredClone(snapshot);mutate(wrong);await denied(()=>insert(wrong));}
  await denied(()=>insert({...finite,review_expires_at:review},scope.consent_expires_at));
  // Actual consent triggers enforce review freshness on activation, even though
  // persistent owner scope itself has no deadline. Only temporary relations are
  // seeded to model the elapsed clock; production guards are not replaced.
  await c.query('CREATE TEMP TABLE app_connection_sessions(org_id text,owner_user_id text,session_id text,record jsonb,revision integer)');
  await c.query('INSERT INTO app_connection_sessions VALUES($1,$2,$3,$4,1)',[scope.org_id,owner,connection.session_id,
   {state:'connected',scope:persistent,runtime_session_ref:connection.runtime_session_ref,account:{account_ref:connection.account_ref}}]);
  await c.query('CREATE TEMP TABLE persistent_data(LIKE app_data_consents INCLUDING DEFAULTS INCLUDING CONSTRAINTS)');
  await c.query('CREATE TEMP TABLE expired_observation(LIKE app_resource_observation_consents INCLUDING DEFAULTS INCLUDING CONSTRAINTS)');
  const created=new Date(+now-600000).toISOString(),expiredReview=new Date(+now-360000).toISOString();
  const expiredSnapshot={...snapshot,review_expires_at:expiredReview};
  await c.query("INSERT INTO expired_observation VALUES($1,$2,$3,$4,$5,'proposed',$6,$7,NULL,$8,$8)",
   [scope.org_id,owner,snapshot.consent_id,scope.resource_binding_id,connection.session_id,digest,expiredSnapshot,created]);
  const dataSnapshot={schema_version:'deft.app_data_consent.v1',consent_id:randomUUID(),scope:persistent,
   connection:{session_id:connection.session_id,session_revision:1,runtime_session_ref:connection.runtime_session_ref,account_ref:connection.account_ref},
   store:{key:'drafts'},data_policy_digest:digest,purpose:'human_record_write',expires_at:null,consent_lifetime:'until_revoked',review_expires_at:expiredReview};
  await c.query("INSERT INTO persistent_data VALUES($1,$2,$3,$4,'drafts','proposed',$5,$6,NULL,$7,$7)",
   [scope.org_id,owner,dataSnapshot.consent_id,connection.session_id,digest,dataSnapshot,created]);
  await c.query('CREATE TRIGGER expired_data_guard BEFORE INSERT OR UPDATE ON persistent_data FOR EACH ROW EXECUTE FUNCTION guard_app_data_consent()');
  await c.query('CREATE TRIGGER expired_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON expired_observation FOR EACH ROW EXECUTE FUNCTION deft_resource_observation_consent_guard()');
  await denied(()=>c.query("UPDATE persistent_data SET state='active'"),/App data review expired/);
  await denied(()=>c.query("UPDATE expired_observation SET state='active'"),/observation review expired/);
  await c.query("UPDATE persistent_data SET state='revoked'");await c.query("UPDATE expired_observation SET state='revoked'");
  const bindingCheck=(await c.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='app_resource_bindings_review_check'")).rows[0].definition;
  await c.query(`CREATE TEMP TABLE persistent_binding(state text,reviewed_by_user_id text,owner_user_id text,reviewed_at timestamptz,consent_expires_at timestamptz,consent_lifetime text,${bindingCheck})`);
  await c.query("INSERT INTO persistent_binding VALUES('active',$1,$1,$2,NULL,'until_revoked')",[owner,now]);
  await denied(()=>c.query("INSERT INTO persistent_binding VALUES('active',$1,$1,$2,NULL,NULL)",[owner,now]));
  await denied(()=>c.query("INSERT INTO persistent_binding VALUES('active',$1,$1,$2,$3,'until_revoked')",[owner,now,scope.consent_expires_at]));
  await c.query('CREATE TEMP TABLE persistent_sessions(LIKE app_runtime_sessions INCLUDING DEFAULTS INCLUDING CONSTRAINTS)');
  const attachSessionGuard=()=>c.query('CREATE TRIGGER persistent_session_guard BEFORE INSERT OR UPDATE OR DELETE ON persistent_sessions FOR EACH ROW EXECUTE FUNCTION enforce_app_runtime_session()');
  await attachSessionGuard();
  const base={id:randomUUID(),org_id:scope.org_id,runtime_registration_id:scope.runtime_registration_id,runtime_binding_id:null,resource_binding_id:scope.resource_binding_id,
   operator_user_id:owner,token_hash:digest,audience:'app_resource_sync',session_epoch:0,runtime_epoch:1,lifecycle_epoch:1,grant_epoch:1,
   next_sequence:1,expires_at:new Date(now.getTime()+300000).toISOString(),revoked_at:null,created_at:now.toISOString(),updated_at:now.toISOString(),
   renewable_until:null,renewal_lifetime:'until_revoked',renewal_web_session_id:randomUUID(),renewal_operator_role:'owner'};
  const insertSession=(row:Record<string,unknown>)=>c.query('INSERT INTO persistent_sessions SELECT * FROM jsonb_populate_record(NULL::persistent_sessions,$1)',[row]);
  await insertSession(base);
  const actionSession={...base,id:randomUUID(),audience:'app_runtime',runtime_binding_id:randomUUID(),resource_binding_id:null};
  await insertSession(actionSession);
  await insertSession({...actionSession,id:randomUUID(),renewal_lifetime:null,renewable_until:scope.consent_expires_at});
  await denied(()=>insertSession({...base,id:randomUUID(),renewal_lifetime:null,renewable_until:scope.consent_expires_at}));
  await c.query("UPDATE persistent_sessions SET expires_at=timezone('UTC',clock_timestamp()+interval '10 minutes')");
  await denied(()=>c.query("UPDATE persistent_sessions SET expires_at=timezone('UTC',clock_timestamp()+interval '16 minutes')"));
  await denied(()=>c.query("UPDATE persistent_sessions SET renewal_lifetime=NULL"));
  await denied(()=>c.query("UPDATE persistent_sessions SET renewal_web_session_id='foreign'"));
  await denied(()=>insertSession({...base,id:randomUUID(),renewal_lifetime:null}));
  await denied(()=>insertSession({...base,id:randomUUID(),renewable_until:scope.consent_expires_at}));
  await denied(()=>insertSession({...base,id:randomUUID(),renewal_lifetime:'forever'}));
  await denied(()=>insertSession({...base,id:randomUUID(),expires_at:new Date(now.getTime()+960000).toISOString()}),/APP_RUNTIME_RENEWAL_WINDOW_INVALID/);
  await c.query('TRUNCATE persistent_sessions');
  await c.query('DROP TRIGGER persistent_session_guard ON persistent_sessions');
  await insertSession({...base,created_at:new Date(now.getTime()-600000).toISOString(),expires_at:new Date(now.getTime()-1000).toISOString()});
  await attachSessionGuard();
  await denied(()=>c.query("UPDATE persistent_sessions SET expires_at=timezone('UTC',clock_timestamp()+interval '10 minutes')"));
  console.log('# actual SQL120 explicit/implicit/mixed mode, five-minute review, and live-only 15-minute technical renewal guards passed');
 }finally{await c.query('ROLLBACK');await c.end();}
});
