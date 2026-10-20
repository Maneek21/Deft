import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeNativeCalendarSourceRow, nativeCalendarSourceScopeKey, nativeCalendarSourceRevisionDigest, readNativeCalendarSourceModel,
  type NativeCalendarSourceModel, type NativeCalendarSourceRow } from '../src/lib/native-calendar-source-model.js';
import { projectNativeCalendarEvents } from '../src/lib/native-calendar-recurrence.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner={org_id:id(1),user_id:id(2)}, source={installation_id:id(3),account_ref:'bookings',store_key:'bookings',ref:{resource_key:'bookings',record_id:id(4),content_digest:'sha256:'+'a'.repeat(64)}};
const hash='sha256:'+'b'.repeat(64);
function fixture():NativeCalendarSourceRow {
  const model:NativeCalendarSourceModel={schema_version:'deft.app_calendar_source.v1',source,source_scope_key:nativeCalendarSourceScopeKey(owner,source),
    source_model_digest:hash,publication_digest:hash,captured_at:'2026-10-25T12:00:00Z',applied_event_digest:hash,
    event:{schema_version:'deft.app_calendar_event.v1',event_key:'booking-1',series_key:'booking-series',source_revision:'1',status:'confirmed',
      start:{value:'20261026T090000',value_type:'date_time',time_zone:'America/New_York',instant:'2026-10-26T13:00:00Z'},
      end:{value:'20261026T100000',value_type:'date_time',time_zone:'America/New_York',instant:'2026-10-26T14:00:00Z'},
      rrule:'FREQ=WEEKLY;COUNT=3',exdates:[],recurrence_id:null,sequence:1,dtstamp:'2026-10-25T12:00:00Z'}};
  const row:NativeCalendarSourceRow={id:id(5),...owner,title:'Booking',body:'Authorized retained copy',timestamp:new Date('2026-10-26T13:00:00Z'),updated_at:new Date('2026-10-25T12:00:00Z'),
    metadata:{status:'confirmed',start:'2026-10-26T13:00:00Z',end:'2026-10-26T14:00:00Z',allDay:false,app_calendar_source:model}};
  model.applied_event_digest=nativeCalendarSourceRevisionDigest(row);return row;
}
test('source scope binds organization, owner, installation, account and store without using a title',()=>{
  const row=fixture();assert.ok(readNativeCalendarSourceModel(row));
  for(const patch of [{org_id:id(9)},{user_id:id(9)}])assert.throws(()=>readNativeCalendarSourceModel({...row,...patch}),/MODEL_INVALID/);
  const keys=[nativeCalendarSourceScopeKey(owner,source),nativeCalendarSourceScopeKey(owner,{...source,installation_id:id(9)}),nativeCalendarSourceScopeKey(owner,{...source,account_ref:'other'}),nativeCalendarSourceScopeKey(owner,{...source,store_key:'other'})];
  assert.equal(new Set(keys).size,4);
});
test('native owner edits project across DST without mutating captured recurrence or source identity',()=>{
  const row=fixture(),original=JSON.stringify(row.metadata);
  row.timestamp=new Date('2026-10-26T15:00:00Z');(row.metadata as Record<string,unknown>).end='2026-10-26T16:00:00Z';
  const values=projectNativeCalendarEvents([row],new Date('2026-10-25Z'),new Date('2026-11-10Z'),decodeNativeCalendarSourceRow);
  assert.deepEqual(values.map(v=>v.timestamp.toISOString()),['2026-10-26T15:00:00.000Z','2026-11-02T16:00:00.000Z','2026-11-09T16:00:00.000Z']);
  assert.ok(values.every(v=>v.event_id===row.id));
  assert.deepEqual((row.metadata as any).app_calendar_source,JSON.parse(original).app_calendar_source);
});
test('review revision detects local edits and ignores only its own applied digest',()=>{
  const row=fixture(),stored=readNativeCalendarSourceModel(row)!;
  assert.equal(nativeCalendarSourceRevisionDigest(row),stored.applied_event_digest);
  stored.applied_event_digest=hash;(row.metadata as any).app_calendar_source=stored;
  const unchanged=nativeCalendarSourceRevisionDigest(row);assert.notEqual(unchanged,hash);
  assert.notEqual(nativeCalendarSourceRevisionDigest({...row,title:'Owner edit'}),unchanged);
  assert.notEqual(nativeCalendarSourceRevisionDigest({...row,metadata:{...(row.metadata as any),location:'Owner location'}}),unchanged);
});
test('JSON restore preserves occurrence identity; unknown and malformed versions fail closed',()=>{
  const row=fixture(),copy={...row,metadata:JSON.parse(JSON.stringify(row.metadata))};
  const project=(value:NativeCalendarSourceRow)=>projectNativeCalendarEvents([value],new Date('2026-10-25Z'),new Date('2026-11-10Z'),decodeNativeCalendarSourceRow);
  assert.deepEqual(project(copy),project(row));
  (copy.metadata as any).app_calendar_source.schema_version='future';assert.equal(decodeNativeCalendarSourceRow(copy),null);
  (copy.metadata as any).app_calendar_source.schema_version='deft.app_calendar_source.v1';(copy.metadata as any).app_calendar_source.source_scope_key='invalid';
  assert.throws(()=>decodeNativeCalendarSourceRow(copy),/MODEL_INVALID/);
});
