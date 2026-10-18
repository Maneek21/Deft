/** Trusted Host diagnostics only. No source, account, URL, error text or author
 * values enter this closed record. Enable explicitly in a diagnostic build. */
const phases=['source.open','source.catalog','source.candidate','source.selected','source.select',
  'account.catalog','account.open','account.queue','account.validate','account.read','account.list','account.execute',
  'data.context','data.resolve','data.request','data.binary','data.body','reader.lifecycle','reader.presentation'] as const;
export type ExperienceReadPhase=typeof phases[number];
type Outcome = 'completed' | 'failed' | 'aborted';
export type ExperienceReadSpan = Readonly<{schema_version:'deft.experience_read_span.v1';trace_id:string;span_id:number;
  phase:ExperienceReadPhase;start_ms:number;duration_ms:number;outcome:Outcome;request_id?:string}>;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export function createExperienceReadTracer(options:{enabled:()=>boolean;emit:(span:ExperienceReadSpan)=>void;
  now?:()=>number;id?:()=>string}) {
  const traces=new WeakMap<AbortSignal,{id:string;start:number;next:number}>();let remaining=1024;
  const clock=()=>{try{const value=(options.now??(()=>performance.now()))();return Number.isFinite(value)?value:0;}catch{return 0;}};
  const begin=(signal:AbortSignal,phase:ExperienceReadPhase,requestId?:string)=>{
    let enabled=false;try{enabled=options.enabled();}catch{/* Diagnostics cannot affect reads. */}
    if(!enabled||remaining<=0||!phases.includes(phase))return (_outcome:Outcome)=>{};
    let trace=traces.get(signal);const owns=!trace;
    if(!trace){let id:string;try{id=(options.id??(()=>crypto.randomUUID()))();}catch{return (_outcome:Outcome)=>{};}
      if(!uuid.test(id))return (_outcome:Outcome)=>{};trace={id,start:clock(),next:0};traces.set(signal,trace);}
    if(trace.next>=128)return (_outcome:Outcome)=>{};
    const owner=trace,spanId=++trace.next,start=clock();let ended=false;
    const finish=(outcome:Outcome)=>{if(ended)return;ended=true;signal.removeEventListener('abort',abort);
      if(owns&&traces.get(signal)===owner)traces.delete(signal);
      if(remaining--<=0)return;
      const span:ExperienceReadSpan={schema_version:'deft.experience_read_span.v1',trace_id:owner.id,span_id:spanId,phase,
        start_ms:Math.max(0,Math.round(start-owner.start)),duration_ms:Math.max(0,Math.round(clock()-start)),outcome,
        ...(requestId&&uuid.test(requestId)?{request_id:requestId}:{})};
      try{options.emit(Object.freeze(span));}catch{/* A diagnostic sink never changes an operation. */}};
    const abort=()=>finish('aborted');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();return finish;
  };
  return {begin,inherit(parent:AbortSignal,child:AbortSignal){const trace=traces.get(parent);if(trace&&!traces.has(child))traces.set(child,trace);},
    async run<T>(signal:AbortSignal,phase:ExperienceReadPhase,work:()=>Promise<T>,requestId?:string):Promise<T>{
      const finish=begin(signal,phase,requestId);try{const result=await work();finish(signal.aborted?'aborted':'completed');return result;}
      catch(error){finish(signal.aborted?'aborted':'failed');throw error;}}
  };
}
const tracer=createExperienceReadTracer({enabled:()=>process.env.NEXT_PUBLIC_DEFT_EXPERIENCE_READ_TRACE==='true',
  emit:span=>console.info('deft.experience.read',JSON.stringify(span))});
export const traceExperienceRead=tracer.run;
export const beginExperienceReadTrace=tracer.begin;
export const inheritExperienceReadTrace=tracer.inherit;
