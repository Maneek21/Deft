'use client';
import {useId,useState} from 'react';
import type {NativeTriageState} from '@/lib/email-native-triage';
export function NativeEmailActionStatus({state,accounts,refreshing,onCheck,onUndo}:{state:NativeTriageState|null;accounts:{account_id:string;primary_address:string}[];refreshing:boolean;onCheck:()=>void;onUndo:()=>void}){
 const id=useId(),[open,setOpen]=useState(false);if(!state?.groups.length)return null;
 const unresolved=state.groups.some(group=>group.state==='uncertain'||group.result?.items.some(item=>['prepared','unknown'].includes(item.state)));
 const accountIds=[...new Set(state.groups.map(group=>group.accountId))],label=(accountId:string)=>accounts.find(row=>row.account_id===accountId)?.primary_address??'Account';
 const outcomes=accountIds.map(accountId=>{const groups=state.groups.filter(group=>group.accountId===accountId),counts={succeeded:0,failed:0,unknown:0,prepared:0};
  for(const group of groups){if(group.result)for(const item of group.result.items)counts[item.state]++;else counts[group.state==='failed'?'failed':group.state==='uncertain'||group.state==='denied'?'unknown':'prepared']+=group.ids.length;}
  return {accountId,summary:[counts.succeeded?`${counts.succeeded} updated`:'',counts.failed?`${counts.failed} not updated`:'',counts.unknown?`${counts.unknown} unconfirmed`:'',counts.prepared?`${counts.prepared} pending`:''].filter(Boolean).join(' · '),attention:counts.failed>0||counts.unknown>0,notices:[...new Set(groups.map(group=>group.notice).filter(Boolean))]};});
 const pill='rounded-full px-3 py-1.5 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40';
 return <div className="text-xs text-[var(--text-secondary)]"><div className="flex flex-wrap items-center gap-x-1 gap-y-1"><p role="status" className="min-w-0 flex-1" aria-live="polite">{state.busy?'Updating messages…':state.summary+(refreshing?' · refreshing details…':'')}</p>
  {unresolved&&<button type="button" aria-label="Check message action status" disabled={state.busy} onClick={onCheck} className={pill}>Check status</button>}{!unresolved&&state.groups.some(group=>group.result?.undo_available&&!group.undoOf)&&<button type="button" aria-label="Undo message action" disabled={state.busy||refreshing} onClick={onUndo} className={pill}>Undo</button>}
  <button type="button" aria-label="Message action details by account" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)} className={pill}>Details</button></div>
  {outcomes.filter(row=>row.attention).map(row=><p key={row.accountId} className="mt-1 break-words">{label(row.accountId)}: {row.summary}{row.notices.length?' · '+row.notices.join(' '):''}</p>)}
  <div id={id} hidden={!open} className="mt-1 space-y-1 rounded-xl bg-[var(--surface-container-low)] p-3">{outcomes.map(row=><div key={row.accountId}><p className="break-words">{label(row.accountId)}: {row.summary}</p>{row.notices.map(notice=><p key={notice}>{notice}</p>)}</div>)}</div>
 </div>;
}
