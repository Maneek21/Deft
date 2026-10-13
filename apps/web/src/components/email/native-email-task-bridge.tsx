'use client';
import {useEffect,useRef,useState} from 'react';
import {AppDialog} from '@/components/overlay-primitives';
import {TaskQuickCreate} from '@/components/task-quick-create';
import {api} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createNativeMessageSummary,type NativeMessageTarget} from '@/lib/email-native-message-links';
import {prepareNativeEmailTask} from '@/lib/email-native-task-bridge';

/** Mount only for an explicit reader action and key by session+message. */
export function NativeEmailTaskBridge({target,sessionScope,onClose,onCreated}:{target:NativeMessageTarget;sessionScope:string;onClose:()=>void;onCreated:()=>void}){
 const [projects,setProjects]=useState<{id:string;name:string}[]>([]),[project,setProject]=useState(''),[includeSubject,setIncludeSubject]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[seed,setSeed]=useState<Awaited<ReturnType<typeof prepareNativeEmailTask>>|null>(null);
 const live=useRef(true);const current=()=>live.current&&getActiveSessionCacheScope()===sessionScope;
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 useEffect(()=>{let active=true;const controller=new AbortController();
  void api.fetch('/api/projects',{signal:controller.signal}).then(async response=>{if(!response.ok)throw Error('Projects could not be loaded.');const rows:unknown=await response.json();if(!Array.isArray(rows)||rows.length>10000)throw Error('Projects could not be loaded.');
   const parsed=rows.filter((row):row is {id:string;name:string}=>!!row&&typeof row==='object'&&typeof row.id==='string'&&typeof row.name==='string');
   if(active&&getActiveSessionCacheScope()===sessionScope){setProjects(parsed);if(parsed.length===1)setProject(parsed[0].id);}
  }).catch(reason=>{if(active&&!controller.signal.aborted&&getActiveSessionCacheScope()===sessionScope)setError(reason instanceof Error?reason.message:'Projects could not be loaded.');}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;controller.abort();};
 },[sessionScope,attempt]);
 const prepare=async()=>{if(busy||!current()||!projects.some(row=>row.id===project))return;setBusy(true);setError('');const reader=createNativeMessageSummary({fetch:(path,init)=>api.fetch(path,init),current});
  try{const value=await prepareNativeEmailTask(target,includeSubject,{current,read:reader.read});if(current())setSeed(value);}
  catch(reason){if(current())setError(reason instanceof Error?reason.message:'The message could not be confirmed.');}
  finally{reader.dispose();if(current())setBusy(false);}
 };
 if(getActiveSessionCacheScope()!==sessionScope)return null;
 if(seed)return <TaskQuickCreate key={project} projectId={project} initialTitle={seed.title} initialDescription={seed.description} sourceLink={seed.sourceLink} beforeCreate={async()=>{const reader=createNativeMessageSummary({fetch:(path,init)=>api.fetch(path,init),current});try{await prepareNativeEmailTask(target,false,{current,read:reader.read});}finally{reader.dispose();}}} onClose={onClose} onCreated={onCreated}/>;
 return <AppDialog open title="Create task from email" description="Choose where to keep your follow-up." onClose={()=>{if(!busy)onClose();}} width={500} footer={<div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className="rounded-full px-4 py-2 text-sm">Cancel</button><button type="button" disabled={busy||loading||!project} onClick={()=>void prepare()} className="rounded-full bg-[var(--accent-light)] px-4 py-2 text-sm text-[var(--primary)] disabled:opacity-50">{busy?'Opening…':'Continue'}</button></div>}>
  <div className="space-y-4 text-sm"><label className="block space-y-2"><span>Project</span><select value={project} onChange={event=>setProject(event.target.value)} className="w-full rounded-full bg-[var(--surface-container-low)] px-4 py-3"><option value="">{loading?'Loading projects…':'Choose a project'}</option>{projects.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
   {!loading&&!error&&!projects.length&&<p>Create a project in Tasks before adding a follow-up.</p>}
   <p className="text-[var(--text-secondary)]">The task can be visible to your workspace. It includes a link to this email; opening the link still requires access to your email account.</p>
   <label className="flex items-start gap-2"><input type="checkbox" checked={includeSubject} onChange={event=>setIncludeSubject(event.target.checked)}/><span>Copy the email subject into the task title</span></label>
   {error&&<p role="alert">{error} <button type="button" onClick={()=>{setLoading(true);setError('');setAttempt(value=>value+1);}} className="underline">Try again</button></p>}
  </div>
 </AppDialog>;
}
