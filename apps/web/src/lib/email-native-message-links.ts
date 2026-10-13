import {parseNativeEmailMessage,type NativeEmailMessage} from './email-native-search';
export type NativeMessageTarget={account_id:string;logical_message_id:string};
const id=(value:string)=>!!value&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export function nativeMessageUrl(target:NativeMessageTarget){if(!id(target.account_id)||!/^mail_[a-f0-9]{64}$/u.test(target.logical_message_id))throw Error('Message link is unavailable.');return '/email?'+new URLSearchParams({account:target.account_id,message:target.logical_message_id}).toString();}
export function parseNativeMessageLink(search:string):NativeMessageTarget|null{
 const params=new URLSearchParams(search);if(!params.has('account')&&!params.has('message'))return null;
 if(params.has('draft')&&!params.has('message'))return null;
 if(params.getAll('account').length!==1||params.getAll('message').length!==1||!id(params.get('account')??'')||!/^mail_[a-f0-9]{64}$/u.test(params.get('message')??''))throw Error('This message link is unavailable.');return {account_id:params.get('account')!,logical_message_id:params.get('message')!};
}
export class NativeSummaryError extends Error{constructor(readonly status:number){super([401,403].includes(status)?'Account access changed.':status===404?'This message is unavailable.':'Message details could not be loaded.');}}
export function createNativeMessageSummary(options:{fetch:(path:string,init:RequestInit)=>Promise<Response>;current:()=>boolean}){
 const controller=new AbortController();let active=true;const current=()=>active&&!controller.signal.aborted&&options.current();
 return {read:async(target:NativeMessageTarget,signal?:AbortSignal)=>{nativeMessageUrl(target);if(!current())throw Error('Account access changed.');const owned=AbortSignal.any([controller.signal,AbortSignal.timeout(8000),...(signal?[signal]:[])]);
  const response=await options.fetch('/api/email/accounts/'+encodeURIComponent(target.account_id)+'/messages/'+target.logical_message_id+'/summary',{cache:'no-store',signal:owned});owned.throwIfAborted();if(!current())throw Error('Account access changed.');if(!response.ok)throw new NativeSummaryError(response.status);
  const text=await response.text();owned.throwIfAborted();if(!current()||new TextEncoder().encode(text).length>256*1024)throw Error('Message details could not be confirmed.');const value=JSON.parse(text);if(value?.account_id!==target.account_id)throw Error('Message details could not be confirmed.');const row=parseNativeEmailMessage(value,target.account_id);if(row.logical_message_id!==target.logical_message_id)throw Error('Message details could not be confirmed.');return row;
 },dispose:()=>{active=false;controller.abort();}};
}
/** Refresh only explicit affected loaded rows. Two readers share the host's
 * deadline; access denial cancels that account without discarding other ones. */
export async function readNativeAffectedSummaries(targets:readonly NativeMessageTarget[],options:{
 read:(target:NativeMessageTarget,signal:AbortSignal)=>Promise<NativeEmailMessage>;current:()=>boolean;signal:AbortSignal;denied:(accountId:string)=>void}){
 if(targets.length>100)throw Error('Too many message details to refresh.');
 const unique=new Map<string,NativeMessageTarget>();for(const target of targets){nativeMessageUrl(target);unique.set(JSON.stringify([target.account_id,target.logical_message_id]),target);}
 const requests=[...unique.values()],controllers=new Map<string,AbortController>(),blocked=new Set<string>(),items:NativeEmailMessage[]=[];
 let cursor=0,remaining=requests.length,failed=false;
 const current=()=>options.current()&&!options.signal.aborted;
 const consume=async()=>{for(;;){if(!current())return;const target=requests[cursor++];if(!target)return;
   if(blocked.has(target.account_id)){remaining--;continue;}
   let controller=controllers.get(target.account_id);if(!controller){controller=new AbortController();controllers.set(target.account_id,controller);}
   const signal=AbortSignal.any([options.signal,controller.signal]);
   try{const row=await options.read(target,signal);if(current()&&!signal.aborted&&!blocked.has(target.account_id)){
     if(row.account_id!==target.account_id||row.logical_message_id!==target.logical_message_id)throw Error('Message details could not be confirmed.');items.push(row);}}
   catch(error){if(options.current()&&!blocked.has(target.account_id)){
     if(error instanceof NativeSummaryError&&[401,403].includes(error.status)){blocked.add(target.account_id);controller.abort();options.denied(target.account_id);}
     else failed=true;}}
   finally{remaining--;}
 }};
 try{await Promise.all([consume(),consume()]);return {items:items.filter(row=>!blocked.has(row.account_id)),incomplete:failed||remaining>0||options.signal.aborted,deniedAccounts:[...blocked]};}
 finally{for(const controller of controllers.values())controller.abort();}
}
/** Back/forward and account discovery are nominations, never authority. A
 * different target clears before lookup. The exact already-selected current
 * target may stay visible while its fresh guarded summary is revalidated. */
