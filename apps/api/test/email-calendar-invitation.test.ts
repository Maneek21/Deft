import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEmailCalendarInvitations,selectEmailInvitationAttendee,compareEmailInvitationVersion,serializeEmailInvitationReply,emailCalendarInvitationIdentity,type EmailCalendarInvitation} from '../src/lib/email-calendar-invitation.js';
const digest='a'.repeat(64);
const event=(extra:string[]=[])=>['BEGIN:VEVENT','UID:meeting@example.test','DTSTAMP:20261004T000000Z','SEQUENCE:2','DTSTART:20261101T140000Z','DTEND:20261101T150000Z','ORGANIZER;CN=Meeting Host:mailto:host@example.test','ATTENDEE;CN=Guest;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:guest@example.test','SUMMARY:Fixture','DESCRIPTION:Untrusted description',...extra,'END:VEVENT'];
const calendar=(rows=event(),method='REQUEST')=>['BEGIN:VCALENDAR','VERSION:2.0',`METHOD:${method}`,...rows,'END:VCALENDAR'].join('\r\n')+'\r\n';
const parse=(text:string)=>parseEmailCalendarInvitations({ics_text:text,source_digest:digest,media_type_method:'REQUEST'});
function one(text=calendar()):EmailCalendarInvitation{const result=parse(text);if(result.status!=='parsed')throw Error(result.reason);assert.equal(result.items.length,1);return result.items[0]!;}
test('retains actual organizer address, attendees, source binding and revision without effects',()=>{
 const result=one();assert.equal(result.organizer.address,'host@example.test');assert.equal(result.organizer.name,'Meeting Host');assert.equal(result.sequence,2);assert.equal(result.dtstamp,'2026-10-04T00:00:00.000Z');assert.equal(result.start?.instant,'2026-11-01T14:00:00.000Z');assert.equal(result.source_digest,digest);
 assert.equal(selectEmailInvitationAttendee(result,['GUEST@example.test'])?.address,'guest@example.test');assert.equal(selectEmailInvitationAttendee(result,['someone@example.test']),null);
});
test('UID organizer and recurrence form exact identity; source account cannot nominate a different attendee',()=>{
 const current=one();assert.equal(compareEmailInvitationVersion(current,one(calendar(event().map(line=>line.replace('meeting@example.test','other@example.test'))))),'conflict');
 assert.equal(compareEmailInvitationVersion(current,one(calendar(event().map(line=>line.replace('host@example.test','another@example.test'))))),'conflict');
 const aliases=one(calendar(event(['ATTENDEE:mailto:alias@example.test'])));assert.equal(selectEmailInvitationAttendee(aliases,['guest@example.test','alias@example.test']),null);
});
test('revision ordering rejects stale sequence even with later DTSTAMP, detects same-version content conflict',()=>{
 const current=one(),older=one(calendar(event().map(line=>line.replace('SEQUENCE:2','SEQUENCE:1').replace('20261004T000000Z','20261005T000000Z'))));assert.equal(compareEmailInvitationVersion(current,older),'older');
 assert.equal(compareEmailInvitationVersion(current,one(calendar(event().map(line=>line.replace('SEQUENCE:2','SEQUENCE:3'))))),'newer');assert.equal(compareEmailInvitationVersion(current,one()),'same');
 assert.equal(compareEmailInvitationVersion(current,one(calendar(event().map(line=>line.replace('SUMMARY:Fixture','SUMMARY:Changed'))))),'conflict');
 assert.equal(compareEmailInvitationVersion(current,one(calendar(event().map(line=>line.replace('20261004T000000Z','20261004T010000Z'))))),'newer');
});
test('DATE values remain civil dates and exclusive end, midnight UTC is not guessed all-day',()=>{
 const allDay=one(calendar(event().map(line=>line.startsWith('DTSTART:')?'DTSTART;VALUE=DATE:20261101':line.startsWith('DTEND:')?'DTEND;VALUE=DATE:20261102':line)));
 assert.deepEqual(allDay.start,{value:'20261101',value_type:'date',time_zone:null,instant:null});assert.equal(allDay.end?.value,'20261102');assert.equal(one(calendar(event().map(line=>line.replace('140000Z','000000Z')))).start?.value_type,'date_time');
});
test('TZID conversion preserves DST and recurrence identity independently of moved DTSTART',()=>{
 const rows=event(['RECURRENCE-ID;TZID=America/New_York:20261101T090000','RRULE:FREQ=WEEKLY;COUNT=3','EXDATE;TZID=America/New_York:20261108T090000']).map(line=>line.startsWith('DTSTART:')?'DTSTART;TZID=America/New_York:20261102T090000':line.startsWith('DTEND:')?'DTEND;TZID=America/New_York:20261102T100000':line);
 const result=one(calendar(rows));assert.equal(result.start?.instant,'2026-11-02T14:00:00.000Z');assert.equal(result.recurrence_id?.value,'20261101T090000');assert.equal(result.recurrence_id?.time_zone,'America/New_York');assert.equal(result.exdates[0]?.instant,'2026-11-08T14:00:00.000Z');assert.equal(result.rrule,'FREQ=WEEKLY;COUNT=3');
});
test('floating times, unknown zones and THISANDFUTURE are explicit unsupported states',()=>{
 for(const [from,to,reason] of [['DTSTART:20261101T140000Z','DTSTART:20261101T140000','FLOATING_TIME_UNSUPPORTED'],['DTSTART:20261101T140000Z','DTSTART;TZID=Unknown/Zone:20261101T140000','TIME_ZONE_UNSUPPORTED']] as const){assert.deepEqual(parse(calendar(event().map(line=>line.replace(from,to)))),{status:'unsupported',items:[],reason});}
 assert.equal(parse(calendar(event(['RECURRENCE-ID;RANGE=THISANDFUTURE:20261101T140000Z']))).status,'unsupported');
});
test('rejects invalid dates, inverted range, sequence and duplicate identity properties',()=>{
 const broken=[event().map(line=>line.replace('20261101T140000Z','20260230T140000Z')),event().map(line=>line.replace('20261101T150000Z','20261101T130000Z')),event().map(line=>line.replace('SEQUENCE:2','SEQUENCE:-1')),event(['UID:shadow@example.test']),event(['ORGANIZER:mailto:shadow@example.test'])];
 for(const rows of broken)assert.equal(parse(calendar(rows)).status,'malformed');
});
test('malformed attendee/group/delegation never becomes guessed response recipient',()=>{
 assert.equal(parse(calendar(event(['ATTENDEE:mailto:guest@example.test']))).status,'malformed');assert.equal(parse(calendar(event().map(line=>line.replace('mailto:guest@example.test','mailto:guest@example.test?subject=foo')))).status,'malformed');
 for(const rows of [event().map(line=>line.replace('ATTENDEE;','ATTENDEE;CUTYPE=GROUP;')),event().map(line=>line.replace('ATTENDEE;','ATTENDEE;DELEGATED-TO="mailto:other@example.test";')),event().map(line=>line.replace('ORGANIZER;','ORGANIZER;SENT-BY="mailto:assistant@example.test";'))])assert.equal(selectEmailInvitationAttendee(one(calendar(rows)),['guest@example.test']),null);
});
test('preserves separate recurring master and exception without parser UID coalescing',()=>{
 const result=parse(calendar([...event(['RRULE:FREQ=WEEKLY;COUNT=3']),...event(['RECURRENCE-ID:20261108T140000Z']).map(line=>line.replace('SUMMARY:Fixture','SUMMARY:Exception'))]));assert.equal(result.status,'parsed');if(result.status==='parsed'){assert.equal(result.items.length,2);assert.equal(result.items[1]?.summary,'Exception');assert.equal(result.items[1]?.recurrence_id?.value,'20261108T140000Z');}
 assert.equal(parse(calendar([...event(),...event()])).status,'malformed');
});
test('CANCEL may omit time and attendee; REPLY retains its own status without actionable REQUEST rights',()=>{
 const cancelled=parseEmailCalendarInvitations({ics_text:calendar(['BEGIN:VEVENT','UID:meeting@example.test','DTSTAMP:20261004T000000Z','SEQUENCE:3','ORGANIZER:mailto:host@example.test','END:VEVENT'],'CANCEL'),source_digest:digest});assert.equal(cancelled.status,'parsed');if(cancelled.status==='parsed'){assert.equal(cancelled.items[0]?.start,null);assert.equal(selectEmailInvitationAttendee(cancelled.items[0]!,['guest@example.test']),null);}
 const reply=parseEmailCalendarInvitations({ics_text:calendar(event().map(line=>line.replace('PARTSTAT=NEEDS-ACTION','PARTSTAT=ACCEPTED')),'REPLY'),source_digest:digest});assert.equal(reply.status,'parsed');if(reply.status==='parsed')assert.equal(reply.items[0]?.attendees[0]?.partstat,'ACCEPTED');
});
test('MIME METHOD mismatch, unsupported components and limits fail closed with no partial items',()=>{
 assert.equal(parseEmailCalendarInvitations({ics_text:calendar(),source_digest:digest,media_type_method:'CANCEL'}).status,'malformed');assert.equal(parse(calendar(event(),'PUBLISH')).status,'unsupported');
 assert.equal(parse(calendar(['BEGIN:VTODO','UID:todo','END:VTODO'])).status,'unsupported');assert.equal(parse(calendar([...event(),...'x'.repeat(300000)])).status,'malformed');assert.equal(parse(calendar(Array.from({length:33},(_,i)=>event().map(line=>line.replace('meeting@example.test',`${i}@example.test`))).flat())).status,'malformed');
});
test('pure REPLY preserves original organizer/UID/sequence/instance and exact selected account identity',()=>{
 const invitation=one(calendar(event(['RECURRENCE-ID:20261101T140000Z']))),text=serializeEmailInvitationReply(invitation,['guest@example.test'],'tentative',new Date('2026-10-04T02:00:00Z'));
 assert.match(text,/METHOD:REPLY\r\n/u);assert.match(text,/ATTENDEE;PARTSTAT=TENTATIVE:mailto:guest@example.test/u);assert.match(text,/ORGANIZER:mailto:host@example.test/u);assert.match(text,/SEQUENCE:2/u);assert.match(text,/RECURRENCE-ID:20261101T140000Z/u);assert.match(text,/DTSTAMP:20261004T020000Z/u);
 const result=parseEmailCalendarInvitations({ics_text:text,source_digest:digest,media_type_method:'REPLY'});assert.equal(result.status,'parsed');assert.throws(()=>serializeEmailInvitationReply(invitation,['forwarded@example.test'],'accepted',new Date()),/REPLY_DENIED/u);
});
test('UTF8 reply folding respects 75 octets and round-trips escaped UID',()=>{
 const uid='é'.repeat(65)+'\\,suffix',invitation=one(calendar(event().map(line=>line.replace('meeting@example.test',uid)))),text=serializeEmailInvitationReply(invitation,['guest@example.test'],'accepted',new Date('2026-10-04T02:00:00Z'));
 for(const line of text.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);const result=parseEmailCalendarInvitations({ics_text:text,source_digest:digest});assert.equal(result.status,'parsed');if(result.status==='parsed')assert.equal(result.items[0]?.uid,invitation.uid);
});
test('UTC RSVP preserves exact zoned recurrence instant without inventing VTIMEZONE',()=>{
 const invitation=one(calendar(event(['RECURRENCE-ID;TZID=America/New_York:20261101T090000']))),text=serializeEmailInvitationReply(invitation,['guest@example.test'],'accepted',new Date('2026-10-04T02:00:00Z'));
 assert.match(text,/RECURRENCE-ID:20261101T140000Z/u);assert.ok(!text.includes('TZID='));const result=parseEmailCalendarInvitations({ics_text:text,source_digest:digest});assert.equal(result.status,'parsed');if(result.status==='parsed')assert.equal(emailCalendarInvitationIdentity(result.items[0]!),emailCalendarInvitationIdentity(invitation));
});
test('all-day RSVP retains DATE recurrence and start/end exclusive dates',()=>{
 const invitation=one(calendar(event(['RECURRENCE-ID;VALUE=DATE:20261101']).map(line=>line.startsWith('DTSTART:')?'DTSTART;VALUE=DATE:20261101':line.startsWith('DTEND:')?'DTEND;VALUE=DATE:20261102':line))),text=serializeEmailInvitationReply(invitation,['guest@example.test'],'declined',new Date('2026-10-04T02:00:00Z'));
 assert.match(text,/RECURRENCE-ID;VALUE=DATE:20261101/u);assert.match(text,/DTEND;VALUE=DATE:20261102/u);assert.match(text,/PARTSTAT=DECLINED/u);
});
test('quoted parameter delimiter and folded Unicode names remain display-only',()=>{
 const invitation=one(calendar(event().map(line=>line.startsWith('ORGANIZER;')?'ORGANIZER;CN="Host; Event":mailto:host@example.test':line.startsWith('SUMMARY:')?'SUMMARY:Rencontre é\r\n quipes':line)));
 assert.equal(invitation.organizer.name,'Host; Event');assert.equal(invitation.organizer.address,'host@example.test');assert.equal(invitation.summary,'Rencontre équipes');
});
test('calendar payload never guesses required identity or silently returns a partial valid event',()=>{
 for(const name of ['UID:','DTSTAMP:','ORGANIZER:'])assert.equal(parse(calendar(event().filter(line=>!line.startsWith(name)&&!(name==='ORGANIZER:'&&line.startsWith('ORGANIZER;'))))).status,'malformed');
 const mixed=calendar([...event(),...event().map(line=>line.startsWith('UID:')?'UID:second@example.test':line.startsWith('SEQUENCE:')?'SEQUENCE:bogus':line)]);assert.equal(parse(mixed).items.length,0);
});
test('duplicate received source digest does not invent a newer event content version',()=>{
 const first=one(),result=parseEmailCalendarInvitations({ics_text:calendar(),source_digest:'b'.repeat(64)});assert.equal(result.status,'parsed');if(result.status==='parsed'){assert.notEqual(first.source_digest,result.items[0]?.source_digest);assert.equal(compareEmailInvitationVersion(first,result.items[0]!),'same');}
});
