import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AppCalendarEventSchema, type AppCalendarTime } from '../../../packages/app-kit/src/app-calendar-event.js';
import { NativeCalendarSourceModelSchema, nativeCalendarSourceScopeKey } from '../src/lib/native-calendar-source-model.js';
import { readAppSourceCalendarOccurrences, ordinaryCalendarEventCondition } from '../src/lib/native-calendar-source.js';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=uuid(1),owner=uuid(2),foreign=uuid(3),digest='sha256:'+'a'.repeat(64);
const source={installation_id:uuid(4),account_ref:'booking-account',store_key:'bookings',
 ref:{resource_key:'booking',record_id:uuid(5),content_digest:digest}};
const zoned=(value:string,instant:string):AppCalendarTime=>({value,instant,value_type:'date_time',time_zone:'America/New_York'});
const date=(value:string):AppCalendarTime=>({value,value_type:'date',time_zone:null,instant:null});
const event=AppCalendarEventSchema.parse({schema_version:'deft.app_calendar_event.v1',event_key:'master',series_key:'booking-series',
 source_revision:'1',status:'confirmed',start:zoned('20261026T090000','2026-10-26T13:00:00Z'),
 end:zoned('20261026T100000','2026-10-26T14:00:00Z'),rrule:'FREQ=WEEKLY;COUNT=4',
 exdates:[zoned('20261102T090000','2026-11-02T14:00:00Z')],recurrence_id:null,sequence:1,dtstamp:'2026-10-25T12:00:00Z'});
const instant=(time:AppCalendarTime)=>time.instant??`${time.value.slice(0,4)}-${time.value.slice(4,6)}-${time.value.slice(6,8)}T00:00:00Z`;
const url=process.env.DEFT_TEST_DATABASE_URL;
const safe=!!url&&url===process.env.DATABASE_URL&&/^postgres(?:ql)?:\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost):\d+\/[^?]*test(?:\?.*)?$/u.test(url);

