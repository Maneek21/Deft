'use client';
import {useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createNativeEmailConnectionTargets,nativeEmailConnectionKey,type NativeEmailConnectionState,type NativeEmailConnectionTarget} from '@/lib/email-native-connection-targets';
const button='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
export function NativeEmailRetainedConnectionList({state,activeAccountIds=[],onRefresh,onAdopt}:{state:NativeEmailConnectionState;activeAccountIds?:readonly string[];onRefresh:()=>void;onAdopt:(target:NativeEmailConnectionTarget)=>void}){
 return <section aria-label="Existing email connections" className="space-y-3"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Existing connections</h3><button type="button" disabled={state.busy||state.state==='denied'} onClick={onRefresh} className={button}>Refresh connections</button></div>
  <p className="text-xs leading-5 text-[var(--text-secondary)]">Use your already connected accounts in Deft. This uses their existing connection and keeps agent access separate.</p>
  {state.targets.map(target=>{const key=nativeEmailConnectionKey(target),uncertain=state.uncertain.includes(key),alreadyEnabled=activeAccountIds.includes(target.native_email.account_id);return <div key={key} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--surface-container-low)] px-4 py-3"><div className="min-w-0"><p className="break-words text-sm">{target.primary_address}</p><p className="mt-1 text-xs text-[var(--muted)]">{target.provider==='gmail'?'Gmail':'Microsoft'} · {alreadyEnabled?'Already in Email':target.native_email.state==='active'?'Enabled in Deft':target.native_email.state==='unavailable'?'Setup unavailable':uncertain?'Setup not confirmed':'Connected'}</p></div>
   {!alreadyEnabled&&target.native_email.state==='available'&&<button type="button" className={`${button} bg-[var(--accent-light)] text-[var(--primary)]`} disabled={state.busy||uncertain} onClick={()=>onAdopt(target)}>{state.working===key?'Enabling…':'Use in Deft'}</button>}
  </div>;})}
  {state.state==='loading'&&<p role="status" className="text-xs text-[var(--muted)]">Checking existing connections…</p>}{state.state==='available'&&!state.targets.length&&<p className="text-xs text-[var(--muted)]">No healthy existing connections were found for this account setup.</p>}
  {state.hasMore&&<p className="text-xs text-[var(--muted)]">More connections may exist. The first 50 reviewed connections are shown.</p>}{state.unavailableCount>0&&<p className="text-xs text-[var(--muted)]">{state.unavailableCount} existing connection{state.unavailableCount===1?' is':'s are'} unavailable for this setup.</p>}
  {state.notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{state.notice}</p>}
 </section>;
}
export function NativeEmailRetainedConnections({sessionScope,activeAccountIds,onAdopted}:{sessionScope:string;activeAccountIds?:readonly string[];onAdopted:()=>void}){
 const [state,setState]=useState<NativeEmailConnectionState>({state:'loading',targets:[],hasMore:false,unavailableCount:0,busy:false,working:null,uncertain:[],notice:''});
 const client=useRef<ReturnType<typeof createNativeEmailConnectionTargets>|null>(null),callback=useRef(onAdopted);useEffect(()=>{callback.current=onAdopted;},[onAdopted]);
 useEffect(()=>{
  const anchor=api.getAccessToken();let active=true;const current=()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
  const owned=createNativeEmailConnectionTargets({fetch:(path,options)=>api.fetch(path,options),current,change:setState,adopted:()=>callback.current()});client.current=owned;void owned.load();
  return()=>{active=false;owned.dispose();if(client.current===owned)client.current=null;};
 },[sessionScope]);
 return <NativeEmailRetainedConnectionList state={state} activeAccountIds={activeAccountIds} onRefresh={()=>void client.current?.load()} onAdopt={target=>void client.current?.adopt(target)}/>;
}
