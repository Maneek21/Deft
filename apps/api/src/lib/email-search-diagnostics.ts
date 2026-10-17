import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const phases=['setup','search','authority_connected','authority_sql_pass','provider','persist','json_response'] as const;
export type EmailSearchPhase=typeof phases[number];
type Interval={id:number;parent:number|null;phase:EmailSearchPhase;start_ms:number;end_ms:number|null};
type Sample={id:string;started:number;clock:()=>number;intervals:Interval[];overflow:boolean;closed:boolean;items:number|null;failures:number|null;partial:boolean|null};
type Active={sample:Sample;parent:number|null;depth:number};
const active=new AsyncLocalStorage<Active>();
const MAX_REQUESTS=4,TTL_MS=10*60_000,MAX_INTERVALS=512,MAX_DEPTH=16;
const readClock=(clock:()=>number)=>{try{return clock();}catch{return NaN;}};
const elapsed=(sample:Sample)=>Math.max(0,readClock(sample.clock)-sample.started);
const valid=(value:number)=>Number.isFinite(value)&&value>=0;

/** Only fixed phase names and numeric intervals enter this request-owned store.
 * Disabled work returns its original promise and every authority call remains. */
export function profileEmailSearchPhase<T>(phase:EmailSearchPhase,work:()=>Promise<T>):Promise<T>{
 const context=active.getStore();
 if(!context||context.sample.closed||!phases.includes(phase))return work();
 const sample=context.sample;
 if(context.depth>=MAX_DEPTH||sample.intervals.length>=MAX_INTERVALS){sample.overflow=true;return work();}
 const start=elapsed(sample);if(!valid(start))return work();
 const interval:Interval={id:sample.intervals.length,parent:context.parent,phase,start_ms:start,end_ms:null};sample.intervals.push(interval);
 const end=()=>{if(!sample.closed){const time=elapsed(sample);if(valid(time))interval.end_ms=Math.max(start,time);}};
 return active.run({sample,parent:interval.id,depth:context.depth+1},()=>{
  try{return work().finally(end);}catch(error){end();throw error;}
 });
}
export function noteEmailSearchResult(value:{items:number;failures:number;partial:boolean}){
 const sample=active.getStore()?.sample;if(!sample||sample.closed)return;
 if(Number.isSafeInteger(value.items)&&value.items>=0&&value.items<=100&&Number.isSafeInteger(value.failures)&&value.failures>=0&&value.failures<=100000&&typeof value.partial==='boolean'){
  sample.items=value.items;sample.failures=value.failures;sample.partial=value.partial;
 }
}
type Report={event:'email_search_profile';schema_version:1;sample_id:string;outcome:'success'|'error';elapsed_ms:number;activation_overhead_ms:number;items:number|null;failures:number|null;partial:boolean|null;overflow:boolean;intervals:Interval[]};
/** Trusted construction port for tests/operator activation; request data cannot
 * enable collection. Lifetime and request/event limits are fixed in production. */
export function createEmailSearchDiagnostics(options:{enabled:(account:string)=>boolean;wall?:()=>number;clock?:()=>number;emit:(record:Report)=>void}){
 const wall=options.wall??Date.now,clock=options.clock??(()=>performance.now()),created=readClock(wall);let admitted=0,expired=false;
 return {run<T>(account:string,work:()=>Promise<T>,activationOverhead=0):Promise<T>{
  let allowed=false;try{const now=wall();if(Number.isFinite(now)&&Number.isFinite(created)&&(now<created||now-created>=TTL_MS))expired=true;
   allowed=!expired&&options.enabled(account)&&Number.isFinite(created)&&Number.isFinite(now)&&now>=created&&now-created<TTL_MS&&admitted<MAX_REQUESTS;}catch{}
  if(!allowed)return work();admitted++;
  const started=readClock(clock);if(!Number.isFinite(started))return work();
  const sample:Sample={id:randomUUID(),started,clock,intervals:[],overflow:false,closed:false,items:null,failures:null,partial:null};
  let outcome:'success'|'error'='error';
  return active.run({sample,parent:null,depth:0},async()=>{
   try{const result=await work();outcome='success';return result;}finally{
    const duration=elapsed(sample);sample.closed=true;
    if(valid(duration))try{options.emit({event:'email_search_profile',schema_version:1,sample_id:sample.id,outcome,elapsed_ms:duration,
     activation_overhead_ms:valid(activationOverhead)?activationOverhead:0,items:sample.items,failures:sample.failures,partial:sample.partial,overflow:sample.overflow,
     intervals:sample.intervals.map(row=>({...row}))});}catch{}
    sample.intervals.length=0;
   }
  });
 }};
}
/** Parse once at process start. No request can nominate the diagnostic accounts.
 * A malformed/oversized flag stays off and no configuration value is logged. */
export function emailSearchDiagnosticAccounts(raw:string|undefined):ReadonlySet<string>{
 try{
  if(!raw||Buffer.byteLength(raw,'utf8')>1024)return new Set();
  const value=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'account_ids')
   ||!Array.isArray(value.account_ids)||value.account_ids.length!==2
   ||value.account_ids.some((id:unknown)=>typeof id!=='string'||id.length<1||id.length>256||id.trim()!==id||/[\u0000-\u001f\u007f-\u009f]/u.test(id))
   ||new Set(value.account_ids).size!==2)return new Set();
  return new Set<string>(value.account_ids);
 }catch{return new Set();}
}
const diagnosticAccounts=emailSearchDiagnosticAccounts(process.env.DEFT_EMAIL_SEARCH_DIAGNOSTICS);
export const emailSearchDiagnostics=createEmailSearchDiagnostics({enabled:account=>diagnosticAccounts.has(account),emit:record=>console.info(JSON.stringify(record))});
