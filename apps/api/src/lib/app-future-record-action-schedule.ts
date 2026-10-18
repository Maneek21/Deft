import {AppFutureScheduleInputSchema} from '../../../../packages/app-kit/src/future-record-action.js';
/** The resolved instant is saved once; queue dispatch never re-resolves it. */
export function resolveFutureRecordActionSchedule(raw:unknown,now:number,horizonSeconds:number){
 const input=AppFutureScheduleInputSchema.parse(raw),parts=input.wall_time.match(/\d+/gu)!.map(Number);
 const wall=Date.UTC(parts[0]!,parts[1]!-1,parts[2]!,parts[3]!,parts[4]!);
 if(!Number.isFinite(now)||!Number.isInteger(horizonSeconds)||horizonSeconds<0||horizonSeconds>2*366*86400
 ||new Date(wall).toISOString().slice(0,16)!==input.wall_time)throw Error('APP_FUTURE_SCHEDULE_INVALID');
 let formatter:Intl.DateTimeFormat;
 try{formatter=new Intl.DateTimeFormat('en-CA',{timeZone:input.zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}
 catch{throw Error('APP_FUTURE_SCHEDULE_INVALID');}
 const local=(ms:number)=>{const p=Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(v=>v.type!=='literal').map(v=>[v.type,v.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;};
 const offsets=new Set<number>();
 for(let hours=-48;hours<=48;hours+=6){const ms=wall+hours*3600000,p=local(ms).match(/\d+/gu)!.map(Number);offsets.add(Date.UTC(p[0]!,p[1]!-1,p[2]!,p[3]!,p[4]!)-ms);}
 const candidates=[...offsets].map(offset=>wall-offset).filter(ms=>local(ms)===input.wall_time).sort((a,b)=>a-b);
 if(!candidates.length)throw Error('APP_FUTURE_SCHEDULE_GAP');
 if(candidates.length>1&&input.ambiguity==='reject')throw Error('APP_FUTURE_SCHEDULE_AMBIGUOUS');
 const chosen=input.ambiguity==='later'?candidates.at(-1)!:candidates[0]!;
 if(chosen<=now||chosen>now+horizonSeconds*1000)throw Error('APP_FUTURE_SCHEDULE_OUTSIDE_REVIEWED_HORIZON');
 return Object.freeze({...input,zone:formatter.resolvedOptions().timeZone,instant:new Date(chosen).toISOString(),rules_version:`node-tz:${process.versions.tz??'unavailable'};icu:${process.versions.icu??'unavailable'}`});
}
