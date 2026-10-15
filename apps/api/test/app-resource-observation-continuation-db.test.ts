import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {securityTestDatabaseIsSafe} from './fixtures/security-test-database.js';

const synthetic = process.env.DATABASE_URL === 'postgresql://authority_fixture@127.0.0.1:55437/authority_fixture';
const upgrade = (name: string) => readFileSync(new URL('../../../packages/db/upgrades/' + name, import.meta.url), 'utf8');

test('observation SQL accepts exact renewed connection receipts and retains all receipt and transition fences',
 {skip: !synthetic && !securityTestDatabaseIsSafe(), timeout: 30000}, async () => {
 const c = new pg.Client({connectionString: process.env.DATABASE_URL}); await c.connect();
 try {
  await c.query('BEGIN');
  // Temporary relations isolate the actual trigger body from tenant fixtures.
  // The existing validators are compiled verbatim, not replaced by stubs.
  await c.query(`CREATE TEMP TABLE app_connection_sessions(org_id text,owner_user_id text,session_id text,record jsonb);
   CREATE TEMP TABLE app_connection_forms(LIKE app_connection_sessions);
   CREATE TEMP TABLE app_connection_consent_continuations(LIKE app_connection_sessions);
   CREATE TEMP TABLE observation_fixture(org_id text,owner_user_id text,connection_session_id text,state text,snapshot jsonb,expires_at timestamptz,updated_at timestamptz);`);
  for (const [file, end] of [
   ['0.3.0-preview.97-app-connection-reattachment.sql', 'ALTER TABLE app_connection_sessions'],
   ['0.3.0-preview.99-app-connection-upgrade.sql', 'CREATE OR REPLACE FUNCTION deft_app_connection_upgrade_valid'],
   ['0.3.0-preview.111-app-connection-consent-continuation.sql', 'CREATE TABLE IF NOT EXISTS'],
  ]) await c.query(upgrade(file!).split(end!)[0]!.replaceAll('CREATE OR REPLACE FUNCTION ', 'CREATE OR REPLACE FUNCTION pg_temp.'));
  // Functions are explicitly qualified because PostgreSQL does not implicitly
  // resolve function calls through pg_temp. All bodies remain unchanged.
  const define = async (sql: string) => c.query(sql.replaceAll('deft_app_connection_reattachment_valid(', 'pg_temp.deft_app_connection_reattachment_valid(')
   .replaceAll('deft_app_connection_actions_v2_valid(', 'pg_temp.deft_app_connection_actions_v2_valid(')
   .replaceAll('deft_app_consent_continuation_valid(', 'pg_temp.deft_app_consent_continuation_valid(')
   .replace('FUNCTION deft_resource_observation_consent_guard()', 'FUNCTION pg_temp.deft_resource_observation_consent_guard()'));
  // Rebind the validator calls in the actual continuation validator too.
  await define(upgrade('0.3.0-preview.111-app-connection-consent-continuation.sql').split('CREATE TABLE IF NOT EXISTS')[0]!);
  const id = randomUUID(), owner = randomUUID(), sid = randomUUID(), digest = 'sha256:' + 'a'.repeat(64);
  const scope = {org_id:id,owner_user_id:owner,installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
   package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,target_key:'records',resource_key:'records',
   resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:owner,runtime_epoch:1,profile_digest:digest,
   consent_expires_at:'2030-01-01T13:00:00.000Z'};
  const account = {account_ref:'synthetic_account',label:'Synthetic account'};
  const record = {session_id:sid,state:'connected',scope,profile:{key:'synthetic'},action_consents:[],account,runtime_session_ref:'new_runtime_ref',callback_consumed:true};
  const continuation = {session_id:sid,revision:3,state:'connected',activation_started:true,scope,profile:record.profile,
   source:{session_id:randomUUID(),session_revision:2,scope:{...scope,consent_expires_at:'2030-01-01T12:00:00.000Z'},runtime_session_ref:'old_runtime_ref',account_ref:account.account_ref,action_consents:[]},
   action_consents:[],transport_digest:digest,review_expires_at:'2030-01-01T11:02:00.000Z',reviewed_at:'2030-01-01T11:00:00.000Z',binding_before:{},attachment_consent_digest:digest,
   review:{digest,custody_generation:2,custody_digest:digest,account},
   result:{schema_version:'deft.app_connection_consent_continuation_runtime.v1',session_id:sid,state:'connected',account,runtime_session_ref:record.runtime_session_ref,custody_generation:2,receipt_digest:digest},
   created_at:'2030-01-01T11:00:00.000Z',updated_at:'2030-01-01T11:00:01.000Z'};
  assert.equal((await c.query('SELECT pg_temp.deft_app_consent_continuation_valid($1) AS valid',[continuation])).rows[0].valid,true);
  await c.query('INSERT INTO app_connection_sessions VALUES($1,$2,$3,$4)',[id,owner,sid,record]);
  await c.query('INSERT INTO app_connection_consent_continuations VALUES($1,$2,$3,$4)',[id,owner,sid,continuation]);
  const snapshot = {scope,connection:{session_id:sid,runtime_session_ref:record.runtime_session_ref,account_ref:account.account_ref,expected_custody_generation:2,receipt_digest:digest}};
  const insert = (value: unknown = snapshot) => c.query("INSERT INTO observation_fixture VALUES($1,$2,$3,'proposed',$4,'2030-01-01T12:30:00Z','2030-01-01T11:00:00Z')",[id,owner,sid,value]);
  const denied = async (fn: () => Promise<unknown>, message: RegExp) => {
   await c.query('SAVEPOINT negative'); await assert.rejects(fn, message); await c.query('ROLLBACK TO SAVEPOINT negative');
  };
  await define(upgrade('0.3.0-preview.104-app-resource-observation-connection-receipts.sql'));
  await c.query('CREATE TRIGGER observation_guard BEFORE INSERT OR UPDATE OR DELETE ON observation_fixture FOR EACH ROW EXECUTE FUNCTION pg_temp.deft_resource_observation_consent_guard()');
  await denied(() => insert(), /observation connection pins mismatch/); // Exact schema118 RED.
  await define(upgrade('0.3.0-preview.119-app-resource-observation-continuation-receipts.sql'));
  await insert(); // Same renewed carrier, same receipt, now GREEN.
  for (const change of [
   (s: typeof snapshot) => {s.connection.receipt_digest='sha256:'+'b'.repeat(64);},
   (s: typeof snapshot) => {s.connection.expected_custody_generation++;},
   (s: typeof snapshot) => {s.connection.account_ref='foreign_account';},
   (s: typeof snapshot) => {s.scope.grant_epoch++;},
   (s: typeof snapshot) => {s.connection.runtime_session_ref='foreign_runtime';},
  ]) {const wrong=structuredClone(snapshot);change(wrong);await denied(()=>insert(wrong),/observation connection pins mismatch/);}
  for (const change of [
   (r: typeof continuation) => {r.state='reviewed';},
   (r: typeof continuation) => {r.activation_started=false;},
   (r: typeof continuation) => {r.result.account={...account,account_ref:'foreign_account'};},
   (r: typeof continuation) => {r.profile={key:'foreign'};},
   (r: typeof continuation) => {r.scope={...scope,grant_epoch:2};},
  ]) {
   const wrong=structuredClone(continuation);change(wrong);
   await c.query('UPDATE app_connection_consent_continuations SET record=$1',[wrong]);
   await denied(()=>insert(),/observation continuation connection pins mismatch/);
  }
  await c.query('UPDATE app_connection_consent_continuations SET record=$1',[continuation]);
  await denied(()=>c.query("UPDATE observation_fixture SET snapshot=jsonb_set(snapshot,'{scope,grant_epoch}','2')"),/immutable identity/);
  await c.query("UPDATE observation_fixture SET state='active'");
  await c.query("UPDATE observation_fixture SET state='revoked'");
  await denied(()=>c.query("UPDATE observation_fixture SET state='active'"),/immutable identity/);
  await denied(()=>c.query('DELETE FROM observation_fixture'),/history retained/);
  // Legacy OAuth and retained upgrade/reattachment receipts keep their behavior.
  await c.query('DELETE FROM app_connection_consent_continuations');
  const legacy=structuredClone(snapshot);legacy.connection.expected_custody_generation=null as unknown as number;legacy.connection.receipt_digest=null as unknown as string;
  await insert(legacy);
  for (const kind of ['upgrade','reattachment']) {
   await c.query('UPDATE app_connection_sessions SET record=$1',[{...record,[kind]:{receipt:{custody_generation:2,receipt_digest:digest}}}]);
   await insert();
  }
 } finally {await c.query('ROLLBACK');await c.end();}
});
