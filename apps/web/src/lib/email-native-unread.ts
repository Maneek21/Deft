export type NativeUnreadAccount={account_id:string;coverage:'partial'|'complete';sync_state:'idle'|'queued'|'syncing'|'failed'|'paused';checkpoint_revision:number;observed_at:string|null;fresh_until:string|null};
export type NativeUnreadSnapshot={folder:'inbox';unread_count:number|null;cached_unread_count:number|null;coverage:'partial'|'complete';accounts:NativeUnreadAccount[]};
export type NativeUnreadDisplay={count:number|null;text:string;label:string};
export type NativeUnreadState={key:string;snapshot:NativeUnreadSnapshot|null;busy:boolean;denied:boolean;notice:string};
export const NATIVE_UNREAD_POLL_MS=60000;
const validId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const record=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const count=(v:unknown):v is number|null=>v===null||typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=5000000;
const date=(v:unknown):v is string|null=>v===null||typeof v==='string'&&v.length<=40&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(v)&&Number.isFinite(Date.parse(v));
const fail=():never=>{throw Error('Unread count could not be confirmed.');};
export function nativeUnreadScopeKey(accountIds:readonly string[]):string{if(accountIds.length>50||accountIds.some(v=>!validId(v))||new Set(accountIds).size!==accountIds.length)return fail();return JSON.stringify([...accountIds].sort());}
function parseAccount(raw:unknown):NativeUnreadAccount{
 const keys=['account_id','coverage','sync_state','checkpoint_revision','observed_at','fresh_until'];
 if(!record(raw,keys)||!validId(raw.account_id)||!['partial','complete'].includes(String(raw.coverage))||!['idle','queued','syncing','failed','paused'].includes(String(raw.sync_state))||typeof raw.checkpoint_revision!=='number'||!Number.isSafeInteger(raw.checkpoint_revision)||raw.checkpoint_revision<0||raw.checkpoint_revision>2147483647||!date(raw.observed_at)||!date(raw.fresh_until))return fail();return raw as NativeUnreadAccount;
}
export function parseNativeUnread(raw:unknown,accountIds:readonly string[]):NativeUnreadSnapshot{
 nativeUnreadScopeKey(accountIds);if(!accountIds.length)return fail();const keys=['folder','unread_count','cached_unread_count','coverage'];let value:Record<string,unknown>,accounts:NativeUnreadAccount[];
 if(accountIds.length===1){if(!record(raw,[...keys,'account_id','sync_state','checkpoint_revision','observed_at','fresh_until']))return fail();value=raw;accounts=[parseAccount({account_id:raw.account_id,coverage:raw.coverage,sync_state:raw.sync_state,checkpoint_revision:raw.checkpoint_revision,observed_at:raw.observed_at,fresh_until:raw.fresh_until})];}
 else{if(!record(raw,[...keys,'accounts'])||!Array.isArray(raw.accounts)||raw.accounts.length!==accountIds.length)return fail();value=raw;accounts=raw.accounts.map(parseAccount);}
 if(value.folder!=='inbox'||!count(value.unread_count)||!count(value.cached_unread_count)||!['partial','complete'].includes(String(value.coverage))||nativeUnreadScopeKey(accounts.map(row=>row.account_id))!==nativeUnreadScopeKey(accountIds)||value.coverage!==(accounts.every(row=>row.coverage==='complete')?'complete':'partial')||value.coverage==='partial'&&value.unread_count!==null||value.unread_count!==null&&value.unread_count!==value.cached_unread_count)return fail();
 return {folder:'inbox',unread_count:value.unread_count,cached_unread_count:value.cached_unread_count,coverage:value.coverage as NativeUnreadSnapshot['coverage'],accounts};
}
/** Only a fresh, complete bounded snapshot supplies a sidebar number. Partial
 * or stale cached counts remain useful text inside Email, never an exact badge. */
export function nativeUnreadDisplay(value:NativeUnreadSnapshot|null,now=Date.now()):NativeUnreadDisplay{
 if(!value)return {count:null,text:'',label:'Unread count unavailable'};
 const fresh=value.accounts.every(row=>row.fresh_until!==null&&Date.parse(row.fresh_until)>now&&row.observed_at!==null&&Date.parse(row.observed_at)<=now);
 if(value.coverage==='complete'&&fresh&&value.unread_count!==null)return {count:value.unread_count,text:`${value.unread_count} unread`,label:`${value.unread_count} unread messages in the synced Inbox`};
 if(value.cached_unread_count!==null)return {count:null,text:`${value.cached_unread_count} cached unread`,label:`${value.cached_unread_count} unread messages in loaded mail. The current Inbox total is not confirmed.`};
 return {count:null,text:'Unread count unavailable',label:'Unread count is unavailable until mailbox sync can confirm it.'};
}
/** A pending first read is loading, while a failed refresh may describe only
 * the last confirmed cache. Access denial always clears that cache. */
