'use client';
import {useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createDirectEmailConnections,directEmailSessionTag,type DirectEmailCapability,type DirectEmailFlowState,type DirectEmailProvider,type DirectEmailReconnect} from '@/lib/email-native-direct-connections';

const button='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
const providerName=(provider:DirectEmailProvider)=>provider==='gmail'?'Gmail':'Microsoft';
const initialState:DirectEmailFlowState={providers:[],status:null,pending:null,busy:false,denied:false,notice:''};
export function NativeEmailDirectConnectionView({state,selected,caps,reconnect,navigationBlocked=false,accessUnavailable=false,onSelect,onCaps,onBegin,onContinue,onCheck,onReset,onCancelReconnect}:{state:DirectEmailFlowState;selected:DirectEmailProvider|null;caps:DirectEmailCapability[];reconnect?:DirectEmailReconnect|null;navigationBlocked?:boolean;accessUnavailable?:boolean;onSelect:(provider:DirectEmailProvider)=>void;onCaps:(caps:DirectEmailCapability[])=>void;onBegin:()=>void;onContinue:()=>void;onCheck:()=>void;onReset:()=>void;onCancelReconnect:()=>void}){
 const offered=state.providers.find(row=>row.provider===selected),pending=!!state.pending,disabled=state.busy||state.denied;
 const terminal=state.status&&['connected','failed','expired'].includes(state.status.state);
 return <section aria-label="Connect an Email account" className="space-y-3">
  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">Connect an account</h3>{!pending&&<button type="button" className={button} disabled={disabled} onClick={onCheck}>Refresh options</button>}</div>
  {!pending&&<><div className="flex flex-wrap gap-2">{state.providers.filter(row=>!reconnect||row.provider===reconnect.provider).map(row=><button key={row.provider} type="button" aria-pressed={selected===row.provider} className={`${button} ${selected===row.provider?'bg-[var(--accent-light)] text-[var(--primary)]':'bg-[var(--surface-container-low)]'}`} disabled={disabled} onClick={()=>onSelect(row.provider)}>{providerName(row.provider)}</button>)}</div>
   {reconnect&&<p className="text-xs text-[var(--text-secondary)]">Reconnect {reconnect.label}. Choose the same provider account.</p>}
   {offered&&<><fieldset className="flex flex-wrap gap-4 text-xs"><legend className="mb-2 text-[var(--muted)]">Access for this Email account</legend>{(['read','modify','send'] as DirectEmailCapability[]).map(cap=><label key={cap} className="flex items-center gap-2"><input type="checkbox" checked={caps.includes(cap)} disabled={disabled||cap==='read'||!offered.capabilities.includes(cap)} onChange={event=>onCaps(event.target.checked?[...caps,cap]:caps.filter(v=>v!==cap))}/>{cap==='read'?'Read mail':cap==='modify'?'Organize mail':'Send mail'}{!offered.capabilities.includes(cap)&&<span className="text-[var(--muted)]">unavailable</span>}</label>)}</fieldset>
    <p className="text-xs text-[var(--muted)]">Email access is separate from agent access.</p>
    {accessUnavailable&&<p role="status" className="text-xs text-[var(--muted)]">Some current access is unavailable. Refresh options before reconnecting.</p>}
    <button type="button" className={`${button} bg-[var(--accent-light)] text-[var(--primary)]`} disabled={disabled||navigationBlocked||accessUnavailable} onClick={onBegin}>Connect {providerName(offered.provider)}</button>
   </>}
   {reconnect&&<button type="button" className={button} disabled={disabled} onClick={onCancelReconnect}>Connect a different account</button>}
   {!state.busy&&!state.providers.length&&!state.notice&&<p className="text-xs text-[var(--muted)]">Gmail and Microsoft account setup is unavailable right now. Existing connections remain available below.</p>}
  </>}
  {pending&&<div className="flex flex-wrap gap-2">
   {state.status?.state==='pending'&&<button type="button" className={`${button} bg-[var(--accent-light)] text-[var(--primary)]`} disabled={disabled||navigationBlocked} onClick={onContinue}>Continue with {providerName(state.status.provider)}</button>}
   {!terminal&&<button type="button" className={button} disabled={disabled} onClick={onCheck}>Check connection status</button>}
   {terminal&&<button type="button" className={button} disabled={disabled} onClick={onReset}>{state.status?.state==='connected'?'Connect another account':'Start a new connection'}</button>}
  </div>}
  {state.status?.state==='connected'&&state.status.primary_address&&<p className="break-words text-sm">{state.status.primary_address}</p>}
  {navigationBlocked&&<p className="text-xs text-[var(--muted)]">Save and close your draft before continuing account setup.</p>}
  {state.notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{state.notice}</p>}
  {state.busy&&!state.notice&&<p role="status" className="text-xs text-[var(--muted)]">Checking account setup…</p>}
 </section>;
}
export function NativeEmailDirectConnections({sessionScope,reconnect,navigationBlocked=false,onConnected,onCancelReconnect}:{sessionScope:string;reconnect?:DirectEmailReconnect|null;navigationBlocked?:boolean;onConnected:()=>void;onCancelReconnect:()=>void}){
 const [state,setState]=useState(initialState),[selected,setSelected]=useState<DirectEmailProvider|null>(null),[choice,setChoice]=useState<{owner:string;caps:DirectEmailCapability[]}|null>(null);
 const client=useRef<ReturnType<typeof createDirectEmailConnections>|null>(null),callback=useRef(onConnected);useEffect(()=>{callback.current=onConnected;},[onConnected]);
 useEffect(()=>{const anchor=api.getAccessToken();let active=true;const current=()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());void (async()=>{
  try{const tag=await directEmailSessionTag(sessionScope);if(!current())return;const owned=createDirectEmailConnections({sessionTag:tag,storage:sessionStorage,current,fetch:(path,init)=>api.fetch(path,init),change:setState,connected:()=>callback.current()});client.current=owned;await owned.load();}
  catch{if(current())setState({...initialState,notice:'Account setup needs a current signed-in session. Refresh Email to continue.'});}
 })();return()=>{active=false;client.current?.dispose();client.current=null;};},[sessionScope]);
 // A reconnect nomination comes from a fresh owner-scoped management row;
 // its account ID remains a nomination, revalidated by the server.
 const effectiveProvider=reconnect?.provider??selected;
 const offered=state.providers.find(row=>row.provider===effectiveProvider),choiceOwner=JSON.stringify([sessionScope,effectiveProvider,reconnect?.account_id??null,reconnect?.capabilities??null]),currentOwner=useRef(choiceOwner);currentOwner.current=choiceOwner;
 const effectiveCaps=choice?.owner===choiceOwner?choice.caps:reconnect?[...reconnect.capabilities]:[...(offered?.capabilities??['read'])];
 const accessUnavailable=!!reconnect&&effectiveCaps.some(cap=>!offered?.capabilities.includes(cap));
 const currentChoice=()=>currentOwner.current===choiceOwner&&sessionScope===getActiveSessionCacheScope();
 return <NativeEmailDirectConnectionView state={state} selected={effectiveProvider} caps={effectiveCaps} reconnect={reconnect} navigationBlocked={navigationBlocked} accessUnavailable={accessUnavailable} onSelect={value=>{if(!currentChoice())return;if(value!==effectiveProvider)setChoice(null);setSelected(value);}} onCaps={caps=>{if(currentChoice())setChoice({owner:choiceOwner,caps:[...caps]});}}
  onBegin={()=>{if(currentChoice()&&effectiveProvider&&!navigationBlocked&&!accessUnavailable)void client.current?.begin(effectiveProvider,effectiveCaps,reconnect?.account_id);}}
  onContinue={()=>{if(navigationBlocked)return;const url=client.current?.continuation();if(url)window.location.assign(url);else void client.current?.check();}}
  onCheck={()=>void (state.pending?client.current?.check():client.current?.load())}
  onReset={()=>{client.current?.reset();setSelected(null);setChoice(null);onCancelReconnect();}} onCancelReconnect={onCancelReconnect}/>;
}
