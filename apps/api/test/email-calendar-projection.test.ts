import test from 'node:test';
import assert from 'node:assert/strict';
import {projectEmailCalendarEvents,emailInvitationApplyLimitations} from '../src/lib/email-calendar-projection.js';
import {parseEmailCalendarInvitations,type EmailCalendarInvitation} from '../src/lib/email-calendar-invitation.js';
const parse=(extra:string,start='DTSTART:20261005T120000Z',end='DTEND:20261005T130000Z')=>{
 const result=parseEmailCalendarInvitations({source_digest:'a'.repeat(64),ics_text:`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:series-fixture\r\nDTSTAMP:20261004T120000Z\r\nSEQUENCE:1\r\n${start}\r\n${end}\r\nSUMMARY:Series\r\nORGANIZER:mailto:organizer@example.test\r\nATTENDEE:mailto:owner@example.test\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`});assert.equal(result.status,'parsed');if(result.status!=='parsed')throw Error();return result.items[0]!;
};
const row=(id:string,item:EmailCalendarInvitation,account='account',status='confirmed')=>({id,title:id,timestamp:new Date(item.start!.instant??'2026-10-05T00:00:00Z'),metadata:{status,start:item.start!.instant,end:item.end!.instant,email_invitation:{schema_version:'deft.email_calendar_event.v1',account_id:account,invitation_id:'a'.repeat(64),
 uid:item.uid,organizer:item.organizer.address,start:item.start,end:item.end,rrule:item.rrule,exdates:item.exdates,recurrence_id:item.recurrence_id,sequence:item.sequence,dtstamp:item.dtstamp}}});
test('existing Calendar rows project bounded recurrence + EXDATE with stable editable event identity',()=>{
 const item=parse('RRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE:20261012T120000Z\r\n'),rows=[row('master',item)],from=new Date('2026-10-01Z'),to=new Date('2026-11-05Z');
 const projected=projectEmailCalendarEvents(rows,from,to);assert.deepEqual(projected.map(value=>value.timestamp.toISOString()),['2026-10-05T12:00:00.000Z','2026-10-19T12:00:00.000Z','2026-10-26T12:00:00.000Z']);
 assert.ok(projected.every(value=>value.event_id==='master'&&value.id==='master'));assert.equal(new Set(projected.map(value=>value.occurrence_id)).size,3);assert.deepEqual(projectEmailCalendarEvents(rows,from,to),projected);
});
test('moved recurrence instance overrides original date, same UID another account is independent, cancellation never projects cancelled instance',()=>{
 const master=parse('RRULE:FREQ=WEEKLY;COUNT=3\r\n'),exception=parse('RECURRENCE-ID:20261012T120000Z\r\n','DTSTART:20261013T150000Z','DTEND:20261013T160000Z'),from=new Date('2026-10-01Z'),to=new Date('2026-10-25Z');
 const rows=[row('master',master),row('moved',exception)],projected=projectEmailCalendarEvents(rows,from,to);
 assert.deepEqual(projected.map(value=>[value.event_id,value.timestamp.toISOString()]),[['master','2026-10-05T12:00:00.000Z'],['moved','2026-10-13T15:00:00.000Z'],['master','2026-10-19T12:00:00.000Z']]);
 assert.equal(projectEmailCalendarEvents([...rows,row('other',master,'other')],from,to).length,6);
 assert.deepEqual(projectEmailCalendarEvents([row('master',master),row('moved',exception,'account','canceled')],from,to).map(value=>value.timestamp.toISOString()),['2026-10-05T12:00:00.000Z','2026-10-19T12:00:00.000Z']);
 assert.deepEqual(projectEmailCalendarEvents([row('master',master,'account','canceled'),row('moved',exception)],from,to),[]);
});
test('TZID recurrence follows DST while preserving civil all-day exclusive ends',()=>{
 const dst=parse('RRULE:FREQ=WEEKLY;COUNT=3\r\n','DTSTART;TZID=America/New_York:20261026T090000','DTEND;TZID=America/New_York:20261026T100000');
 assert.deepEqual(projectEmailCalendarEvents([row('dst',dst)],new Date('2026-10-25Z'),new Date('2026-11-10Z')).map(value=>value.timestamp.toISOString()),['2026-10-26T13:00:00.000Z','2026-11-02T14:00:00.000Z','2026-11-09T14:00:00.000Z']);
 const allDay=parse('RRULE:FREQ=DAILY;COUNT=2\r\n','DTSTART;VALUE=DATE:20261005','DTEND;VALUE=DATE:20261007');
 const projected=projectEmailCalendarEvents([row('all-day',allDay)],new Date('2026-10-04Z'),new Date('2026-10-10Z'));assert.equal(projected.length,2);assert.deepEqual(projected.map(value=>value.timestamp.toISOString()),['2026-10-05T00:00:00.000Z','2026-10-06T00:00:00.000Z']);assert.equal((projected[0]!.metadata as any).end,'2026-10-07T00:00:00.000Z');
});
test('unsupported density and oversized windows/rows are explicit before any recurrence expansion',()=>{
 for(const rule of ['FREQ=HOURLY;COUNT=3','FREQ=DAILY;BYHOUR=1,2'])assert.deepEqual(emailInvitationApplyLimitations(parse('RRULE:'+rule+'\r\n')),['calendar_recurrence_density_unsupported']);
 const item=parse('RRULE:FREQ=DAILY;COUNT=2\r\n');assert.throws(()=>projectEmailCalendarEvents([row('master',item)],new Date('2026-01-01Z'),new Date('2026-12-31Z')),/PROJECTION_LIMIT/);
 assert.throws(()=>projectEmailCalendarEvents(Array.from({length:513},(_,i)=>row(String(i),item)),new Date('2026-10-01Z'),new Date('2026-10-02Z')),/PROJECTION_LIMIT/);
 assert.deepEqual(emailInvitationApplyLimitations({...item,end:null}),['calendar_end_required']);
});
test('owner Calendar time edits remain the actual projection source without changing imported recurrence identity or timezone',()=>{
 const item=parse('RRULE:FREQ=WEEKLY;COUNT=2\r\n','DTSTART;TZID=America/New_York:20261026T090000','DTEND;TZID=America/New_York:20261026T100000'),edited=row('edited',item);
 edited.timestamp=new Date('2026-10-26T15:00:00Z');edited.metadata.start='2026-10-26T15:00:00Z';edited.metadata.end='2026-10-26T16:00:00Z';
 const values=projectEmailCalendarEvents([edited],new Date('2026-10-25'),new Date('2026-11-04'));
 assert.deepEqual(values.map(value=>value.timestamp.toISOString()),['2026-10-26T15:00:00.000Z','2026-11-02T16:00:00.000Z']);
 assert.ok(values.every(value=>value.event_id==='edited'));assert.equal(edited.metadata.email_invitation.start!.value,'20261026T090000');
});
