import {adoptNativeEmailAccount,type NativeEmailSetup} from './email-native-enrollment';
export type NativeEmailConnectionTarget=Readonly<{provider:'gmail'|'microsoft';primary_address:string;display_label:string;native_email:NativeEmailSetup}>;
export type NativeEmailConnectionTargets=Readonly<{targets:readonly NativeEmailConnectionTarget[];has_more:boolean;unavailable_count:number}>;
export type NativeEmailConnectionState={state:'loading'|'available'|'failed'|'denied';targets:NativeEmailConnectionTarget[];hasMore:boolean;unavailableCount:number;busy:boolean;working:string|null;uncertain:string[];notice:string};
export class NativeEmailConnectionError extends Error{constructor(readonly kind:'denied'|'unavailable'){super(kind==='denied'?'Account connection access changed. Reconnect in Email settings.':'Existing connections could not be confirmed. Refresh connections to check their current status.');}}
const closed=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const safeText=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export const nativeEmailConnectionKey=(target:NativeEmailConnectionTarget)=>JSON.stringify([target.native_email.account_id,target.native_email.resource_binding_id]);
export function parseNativeEmailConnectionTargets(value:unknown):NativeEmailConnectionTargets{
 const fail=():never=>{throw new NativeEmailConnectionError('unavailable');};
 if(!closed(value,['targets','has_more','unavailable_count'])||!Array.isArray(value.targets)||value.targets.length>50||typeof value.has_more!=='boolean'||typeof value.unavailable_count!=='number'||!Number.isSafeInteger(value.unavailable_count)||value.unavailable_count<0||value.unavailable_count>50)return fail();
 const targets=value.targets.map(raw=>{
  if(!closed(raw,['provider','primary_address','display_label','native_email'])||!['gmail','microsoft'].includes(String(raw.provider))||!safeText(raw.primary_address,320)||!raw.primary_address||!safeText(raw.display_label,256)||!closed(raw.native_email,['account_id','resource_binding_id','state'])||!safeText(raw.native_email.account_id,256)||!raw.native_email.account_id||raw.native_email.account_id.trim()!==raw.native_email.account_id||typeof raw.native_email.resource_binding_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(raw.native_email.resource_binding_id)||!['available','active','unavailable'].includes(String(raw.native_email.state)))return fail();
  return {provider:raw.provider,primary_address:raw.primary_address,display_label:raw.display_label,native_email:{...raw.native_email}} as NativeEmailConnectionTarget;
 });
 if(new Set(targets.map(nativeEmailConnectionKey)).size!==targets.length)return fail();return {targets,has_more:value.has_more,unavailable_count:value.unavailable_count};
}
async function readJson(response:Response,signal:AbortSignal,max:number){
 if(!response.body)throw new NativeEmailConnectionError('unavailable');const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{for(;;){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;size+=part.value.byteLength;if(size>max)throw new NativeEmailConnectionError('unavailable');text+=decoder.decode(part.value,{stream:true});}return JSON.parse(text+decoder.decode()) as unknown;}
 finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function readTargets(ports:{fetch:(path:string,init:RequestInit)=>Promise<Response>;current:()=>boolean},signal:AbortSignal){
 if(!ports.current()||signal.aborted)throw new NativeEmailConnectionError('denied');const response=await ports.fetch('/api/email/connection-targets',{method:'GET',cache:'no-store',signal});
 if(!ports.current()){await response.body?.cancel().catch(()=>{});throw new NativeEmailConnectionError('denied');}if(!response.ok){await response.body?.cancel().catch(()=>{});throw new NativeEmailConnectionError([401,403].includes(response.status)?'denied':'unavailable');}
 const value=await readJson(response,signal,128*1024);if(!ports.current())throw new NativeEmailConnectionError('denied');return parseNativeEmailConnectionTargets(value);
}
export function createNativeEmailConnectionTargets(ports:{fetch:(path:string,init:RequestInit)=>Promise<Response>;current:()=>boolean;change:(state:NativeEmailConnectionState)=>void;adopted:()=>void}){
 const controller=new AbortController();let active=true,ended=false;
 let value:NativeEmailConnectionState={state:'loading',targets:[],hasMore:false,unavailableCount:0,busy:false,working:null,uncertain:[],notice:''};
 const current=()=>active&&!ended&&!controller.signal.aborted&&ports.current(),publish=()=>{if(current())ports.change({...value,targets:structuredClone(value.targets),uncertain:[...value.uncertain]});};
 const fail=(error:unknown)=>{if(!current())return;if(error instanceof NativeEmailConnectionError&&error.kind==='denied'){value={...value,state:'denied',targets:[],uncertain:[],hasMore:false,unavailableCount:0,busy:false,working:null,notice:error.message};publish();ended=true;controller.abort();}else value={...value,notice:error instanceof NativeEmailConnectionError?error.message:'This setup could not be confirmed. Refresh connections before another action.'};};
 return {async load(){if(!current()||value.busy)return;value={...value,busy:true,state:'loading',notice:''};publish();
   try{const page=await readTargets(ports,AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]));if(current())value={...value,state:'available',targets:[...page.targets],hasMore:page.has_more,unavailableCount:page.unavailable_count,uncertain:[],notice:''};}
   catch(error){if(current()){value={...value,state:'failed',targets:[],hasMore:false,unavailableCount:0};fail(error);}}
   finally{value={...value,busy:false,working:null};publish();}
  },async adopt(target:NativeEmailConnectionTarget){
   if(!current()||value.busy||value.state!=='available'||target.native_email.state!=='available'||value.uncertain.includes(nativeEmailConnectionKey(target)))return;
   const selected=value.targets.find(row=>nativeEmailConnectionKey(row)===nativeEmailConnectionKey(target));if(!selected||selected.native_email.state!=='available'||JSON.stringify(selected)!==JSON.stringify(target))return;
   const key=nativeEmailConnectionKey(selected);value={...value,busy:true,working:key,notice:'Enabling this account in Deft…'};publish();
   try{const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);const setup=await adoptNativeEmailAccount(selected.native_email,{current,fetch:async(path,init)=>{
     const response=await ports.fetch(path,init);if([401,403].includes(response.status)){await response.body?.cancel().catch(()=>{});throw new NativeEmailConnectionError('denied');}if(!response.ok){await response.body?.cancel().catch(()=>{});return response;}
     const result=await readJson(response,signal,65536);if(!closed(result,['account_id','provider','state','authority_revision'])||result.account_id!==selected.native_email.account_id||result.provider!==selected.provider||result.state!=='active'||typeof result.authority_revision!=='number'||!Number.isSafeInteger(result.authority_revision)||result.authority_revision<1||result.authority_revision>2147483647)throw new NativeEmailConnectionError('unavailable');
     return new Response(JSON.stringify(result),{status:response.status,headers:{'Content-Type':'application/json'}});
    }},signal);
    if(current()){value={...value,targets:value.targets.map(row=>nativeEmailConnectionKey(row)===key?{...row,native_email:setup}:row),notice:'Account enabled in Deft. Messages will appear as the first sync completes.'};try{ports.adopted();}catch{}}
   }catch(error){if(current()){value={...value,uncertain:[...new Set([...value.uncertain,key])]};fail(error);}}
   finally{value={...value,busy:false,working:null};publish();}
  },snapshot:()=>({...value,targets:structuredClone(value.targets),uncertain:[...value.uncertain]}),dispose(){active=false;controller.abort();value={...value,targets:[],uncertain:[]};}
 };
}
