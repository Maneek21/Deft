'use client';
import {useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createNativeEmailFolders,nativeFolderLabel,type NativeFolderState} from '@/lib/email-native-folders';

export function NativeEmailKnowledgeFolders({accountId,sessionScope,excluded,disabled,onChange}:{accountId:string;sessionScope:string;excluded:string[];disabled:boolean;onChange:(folders:string[])=>void}) {
  const [open,setOpen]=useState(false),[attempt,setAttempt]=useState(0),[state,setState]=useState<NativeFolderState|null>(null),client=useRef<ReturnType<typeof createNativeEmailFolders>|null>(null);
  useEffect(()=>{
    if(!open)return;
    let active=true;const anchor=api.getAccessToken(),value=createNativeEmailFolders({accountIds:[accountId],current:()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken()),fetch:(path,init)=>api.fetch(path,init),change:setState,denied:()=>setState(null)});client.current=value;void value.start();
    return()=>{active=false;value.dispose();client.current=null;};
  },[accountId,sessionScope,open,attempt]);
  const account=state?.accounts[0],basic=[{id:'inbox',label:'Inbox'},{id:'sent',label:'Sent'},{id:'archive',label:'Archive'}],custom=account?.items.filter(item=>!['inbox','sent','archive','spam','trash','drafts'].includes(item.folder_id)).map(item=>({id:item.folder_id,label:nativeFolderLabel(item,account.items)}))??[];
  const folders=[...basic,...custom];
  return <div className="space-y-2"><p className="text-xs">Skip folders</p><div role="group" aria-label="Excluded email folders" className="flex flex-wrap gap-2">{folders.map(folder=><button type="button" key={folder.id} aria-pressed={excluded.includes(folder.id)} disabled={disabled} onClick={()=>onChange(excluded.includes(folder.id)?excluded.filter(id=>id!==folder.id):[...excluded,folder.id])} className={'rounded-full px-3 py-2 text-xs focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50 '+(excluded.includes(folder.id)?'bg-[var(--accent-light)] text-[var(--primary)]':'bg-[var(--surface)] hover:bg-[var(--hover-tint)]')}>{folder.label}</button>)}</div><p className="text-xs text-[var(--text-secondary)]">Spam, Trash and unsent drafts are always skipped.</p>{!open?<button type="button" onClick={()=>setOpen(true)} className="rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)]">Choose other folders</button>:<>{account?.notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{account.notice}</p>}{state?.busy&&<p role="status" className="text-xs text-[var(--text-secondary)]">Loading folders…</p>}<div className="flex gap-2">{account?.nextCursor&&<button type="button" disabled={state?.busy} onClick={()=>void client.current?.more(accountId)} className="rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)]">More folders</button>}<button type="button" disabled={state?.busy} onClick={()=>setAttempt(value=>value+1)} className="rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)]">Reload folders</button></div></>}</div>;
}
