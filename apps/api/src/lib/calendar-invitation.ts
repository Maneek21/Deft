import {createHash} from 'node:crypto';
import ical, {type VEvent} from 'node-ical';
import {parseAddressList} from '../../../../packages/app-kit/src/structured-address.js';

export type CalendarTime=Readonly<{value:string;value_type:'date'|'date_time';time_zone:string|null;instant:string|null}>;
export type CalendarAttendee=Readonly<{address:string;name:string;partstat:string;role:string;kind:string;rsvp:boolean|null;delegated:boolean}>;
export type CalendarInvitation=Readonly<{
 method:'REQUEST'|'REPLY'|'CANCEL';uid:string;organizer:Readonly<{address:string;name:string}>;attendees:readonly CalendarAttendee[];
 sequence:number;dtstamp:string;recurrence_id:CalendarTime|null;start:CalendarTime|null;end:CalendarTime|null;
 rrule:string|null;exdates:readonly CalendarTime[];summary:string;description:string;location:string;
 source_digest:string;content_digest:string;limitations:readonly string[];
}>;
export type CalendarInvitationParse=Readonly<{status:'parsed';items:readonly CalendarInvitation[]}|
 {status:'unsupported'|'malformed';items:readonly [];reason:string}>;
type Property={name:string;params:Record<string,string>;value:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fail(reason:string):never{throw Error(reason);}
const clean=(value:string,max:number)=>value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const unsupported=new Set(['METHOD_UNSUPPORTED','COMPONENT_UNSUPPORTED','FLOATING_TIME_UNSUPPORTED','TIME_ZONE_UNSUPPORTED','RECURRENCE_RANGE_UNSUPPORTED','TIME_VALUE_UNSUPPORTED']);
const reasons=new Set([...unsupported,'INPUT_INVALID','INPUT_LIMIT','CONTENT_LINE_INVALID','PARAMETER_INVALID','CALENDAR_ADDRESS_INVALID','TEXT_INVALID','IDENTITY_PROPERTY_INVALID','TIME_INVALID','TIME_RANGE_INVALID','CALENDAR_INVALID','COMPONENT_LIMIT','EVENT_LIMIT','MIME_METHOD_MISMATCH','UID_INVALID','DTSTAMP_INVALID','SEQUENCE_INVALID','EVENT_INVALID','RECURRENCE_INVALID','RECURRENCE_LIMIT','ATTENDEE_INVALID','ATTENDEE_DUPLICATE','EVENT_IDENTITY_DUPLICATE']);
function property(line:string):Property{
 let colon=-1,quoted=false;
 for(let i=0;i<line.length;i++){if(line[i]==='"')quoted=!quoted;else if(line[i]===':'&&!quoted){colon=i;break;}}
 if(colon<1||quoted)fail('CONTENT_LINE_INVALID');
 const tokens:string[]=[];let token='',inQuote=false;for(const char of line.slice(0,colon)){if(char==='"')inQuote=!inQuote;if(char===';'&&!inQuote){tokens.push(token);token='';}else token+=char;}tokens.push(token);if(inQuote||!tokens.length)fail('CONTENT_LINE_INVALID');
 const name=tokens[0]!.toUpperCase();if(!/^[A-Z0-9-]+$/u.test(name))fail('CONTENT_LINE_INVALID');
 const params:Record<string,string>={};
 for(const token of tokens.slice(1)){const equal=token.indexOf('=');if(equal<1)fail('PARAMETER_INVALID');const key=token.slice(0,equal).toUpperCase();
  if(params[key]!==undefined||!/^[-A-Z0-9]+$/u.test(key))fail('PARAMETER_INVALID');const raw=token.slice(equal+1);params[key]=raw.startsWith('"')&&raw.endsWith('"')?raw.slice(1,-1):raw;
 }
 return {name,params,value:line.slice(colon+1)};
}
function mailbox(value:unknown):string{
 if(typeof value!=='string'||!/^mailto:/iu.test(value))return fail('CALENDAR_ADDRESS_INVALID');
 const address=value.slice(7);if(/[?%]/u.test(address))return fail('CALENDAR_ADDRESS_INVALID');
 try{const row=parseAddressList(address,{maxItems:1})[0]!;if(row.displayName)return fail('CALENDAR_ADDRESS_INVALID');return row.address.toLowerCase();}catch{return fail('CALENDAR_ADDRESS_INVALID');}
}
const textValue=(value:unknown,max:number):string=>{
 const raw=typeof value==='string'?value:value&&typeof value==='object'&&'val' in value?(value as {val:unknown}).val:'';
 if(typeof raw!=='string'||raw.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(raw))return fail('TEXT_INVALID');return raw;
};
const scalar=(rows:Property[],name:string,required=false)=>{const found=rows.filter(row=>row.name===name);if(found.length>1||required&&!found.length)fail('IDENTITY_PROPERTY_INVALID');return found[0];};
function dateValue(row:Property,value?:Date):CalendarTime{
 if(row.params.RANGE!==undefined)fail('RECURRENCE_RANGE_UNSUPPORTED');
 const dateOnly=row.params.VALUE==='DATE';if(row.params.VALUE!==undefined&&!['DATE','DATE-TIME'].includes(row.params.VALUE))fail('TIME_VALUE_UNSUPPORTED');
 if(!(dateOnly?/^\d{8}$/u:/^\d{8}T\d{6}Z?$/u).test(row.value))fail('TIME_INVALID');
 const y=Number(row.value.slice(0,4)),m=Number(row.value.slice(4,6)),d=Number(row.value.slice(6,8));
 const civil=new Date(Date.UTC(y,m-1,d));if(y<100||civil.getUTCFullYear()!==y||civil.getUTCMonth()!==m-1||civil.getUTCDate()!==d)fail('TIME_INVALID');
 if(dateOnly){if(row.params.TZID!==undefined)fail('TIME_INVALID');return {value:row.value,value_type:'date',time_zone:null,instant:null};}
 const h=Number(row.value.slice(9,11)),minute=Number(row.value.slice(11,13)),second=Number(row.value.slice(13,15));if(h>23||minute>59||second>59)fail('TIME_INVALID');
 const utc=row.value.endsWith('Z'),zone=row.params.TZID??null;if(utc&&zone)fail('TIME_INVALID');if(!utc&&!zone)fail('FLOATING_TIME_UNSUPPORTED');
 if(zone){try{new Intl.DateTimeFormat('en',{timeZone:zone}).format(new Date());}catch{fail('TIME_ZONE_UNSUPPORTED');}}
 const instant=utc?new Date(Date.UTC(y,m-1,d,h,minute,second)):value;
 if(!(instant instanceof Date)||!Number.isFinite(instant.getTime()))fail('TIME_INVALID');
 return {value:row.value,value_type:'date_time',time_zone:zone,instant:instant.toISOString()};
}
function calendarAddress(row:Property){return {address:mailbox(row.value),name:textValue(row.params.CN??'',120)};}

/** Pure bounded parsing only. Organizer/description are untrusted calendar data;
 * parsing neither verifies a sender nor creates an event or sends a response. */
export function parseCalendarInvitations(input:{ics_text:string;source_digest:string;media_type_method?:string}):CalendarInvitationParse{
 try{
  if(typeof input.ics_text!=='string'||Buffer.byteLength(input.ics_text,'utf8')>256*1024||!/^[a-f0-9]{64}$/u.test(input.source_digest))fail('INPUT_INVALID');
  if(/[\u0000\u000b\u000c]/u.test(input.ics_text))fail('INPUT_INVALID');
  const physical=input.ics_text.replace(/\r\n/gu,'\n').split('\n');if(physical.length>8192||physical.some(line=>line.length>16384||line.includes('\r')))fail('INPUT_LIMIT');
  const lines:string[]=[];for(const line of physical){if(/^[ \t]/u.test(line)){if(!lines.length)fail('CONTENT_LINE_INVALID');lines[lines.length-1]+=line.slice(1);}else if(line)lines.push(line);}
  if(lines[0]!=='BEGIN:VCALENDAR'||lines.at(-1)!=='END:VCALENDAR')fail('CALENDAR_INVALID');
  const root:Property[]=[],events:{lines:string[];properties:Property[]}[]=[],zones:string[]=[];const stack=['VCALENDAR'];let active:{lines:string[];properties:Property[]}|null=null,zone:string[]|null=null;
  for(const line of lines.slice(1,-1)){
   const p=property(line);
   if(p.name==='BEGIN'){
    if(p.value==='VCALENDAR')fail('CALENDAR_INVALID');
    if(stack.length===1){if(p.value==='VEVENT'){active={lines:[line],properties:[]};events.push(active);if(events.length>32)fail('EVENT_LIMIT');}else if(p.value==='VTIMEZONE')zone=[line];else fail('COMPONENT_UNSUPPORTED');}
    else{if(active&&!(stack.length===2&&p.value==='VALARM')||zone&&!(stack.length===2&&['STANDARD','DAYLIGHT'].includes(p.value)))fail('COMPONENT_UNSUPPORTED');if(active)active.lines.push(line);if(zone)zone.push(line);if(stack.length>5)fail('COMPONENT_LIMIT');}
    stack.push(p.value);continue;
   }
   if(p.name==='END'){if(stack.length<2||stack.at(-1)!==p.value)fail('CALENDAR_INVALID');if(active)active.lines.push(line);if(zone)zone.push(line);stack.pop();if(stack.length===1){if(active)active=null;if(zone){zones.push(zone.join('\r\n'));zone=null;}}continue;}
   if(stack.length===1)root.push(p);else{if(active){active.lines.push(line);if(stack.length===2)active.properties.push(p);}if(zone)zone.push(line);}
  }
  if(stack.length!==1||!events.length||zones.length>16)fail('CALENDAR_INVALID');
  if(scalar(root,'VERSION',true)!.value!=='2.0')fail('CALENDAR_INVALID');
  const method=scalar(root,'METHOD',true)!.value;if(!['REQUEST','REPLY','CANCEL'].includes(method))fail('METHOD_UNSUPPORTED');
  if(input.media_type_method!==undefined&&input.media_type_method.toUpperCase()!==method)fail('MIME_METHOD_MISMATCH');
  const items:CalendarInvitation[]=[],identities=new Set<string>();
  for(const block of events){
   const props=block.properties,rawUid=scalar(props,'UID',true)!.value;if(!clean(rawUid,1024))fail('UID_INVALID');
   const organizerRow=scalar(props,'ORGANIZER',true)!,organizer=calendarAddress(organizerRow);
   const stamp=scalar(props,'DTSTAMP',true)!;if(!/^\d{8}T\d{6}Z$/u.test(stamp.value))fail('DTSTAMP_INVALID');const dtstamp=dateValue(stamp).instant!;
   const seq=scalar(props,'SEQUENCE'),sequence=seq?Number(seq.value):0;if(seq&&!/^\d{1,10}$/u.test(seq.value)||!Number.isSafeInteger(sequence)||sequence<0||sequence>2147483647)fail('SEQUENCE_INVALID');
   const parsed=ical.sync.parseICS(['BEGIN:VCALENDAR','VERSION:2.0',`METHOD:${method}`,...zones,...block.lines,'END:VCALENDAR'].join('\r\n'));
   const event=Object.values(parsed).find((value):value is VEvent=>value?.type==='VEVENT');if(!event)fail('EVENT_INVALID');
   const uid=event.uid;if(typeof uid!=='string'||!clean(uid,1024))fail('UID_INVALID');
   const startRow=scalar(props,'DTSTART',method==='REQUEST'),endRow=scalar(props,'DTEND'),rid=scalar(props,'RECURRENCE-ID'),rrule=scalar(props,'RRULE');
   if(scalar(props,'DURATION'))fail('TIME_VALUE_UNSUPPORTED');
   // node-ical nests a RECURRENCE-ID + RRULE component in recurrences. This
   // parse contains exactly one raw VEVENT, so its sole override is unambiguous.
   const recurrenceDate=event.recurrenceid??Object.values(event.recurrences??{}).map(row=>row.recurrenceid).find((value):value is Date=>value instanceof Date);
   const start=startRow?dateValue(startRow,event.start):null,end=endRow?dateValue(endRow,event.end):null,recurrence_id=rid?dateValue(rid,recurrenceDate):null;
   if(start&&end&&(start.value_type!==end.value_type||(start.instant&&end.instant?end.instant<=start.instant:end.value<=start.value)))fail('TIME_RANGE_INVALID');
   if(recurrence_id&&start&&recurrence_id.value_type!==start.value_type)fail('RECURRENCE_INVALID');
   if(rrule&&(!clean(rrule.value,1024)||!event.rrule))fail('RECURRENCE_INVALID');
   const exdates:CalendarTime[]=[];for(const row of props.filter(p=>p.name==='EXDATE'))for(const value of row.value.split(',')){if(exdates.length>=256)fail('RECURRENCE_LIMIT');const single={...row,value};
    const raw=ical.sync.parseICS(['BEGIN:VCALENDAR','VERSION:2.0',...zones,'BEGIN:VEVENT',`UID:${uid}`,`DTSTART${row.params.TZID?`;TZID=${row.params.TZID}`:row.params.VALUE==='DATE'?';VALUE=DATE':''}:${value}`,'END:VEVENT','END:VCALENDAR'].join('\r\n'));
    const date=Object.values(raw).find(v=>v?.type==='VEVENT');exdates.push(dateValue(single,date?.type==='VEVENT'?date.start:undefined));}
   const attendeeRows=props.filter(row=>row.name==='ATTENDEE');if(method!=='CANCEL'&&!attendeeRows.length||attendeeRows.length>100||method==='REPLY'&&attendeeRows.length!==1)fail('ATTENDEE_INVALID');const seen=new Set<string>();
   const attendees=attendeeRows.map(row=>{const address=calendarAddress(row);if(seen.has(address.address))fail('ATTENDEE_DUPLICATE');seen.add(address.address);
    const rsvp=row.params.RSVP?.toUpperCase();if(rsvp!==undefined&&!['TRUE','FALSE'].includes(rsvp))fail('ATTENDEE_INVALID');
    if(['PARTSTAT','ROLE','CUTYPE'].some(key=>row.params[key]!==undefined&&!clean(row.params[key]!,64)))fail('ATTENDEE_INVALID');
    return {...address,partstat:row.params.PARTSTAT?.toUpperCase()??'NEEDS-ACTION',role:row.params.ROLE?.toUpperCase()??'REQ-PARTICIPANT',kind:row.params.CUTYPE?.toUpperCase()??'INDIVIDUAL',rsvp:rsvp===undefined?null:rsvp==='TRUE',delegated:row.params['DELEGATED-TO']!==undefined||row.params['DELEGATED-FROM']!==undefined||row.params['SENT-BY']!==undefined};
   });
   const key=JSON.stringify([uid,organizer.address,recurrence_id]);if(identities.has(key))fail('EVENT_IDENTITY_DUPLICATE');identities.add(key);
   const limitations:string[]=[];if(organizerRow.params['SENT-BY'])limitations.push('organizer_delegation');if(attendees.some(a=>a.delegated||a.kind!=='INDIVIDUAL'||!['NEEDS-ACTION','ACCEPTED','DECLINED','TENTATIVE'].includes(a.partstat)||!['REQ-PARTICIPANT','OPT-PARTICIPANT','NON-PARTICIPANT','CHAIR'].includes(a.role)))limitations.push('attendee_delegation_or_group');
   const data={method:method as CalendarInvitation['method'],uid,organizer,attendees,sequence,dtstamp,recurrence_id,start,end,rrule:rrule?.value??null,exdates,
    summary:textValue(event.summary,500),description:textValue(event.description,5000),location:textValue(event.location,500)};
   items.push({...data,source_digest:input.source_digest,content_digest:hash(JSON.stringify(data)),limitations});
  }
  return {status:'parsed',items};
 }catch(error){const message=error instanceof Error?error.message:'CALENDAR_INVALID',reason=reasons.has(message)?message:'CALENDAR_INVALID';return {status:unsupported.has(reason)?'unsupported':'malformed',items:[],reason};}
}

/** Exact server-verified identity selection; never infer an attendee from a
 * display name, forwarding recipient, domain, group, or organizer. */
export function selectInvitationAttendee(invitation:CalendarInvitation,verifiedAddresses:readonly string[]):CalendarAttendee|null{
 if(invitation.method!=='REQUEST'||invitation.limitations.length)return null;
 const own=new Set(verifiedAddresses.map(address=>{try{return mailbox(`mailto:${address}`);}catch{return '';}}));
 const matches=invitation.attendees.filter(row=>own.has(row.address)&&!row.delegated&&row.kind==='INDIVIDUAL');return matches.length===1?matches[0]!:null;
}
export function compareInvitationVersion(current:CalendarInvitation,incoming:CalendarInvitation):'newer'|'older'|'same'|'conflict'{
 if(calendarInvitationIdentity(current)!==calendarInvitationIdentity(incoming))return 'conflict';
 if(incoming.sequence!==current.sequence)return incoming.sequence>current.sequence?'newer':'older';
 if(incoming.dtstamp!==current.dtstamp)return incoming.dtstamp>current.dtstamp?'newer':'older';return incoming.content_digest===current.content_digest?'same':'conflict';
}
/** Identity is semantic: a zoned recurrence and its equivalent UTC instant
 * identify the same instance; a civil DATE remains distinct from DATE-TIME. */
export function calendarInvitationIdentity(invitation:Pick<CalendarInvitation,'uid'|'organizer'|'recurrence_id'>):string{
 const recurrence=invitation.recurrence_id;return JSON.stringify([invitation.uid,invitation.organizer.address,recurrence?recurrence.value_type==='date'?['date',recurrence.value]:['date_time',recurrence.instant]:null]);
}
const escapeText=(value:string)=>value.replace(/\\/gu,'\\\\').replace(/\n/gu,'\\n').replace(/;/gu,'\\;').replace(/,/gu,'\\,');
const folded=(line:string)=>{const lines:string[]=[];let part='',size=0;for(const char of line){const bytes=Buffer.byteLength(char);if(size+bytes>75){lines.push(part);part=' ';size=1;}part+=char;size+=bytes;}lines.push(part);return lines.join('\r\n');};
/** Calendar body only. Reply MIME composition MUST set text/calendar;method=REPLY,
 * and reserve the exact immutable bytes through ordinary durable Send/Outbox. */
export function serializeInvitationReply(invitation:CalendarInvitation,verifiedAddresses:readonly string[],choice:'accepted'|'tentative'|'declined',now:Date):string{
 const attendee=selectInvitationAttendee(invitation,verifiedAddresses);if(!attendee||!['accepted','tentative','declined'].includes(choice)||!Number.isFinite(now.getTime()))fail('REPLY_DENIED');
 const utc=(instant:string)=>instant.replace(/[-:]/gu,'').replace(/\.\d{3}Z$/u,'Z');
 const stamp=utc(now.toISOString()),timeLine=(name:string,value:CalendarTime)=>value.value_type==='date'?`${name};VALUE=DATE:${value.value}`:`${name}:${utc(value.instant!)}`;
 // UTC DATE-TIME values preserve the exact instance while avoiding a copied
 // or missing VTIMEZONE definition. Civil DATE values retain their value type.
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Deft//Email Calendar Bridge//EN','METHOD:REPLY','BEGIN:VEVENT',`UID:${escapeText(invitation.uid)}`,`DTSTAMP:${stamp}`,`SEQUENCE:${invitation.sequence}`,
  `ORGANIZER:mailto:${invitation.organizer.address}`,`ATTENDEE;PARTSTAT=${choice.toUpperCase()}:mailto:${attendee.address}`,
  ...(invitation.recurrence_id?[timeLine('RECURRENCE-ID',invitation.recurrence_id)]:[]),...(invitation.start?[timeLine('DTSTART',invitation.start)]:[]),...(invitation.end?[timeLine('DTEND',invitation.end)]:[]),'END:VEVENT','END:VCALENDAR'];
 return lines.map(line=>line.split('\r\n').map(folded).join('\r\n')).join('\r\n')+'\r\n';
}
