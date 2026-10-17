import {experienceRecordSubmissionEvent,type ExperienceRecordRow} from './app-experience-record-writer';
type Event=ReturnType<typeof experienceRecordSubmissionEvent>;
/** Retry only an immutable reference after confirmed submission. True means
 * posted to the live port, not processed/acknowledged by the author Worker. */
export async function deliverExperienceRecordSubmission(options:{confirmed:boolean;nodeId:string;row:ExperienceRecordRow;
 current:()=>boolean;signal:AbortSignal;send:(event:Event,signal:AbortSignal)=>unknown;
 timeoutMs?:number;retryDelayMs?:number;maxAttempts?:number}):Promise<boolean>{
 if(!options.confirmed||!options.current()||options.signal.aborted)return false;
 const event=Object.freeze(experienceRecordSubmissionEvent(options.nodeId,options.row));
 const controller=new AbortController(),signal=AbortSignal.any([options.signal,controller.signal]);
 const timeout=Math.max(1,Math.min(options.timeoutMs??5000,5000)),delay=Math.max(1,Math.min(options.retryDelayMs??250,1000));
 const attempts=Math.max(1,Math.min(options.maxAttempts??8,8));
 const timer=setTimeout(()=>controller.abort(),timeout);let pause:ReturnType<typeof setTimeout>|undefined;
 let onAbort=()=>{};const ended=new Promise<false>(resolve=>{onAbort=()=>resolve(false);signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();});
 const current=()=>options.current()&&!signal.aborted;
 try{for(let attempt=0;attempt<attempts&&current();attempt++){
   let posted:unknown;try{posted=await Promise.race([Promise.resolve().then(()=>current()?options.send(event,signal):false),ended]);}catch{posted=false;}
   if(!current())return false;if(posted===true)return true;
   if(attempt+1<attempts)await Promise.race([new Promise<void>(resolve=>{pause=setTimeout(resolve,delay);}),ended]);
  }return false;
 }finally{clearTimeout(timer);clearTimeout(pause);controller.abort();signal.removeEventListener('abort',onAbort);}
}
/** Reopening only reconciles UI. Any other unresolved writer must keep it closed. */
export async function reopenExperienceAfterSubmission(options:{confirmed:boolean;current:()=>boolean;
 flush:()=>Promise<boolean>;settle:()=>Promise<boolean>;reopen:()=>void}):Promise<boolean>{
 if(!options.confirmed||!options.current())return false;
 try{if(!await options.flush()||!options.current()||!await options.settle()||!options.current())return false;
  options.reopen();return true;
 }catch{return false;}
}
