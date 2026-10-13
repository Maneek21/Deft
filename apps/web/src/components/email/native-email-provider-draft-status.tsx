'use client';
import {useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createProviderDraftStatus,providerDraftStatusText,type ProviderDraftStatusView} from '@/lib/email-provider-draft-status';
const initial:ProviderDraftStatusView={value:null,busy:false,notice:'',recoveryPending:false};
const button='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
export function NativeEmailProviderDraftStatusView({view,editable,onCheck,onReconcile,onSettings}:{view:ProviderDraftStatusView;editable:boolean;onCheck:()=>void;onReconcile:()=>void;onSettings?:()=>void}){
 return <section aria-label="Provider draft status" className="space-y-1 text-xs text-[var(--text-secondary)]">
  {view.value&&<p>{providerDraftStatusText(view.value)}</p>}
  {view.notice&&<p role="status">{view.notice}</p>}
  <div className="flex flex-wrap items-center gap-1"><button type="button" onClick={onCheck} disabled={view.busy} className={button}>{view.busy?'Checking…':'Check provider draft status'}</button>
   {view.value?.recovery_available&&<button type="button" onClick={onReconcile} disabled={!editable||view.busy||view.recoveryPending} className={button+' text-[var(--primary)]'}>Reconcile provider draft</button>}
   {onSettings&&view.value&&(!view.value.enabled||view.value.state==='paused')&&<button type="button" onClick={onSettings} className={button}>Draft sync settings</button>}
  </div>
  {view.value?.recovery_available&&<p>Checks an interrupted update and may finish its remaining saved changes. It does not create another copy.{!editable?' Save your current edits first.':''}</p>}
 </section>;
}
export function NativeEmailProviderDraftStatus({accountId,draftId,revision,sessionScope,editable,onDenied,onSettings}:{accountId:string;draftId:string;revision:number;sessionScope:string;editable:boolean;onDenied:()=>void;onSettings?:()=>void}){
 const [view,setView]=useState<ProviderDraftStatusView>(initial),client=useRef<ReturnType<typeof createProviderDraftStatus>|null>(null),denied=useRef(onDenied);
 useEffect(()=>{denied.current=onDenied;},[onDenied]);
 useEffect(()=>{
  const anchor=api.getAccessToken();let active=true;
  const current=()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
  const value=createProviderDraftStatus({accountId,draftId,current,fetch:(path,options)=>api.fetch(path,options),change:setView,denied:()=>denied.current()});client.current=value;void value.check();
  return()=>{active=false;value.dispose();if(client.current===value)client.current=null;};
 },[accountId,draftId,revision,sessionScope]);
 const savedCurrent=editable&&view.value?.draft_revision===revision;
 return <NativeEmailProviderDraftStatusView view={view} editable={savedCurrent} onCheck={()=>void client.current?.check()} onReconcile={()=>{if(savedCurrent)void client.current?.reconcile();}} onSettings={onSettings}/>;
}