test('native Calendar dual reader preserves recurrence, authority, identity and ordinary rows in PostgreSQL',{skip:!safe},async()=>{
 const client=new pg.Client({connectionString:url});await client.connect();
 try{
  await client.query(`BEGIN;
   CREATE TEMP TABLE events(id text,org_id text,user_id text,source text,event_type text,title text,body text,url text,
    timestamp timestamp,metadata jsonb);
   CREATE TEMP TABLE org_members(org_id text,user_id text,is_active boolean);
  `);
  await client.query('INSERT INTO org_members VALUES ($1,$2,true),($1,$3,true),($3,$2,true)',[org,owner,foreign]);
  const insert=async(id:string,patch:Record<string,unknown>={},rowOrg=org,rowOwner=owner,identity=source)=>{
   const normalized=AppCalendarEventSchema.parse({...event,...patch});
   const model=NativeCalendarSourceModelSchema.parse({schema_version:'deft.app_calendar_source.v1',source:identity,
    source_scope_key:nativeCalendarSourceScopeKey({org_id:rowOrg,user_id:rowOwner},identity),event:normalized,
    source_model_digest:digest,publication_digest:digest,captured_at:'2026-10-25T12:00:00Z',applied_event_digest:digest});
   await client.query("INSERT INTO events VALUES ($1,$2,$3,'native','calendar_event',$1,'Retained booking details',null,$4,$5)",
    [id,rowOrg,rowOwner,instant(normalized.start),JSON.stringify({status:normalized.status,end:instant(normalized.end),app_calendar_source:model})]);
  };
  await insert('master');
  await insert('moved',{event_key:'moved',rrule:null,exdates:[],recurrence_id:zoned('20261109T090000','2026-11-09T14:00:00Z'),
   start:zoned('20261110T110000','2026-11-10T16:00:00Z'),end:zoned('20261110T120000','2026-11-10T17:00:00Z')});
  await insert('canceled',{event_key:'canceled',status:'canceled',rrule:null,exdates:[],recurrence_id:zoned('20261116T090000','2026-11-16T14:00:00Z'),
   start:zoned('20261116T090000','2026-11-16T14:00:00Z'),end:zoned('20261116T100000','2026-11-16T15:00:00Z')});
  await insert('all-day',{event_key:'all-day',series_key:'all-day-series',start:date('20261101'),end:date('20261103'),rrule:'FREQ=DAILY;COUNT=2',exdates:[]});
  await insert('foreign-org',{},foreign);
  await insert('foreign-owner',{},org,foreign);
  const database=drizzle(client),input={org_id:org,owner_user_id:owner,from:new Date('2026-10-25Z'),to:new Date('2026-11-25Z')};
  const values=await readAppSourceCalendarOccurrences(database,input);
  assert.deepEqual(values.map(value=>[value.event_id,value.timestamp.toISOString()]),[
   ['master','2026-10-26T13:00:00.000Z'],['all-day','2026-11-01T00:00:00.000Z'],
   ['all-day','2026-11-02T00:00:00.000Z'],['moved','2026-11-10T16:00:00.000Z']]);
  assert.equal((values[1]!.metadata as Record<string,unknown>).end,'2026-11-03T00:00:00.000Z');
  assert.ok(values.every(value=>value.id===value.event_id));
  assert.deepEqual(await readAppSourceCalendarOccurrences(database,input),values,'replay preserves event and occurrence IDs');
  assert.equal((await readAppSourceCalendarOccurrences(database,{...input,from:new Date('2026-11-01Z')})).length,3,'the old master is still loaded before the window');
  await client.query('UPDATE org_members SET is_active=false WHERE org_id=$1 AND user_id=$2',[org,owner]);
  assert.deepEqual(await readAppSourceCalendarOccurrences(database,input),[],'retained copies require current membership');
  await client.query('UPDATE org_members SET is_active=true WHERE org_id=$1 AND user_id=$2',[org,owner]);
  // No app installation/runtime tables exist in this connection. Retained reads
  // and current native edits remain available without the source application.
  await insert('edited',{event_key:'edited',series_key:'edited-series',rrule:'FREQ=WEEKLY;COUNT=2',exdates:[]});
  await client.query("UPDATE events SET timestamp='2026-10-26 15:00:00',metadata=jsonb_set(metadata,'{end}','\"2026-10-26T16:00:00Z\"') WHERE id='edited'");
  const edited=(await readAppSourceCalendarOccurrences(database,input)).filter(row=>row.id==='edited');
  assert.deepEqual(edited.map(row=>row.timestamp.toISOString()),['2026-10-26T15:00:00.000Z','2026-11-02T16:00:00.000Z']);
  await client.query("INSERT INTO events VALUES ('ordinary-null',$1,$2,'native','calendar_event','Ordinary',null,null,'2026-11-01',null),('ordinary-empty',$1,$2,'native','calendar_event','Ordinary',null,null,'2026-11-01','{}'),('unknown',$1,$2,'native','calendar_event','Unknown',null,null,'2026-11-01','{\"app_calendar_source\":{\"schema_version\":\"future\"}}')",[org,owner]);
  const ordinary=new PgDialect().sqlToQuery(ordinaryCalendarEventCondition());
  assert.deepEqual((await client.query('SELECT id FROM events WHERE '+ordinary.sql+' ORDER BY id',ordinary.params)).rows.map(row=>row.id),['ordinary-empty','ordinary-null']);
  assert.ok(!(await readAppSourceCalendarOccurrences(database,input)).some(row=>row.id==='unknown'));
  await client.query("UPDATE events SET metadata=jsonb_set(metadata,'{app_calendar_source,source_scope_key}',$1::jsonb) WHERE id='edited'",[JSON.stringify('sha256:'+'b'.repeat(64))]);
  await assert.rejects(readAppSourceCalendarOccurrences(database,input),/MODEL_INVALID/u,'a wrong owner/source scope fails closed');
 }finally{await client.query('ROLLBACK');await client.end();}
});
