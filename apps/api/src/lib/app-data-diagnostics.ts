import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

type Phase = 'context'|'resolve'|'invoke'|'authority'|'current'|'session_read'|'upgrade'|'connection_authority'|'registry'|'manifest'|'consent_connections'|'consent_read'|'runtime_request';
type Trace = {request_id:string; timings:Partial<Record<Phase,{calls:number;elapsed_ms:number}>>};
type FailureKind = 'database_connection_timeout'|'database_pool_acquisition_timeout'|'database_lock_timeout'|'database_statement_timeout'
 |'database_constraint'|'database_connection_failure'|'authority_denied'|'invalid_request'|'request_aborted'|'unclassified';
type Event = {event:'app_data_timing';request_id:string;parent_request_id?:string;operation:Phase;outcome:'completed'|'failed';failure_kind?:FailureKind;elapsed_ms:number;timings:Trace['timings']};
const context = new AsyncLocalStorage<Trace>();
const clock = () => performance.now();

/** A closed vocabulary, never an error message, query, provider payload, or
 * arbitrary error code. Wrappers may retain the actual database cause. */
function failureKind(error:unknown):FailureKind {
 const seen=new Set<Error>();
 for(let cause=error;cause instanceof Error&&!seen.has(cause)&&seen.size<8;cause=cause.cause){
  seen.add(cause);const code='code' in cause?cause.code:undefined;
  if(cause.message==='Connection terminated due to connection timeout')return 'database_connection_timeout';
  if(cause.message==='timeout exceeded when trying to connect')return 'database_pool_acquisition_timeout';
  if(code==='55P03')return 'database_lock_timeout';
  if(code==='57014')return 'database_statement_timeout';
  if(code==='23502'||code==='23503'||code==='23505'||code==='23514')return 'database_constraint';
  if(code==='ECONNREFUSED'||code==='ECONNRESET'||code==='08006'||code==='57P01')return 'database_connection_failure';
  if(code==='APP_ACCESS_DENIED')return 'authority_denied';
  if(cause instanceof TypeError||cause instanceof SyntaxError||cause.name==='ZodError')return 'invalid_request';
  if(cause.name==='AbortError')return 'request_aborted';
 }
 return 'unclassified';
}

/** Request-local measurements only: no cached authority, user values, source
 * identifiers, URLs or error messages are retained or logged. */
export async function measureAppDataPhase<T>(phase:Phase, work:()=>Promise<T>):Promise<T> {
 const trace=context.getStore(); if(!trace)return work();
 const began=clock();try{return await work();}finally{const row=trace.timings[phase]??={calls:0,elapsed_ms:0};row.calls++;row.elapsed_ms=Math.round((row.elapsed_ms+clock()-began)*100)/100;}
}

export async function withAppDataDiagnostic<T>(operation:Phase, work:()=>Promise<T>, requestId?:string, sink?:(event:Event)=>void):Promise<T> {
 const request_id=requestId&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(requestId)?requestId:randomUUID();
 const parent=context.getStore(),trace:Trace={request_id,timings:{}},began=clock();let failure_kind:FailureKind|undefined;
 try{return await context.run(trace,work);}catch(error){
  try{failure_kind=failureKind(error);}catch{failure_kind='unclassified';}
  throw error;
 }finally{
  const elapsed_ms=Math.round((clock()-began)*100)/100;
  const event:Event={event:'app_data_timing',request_id,...(parent?{parent_request_id:parent.request_id}:{}),operation,outcome:failure_kind?'failed':'completed',...(failure_kind?{failure_kind}:{}),elapsed_ms,timings:trace.timings};
  try{if(sink)sink(event);else if(failure_kind||elapsed_ms>=250)console.info(JSON.stringify(event));}catch{}
 }
}
