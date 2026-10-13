/** A held auth refresh, request, JSON body, or list read must not strand the
 * mailbox UI. The owner scope remains separate so timeout can still settle it. */
export function nativeMailboxRefreshBudget(ownerSignal:AbortSignal,totalMs=25000,requestMs=8000){
 const controller=new AbortController(),timeout=()=>new Error('Mailbox updates were not confirmed before the request timed out. The current view is kept.');
 const abort=()=>controller.abort(ownerSignal.reason);ownerSignal.addEventListener('abort',abort,{once:true});if(ownerSignal.aborted)abort();const deadline=setTimeout(()=>controller.abort(timeout()),totalMs);
 return {signal:controller.signal,async run<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const request=new AbortController(),signal=AbortSignal.any([controller.signal,request.signal]);let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await new Promise<T>((resolve,reject)=>{const stop=()=>{signal.removeEventListener('abort',stop);reject(signal.reason);};signal.addEventListener('abort',stop,{once:true});if(signal.aborted){stop();return;}timer=setTimeout(()=>request.abort(timeout()),requestMs);void Promise.resolve().then(()=>work(signal)).then(value=>{signal.removeEventListener('abort',stop);if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});});}finally{clearTimeout(timer);request.abort();}
 },dispose(){clearTimeout(deadline);ownerSignal.removeEventListener('abort',abort);controller.abort();}};
}
