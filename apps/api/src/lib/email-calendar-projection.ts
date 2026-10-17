import {createHash} from 'node:crypto';
import {and,eq,lte,sql} from 'drizzle-orm';
import {events} from '@deft/db/schema';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import ical,{type VEvent} from 'node-ical';
import {z} from 'zod';
import type {EmailCalendarInvitation,EmailCalendarTime} from './email-calendar-invitation.js';
const DAY=86400000,MAX_ROWS=512,MAX_OCCURRENCES=2048;
/** The stored model is preserved even when projection is unsupported. This
 * ordinary Calendar projection supports bounded daily-or-slower recurrence;
 * dense sub-daily/BYHOUR expansions must never allocate an unbounded array. */
export function emailInvitationApplyLimitations(item:Pick<EmailCalendarInvitation,'method'|'start'|'end'|'rrule'>):readonly string[]{
 if(item.method!=='REQUEST')return [];
 if(!item.start||!item.end)return ['calendar_end_required'];
 const start=item.start.instant?Date.parse(item.start.instant):Date.parse(dateISO(item.start.value)),end=item.end.instant?Date.parse(item.end.instant):Date.parse(dateISO(item.end.value));
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>366*DAY)return ['calendar_duration_unsupported'];
 if(item.rrule){const fields=new Map(item.rrule.toUpperCase().split(';').map(part=>{const at=part.indexOf('=');return [part.slice(0,at),part.slice(at+1)];}));
  if(!['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(fields.get('FREQ')??'')||['BYSECOND','BYMINUTE','BYHOUR'].some(key=>fields.has(key)))return ['calendar_recurrence_density_unsupported'];
  if(Number(item.start.value.slice(0,4))<1900)return ['calendar_recurrence_origin_unsupported'];
 }
 return [];
}
const dateISO=(value:string)=>`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T00:00:00Z`;
const escaped=(value:string)=>value.replace(/\\/gu,'\\\\').replace(/\n/gu,'\\n').replace(/;/gu,'\\;').replace(/,/gu,'\\,');
const dateLine=(name:string,time:EmailCalendarTime)=>time.value_type==='date'?`${name};VALUE=DATE:${time.value}`:
 time.time_zone?`${name};TZID=${time.time_zone}:${time.value}`:`${name}:${time.value}`;
type Row=Readonly<{id:string;title:string|null;body?:string|null;url?:string|null;timestamp:Date;metadata:unknown;source?:string;event_type?:string}>;
const TimeSchema=z.strictObject({value:z.string().regex(/^(?:[0-9]{8}|[0-9]{8}T[0-9]{6}Z?)$/u),value_type:z.enum(['date','date_time']),time_zone:z.string().regex(/^[A-Za-z0-9_+./-]{1,128}$/u).nullable(),instant:z.iso.datetime().nullable()});
const ModelSchema=z.strictObject({schema_version:z.literal('deft.email_calendar_event.v1'),account_id:z.string().min(1).max(256),invitation_id:z.string().regex(/^[a-f0-9]{64}$/u),
 uid:z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u),organizer:z.string().email().max(320),start:TimeSchema,end:TimeSchema,rrule:z.string().regex(/^[A-Z0-9=;,+-]{1,1024}$/iu).nullable(),
 exdates:z.array(TimeSchema).max(256),recurrence_id:TimeSchema.nullable(),sequence:z.number().int().nonnegative(),dtstamp:z.iso.datetime()});
