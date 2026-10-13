import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {emailAccounts,emailTimers,notifications,emailMessages,emailMemberships,emailCheckpoints,emailProviderStates,emailSyncReceipts} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {EmailTimerStore} from '../src/lib/email-timer-store.js';
import {PostgresEmailMailboxStore} from '../src/lib/email-mailbox-store.js';
import {EmailUnreadService} from '../src/lib/email-unread.js';
import type {EmailScope} from '../src/lib/email-mailbox-service.js';

const target='postgresql://gate_g_test@127.0.0.1:55435/email_m2_release';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
const logical=(n:number)=>'mail_'+n.toString(16).padStart(64,'0');
const digest=(scope:EmailScope,id:string)=>createHash('sha256').update(canonicalCapabilityJson(['deft.email.timer.target.v1',scope.org_id,scope.owner_user_id,scope.account_id,id])).digest('hex');

test('isolated PostgreSQL aggregate is exact above 100001, avoids unread ID enumeration, and preserves snooze/scope/coverage semantics',{skip:!safe,timeout:120000},async t=>{
  const namespace='unread_aggregate_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:target,max:1});
  assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'email_m2_release',role:'gate_g_test',port:55435});
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({connectionString:target,max:3,options:`-c search_path=${namespace},public`});
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();});
  await pool.query(`CREATE TABLE email_accounts(org_id text,owner_user_id text,account_id text,state text);
    CREATE TABLE email_messages(org_id text,owner_user_id text,account_id text,logical_message_id text,seen boolean,flagged boolean,deleted_at timestamptz);
    CREATE TABLE email_memberships(org_id text,owner_user_id text,account_id text,logical_message_id text,folder text);
    CREATE TABLE email_checkpoints(org_id text,owner_user_id text,account_id text,revision integer,coverage text,observed_at timestamptz,fresh_until timestamptz,sync_state text);
    CREATE TABLE email_timers(org_id text,owner_user_id text,account_id text,timer_id uuid,revision integer,logical_message_digest text,kind text,state text,scheduled_at timestamptz,timer_envelope jsonb);
    CREATE UNIQUE INDEX unread_messages_scope ON email_messages(org_id,owner_user_id,account_id,logical_message_id);
    CREATE INDEX unread_memberships_scope ON email_memberships(org_id,owner_user_id,account_id,logical_message_id,folder);
    CREATE INDEX snooze_scope ON email_timers(org_id,owner_user_id,account_id,kind,state,scheduled_at);`);
  const scope={org_id:'org-scale',owner_user_id:'owner-scale',account_id:'account-scale'},second={...scope,account_id:'second-account'};
  const instant=new Date('2026-10-07T10:00:00.000Z');
  const keys={current:()=>({key_id:'synthetic',key:Buffer.alloc(32,19)}),read:()=>({key_id:'synthetic',key:Buffer.alloc(32,19)}),keyIds:()=>['synthetic']};
  const crypto=new EmailMailboxCrypto(keys);
  for(const selected of [scope,second]){
    await pool.query("INSERT INTO email_accounts VALUES($1,$2,$3,'active')",Object.values(selected));
    await pool.query("INSERT INTO email_checkpoints VALUES($1,$2,$3,10,'complete',$4,$5,'idle')",[...Object.values(selected),instant,new Date(instant.getTime()+60000)]);
  }
  await pool.query("INSERT INTO email_messages SELECT $1,$2,$3,'mail_'||lpad(to_hex(n),64,'0'),false,n=1,NULL FROM generate_series(1,81160) AS n",Object.values(scope));
  await pool.query("INSERT INTO email_messages SELECT $1,$2,$3,'mail_'||lpad(to_hex(n),64,'0'),false,false,NULL FROM generate_series(1,2) AS n",Object.values(second));
  await pool.query("INSERT INTO email_memberships SELECT org_id,owner_user_id,account_id,logical_message_id,'inbox' FROM email_messages");
  const add=async(selected:EmailScope,id:number,kind='snooze',state='scheduled',delta=60000,targetScope=selected)=>{
    const timerId=randomUUID();
    const envelope=crypto.seal({logical_message_id:logical(id),kind},{...selected,kind:'timer',record_id:`timer:${timerId}`,revision:1});
    await pool.query('INSERT INTO email_timers VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9)',[...Object.values(selected),timerId,digest(targetScope,logical(id)),kind,state,new Date(instant.getTime()+delta),envelope]);
  };
  await add(scope,1);await add(scope,1);await add(scope,2,'snooze','firing');await add(scope,3,'follow_up');
  await add(scope,4,'snooze','scheduled',0);await add(scope,5,'snooze','cancelled');await add(scope,81161);
  await add(second,6,'snooze','scheduled',60000,scope);await add({...scope,org_id:'other-org'},7);await add({...scope,owner_user_id:'other-owner'},8);
  await pool.query('ANALYZE email_messages; ANALYZE email_memberships; ANALYZE email_timers;');
  const db=drizzle(pool,{schema:{emailAccounts,emailTimers,notifications,emailMessages,emailMemberships,emailCheckpoints,emailProviderStates,emailSyncReceipts}});
  const timers=new EmailTimerStore(db as never,crypto,()=>instant),mailbox=new PostgresEmailMailboxStore(db as never,crypto);
  const guards:unknown[]=[];
  const guardFor=(selected:EmailScope)=>async(tx:unknown)=>{
    guards.push(tx);const result=await (tx as typeof db).execute(sql`SELECT account_id FROM email_accounts WHERE org_id=${selected.org_id} AND owner_user_id=${selected.owner_user_id} AND account_id=${selected.account_id} AND state='active' FOR SHARE`);
    assert.equal(result.rows.length,1);
  };
  const aggregate='readUnreadCount' in mailbox;
  // The unchanged M1 implementation uses its original filter. This lets the
  // same fixture prove a red >100001 outcome against the frozen baseline.
  const snoozes=aggregate
    ? (selected:EmailScope,signal?:AbortSignal)=>(timers as any).futureInboxMessageIds(selected,guardFor(selected),signal)
    : (selected:EmailScope,ids:readonly string[],signal?:AbortSignal)=>timers.hiddenInboxMessageIds(selected,ids,guardFor(selected),signal);
  const actor={user_id:scope.owner_user_id,web_session_id:'synthetic-session',access_expires_at:instant.getTime()+60000};
  let authorityCalls=0;
  const authority={current:async(_actor:unknown,selected:EmailScope)=>{authorityCalls++;return {scope:selected,resource_binding_id:'synthetic-binding',authority_version:'synthetic-current',expires_at:actor.access_expires_at};}};
  const service=new EmailUnreadService(authority,mailbox,snoozes as never,()=>instant.getTime());
  const start=performance.now(),snapshot=await service.read(actor,scope,'INBOX'),elapsed=performance.now()-start;
  assert.equal(snapshot.unread_count,81158);assert.equal(snapshot.cached_unread_count,81158);assert.equal(authorityCalls,2);
  assert.equal(guards.length,2);assert.equal(guards[0],guards[1]);
  await pool.query('DELETE FROM email_timers WHERE account_id=$1',[second.account_id]);
  const unifiedStart=performance.now(),unified=await service.readUnified(actor,[scope,second,scope],'inbox'),unifiedMs=performance.now()-unifiedStart;
  assert.equal(unified.unread_count,81160);assert.equal(unified.accounts.length,3);
  console.log(JSON.stringify({proof:'actual PostgreSQL mailbox/timer/service',aggregate,unread_ids:81160,account_ms:Math.round(elapsed),unified_ms:Math.round(unifiedMs),live_data:false}));
  await pool.query("INSERT INTO email_messages SELECT $1,$2,$3,'mail_'||lpad(to_hex(n),64,'0'),false,false,NULL FROM generate_series(81161,100002) AS n",Object.values(scope));
  await pool.query("INSERT INTO email_memberships SELECT org_id,owner_user_id,account_id,logical_message_id,'inbox' FROM email_messages WHERE account_id=$1 AND logical_message_id>$2",[scope.account_id,logical(81160)]);
  const large=await service.read(actor,scope,'inbox');
  assert.equal(large.unread_count,99999,'exact counts must continue past the legacy 100001 projection ceiling');
  assert.equal(aggregate,true,'production store must use aggregate path');
  mailbox.readUnreadIds=async()=>{throw Error('full unread ID enumeration forbidden');};
  assert.equal((await service.read(actor,scope,'inbox')).unread_count,99999);
  assert.equal((await service.read(actor,scope,'all')).unread_count,100002);
  assert.equal((await service.read(actor,scope,'starred')).unread_count,1);
  await pool.query("INSERT INTO email_memberships VALUES($1,$2,$3,$4,'INBOX')",[...Object.values(scope),logical(1)]);
  assert.equal((await service.read(actor,scope,'inbox')).unread_count,99999,'duplicate inbox memberships must not double count');
  await pool.query('UPDATE email_messages SET seen=true WHERE logical_message_id=$1 AND account_id=$2',[logical(10),scope.account_id]);
  await pool.query('UPDATE email_messages SET deleted_at=$1 WHERE logical_message_id=$2 AND account_id=$3',[instant,logical(11),scope.account_id]);
  assert.equal((await service.read(actor,scope,'inbox')).unread_count,99997);
  await pool.query("UPDATE email_checkpoints SET coverage='partial' WHERE account_id=$1",[scope.account_id]);
  const partial=await service.read(actor,scope,'inbox');assert.equal(partial.unread_count,null);assert.equal(partial.cached_unread_count,99997);
  assert.equal((await mailbox.readUnreadCount(scope,'all',Array.from({length:70000},(_,n)=>logical(n+1)))).cached_unread_count,30002,'many snoozes must remain one PostgreSQL array bind');
  let denied=0;
  await assert.rejects((timers as any).futureInboxMessageIds(scope,async()=>{if(++denied===2)throw Error('synthetic late denial');}),/synthetic late denial/);
  let guarded=0;
  await assert.rejects((timers as any).futureInboxMessageIds(scope,async(tx:unknown)=>{
    if(++guarded===2)await (tx as typeof db).execute(sql`UPDATE email_accounts SET state='paused' WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id}`);
    const found=await (tx as typeof db).execute(sql`SELECT account_id FROM email_accounts WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id} AND state='active' FOR SHARE`);
    if(found.rows.length!==1)throw Error('SQL authority revoked');
  }),/SQL authority revoked/);
  assert.equal((await pool.query('SELECT state FROM email_accounts WHERE account_id=$1',[scope.account_id])).rows[0].state,'active','failed late SQL guard must roll back');
  await pool.query('UPDATE email_timers SET logical_message_digest=$1 WHERE account_id=$2 AND logical_message_digest=$3',['0'.repeat(64),scope.account_id,digest(scope,logical(1))]);
  await assert.rejects(service.read(actor,scope,'inbox'),/timer envelope mismatch/);
  console.log(JSON.stringify({proof:'>100001 + no identifier enumeration + partial/deletion/seen/starred/duplicate-membership/late-denial/corruption',unread_ids:100002,live_data:false}));
});
