'use client';
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {useChatContext} from '@/lib/chat-context';
import {parseEmailDeftyHandoff} from '@/lib/email-native-defty-context';
export function NativeEmailAskDefty({accountId,logicalMessageId,sessionScope}:{accountId:string;logicalMessageId:string;sessionScope:string}) {
  const router=useRouter(),{refreshSpaces}=useChatContext(),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),owner=useRef<AbortController|null>(null);
  useEffect(()=>()=>{owner.current?.abort();},[accountId,logicalMessageId,sessionScope]);
  const open=async()=>{
    if(owner.current||sessionScope!==getActiveSessionCacheScope())return;
    const controller=new AbortController(),anchor=api.getAccessToken();owner.current=controller;setBusy(true);setNotice('');
    const current=()=>!controller.signal.aborted&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
    try {
      const response=await api.fetch('/api/email/accounts/'+encodeURIComponent(accountId)+'/messages/'+encodeURIComponent(logicalMessageId)+'/defty-context',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});
      if(!response.ok)throw Error(response.status===403?'Allow Defty to read this account in Email settings, then try again.':'Defty could not be opened. Try again.');
      const text=await response.text();if(text.length>8192)throw Error('Defty could not be opened.');const value=parseEmailDeftyHandoff(JSON.parse(text),{accountId,messageId:logicalMessageId});
      if(current()){refreshSpaces();router.push(value.url);}
    }catch(error){if(current())setNotice(error instanceof Error?error.message:'Defty could not be opened.');}
    finally{if(current())setBusy(false);if(owner.current===controller)owner.current=null;}
  };
  return <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={busy} onClick={()=>void open()} className="rounded-full px-3 py-2 text-sm text-[var(--primary)] hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50">{busy?'Opening Defty…':'Ask Defty'}</button>{notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{notice}</p>}</div>;
}
