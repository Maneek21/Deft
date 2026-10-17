import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
pg.defaults.parseInputDatesAsUTC=true;
test('schema109 preserves legacy rows and fences opt-in expiry updates across migration replay',{skip:process.env.DATABASE_URL!=='postgresql://gate_g_test@127.0.0.1:55439/deft_runtime_renewal_test'||process.env.DEFT_TEST_DATABASE_URL!==process.env.DATABASE_URL},async()=>{
 const url='postgresql://gate_g_test@127.0.0.1:55439/deft_runtime_renewal_test';assert.equal(process.env.DATABASE_URL,url);assert.equal(process.env.DEFT_TEST_DATABASE_URL,url);
 const client=new pg.Client({connectionString:url});await client.connect();
 const namespace=`renewal_test_${randomUUID().replaceAll('-','')}`;
 try{
  await client.query(`CREATE SCHEMA ${namespace}`);await client.query(`SET search_path TO ${namespace},public`);
  await client.query('CREATE TABLE app_runtime_sessions AS SELECT * FROM public.app_runtime_sessions WHERE renewable_until IS NULL LIMIT 1');
  await client.query('ALTER TABLE app_runtime_sessions DROP COLUMN renewable_until,DROP COLUMN renewal_web_session_id,DROP COLUMN renewal_operator_role');
  const old=await readFile(new URL('../../../packages/db/upgrades/0.3.0-preview.31-app-runtime-channel.sql',import.meta.url),'utf8');
  await client.query(old.slice(old.indexOf('CREATE OR REPLACE FUNCTION enforce_app_runtime_session()')));
  const before=(await client.query('SELECT row_to_json(t) AS value FROM app_runtime_sessions t')).rows;assert.equal(before.length,1);
  await assert.rejects(client.query("UPDATE app_runtime_sessions SET expires_at=expires_at+interval '1 minute'"));
  const migration=await readFile(new URL('../../../packages/db/upgrades/0.3.0-preview.109-app-runtime-renewal.sql',import.meta.url),'utf8');
  await client.query(migration);await client.query(migration);
  const after=(await client.query("SELECT to_jsonb(t)-'renewable_until'-'renewal_web_session_id'-'renewal_operator_role' AS value FROM app_runtime_sessions t")).rows;assert.deepEqual(after,before);
  await assert.rejects(client.query("UPDATE app_runtime_sessions SET expires_at=expires_at+interval '1 minute'"));
  await assert.rejects(client.query("UPDATE app_runtime_sessions SET renewable_until=now()+interval '1 hour',renewal_web_session_id='new',renewal_operator_role='owner'"));
  const seed=(await client.query('SELECT * FROM app_runtime_sessions LIMIT 1')).rows[0];
  const insert=async(overrides:Record<string,unknown>)=>{const value={...seed,id:randomUUID(),created_at:new Date(),expires_at:new Date(Date.now()+120_000),renewable_until:new Date(Date.now()+3_600_000),renewal_web_session_id:'original',renewal_operator_role:'owner',...overrides};
   const keys=Object.keys(value);await client.query(`INSERT INTO app_runtime_sessions (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,keys.map(key=>value[key]));return value.id;};
  await assert.rejects(insert({renewal_operator_role:null}));await assert.rejects(insert({renewal_web_session_id:''}));
  const current=await insert({});await client.query("UPDATE app_runtime_sessions SET expires_at=now()+interval '10 minutes' WHERE id=$1",[current]);
  for(const statement of ["renewal_operator_role='admin'","renewable_until=renewable_until+interval '1 minute'","session_epoch=session_epoch+1","expires_at=now()+interval '16 minutes'","expires_at=now()+interval '1 minute'"])
   await assert.rejects(client.query(`UPDATE app_runtime_sessions SET ${statement} WHERE id=$1`,[current]));
  const expired=await insert({created_at:new Date(Date.now()-3_600_000),expires_at:new Date(Date.now()-60_000)});
  await assert.rejects(client.query("UPDATE app_runtime_sessions SET expires_at=now()+interval '10 minutes' WHERE id=$1",[expired]));
 }finally{await client.query(`DROP SCHEMA ${namespace} CASCADE`);await client.end();}
});
