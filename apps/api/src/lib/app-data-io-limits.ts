import {AsyncLocalStorage} from 'node:async_hooks';
import {AppError} from './app-errors.js';
type Owner={org_id:string;user_id:string};
type Waiter={key:string;grant:()=>void;timer:ReturnType<typeof setTimeout>};
type Group={active:number;global:number;perOwner:number;owners:Map<string,number>;waiting:Waiter[]};
const QUEUE_MS=2000;
const files:Group={active:0,global:8,perOwner:4,owners:new Map(),waiting:[]},images:Group={active:0,global:12,perOwner:6,owners:new Map(),waiting:[]};
const leases=new AsyncLocalStorage<{owner:string;group:Group}>();
function group(operation:string){return operation==='resource_read_image'?images:
 ['file_upload','file_copy','file_read','resource_read_file','resource_read_source'].includes(operation)?files:null;}
/** Per-process memory admission only; durable authority and request identity
 * remain in PostgreSQL. Slots remain held until all downstream work unwinds.
 * Overflow queues for a bounded interval before rejecting with 503 instead of
 * refusing a second concurrent transfer outright. Upload admission runs before
 * consuming its separately authenticated body. */
const busy=()=>new AppError('App file transfer is busy; retry shortly','APP_PROVIDER_UNAVAILABLE',503);
function admitted(selected:Group,key:string){return selected.active<selected.global&&(selected.owners.get(key)??0)<selected.perOwner;}
function take(selected:Group,key:string){selected.active++;selected.owners.set(key,(selected.owners.get(key)??0)+1);}
function release(selected:Group,key:string){selected.active--;const remaining=(selected.owners.get(key)??1)-1;if(remaining)selected.owners.set(key,remaining);else selected.owners.delete(key);}
function drain(selected:Group){while(selected.waiting.length&&admitted(selected,selected.waiting[0].key)){const waiter=selected.waiting.shift()!;clearTimeout(waiter.timer);waiter.grant();}}
function acquire(selected:Group,key:string):Promise<void>{
 if(admitted(selected,key)){take(selected,key);return Promise.resolve();}
 return new Promise<void>((resolve,reject)=>{const waiter:Waiter={key,grant:()=>{take(selected,key);resolve();},
   timer:setTimeout(()=>{const at=selected.waiting.indexOf(waiter);if(at>=0)selected.waiting.splice(at,1);reject(busy());},QUEUE_MS)};selected.waiting.push(waiter);});
}
export async function withAppDataBinaryIo<T>(owner:Owner,operation:string,use:()=>Promise<T>):Promise<T>{
 const selected=group(operation);if(!selected)return use();const key=`${owner.org_id}:${owner.user_id}`,existing=leases.getStore();
 if(existing?.group===selected&&existing.owner===key)return use();
 await acquire(selected,key);
 try{return await leases.run({owner:key,group:selected},use);}
 finally{release(selected,key);drain(selected);}
}
