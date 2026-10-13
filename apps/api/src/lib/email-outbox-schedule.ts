import {EmailOutboxScheduleInputSchema,type EmailOutboxSchedule} from './email-outbox-contract.js';
/** Resolve a minute-precision calendar selection using the installed IANA rules.
 * A saved instant never gets recomputed when the process timezone changes. */
export function resolveEmailOutboxSchedule(raw:unknown,now=new Date()):EmailOutboxSchedule{
 const input=EmailOutboxScheduleInputSchema.parse(raw),[year,month,day,hour,minute]=input.wall_time.match(/\d+/gu)!.map(Number);
 const wall=Date.UTC(year!,month!-1,day!,hour!,minute!),check=new Date(wall);
 if(check.toISOString().slice(0,16)!==input.wall_time||!Number.isFinite(now.getTime())||wall<now.getTime()-3*86400000||wall>now.getTime()+2*366*86400000)throw Error('EMAIL_OUTBOX_SCHEDULE_INVALID');
 let format:Intl.DateTimeFormat;
 try{format=new Intl.DateTimeFormat('en-CA',{timeZone:input.zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{throw Error('EMAIL_OUTBOX_SCHEDULE_INVALID');}
 const local=(instant:number)=>{const parts=Object.fromEntries(format.formatToParts(new Date(instant)).filter(v=>v.type!=='literal').map(v=>[v.type,v.value]));return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;};
 const offsets=new Set<number>();
 for(let delta=-48;delta<=48;delta+=6){const instant=wall+delta*3600000,parts=local(instant).match(/\d+/gu)!.map(Number);offsets.add(Date.UTC(parts[0]!,parts[1]!-1,parts[2]!,parts[3]!,parts[4]!)-instant);}
 const candidates=[...offsets].map(offset=>wall-offset).filter(instant=>local(instant)===input.wall_time).sort((a,b)=>a-b);
 if(!candidates.length)throw Error('EMAIL_OUTBOX_SCHEDULE_GAP');
 if(candidates.length>1&&input.ambiguity==='reject')throw Error('EMAIL_OUTBOX_SCHEDULE_AMBIGUOUS');
 const instant=input.ambiguity==='later'?candidates.at(-1)!:candidates[0]!;
 if(instant<now.getTime())throw Error('EMAIL_OUTBOX_SCHEDULE_PAST');
 return Object.freeze({...input,zone:format.resolvedOptions().timeZone,instant:new Date(instant).toISOString(),rules_version:`node-tz:${process.versions.tz??'unavailable'};icu:${process.versions.icu??'unavailable'}`});
}