export function createNativeMessageLinkResolver(options:{current:()=>boolean;selected?:()=>NativeEmailMessage|null;read:(target:NativeMessageTarget,signal:AbortSignal)=>Promise<NativeEmailMessage>;change:(row:NativeEmailMessage|null,notice:string)=>void;opening?:(target:NativeMessageTarget)=>void;denied?:(accountId:string)=>void}){
 let active=true,ticket=0,held:AbortController|null=null,linked=false;const current=()=>active&&options.current();
 return {load:async(search:string,accountIds:readonly string[],ready:boolean)=>{
  const own=++ticket;held?.abort();held=null;let target:NativeMessageTarget|null;try{target=parseNativeMessageLink(search);}catch(error){linked=true;if(current())options.change(null,error instanceof Error?error.message:'Message link is unavailable.');return;}
  if(!target){if(linked&&current())options.change(null,'');linked=false;return;}linked=true;if(!current())return;
  const selected=options.selected?.(),sameTarget=ready&&accountIds.includes(target.account_id)&&selected?.account_id===target.account_id&&selected.logical_message_id===target.logical_message_id;
  if(!sameTarget)options.change(null,ready?'Opening message…':'Loading connected accounts…');if(!ready||!current())return;
  if(!accountIds.includes(target.account_id)){options.change(null,'This message is unavailable for your connected accounts.');return;}
  const controller=new AbortController();held=controller;try{options.opening?.(target);if(!current()||ticket!==own||controller.signal.aborted)return;const row=await options.read(target,controller.signal);if(!current()||ticket!==own||controller.signal.aborted)return;if(row.account_id!==target.account_id||row.logical_message_id!==target.logical_message_id)throw Error('Message link is unavailable.');options.change(row,'');}
  catch(error){if(current()&&ticket===own&&!controller.signal.aborted){if(error instanceof NativeSummaryError&&[401,403].includes(error.status))options.denied?.(target.account_id);options.change(null,error instanceof Error?error.message:'This message is unavailable.');}}
 },dispose:()=>{active=false;ticket++;held?.abort();}};
}
/** Bounded two-reader fan-out over the explicit loaded timer list (maximum500,
 * matching the existing timer list controller). Never scans other messages. */
export async function readNativeTimerSummaries(accountId:string,logicalIds:readonly string[],read:(target:NativeMessageTarget)=>Promise<NativeEmailMessage>,current:()=>boolean){
 if(logicalIds.length>500)throw Error('Timer page is too large.');const ids=[...new Set(logicalIds)],rows:Record<string,NativeEmailMessage|null>={};let next=0;
 const consume=async()=>{for(;;){const logical_message_id=ids[next++];if(!logical_message_id||!current())return;try{const row=await read({account_id:accountId,logical_message_id});if(row.account_id!==accountId||row.logical_message_id!==logical_message_id)throw Error('Message details could not be confirmed.');if(current())rows[logical_message_id]=row;}catch(error){if(error instanceof NativeSummaryError&&[401,403].includes(error.status))throw error;if(current())rows[logical_message_id]=null;}}};
 await Promise.all([consume(),consume()]);return rows;
}
