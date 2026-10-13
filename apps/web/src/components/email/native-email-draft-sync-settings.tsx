'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {emailProviderDraftSettingRequest,type EmailProviderDraftSetting} from '@/lib/email-provider-draft-settings';
export function NativeEmailDraftSyncSettings({accountId,provider,sessionScope}:{accountId:string;provider:string;sessionScope:string}){
 const id=useId(),[saved,setSaved]=useState<EmailProviderDraftSetting|null>(null),[choice,setChoice]=useState(false),[working,setWorking]=useState(false),[uncertain,setUncertain]=useState(false);
 const [notice,setNotice]=useState('Checking saved draft sync choice…'),[reload,setReload]=useState(0),generation=useRef(0),pending=useRef<AbortController|null>(null);
 useEffect(()=>{
  const ticket=++generation.current,anchor=api.getAccessToken(),controller=new AbortController();let active=true;
  const current=()=>active&&!controller.signal.aborted&&ticket===generation.current&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
  setSaved(null);setChoice(false);setWorking(false);setUncertain(false);setNotice('Checking saved draft sync choice…');
  void emailProviderDraftSettingRequest(accountId,{fetch:(path,options)=>api.fetch(path,options),current},undefined,controller.signal).then(value=>{if(current()){setSaved(value);setChoice(value.enabled);setNotice('');}}).catch(error=>{if(current())setNotice(error instanceof Error?error.message:'Draft sync choices are unavailable.');});
  return()=>{active=false;controller.abort();pending.current?.abort();pending.current=null;};
 },[accountId,sessionScope,reload]);
 const save=async()=>{
  if(!saved||working||uncertain||choice===saved.enabled||choice&&!saved.supported||pending.current)return;
  const ticket=generation.current,anchor=api.getAccessToken(),controller=new AbortController();pending.current=controller;
  const current=()=>!controller.signal.aborted&&ticket===generation.current&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
  setWorking(true);setNotice('Saving draft sync choice…');
  try{const value=await emailProviderDraftSettingRequest(accountId,{fetch:(path,options)=>api.fetch(path,options),current},{enabled:choice,expected_revision:saved.revision},controller.signal);
   if(current()){setSaved(value);setChoice(value.enabled);setNotice(value.enabled?'Draft syncing enabled. Changes may take a moment to appear in your provider.':'Draft syncing turned off. Drafts already in your provider are kept.');}}
  catch(error){if(current()){setUncertain(true);setNotice(error instanceof Error?error.message:'This choice could not be confirmed. Reload its saved value.');}}
  finally{if(current())setWorking(false);if(pending.current===controller)pending.current=null;}
 };
 return <section aria-labelledby={id+'-title'} className="space-y-3 pt-5 text-sm"><h4 id={id+'-title'} className="font-medium">Provider drafts</h4>
  <label className="flex items-center gap-3"><input type="checkbox" checked={choice} onChange={event=>setChoice(event.target.checked)} disabled={!saved||working||uncertain||!saved.supported&&!saved.enabled} className="accent-[var(--primary)]"/><span>Sync Deft drafts to provider</span></label>
  <p className="text-xs leading-5 text-[var(--text-secondary)]">Off by default. This syncs drafts saved in Deft and does not import all existing provider drafts.</p>
  {provider==='microsoft'&&<p className="text-xs leading-5 text-[var(--text-secondary)]">Microsoft supports drafts up to 3 MiB. Interrupted updates may need reconciliation from the draft; uncertain changes are not repeated automatically.</p>}
  {!['gmail','microsoft'].includes(provider)?<p className="text-xs leading-5 text-[var(--text-secondary)]">Draft syncing is not available for this provider yet.</p>:saved&&!saved.supported&&<p className="text-xs leading-5 text-[var(--text-secondary)]">Reconnect this account with permission to manage drafts before enabling sync.</p>}
  <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={!saved||working||uncertain||choice===saved.enabled||choice&&!saved.supported} onClick={()=>void save()} className="rounded-full bg-[var(--accent-light)] px-3 py-2 text-xs text-[var(--primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50">{working?'Saving…':'Save draft sync choice'}</button><button type="button" disabled={working} onClick={()=>setReload(value=>value+1)} className="rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50">Reload saved choice</button></div>
  {notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{notice}</p>}
 </section>;
}
