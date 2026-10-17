import {AsyncLocalStorage} from 'node:async_hooks';
import {AppError} from './app-errors.js';
type Owner={org_id:string;user_id:string};
type Group={active:number;global:number;perOwner:number;owners:Map<string,number>};
const files:Group={active:0,global:4,perOwner:2,owners:new Map()},images:Group={active:0,global:8,perOwner:4,owners:new Map()};
const leases=new AsyncLocalStorage<{owner:string;group:Group}>();
function group(operation:string){return operation==='resource_read_image'?images:
 ['file_upload','file_copy','file_read','resource_read_file','resource_read_source'].includes(operation)?files:null;}
/** Per-process memory admission only; durable authority and request identity
 * remain in PostgreSQL. Slots remain held until all downstream work unwinds.
 * Upload admission runs before consuming its separately authenticated body. */
export async function withAppDataBinaryIo<T>(owner:Owner,operation:string,use:()=>Promise<T>):Promise<T>{
 const selected=group(operation);if(!selected)return use();const key=`${owner.org_id}:${owner.user_id}`,existing=leases.getStore();
 if(existing?.group===selected&&existing.owner===key)return use();
 const count=selected.owners.get(key)??0;
 if(selected.active>=selected.global||count>=selected.perOwner)throw new AppError('App file transfer is busy; retry shortly','APP_PROVIDER_UNAVAILABLE',503);
 selected.active++;selected.owners.set(key,count+1);
 try{return await leases.run({owner:key,group:selected},use);}
 finally{selected.active--;const remaining=(selected.owners.get(key)??1)-1;if(remaining)selected.owners.set(key,remaining);else selected.owners.delete(key);}
}