export function nativeUnreadStateDisplay(value:NativeUnreadState|null,now=Date.now()):NativeUnreadDisplay{
 if(!value||value.busy&&!value.snapshot)return {count:null,text:'Checking unread…',label:'Checking unread count'};
 if(value.denied)return {count:null,text:'Unread access changed',label:'Unread access changed. Open Email settings to reconnect.'};
 if(value.notice){const cached=value.snapshot?.cached_unread_count;
  return cached===null||cached===undefined?{count:null,text:'Unread count unavailable',label:'Unread count could not be updated. Try Refresh.'}
   :{count:null,text:`${cached} cached unread · update unavailable`,label:`${cached} unread messages in previously loaded mail. The current Inbox total could not be updated.`};}
 return nativeUnreadDisplay(value.snapshot,now);
}
export function createNativeEmailUnread(ports:{accountIds:readonly string[];current:()=>boolean;fetch:(path:string,init:RequestInit)=>Promise<Response>;change:(value:NativeUnreadState)=>void;denied?:(accountId:string|null)=>void;clock?:{now:()=>number;set:(callback:()=>void,delay:number)=>unknown;clear:(timer:unknown)=>void}}){
 const ids=[...ports.accountIds],key=nativeUnreadScopeKey(ids),controller=new AbortController();let active=true,wanted=false;
 const clock=ports.clock??{now:()=>Date.now(),set:(callback:()=>void,delay:number)=>setTimeout(callback,delay),clear:(timer:unknown)=>clearTimeout(timer as ReturnType<typeof setTimeout>)};let expiry:unknown=null;
 let value:NativeUnreadState={key,snapshot:null,busy:false,denied:false,notice:''};const current=()=>active&&!controller.signal.aborted&&ports.current(),publish=()=>{if(expiry!==null){clock.clear(expiry);expiry=null;}if(current()){ports.change(structuredClone(value));const now=clock.now();if(value.snapshot&&nativeUnreadDisplay(value.snapshot,now).count!==null){const due=Math.min(...value.snapshot.accounts.map(row=>Date.parse(row.fresh_until!)));expiry=clock.set(()=>{expiry=null;publish();},Math.min(2147483647,Math.max(1,due-now)));}}};
 const query=new URLSearchParams({folder:'inbox'});if(ids.length>1)for(const id of [...ids].sort())query.append('account_id',id);
 const path=ids.length===1?`/api/email/accounts/${encodeURIComponent(ids[0])}/unread?${query}`:`/api/email/unread?${query}`;
 const load=async()=>{if(!current()||value.denied||!ids.length)return;if(value.busy){wanted=true;return;}value={...value,busy:true};publish();
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
  try{const response=await ports.fetch(path,{method:'GET',cache:'no-store',signal});signal.throwIfAborted();if(!current()){await response.body?.cancel().catch(()=>{});return;}
   if(!response.ok){await response.body?.cancel().catch(()=>{});if([401,403].includes(response.status)){value={...value,snapshot:null,denied:true,notice:'Unread access changed.'};ports.denied?.(ids.length===1?ids[0]:null);}else value={...value,notice:'Unread count unavailable.'};return;}
   if(!response.body)return fail();const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
   try{for(;;){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;bytes+=part.value.byteLength;if(bytes>32768)return fail();text+=decoder.decode(part.value,{stream:true});}if(!current())return;const snapshot=parseNativeUnread(JSON.parse(text+decoder.decode()),ids);if(current())value={...value,snapshot,notice:''};}
   finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
  }catch{if(current())value={...value,notice:'Unread count unavailable.'};}
  finally{value={...value,busy:false};publish();if(wanted&&current()&&!value.denied){wanted=false;queueMicrotask(()=>{if(current())void load();});}}
 };
 return {load,snapshot:()=>structuredClone(value),dispose(){active=false;wanted=false;if(expiry!==null)clock.clear(expiry);expiry=null;controller.abort();value={...value,snapshot:null};}};
}
