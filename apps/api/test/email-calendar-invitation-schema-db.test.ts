import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
const target='postgresql://gate_g_test@127.0.0.1:55435/email_stage34_connections_85';
const safe=process.env.DATABASE_URL===target&&process.env.DEFT_TEST_DATABASE_URL===target;
/** Actual migration/DB boundary only. Minimal predecessor fixture deliberately
 * does not claim supported full-schema parity or a completed RSVP service. */
test('isolated invitation88 DDL scope, version and existing Calendar deletion boundary',{skip:!safe,timeout:15000},async t=>{
 const admin=new pg.Pool({connectionString:target}),namespace='email_invitation_'+randomUUID().replaceAll('-','');await admin.query(`CREATE SCHEMA "${namespace}"`);
 const pool=new pg.Pool({connectionString:target,options:`-c search_path=${namespace},public`,max:4});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);await admin.end();});
 await pool.query('CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,PRIMARY KEY(org_id,owner_user_id,account_id))');
 await pool.query('CREATE TABLE events(id text PRIMARY KEY,org_id text NOT NULL,user_id text NOT NULL,source text NOT NULL,event_type text NOT NULL)');
 await pool.query('CREATE TABLE email_outbox(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,outbox_id text NOT NULL,PRIMARY KEY(org_id,owner_user_id,account_id,outbox_id))');
 const ddl=readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.88-email-calendar-invitations.sql',import.meta.url),'utf8');await pool.query(ddl);await pool.query(ddl);
 await pool.query("INSERT INTO email_accounts VALUES('org','owner','a'),('org','owner','b'),('other-org','owner','a'),('org','other-owner','a')");
 const event=randomUUID(),otherOrg=randomUUID(),otherOwner=randomUUID(),providerEvent=randomUUID();await pool.query("INSERT INTO events VALUES($1,'org','owner','native','calendar_event'),($2,'other-org','owner','native','calendar_event'),($3,'org','other-owner','native','calendar_event'),($4,'org','owner','google_calendar','calendar_event')",[event,otherOrg,otherOwner,providerEvent]);
 const digest='a'.repeat(64),changed='b'.repeat(64),fingerprint='f'.repeat(64),logical='mail_'+'c'.repeat(64);
 const insert=async(id:string,account='a',eventId:string|null=event)=>pool.query("INSERT INTO email_calendar_invitations(org_id,owner_user_id,account_id,invitation_id,sequence,dtstamp,content_digest,logical_message_id,source_digest,model_envelope,event_id,event_fingerprint) VALUES('org','owner',$1,$2,2,'2026-10-04T00:00:00Z',$3,$4,$3,'{}',$5,$6)",[account,id,digest,logical,eventId,fingerprint]);
 await t.test('same semantic invitation identifier in two accounts stays independently scoped',async()=>{await insert(digest,'a');await insert(digest,'b');assert.equal((await pool.query('SELECT * FROM email_calendar_invitations WHERE invitation_id=$1',[digest])).rowCount,2);});
 await t.test('cross organization, owner and non-native event links are rejected by actual trigger',async()=>{for(const wrong of [otherOrg,otherOwner,providerEvent])await assert.rejects(insert(randomUUID().replaceAll('-','').padEnd(64,'a'),'a',wrong),/event_scope/u);});
 await t.test('stale sequence and timestamp cannot overwrite applied revision; same version content conflicts',async()=>{
  await assert.rejects(pool.query("UPDATE email_calendar_invitations SET sequence=1,dtstamp='2026-10-05' WHERE account_id='a'"),/stale/u);
  await assert.rejects(pool.query("UPDATE email_calendar_invitations SET dtstamp='2026-10-03' WHERE account_id='a'"),/stale/u);
  await assert.rejects(pool.query("UPDATE email_calendar_invitations SET content_digest=$1 WHERE account_id='a'",[changed]),/version_conflict/u);
  await pool.query("UPDATE email_calendar_invitations SET sequence=3,dtstamp='2026-10-03',content_digest=$1,revision=revision+1 WHERE account_id='a'",[changed]);
  assert.equal((await pool.query("SELECT sequence FROM email_calendar_invitations WHERE account_id='a'")).rows[0].sequence,3);
 });
 await t.test('invitation scope identity cannot switch and actions cannot reference another account receipt',async()=>{
  await assert.rejects(pool.query("UPDATE email_calendar_invitations SET account_id='b' WHERE account_id='a'"),/scope_immutable/u);
  const outbox=randomUUID();await pool.query("INSERT INTO email_outbox VALUES('org','owner','b',$1)",[outbox]);
  await assert.rejects(pool.query("INSERT INTO email_calendar_invitation_actions VALUES('org','owner','a',$1,$2,$2,1,'{}',$3,now())",[randomUUID(),digest,outbox]),/foreign key/u);
 });
 await t.test('existing Calendar deletion clears only event link and retains deletion fingerprint; scoped deliberate recreation links',async()=>{
  await pool.query('DELETE FROM events WHERE id=$1',[event]);const rows=(await pool.query('SELECT event_id,event_fingerprint FROM email_calendar_invitations')).rows;assert.ok(rows.every(row=>row.event_id===null&&row.event_fingerprint===fingerprint));
  const replacement=randomUUID();await pool.query("INSERT INTO events VALUES($1,'org','owner','native','calendar_event')",[replacement]);
  await pool.query("UPDATE email_calendar_invitations SET event_id=$1,revision=revision+1 WHERE account_id='a'",[replacement]);assert.equal((await pool.query("SELECT event_id FROM email_calendar_invitations WHERE account_id='a'")).rows[0].event_id,replacement);
 });
 await t.test('unknown account and malformed identity never become an invitation row',async()=>{await assert.rejects(insert(changed,'missing',null),/foreign key/u);await assert.rejects(insert('not-a-digest','a',null),/check constraint/u);});
});
