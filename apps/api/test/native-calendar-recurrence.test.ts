import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AppCalendarEventSchema, AppIntegrationCalendarDestinationSchema, type AppCalendarTime } from '../../../packages/app-kit/src/app-calendar-event.js';
import { projectNativeCalendarEvents, type CalendarProjectionModel } from '../src/lib/native-calendar-recurrence.js';

const utc = (value: string): AppCalendarTime => ({ value: value.replace(/[-:]/gu,'').replace('.000Z','Z'), value_type:'date_time', time_zone:null, instant:value });
const start = utc('2026-10-05T12:00:00Z'), end = utc('2026-10-05T13:00:00Z');
const model = (patch: Partial<CalendarProjectionModel> = {}): CalendarProjectionModel => ({
  series_identity:['account','series-fixture','organizer'], uid:'series-fixture', start, end,
  rrule:'FREQ=WEEKLY;COUNT=4', exdates:[], recurrence_id:null, sequence:1, dtstamp:'2026-10-04T12:00:00Z', ...patch,
});
const row = (id: string, model: CalendarProjectionModel, status = 'confirmed') => ({
  id, title:id, timestamp:new Date(model.start.instant ?? '2026-10-05T00:00:00Z'),
  metadata:{ status, end:model.end.instant }, model,
});
const project = (rows: ReturnType<typeof row>[], from = '2026-10-01Z', to = '2026-11-05Z') => projectNativeCalendarEvents(rows,new Date(from),new Date(to),row=>row.model);

test('native projection preserves editable event IDs, legacy occurrence identity, EXDATE and deterministic replay', () => {
  const rows = [row('master',model({exdates:[utc('2026-10-12T12:00:00Z')]}))];
  const values = project(rows);
  assert.deepEqual(values.map(value=>value.timestamp.toISOString()),['2026-10-05T12:00:00.000Z','2026-10-19T12:00:00.000Z','2026-10-26T12:00:00.000Z']);
  assert.ok(values.every(value=>value.id==='master'&&value.event_id==='master'));
  const key=JSON.stringify(rows[0]!.model.series_identity);
  assert.equal(values[0]!.occurrence_id,createHash('sha256').update(JSON.stringify([key,values[0]!.timestamp.toISOString()])).digest('hex'));
  assert.deepEqual(project(rows),values);
});
test('moved exceptions, standalone exceptions, cancellation and independent source scopes are preserved', () => {
  const master=row('master',model({rrule:'FREQ=WEEKLY;COUNT=3'}));
  const moved=row('moved',model({start:utc('2026-10-13T15:00:00Z'),end:utc('2026-10-13T16:00:00Z'),rrule:null,recurrence_id:utc('2026-10-12T12:00:00Z')}));
  assert.deepEqual(project([master,moved]).map(value=>value.timestamp.toISOString()),['2026-10-05T12:00:00.000Z','2026-10-13T15:00:00.000Z','2026-10-19T12:00:00.000Z']);
  assert.equal(project([moved]).length,1);
  assert.equal(project([master,{...moved,metadata:{...moved.metadata,status:'canceled'}}]).length,2);
  assert.deepEqual(project([{...master,metadata:{...master.metadata,status:'canceled'}},moved]),[]);
  assert.equal(project([master,row('other',model({series_identity:['another-installation','series-fixture','organizer']}))]).length,7);
});
test('zoned recurrence crosses DST; all-day ends stay exclusive', () => {
  const zoned = (value:string,instant:string):AppCalendarTime=>({value,instant,value_type:'date_time',time_zone:'America/New_York'});
  const dst=model({start:zoned('20261026T090000','2026-10-26T13:00:00Z'),end:zoned('20261026T100000','2026-10-26T14:00:00Z'),rrule:'FREQ=WEEKLY;COUNT=3'});
  assert.deepEqual(project([row('dst',dst)],'2026-10-25Z','2026-11-10Z').map(value=>value.timestamp.toISOString()),['2026-10-26T13:00:00.000Z','2026-11-02T14:00:00.000Z','2026-11-09T14:00:00.000Z']);
  const date=(value:string):AppCalendarTime=>({value,value_type:'date',time_zone:null,instant:null});
  const values=project([row('all-day',model({start:date('20261005'),end:date('20261007'),rrule:'FREQ=DAILY;COUNT=2'}))]);
  assert.equal(values.length,2);assert.equal((values[0]!.metadata as any).end,'2026-10-07T00:00:00.000Z');
});
test('bounded projection refuses dense expansion, oversized rows and oversized windows', () => {
  assert.throws(()=>project([row('dense',model({rrule:'FREQ=HOURLY;COUNT=3'}))]),/UNSUPPORTED/);
  assert.throws(()=>project(Array.from({length:513},(_,i)=>row(String(i),model()))),/LIMIT/);
  assert.throws(()=>project([row('master',model())],'2026-01-01Z','2026-12-31Z'),/LIMIT/);
});
test('versioned destination accepts non-mail event models and rejects invalid dates, zones, recurrence and wider audiences', () => {
  const event={schema_version:'deft.app_calendar_event.v1',event_key:'booking-1',series_key:'booking-series',source_revision:'1',status:'confirmed',start,end,rrule:null,exdates:[],recurrence_id:null,sequence:1,dtstamp:'2026-10-04T12:00:00Z'};
  const destination={kind:'calendar',schema_version:'deft.app_calendar_destination.v1',audience:'current_user',event};
  assert.ok(AppIntegrationCalendarDestinationSchema.safeParse(destination).success);
  for(const rrule of ['FREQ=DAILY;UNTIL=20261026','FREQ=DAILY;UNTIL=20261026T235959Z'])assert.ok(AppCalendarEventSchema.safeParse({...event,rrule}).success);
  for(const patch of [{start:{...start,value:'20260230T120000Z'}},{start:{...start,time_zone:'Invalid/Zone'}},{rrule:'FREQ=SECONDLY'},{rrule:'FREQ=DAILY;UNTIL=20261026T250000Z'},{rrule:'FREQ=DAILY;UNTIL=20261026T126000Z'},{rrule:'FREQ=DAILY;UNTIL=20261026T120099Z'},{rrule:'FREQ=DAILY;BYMONTH=99'},{end:start},{exdates:Array(257).fill(start)}])assert.equal(AppCalendarEventSchema.safeParse({...event,...patch}).success,false);
  assert.equal(AppIntegrationCalendarDestinationSchema.safeParse({...destination,audience:'organization'}).success,false);
});
