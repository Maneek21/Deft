import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

type Phase = 'context'|'resolve'|'invoke'|'authority'|'current'|'session_read'|'upgrade'|'connection_authority'|'registry'|'manifest'|'consent_connections'|'consent_read'|'runtime_request';
type Trace = {request_id:string; timings:Partial<Record<Phase,{calls:number;elapsed_ms:number}>>};
type Event = {event:'app_data_timing';request_id:string;parent_request_id?:string;operation:Phase;outcome:'completed'|'failed';elapsed_ms:number;timings:Trace['timings']};
const context = new AsyncLocalStorage<Trace>();
const clock = () => performance.now();

/** Request-local measurements only: no cached authority, user values, source
 * identifiers, URLs or error messages are retained or logged. */
export async function measureAppDataPhase<T>(phase:Phase, work:()=>Promise<T>):Promise<T> {
 const trace=context.getStore(); if(!trace)return work();
 const began=clock();try{return await work();}finally{const row=trace.timings[phase]??={calls:0,elapsed_ms:0};row.calls++;row.elapsed_ms=Math.round((row.elapsed_ms+clock()-began)*100)/100;}
}

export async function withAppDataDiagnostic<T>(operation:Phase, work:()=>Promise<T>, requestId?:string, sink?:(event:Event)=>void):Promise<T> {
 const request_id=requestId&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(requestId)?requestId:randomUUID();
 const parent=context.getStore(),trace:Trace={request_id,timings:{}},began=clock();let failed=false;
 try{return await context.run(trace,work);}catch(error){failed=true;throw error;}finally{
  const elapsed_ms=Math.round((clock()-began)*100)/100;
  const event:Event={event:'app_data_timing',request_id,...(parent?{parent_request_id:parent.request_id}:{}),operation,outcome:failed?'failed':'completed',elapsed_ms,timings:trace.timings};
  try{if(sink)sink(event);else if(failed||elapsed_ms>=250)console.info(JSON.stringify(event));}catch{}
 }
}
