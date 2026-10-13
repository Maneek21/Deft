'use client';
import {useEffect,useState} from 'react';
import {parseEmailRelatedKnowledge,type EmailRelatedKnowledge} from '@/lib/email-native-connected';
import {useEmailConnectedResource} from './use-email-connected-resource';

const pill='inline-flex rounded-full px-3 py-1.5 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
export function NativeEmailRelatedKnowledge({accountId,logicalMessageId,sessionScope}:{accountId:string;logicalMessageId:string;sessionScope:string}) {
  const [open,setOpen]=useState(false);
  const resource=useEmailConnectedResource(accountId,sessionScope,'/messages/'+encodeURIComponent(logicalMessageId)+'/knowledge',parseEmailRelatedKnowledge,open);
  useEffect(()=>{if(!open)return;const refresh=()=>{if(document.visibilityState==='visible')void resource.refresh();};const timer=setInterval(refresh,15000);document.addEventListener('visibilitychange',refresh);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[open,resource.refresh]);
  if(!resource.current)return null;
  return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)} className="pt-2"><summary className="cursor-pointer text-xs text-[var(--text-secondary)]">Related{resource.value?.items.length?` · ${resource.value.items.length}`:''}</summary>{open&&<NativeEmailRelatedKnowledgeView value={resource.value} busy={resource.busy} uncertain={resource.uncertain} notice={resource.notice} onToggleLearning={()=>{if(resource.value)void resource.save({suppressed:!resource.value.suppressed});}} onReload={resource.reload}/>}</details>;
}
export function NativeEmailRelatedKnowledgeView({value,busy,uncertain,notice,onToggleLearning,onReload}:{value:EmailRelatedKnowledge|null;busy:boolean;uncertain:boolean;notice:string;onToggleLearning:()=>void;onReload:()=>void}) {
  return <section aria-label="Related Knowledge" className="space-y-2 pt-3 text-xs">
    {value?.items.map(item=><div key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="rounded-full bg-[var(--surface-container-low)] px-2 py-1 text-[var(--text-secondary)]">{item.status==='updated'?'Knowledge updated':'Knowledge saved'}</span><span className="min-w-0 break-words">{item.title}</span><a href={item.url} className={pill+' text-[var(--primary)]'} aria-label={'Open Knowledge: '+item.title}>Open</a></div>)}
    {busy&&!value&&<p role="status" className="text-[var(--text-secondary)]">Checking related Knowledge…</p>}
    {value&&!value.items.length&&<p className="text-[var(--text-secondary)]">No captured Knowledge for this thread yet.</p>}
    {value?.suppressed&&<p className="text-[var(--text-secondary)]">Learning is stopped for this thread. Saved Knowledge remains available.</p>}
    <div className="flex flex-wrap gap-1">{value&&<button type="button" disabled={busy||uncertain} onClick={onToggleLearning} className={pill}>{value.suppressed?'Resume learning for thread':'Stop learning from thread'}</button>}<button type="button" disabled={busy} onClick={onReload} className={pill}>Refresh</button></div>
    {notice&&<p role="status" className="text-[var(--text-secondary)]">{notice}</p>}
  </section>;
}