type Model=z.infer<typeof ModelSchema>;
const currentTime=(original:EmailCalendarTime,instant:string):EmailCalendarTime=>{
 const parsed=new Date(instant);if(!Number.isFinite(parsed.getTime()))throw Error('EMAIL_CALENDAR_MODEL_INVALID');
 if(original.value_type==='date')return {value:parsed.toISOString().slice(0,10).replaceAll('-',''),value_type:'date',time_zone:null,instant:null};
 if(!original.time_zone)return {value:parsed.toISOString().replace(/[-:]/gu,'').replace(/\.\d{3}Z$/u,'Z'),value_type:'date_time',time_zone:null,instant:parsed.toISOString()};
 const parts=new Map(new Intl.DateTimeFormat('en-US',{timeZone:original.time_zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(parsed).map(part=>[part.type,part.value]));
 return {...original,value:`${parts.get('year')}${parts.get('month')}${parts.get('day')}T${parts.get('hour')}${parts.get('minute')}${parts.get('second')}`,instant:parsed.toISOString()};
};
const getModel=(row:Row):Model|null=>{
 const metadata=row.metadata as Record<string,unknown>|null,value=metadata?.email_invitation as Model|undefined;
 if(!value||value.schema_version!=='deft.email_calendar_event.v1')return null;
 const model=ModelSchema.parse(value);
 // Existing Calendar remains the editable time source. Keep the imported
 // timezone/recurrence identity while projecting owner edits to start/end.
 const start=row.timestamp.toISOString(),end=typeof metadata?.end==='string'?metadata.end:null;
 const originalStart=model.start.instant??dateISO(model.start.value),originalEnd=model.end.instant??dateISO(model.end.value);
 if(Date.parse(start)!==Date.parse(originalStart))model.start=currentTime(model.start,start);
 if(end&&Date.parse(end)!==Date.parse(originalEnd))model.end=currentTime(model.end,end);
 return model;
};
const civil=(date:Date)=>`${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
const modelInstanceKey=(model:Model)=>model.recurrence_id?model.recurrence_id.value_type==='date'?'date:'+model.recurrence_id.value:'instant:'+model.recurrence_id.instant:null;
/** Projects existing owner event rows, retaining the original editable event
 * id and a distinct occurrence_id. Exceptions never group by subject. */
export function projectEmailCalendarEvents<T extends Row>(rows:readonly T[],from:Date,to:Date):Array<T&{occurrence_id:string;event_id:string}>{
 // Existing Calendar accepts a 45-day civil range and includes both endpoint
 // days; timezone day boundaries can add one day plus a DST hour.
 if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||to<from||to.getTime()-from.getTime()>46*DAY+3600000||rows.length>MAX_ROWS)throw Error('EMAIL_CALENDAR_PROJECTION_LIMIT');
 const groups=new Map<string,Array<{row:T;model:Model}>>(),output:Array<T&{occurrence_id:string;event_id:string}>=[];
 for(const row of rows){const model=getModel(row);if(!model)continue;const key=JSON.stringify([model.account_id,model.uid,model.organizer]);const group=groups.get(key)??[];group.push({row,model});groups.set(key,group);}
 for(const [key,group]of groups){
  const masters=group.filter(value=>!value.model.recurrence_id);if(masters.length>1)throw Error('EMAIL_CALENDAR_MODEL_INVALID');const master=masters[0];
  if(master&&(master.row.metadata as Record<string,unknown>).status==='canceled')continue;
  const source=master??group[0]!,active=master?group:[source],lines=['BEGIN:VCALENDAR','VERSION:2.0'];
  for(const {model,row}of active){if(emailInvitationApplyLimitations({method:'REQUEST',...model}).length)throw Error('EMAIL_CALENDAR_PROJECTION_UNSUPPORTED');
   if([model.start.time_zone,model.end.time_zone,model.recurrence_id?.time_zone].some(zone=>zone&&!/^[A-Za-z0-9_+./-]{1,128}$/u.test(zone)))throw Error('EMAIL_CALENDAR_MODEL_INVALID');
   lines.push('BEGIN:VEVENT',`UID:${escaped(model.uid)}`,`DTSTAMP:${model.dtstamp.replace(/[-:]/gu,'').replace(/\.\d{3}Z$/u,'Z')}`,`SEQUENCE:${model.sequence}`,dateLine('DTSTART',model.start),dateLine('DTEND',model.end),
    ...(model.recurrence_id?[dateLine('RECURRENCE-ID',model.recurrence_id)]:[]),...(!model.recurrence_id&&model.rrule?['RRULE:'+model.rrule]:[]),...model.exdates.map(time=>dateLine('EXDATE',time)),`SUMMARY:${escaped(row.title??'')}`,'END:VEVENT');
  }
  lines.push('END:VCALENDAR');const parsed=ical.sync.parseICS(lines.join('\r\n')),event=Object.values(parsed).find((value):value is VEvent=>value?.type==='VEVENT');if(!event)throw Error('EMAIL_CALENDAR_MODEL_INVALID');
  // A standalone accepted exception is a single concrete event until its
  // master arrives; it cannot invent unknown other occurrences.
  if(!master&&event.recurrenceid){delete event.recurrenceid;delete event.rrule;delete event.recurrences;}
  const instances=ical.expandRecurringEvent(event,{from,to,expandOngoing:true,includeOverrides:true,excludeExdates:true});if(instances.length>512)throw Error('EMAIL_CALENDAR_PROJECTION_LIMIT');
  for(const instance of instances){
   const rid=instance.event.recurrenceid,instanceKey=rid?rid.dateOnly?'date:'+civil(rid):'instant:'+rid.toISOString():null;
   const selected=instance.isOverride?group.find(value=>modelInstanceKey(value.model)===instanceKey):source;
   if(!selected)throw Error('EMAIL_CALENDAR_MODEL_INVALID');if((selected.row.metadata as Record<string,unknown>).status==='canceled')continue;
   const allDay=instance.isFullDay,start=allDay?new Date(dateISO(civil(instance.start))):instance.start,end=allDay?new Date(dateISO(civil(instance.end))):instance.end;
   const occurrence_id=createHash('sha256').update(JSON.stringify([key,instanceKey??start.toISOString()])).digest('hex');
   output.push({...selected.row,event_id:selected.row.id,occurrence_id,timestamp:start,metadata:{...(selected.row.metadata as Record<string,unknown>),start:start.toISOString(),end:end.toISOString(),allDay}});
   if(output.length>MAX_OCCURRENCES)throw Error('EMAIL_CALENDAR_PROJECTION_LIMIT');
  }
  if(!master&&group.length>1){for(const value of group.slice(1)){output.push(...projectEmailCalendarEvents([value.row],from,to));if(output.length>MAX_OCCURRENCES)throw Error('EMAIL_CALENDAR_PROJECTION_LIMIT');}}
 }
 return output.sort((a,b)=>a.timestamp.getTime()-b.timestamp.getTime()||a.occurrence_id.localeCompare(b.occurrence_id));
}
/** Exact organization+owner query, including series masters predating this
 * window and moved exceptions. No separate Calendar CRUD or event copy. */
export async function readEmailCalendarOccurrences(database:Pick<NodePgDatabase,'select'>,input:{org_id:string;owner_user_id:string;from:Date;to:Date}){
 const rows=await database.select({id:events.id,title:events.title,body:events.body,url:events.url,event_type:events.event_type,timestamp:events.timestamp,metadata:events.metadata,source:events.source}).from(events)
  .where(and(eq(events.org_id,input.org_id),eq(events.user_id,input.owner_user_id),eq(events.source,'native'),eq(events.event_type,'calendar_event'),
   sql`${events.metadata}->'email_invitation'->>'schema_version' = 'deft.email_calendar_event.v1'`,lte(events.timestamp,input.to))).limit(MAX_ROWS+1);
 return projectEmailCalendarEvents(rows,input.from,input.to);
}
