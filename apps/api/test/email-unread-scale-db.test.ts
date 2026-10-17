import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {emailAccounts,emailTimers,notifications,emailMessages,emailMemberships,emailCheckpoints,emailProviderStates,emailSyncReceipts} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {EmailTimerStore} from '../src/lib/email-timer-store.js';
import {PostgresEmailMailboxStore} from '../src/lib/email-mailbox-store.js';
import {EmailUnreadService} from '../src/lib/email-unread.js';
import type {EmailScope} from '../src/lib/email-mailbox-service.js';

// Dedicated network-isolated throwaway PG container only. Never accepts a live
// environment URL or runs migrations against real mailbox/credential tables.
const target='postgresql://gate_g_test@127.0.0.1:55435/email_m1_release';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
const logical=(n:number)=>'mail_'+n.toString(16).padStart(64,'0');
const digest=(scope:EmailScope,id:string)=>createHash('sha256').update(canonicalCapabilityJson(['deft.email.timer.target.v1',scope.org_id,scope.owner_user_id,scope.account_id,id])).digest('hex');

test('isolated PostgreSQL 81160 unread IDs preserve exact snooze exclusion and scope boundaries above bind limit',{skip:!safe,timeout:120000},async t=>{
  const namespace='unread_scale_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:target,max:1});
  const identity=(await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0];
  assert.deepEqual(identity,{db:'email_m1_release',role:'gate_g_test',port:55435});
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({connectionString:target,max:3,options:`-c search_path=${namespace},public`});
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();});
  await pool.query(`CREATE TABLE email_accounts(org_id text,owner_user_id text,account_id text,state text);
    CREATE TABLE email_messages(org_id text,owner_user_id text,account_id text,logical_message_id text,seen boolean,deleted_at timestamptz);
    CREATE TABLE email_memberships(org_id text,owner_user_id text,account_id text,logical_message_id text,folder text);
    CREATE TABLE email_checkpoints(org_id text,owner_user_id text,account_id text,revision integer,coverage text,observed_at timestamptz,fresh_until timestamptz,sync_state text);
    CREATE TABLE email_timers(org_id text,owner_user_id text,account_id text,logical_message_digest text,kind text,state text,scheduled_at timestamptz);
    CREATE INDEX unread_messages_scope ON email_messages(org_id,owner_user_id,account_id,logical_message_id);
    CREATE INDEX unread_memberships_scope ON email_memberships(org_id,owner_user_id,account_id,logical_message_id,folder);
    CREATE INDEX snooze_scope ON email_timers(org_id,owner_user_id,account_id,logical_message_digest);`);
  const scope={org_id:'org-scale',owner_user_id:'owner-scale',account_id:'account-scale'},second={...scope,account_id:'second-account'};
  const instant=new Date('2026-10-07T10:00:00.000Z');
  for(const selected of [scope,second]){
    await pool.query("INSERT INTO email_accounts VALUES($1,$2,$3,'active')",Object.values(selected));
    await pool.query("INSERT INTO email_checkpoints VALUES($1,$2,$3,10,'complete',$4,$5,'idle')",[...Object.values(selected),instant,new Date(instant.getTime()+60000)]);
  }
  await pool.query("INSERT INTO email_messages SELECT $1,$2,$3,'mail_'||lpad(to_hex(n),64,'0'),false,NULL FROM generate_series(1,81160) AS n",Object.values(scope));
  await pool.query("INSERT INTO email_messages SELECT $1,$2,$3,'mail_'||lpad(to_hex(n),64,'0'),false,NULL FROM generate_series(1,2) AS n",Object.values(second));
  await pool.query("INSERT INTO email_memberships SELECT org_id,owner_user_id,account_id,logical_message_id,'inbox' FROM email_messages");
  const add=async(selected:EmailScope,id:number,kind='snooze',state='scheduled',future=true,targetScope=selected)=>pool.query(
    'INSERT INTO email_timers VALUES($1,$2,$3,$4,$5,$6,$7)',[...Object.values(selected),digest(targetScope,logical(id)),kind,state,new Date(instant.getTime()+(future?60000:-1))]);
  await add(scope,1);await add(scope,1);await add(scope,2,'snooze','firing');
  await add(scope,3,'follow_up');await add(scope,4,'snooze','scheduled',false);await add(scope,5,'snooze','cancelled');
  await add(second,6,'snooze','scheduled',true,scope);
  await add({...scope,org_id:'other-org'},7,'snooze','scheduled',true,scope);
  await add({...scope,owner_user_id:'other-owner'},8,'snooze','scheduled',true,scope);
  await add(scope,81161);
  await pool.query('ANALYZE email_messages; ANALYZE email_memberships; ANALYZE email_timers;');
  const db=drizzle(pool,{schema:{emailAccounts,emailTimers,notifications,emailMessages,emailMemberships,emailCheckpoints,emailProviderStates,emailSyncReceipts}});
  const timers=new EmailTimerStore(db as never,{} as never,()=>instant);
  const mailbox=new PostgresEmailMailboxStore(db as never,{} as never);
  const guards:unknown[]=[];
  const guardFor=(selected:EmailScope)=>async(tx:unknown)=>{
    guards.push(tx);const result=await (tx as typeof db).execute(sql`SELECT account_id FROM email_accounts WHERE org_id=${selected.org_id} AND owner_user_id=${selected.owner_user_id} AND account_id=${selected.account_id} AND state='active' FOR SHARE`);
    assert.equal(result.rows.length,1);
  };
  const data=await mailbox.readUnreadIds(scope,'inbox',100001);assert.equal(data.logical_message_ids.length,81160);assert.equal(data.overflow,false);
  const started=performance.now();
  const hidden=await timers.hiddenInboxMessageIds(scope,data.logical_message_ids,guardFor(scope));
  const lookupMs=performance.now()-started;
  assert.deepEqual([...hidden].sort(),[logical(1),logical(2)]);assert.equal(guards.length,2);assert.equal(guards[0],guards[1]);
  const actor={user_id:scope.owner_user_id,web_session_id:'synthetic-session',access_expires_at:instant.getTime()+60000};
  const checks:EmailScope[]=[];
  const service=new EmailUnreadService({current:async(_actor,selected)=>{checks.push(selected);return {scope:selected,resource_binding_id:'synthetic-binding',authority_version:'synthetic-current',expires_at:actor.access_expires_at};}},mailbox,
    async selected=>new Set(selected.account_id===scope.account_id?[logical(1),logical(2)]:[]),()=>instant.getTime());
  const snapshot=await service.read(actor,scope,'inbox');assert.equal(snapshot.unread_count,81158);assert.equal(snapshot.cached_unread_count,81158);assert.equal(snapshot.coverage,'complete');
  assert.equal(checks.length,2);const unified=await service.readUnified(actor,[scope,second],'inbox');assert.equal(unified.unread_count,81160);assert.equal(unified.accounts.length,2);
  let denied=0;await assert.rejects(timers.hiddenInboxMessageIds(scope,data.logical_message_ids,async()=>{if(++denied===2)throw Error('synthetic late denial');}),/synthetic late denial/);
  console.log(JSON.stringify({proof:'isolated PostgreSQL + actual mailbox/timer/unread service',unread_ids:81160,hidden_snoozes:hidden.size,account_unread:snapshot.unread_count,unified_unread:unified.unread_count,lookup_ms:Math.round(lookupMs),live_data:false}));
});
