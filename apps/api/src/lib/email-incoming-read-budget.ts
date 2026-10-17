/** Resource admission only. A lease carries no account, session or authority. */
export class EmailIncomingReadBusyError extends Error {
  readonly code='EMAIL_SOURCE_BUSY';
  constructor(){super('EMAIL_SOURCE_BUSY');this.name='EmailIncomingReadBusyError';}
}
export function createEmailIncomingReadBudget(options:{active?:number;queued?:number;waitMs?:number;now?:()=>number}={}){
  const limit=options.active??2,queueLimit=options.queued??16,waitMs=options.waitMs??2000,now=options.now??Date.now;
  if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(queueLimit)||queueLimit<0||!Number.isSafeInteger(waitMs)||waitMs<1)throw new TypeError('Invalid incoming read budget');
  type Waiter={grant:()=>void};const queue:Waiter[]=[];let active=0;
  const release=()=>{let done=false;return ()=>{if(done)return;done=true;active--;queue[0]?.grant();};};
  const acquire=async(signal?:AbortSignal,deadline?:number):Promise<()=>void>=>{
    signal?.throwIfAborted();if(deadline!==undefined&&(!Number.isFinite(deadline)||deadline<=now()))throw new EmailIncomingReadBusyError();
    if(active<limit){active++;return release();}
    if(queue.length>=queueLimit)throw new EmailIncomingReadBusyError();
    return new Promise((resolve,reject)=>{
      let done=false,timer:ReturnType<typeof setTimeout>;
      const remove=()=>{if(done)return false;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);const index=queue.indexOf(waiter);if(index>=0)queue.splice(index,1);return true;};
      const abort=()=>{if(remove())reject(signal?.reason??new DOMException('Aborted','AbortError'));};
      const waiter:Waiter={grant:()=>{if(!remove())return;if(signal?.aborted){reject(signal.reason);queue[0]?.grant();return;}
        if(deadline!==undefined&&deadline<=now()){reject(new EmailIncomingReadBusyError());queue[0]?.grant();return;}active++;resolve(release());}};
      queue.push(waiter);signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{if(remove())reject(new EmailIncomingReadBusyError());},Math.min(waitMs,deadline===undefined?waitMs:Math.max(1,deadline-now())));
      if(signal?.aborted)abort();
    });
  };
  return Object.freeze({acquire,snapshot:()=>({active,queued:queue.length})});
}
export const emailIncomingProviderBudget=createEmailIncomingReadBudget();
const emailIncomingBinaryBudget=createEmailIncomingReadBudget();
type Outgoing={once:(event:string,listener:()=>void)=>unknown;off:(event:string,listener:()=>void)=>unknown;destroy:(error?:Error)=>unknown;destroyed?:boolean;writableFinished?:boolean};
const outgoingPort=(value:unknown):Outgoing|undefined=>{
  if(value&&typeof value==='object'&&['once','off','destroy'].every(key=>typeof (value as Record<string,unknown>)[key]==='function'))return value as Outgoing;
};
/** Production Node owns the lease until socket finish/close. Non-Node callers
 * consume a bounded owned stream; neither path releases on service return. */
export async function acquireEmailIncomingBinaryResponse(input:{signal:AbortSignal;deadline:number;outgoing?:unknown},
  options:{budget?:ReturnType<typeof createEmailIncomingReadBudget>;lifetimeMs?:number}={}){
  const release=await (options.budget??emailIncomingBinaryBudget).acquire(input.signal,input.deadline),outgoing=outgoingPort(input.outgoing),controller=new AbortController();
  const signal=AbortSignal.any([input.signal,controller.signal]);let bytes:Uint8Array<ArrayBuffer>|undefined,closed=false,responded=false,streamController:ReadableStreamDefaultController<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const cleanup=()=>{if(closed)return;closed=true;clearTimeout(timer);input.signal.removeEventListener('abort',abort);outgoing?.off('finish',cleanup);outgoing?.off('close',onClose);bytes?.fill(0);bytes=undefined;release();};
  const onClose=()=>{controller.abort(new DOMException('Response closed','AbortError'));cleanup();};
  const abort=()=>{
    const reason=signal.reason instanceof Error?signal.reason:new Error('Incoming response aborted');
    if(outgoing){try{outgoing.destroy(reason);}catch{cleanup();}if(outgoing.writableFinished)cleanup();}
    else{try{streamController?.error(reason);}catch{}cleanup();}
  };
  input.signal.addEventListener('abort',abort,{once:true});outgoing?.once('finish',cleanup);outgoing?.once('close',onClose);
  const remaining=Math.min(options.lifetimeMs??45_000,input.deadline-Date.now());
  timer=setTimeout(()=>{controller.abort(new DOMException('Incoming response deadline expired','TimeoutError'));abort();},Math.max(1,remaining));timer.unref?.();
  if(signal.aborted||outgoing?.destroyed||outgoing?.writableFinished){cleanup();signal.throwIfAborted();throw new DOMException('Response ended','AbortError');}
  return Object.freeze({signal,dispose:cleanup,response(value:Uint8Array,headers:Record<string,string>){
    signal.throwIfAborted();if(closed||responded)throw new Error('Incoming response ended');responded=true;
    bytes=new Uint8Array(value);const length=bytes.length,ownedHeaders={...headers,'Content-Length':String(length)};
    if(outgoing)return new Response(bytes,{headers:ownedHeaders});
    let offset=0;
    return new Response(new ReadableStream<Uint8Array>({start(c){streamController=c;},pull(c){
      if(signal.aborted||closed||!bytes){try{c.error(signal.reason??new Error('Incoming response ended'));}catch{}cleanup();return;}
      if(offset===length){c.close();cleanup();return;}
      const end=Math.min(offset+65536,length),chunk=bytes.slice(offset,end);offset=end;c.enqueue(chunk);
    },cancel(){cleanup();}},{highWaterMark:0}),{headers:ownedHeaders});
  }});
}
