'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {ChevronDown} from 'lucide-react';

type Account={account_id:string;primary_address:string;display_label:string};
type Identity={address:string;identity_key:string};
export function NativeEmailComposeIdentity({accounts,accountId,senderAddress,identities,senderUnavailable,accountLocked,disabled,senderDisabled,onAccount,onSender}:{accounts:Account[];accountId:string;senderAddress:string;identities:Identity[]|null;senderUnavailable:boolean;accountLocked:boolean;disabled:boolean;senderDisabled:boolean;onAccount:(accountId:string)=>void;onSender:(address:string)=>void}){
 const id=useId(),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),alive=useRef(true),[open,setOpen]=useState(false);
 const account=accounts.find(row=>row.account_id===accountId),showSender=senderUnavailable||identities!==null&&(identities.length>1||senderAddress.toLowerCase()!==(account?.primary_address??'').toLowerCase());
 const close=(returnFocus=false)=>{setOpen(false);if(returnFocus)trigger.current?.focus();};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{setOpen(false);},[accountId,senderAddress,disabled]);
 useEffect(()=>{if(!open)return;const outside=(event:Event)=>{if(root.current&&!root.current.contains(event.target as Node))close();};document.addEventListener('pointerdown',outside);document.addEventListener('focusin',outside);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside);};},[open]);
 const pill='rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
 return <div ref={root} data-email-menu-open={open?'true':undefined} className="min-w-0 flex-1 sm:relative sm:flex-none" onKeyDown={event=>{if(open&&event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('[aria-modal="true"]')){event.preventDefault();event.stopPropagation();close(true);}}}>
  <button ref={trigger} type="button" aria-label={`From ${senderAddress||'unavailable'}${senderUnavailable?' (unavailable)':''}`} title={senderAddress||'Sending address unavailable'} aria-expanded={open} aria-controls={id} disabled={disabled} onClick={()=>setOpen(value=>!value)} className={`${pill} flex w-full max-w-full items-center gap-2 bg-[var(--surface-container-low)] sm:w-auto`}>
   <span className="shrink-0 text-xs text-[var(--muted)]">From</span><span className="min-w-0 flex-1 text-left sm:flex-initial"><span className="block max-w-[260px] truncate">{senderAddress||'Unavailable'}</span>{senderUnavailable&&<span className="block text-xs text-[var(--muted)]">unavailable</span>}</span><ChevronDown size={14} aria-hidden="true" className="shrink-0"/>
  </button>
  {open&&<div id={id} role="region" aria-label="Sending identity" className="absolute left-0 right-0 top-full z-30 mt-2 w-full max-w-full space-y-3 rounded-xl bg-[var(--surface-container-low)] p-3 text-xs text-[var(--text-secondary)] shadow-xl ring-1 ring-[var(--border)] sm:left-auto sm:w-80 sm:max-w-[calc(100vw-2rem)]">
   <div className="flex items-center justify-between gap-2"><span className="font-medium">Sending identity</span><button type="button" className={pill} onClick={()=>close(true)}>Close</button></div>
   <label className="block space-y-1"><span>Sending account</span><select aria-label="Sending account" value={accountId} disabled={accountLocked||disabled} onChange={event=>{const next=event.target.value;if(!alive.current||accountLocked||disabled||next===accountId||!accounts.some(row=>row.account_id===next))return;close();onAccount(next);}} className="w-full rounded-lg bg-[var(--surface-container-high)] px-2 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
    {accounts.map(row=><option key={row.account_id} value={row.account_id}>{row.primary_address||row.display_label||'Connected account'}</option>)}
   </select></label>
   {accountLocked&&<p>This draft stays with its sending account.</p>}
   {showSender&&<label className="block space-y-1"><span>Sender address</span><select aria-label="Sender address" value={senderAddress} disabled={senderDisabled||!identities?.length} onChange={event=>{const next=event.target.value;if(!alive.current||senderDisabled||next===senderAddress||!identities?.some(item=>item.address===next))return;close();onSender(next);}} className="w-full rounded-lg bg-[var(--surface-container-high)] px-2 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
    {!identities?.some(item=>item.address===senderAddress)&&<option value={senderAddress}>{senderAddress||'Saved sender'} (unavailable)</option>}
    {identities?.map(item=><option key={item.identity_key} value={item.address}>{item.address}</option>)}
   </select></label>}
  </div>}
 </div>;
}
