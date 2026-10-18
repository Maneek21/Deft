'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api,isSameWebSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { PageHeader } from '@/components/page-header';
import { TaskQuickCreate } from '@/components/task-quick-create';
import { APP_ATTACHMENT_BROKER_ENABLED, APP_PRIVATE_SHARING_ENABLED, APP_PRIVATE_MCP_ENABLED } from '@/lib/feature-flags';
import { attachmentId,attachmentObject,attachmentParent,attachmentParentPage,attachmentWebDeadline,
  type AttachmentParent,type AttachmentParentPage } from '@/lib/app-attachment-view';

type Stamp={session:string|null;deadline:number;generation:number;controller:AbortController};
type Value<T>={value:T;stamp:Stamp};
const tap={minHeight:44},button='deft-pill';
const display=(s:Stamp)=>!document.hidden&&s.deadline>Date.now()&&isSameWebSession(s.session,localStorage.getItem('deft-access-token'));
export function AttachmentParentView({bindingId,projectionId,compact=false}:{bindingId:string;projectionId?:string;compact?:boolean}){
  const {user,sessionCacheScope}=useAuth();if(!user||!sessionCacheScope)return null;
  if(!APP_ATTACHMENT_BROKER_ENABLED)return <p className="p-6">Saved App attachments are disabled on this host.</p>;
  return <OwnerView key={`${sessionCacheScope}/${user.role}/${bindingId}/${projectionId??'list'}`} bindingId={bindingId} projectionId={projectionId} compact={compact}/>;
}
function OwnerView({bindingId,projectionId,compact}:{bindingId:string;projectionId?:string;compact:boolean}){
  const router=useRouter();
  const [page,setPage]=useState<Value<AttachmentParentPage>|null>(null),[parent,setParent]=useState<Value<AttachmentParent>|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [projects,setProjects]=useState<{id:string;name:string}[]|null>(null),[project,setProject]=useState(''),[task,setTask]=useState(false);
  const generation=useRef(0),pending=useRef<AbortController|null>(null),disposed=useRef(false),expiry=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),urls=useRef(new Set<string>());
  const clear=useCallback(()=>{generation.current++;pending.current?.abort();clearTimeout(expiry.current);for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();
    setPage(null);setParent(null);setBusy(false);setProjects(null);setProject('');setTask(false);},[]);
  useLayoutEffect(()=>{disposed.current=false;const hidden=()=>{if(document.hidden)clear();};document.addEventListener('visibilitychange',hidden);addEventListener('pagehide',clear);
    return()=>{disposed.current=true;generation.current++;pending.current?.abort();clearTimeout(expiry.current);for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();
      document.removeEventListener('visibilitychange',hidden);removeEventListener('pagehide',clear);};},[clear]);
  const begin=()=>{pending.current?.abort();const controller=new AbortController();pending.current=controller;const session=localStorage.getItem('deft-access-token');
    return {session,controller,generation:++generation.current,deadline:attachmentWebDeadline(session)};};
  const current=(s:Stamp)=>!disposed.current&&s.generation===generation.current&&!s.controller.signal.aborted&&display(s);
  const arm=(s:Stamp)=>{clearTimeout(expiry.current);expiry.current=setTimeout(()=>{if(!disposed.current){clear();setNotice('Private access expired. Reload after reviewing your connection.');}},Math.max(0,Math.min(s.deadline-Date.now(),2147483647)));};
  const base=`/api/private-resources/bindings/${encodeURIComponent(bindingId)}/attachment-parents`;
  const load=async(cursor?:string)=>{const stamp=begin();setBusy(true);setError(null);setPage(null);setParent(null);setProjects(null);setTask(false);
    try{attachmentId(bindingId);if(projectionId)attachmentId(projectionId);
      const response=await api.fetch(projectionId?`${base}/${encodeURIComponent(projectionId)}`:`${base}?limit=25${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal:stamp.controller.signal,cache:'no-store'});
      if(!response.ok)throw new Error('This saved private resource is unavailable.');const raw=await response.json();
      const value=projectionId?attachmentParent(raw,projectionId):attachmentParentPage(raw);stamp.deadline=Math.min(stamp.deadline,Date.parse(value.consent_expires_at));
      if(current(stamp)){if(projectionId)setParent({value:value as AttachmentParent,stamp});else setPage({value:value as AttachmentParentPage,stamp});arm(stamp);}
    }catch{if(current(stamp))setError('This saved private resource is unavailable. Check your current owner session and connection.');}
    finally{if(!disposed.current&&stamp.generation===generation.current)setBusy(false);}};
  useLayoutEffect(()=>{void load();},[]); // eslint-disable-line react-hooks/exhaustive-deps
  const download=async(attachment:AttachmentParent['attachments'][number])=>{if(!parent||!display(parent.stamp)||attachment.state!=='available')return;
    const stamp=begin();stamp.deadline=Math.min(stamp.deadline,parent.stamp.deadline);setBusy(true);setError(null);
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try{const r=await api.fetch(`/api/private-resources/bindings/${encodeURIComponent(bindingId)}/records/${encodeURIComponent(projectionId!)}/attachments/${encodeURIComponent(attachment.attachment_id)}/content`,{signal:stamp.controller.signal,cache:'no-store'});
      if(!r.ok||r.headers.get('content-type')!=='application/octet-stream'||r.headers.get('x-content-type-options')!=='nosniff'||!r.headers.get('content-disposition')?.startsWith('attachment;')||!r.body)throw new Error('Attachment unavailable.');
      reader=r.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>2097152||size>attachment.size_bytes)throw new Error('Attachment unavailable.');chunks.push(next.value);}
      if(size!==attachment.size_bytes||!current(stamp))return;
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));urls.current.add(url);const link=document.createElement('a');link.href=url;link.download=attachment.filename;link.click();
      setTimeout(()=>{URL.revokeObjectURL(url);urls.current.delete(url);},1000);setNotice('Attachment downloaded. Copies you save cannot be recalled when access ends.');
    }catch{if(current(stamp))setError('Attachment download is unavailable. It was not opened inline.');}
    finally{if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}if(!disposed.current&&stamp.generation===generation.current)setBusy(false);}};
  const sourcePath=projectionId?`/app-attachments/${encodeURIComponent(bindingId)}/${encodeURIComponent(projectionId)}`:null;
  const chooseProject=async()=>{if(!parent||!display(parent.stamp))return;const stamp=begin();stamp.deadline=Math.min(stamp.deadline,parent.stamp.deadline);setBusy(true);setError(null);
    try{const r=await api.fetch('/api/projects',{signal:stamp.controller.signal,cache:'no-store'});if(!r.ok)throw new Error('Project list unavailable.');const rows:unknown=await r.json();
      if(!Array.isArray(rows)||rows.length>200||new TextEncoder().encode(JSON.stringify(rows)).byteLength>262144)throw new Error('Project list unavailable.');
      const list=rows.map(raw=>{const p=attachmentObject(raw);if(typeof p.name!=='string'||p.name.length>200)throw new Error('Project list unavailable.');return {id:attachmentId(p.id),name:p.name};});
      if(current(stamp)){setProjects(list);setProject('');}
    }catch{if(current(stamp))setError('Choose a project in Tasks before creating a source reference.');}finally{if(!disposed.current&&stamp.generation===generation.current)setBusy(false);}};
  const visibleParent=parent&&display(parent.stamp)?parent.value:null,visiblePage=page&&display(page.stamp)?page.value:null;
  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"><PageHeader title={compact?'Files and follow-ups':'Saved private App resource'}/>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-8 pt-3 md:px-6"><div className="flex flex-wrap gap-2">{!compact&&<Link className={button} style={tap} href="/settings/apps/private-resources">Private connections</Link>}
      {projectionId&&!compact&&<Link className={button} style={tap} href={`/app-attachments/${encodeURIComponent(bindingId)}`}>Saved records</Link>}<button className={button} style={tap} disabled={busy} onClick={()=>void load()}>Reload saved resource</button></div>
      <p className="text-sm">Saved information is private to its owner. Source freshness is unknown. Every read and download checks current access.</p>
      {busy&&<p role="status">Checking private access…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {visiblePage&&<section aria-label="Saved App records" className="space-y-3">{visiblePage.items.length?visiblePage.items.map(item=><Link key={item.projection_id} className="block break-words rounded border p-3" style={tap} href={`/app-attachments/${encodeURIComponent(bindingId)}/${encodeURIComponent(item.projection_id)}`}>{item.label}</Link>):<p>No saved records are available.</p>}
        {visiblePage.next_cursor&&<button className={button} style={tap} disabled={busy} onClick={()=>void load(visiblePage.next_cursor!)}>Next saved records</button>}</section>}
      {visibleParent&&<><h2 className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{visibleParent.label}</h2><p className="text-sm">Consent ends {new Date(visibleParent.consent_expires_at).toLocaleString()}.</p>
        <details open={!compact}><summary className="min-h-11 cursor-pointer py-3 text-sm">Saved source details</summary><dl className="space-y-3">{Object.entries(visibleParent.data).map(([key,value])=><div key={key}><dt className="break-words text-xs font-semibold">{key}</dt><dd className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{String(value)}</dd></div>)}</dl></details>
        <section aria-label="Saved attachments" className="space-y-3"><h3 className="font-semibold">Attachments</h3>{visibleParent.attachments.length?visibleParent.attachments.map(a=><div key={a.attachment_id} className="flex min-w-0 flex-wrap items-center gap-3 border-b py-3">
          <div className="min-w-0 flex-1"><p className="break-words [overflow-wrap:anywhere]">{a.filename}</p><p className="text-xs">{a.media_type} · {a.size_bytes.toLocaleString()} bytes · {a.state}</p></div>
          <button className={button} style={tap} disabled={busy||a.state!=='available'} onClick={()=>void download(a)}>Download attachment</button></div>):<p>No attachments are retained for this record.</p>}</section>
        <section aria-label="Reference this saved resource" className="space-y-3 border-t py-4"><h3 className="font-semibold">Follow up in Deft</h3><p className="text-sm">A Task or knowledge reference can link here without copying private content. Opening the link still requires current owner access.</p>
          <div className="flex flex-wrap gap-2"><button className={button} style={tap} disabled={busy} onClick={()=>void chooseProject()}>Create Task with source link</button>
            <button className={button} style={tap} onClick={()=>{void navigator.clipboard.writeText(location.origin+sourcePath).then(()=>setNotice('Source link copied. It gives no permission to read this resource.')).catch(()=>setError('Source link could not be copied.'));}}>Copy source link for knowledge</button><Link className={button} style={tap} href="/knowledge">Open knowledge</Link></div>
          {projects&&<><label className="block text-sm">Task project<select className="mt-1 block w-full rounded border p-2" style={tap} value={project} onChange={e=>setProject(e.target.value)}><option value="">Choose a project</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <button className={button} style={tap} disabled={!project||busy} onClick={()=>setTask(true)}>Open normal Task form</button></>}
        </section>
        {visibleParent.ref.provider.kind==='app_runtime'&&(APP_PRIVATE_SHARING_ENABLED||APP_PRIVATE_MCP_ENABLED)&&<section className="space-y-3 border-t py-4" aria-label="Share selected source">
          <h3 className="font-semibold">Choose who can use this source</h3><p className="text-sm">Review the exact fields and expiry before granting access. Files stay private.</p>
          <div className="flex flex-wrap gap-3">{APP_PRIVATE_SHARING_ENABLED&&<Link className={button} style={tap} href={`/app-resources/share/${encodeURIComponent(visibleParent.ref.provider.provider_instance_id)}/${encodeURIComponent(visibleParent.ref.resource_type)}/${encodeURIComponent(visibleParent.ref.resource_id)}`}>Review sharing with a person</Link>}
          {APP_PRIVATE_MCP_ENABLED&&<Link className={button} style={tap} href={`/app-resources/mcp/${encodeURIComponent(visibleParent.ref.provider.provider_instance_id)}/${encodeURIComponent(visibleParent.ref.resource_type)}/${encodeURIComponent(visibleParent.ref.resource_id)}`}>Review assistant access</Link>}</div>
        </section>}
        {task&&project&&<TaskQuickCreate projectId={project} initialDescription={`<p><a href="${sourcePath}">Saved App source</a></p>`} onClose={()=>setTask(false)} onCreated={()=>{setTask(false);router.push(`/tasks?project=${encodeURIComponent(project)}`);}}/>}
      </>}
    </div></div>;
}
