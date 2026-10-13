'use client';
import {useEffect,useRef,useState} from 'react';
import {nativeMailtoHandlerPath,parseNativeMailtoFragment} from '@/lib/email-native-mailto';
import type {NativeDraftContent} from '@/lib/email-native-drafts';

type MailtoAccount={account_id:string;primary_address:string;capabilities?:readonly string[]};
/** Mount with key=sessionScope so pending private compose input never crosses sign-ins. */
export function NativeEmailMailto({accounts,composerOpen,onCompose}:{accounts:MailtoAccount[];composerOpen:boolean;onCompose:(accountId:string,content:NativeDraftContent)=>void}){
 const [pending,setPending]=useState<ReturnType<typeof parseNativeMailtoFragment>>(null),[notice,setNotice]=useState(''),[account,setAccount]=useState('');
 const hasPending=useRef(false);
 useEffect(()=>{
  const receive=()=>{
   if(!window.location.hash.startsWith('#compose='))return;
   const hash=window.location.hash;
   window.history.replaceState(window.history.state,'',window.location.pathname+window.location.search);
   try{const next=parseNativeMailtoFragment(hash);if(hasPending.current){setNotice('Another email link arrived. Open or dismiss this one, then open the other link again.');return;}hasPending.current=!!next;setPending(next);}
   catch{setNotice('This email link could not be opened. Check its addresses and try again.');}
  };
  receive();window.addEventListener('hashchange',receive);return()=>window.removeEventListener('hashchange',receive);
 },[]);
 const senders=accounts.filter(row=>row.capabilities?.includes('send')),chosen=senders.find(row=>row.account_id===account)??(senders.length===1?senders[0]:undefined);
 if(!pending&&!notice)return null;
 return <section aria-label="Email link" className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4 text-sm">
  {pending&&<><p className="font-medium">Open email link</p><p className="truncate text-[var(--text-secondary)]">{pending.content.subject||pending.content.to||'New message'}</p>
   {senders.length>1&&<label className="block space-y-1"><span>Send from</span><select aria-label="Email link sending account" value={account} onChange={event=>setAccount(event.target.value)} className="w-full rounded-full bg-[var(--surface)] px-3 py-2"><option value="">Choose an account</option>{senders.map(row=><option key={row.account_id} value={row.account_id}>{row.primary_address}</option>)}</select></label>}
   {!senders.length&&<p>Connect an account with sending enabled in Email settings.</p>}
   {composerOpen&&<p>Save and close your current draft to open this email link.</p>}
   {!!pending.ignoredFields.length&&<p className="text-xs text-[var(--muted)]">Only recipients, subject and message text will be included.</p>}
   <button type="button" disabled={!chosen||composerOpen} onClick={()=>{if(!chosen||composerOpen)return;onCompose(chosen.account_id,pending.content);hasPending.current=false;setPending(null);setNotice('');}} className="rounded-full bg-[var(--accent-light)] px-3 py-2 text-[var(--primary)] disabled:opacity-50">Review draft</button></>}
  {notice&&<p role="status">{notice}</p>}<button type="button" onClick={()=>{hasPending.current=false;setPending(null);setNotice('');}} className="rounded-full px-3 py-2 hover:bg-[var(--hover-tint)]">Dismiss</button>
 </section>;
}

export function NativeEmailMailtoSettings(){
 const [notice,setNotice]=useState('');
 const request=()=>{
  if(!window.isSecureContext||typeof navigator.registerProtocolHandler!=='function'){setNotice('This browser cannot set Deft as an email link handler. You can still compose mail in Deft.');return;}
  try{navigator.registerProtocolHandler('mailto',new URL(nativeMailtoHandlerPath(),window.location.origin).href);setNotice('If your browser asks, allow Deft to open email links. You can change this in browser settings.');}
  catch{setNotice('Your browser did not allow this change. Check its site permissions for protocol handlers.');}
 };
 return <section className="space-y-2"><h3 className="text-sm font-medium">Email links</h3><button type="button" onClick={request} className="rounded-full bg-[var(--surface-container-low)] px-4 py-2 text-sm hover:bg-[var(--hover-tint)]">Open email links in Deft</button>{notice&&<p role="status" className="text-xs text-[var(--muted)]">{notice}</p>}</section>;
}
