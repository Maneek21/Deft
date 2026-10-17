'use client';
import {useEffect,useRef,useState} from 'react';
import {createOriginalFileCopies,type OriginalFileState,type FileCopyPorts,type FileCopyNode} from '@/lib/app-experience-file-copy';
import type {createExperienceRecordWriter} from '@/lib/app-experience-record-writer';
export function ExperienceRecordOriginalFiles(props:{node:FileCopyNode;writer:()=>ReturnType<typeof createExperienceRecordWriter>|null;ports:FileCopyPorts;signal:AbortSignal;current:()=>boolean;disabled:boolean;onBusy:(busy:boolean)=>void;onUnconfirmed:(blocked:boolean)=>void}){
 const [files,setFiles]=useState<readonly OriginalFileState[]>([]),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');const controller=useRef<ReturnType<typeof createOriginalFileCopies>|null>(null),latest=useRef(props);latest.current=props;
 const sourceKey=JSON.stringify([props.node.store_key,props.node.record_id,props.node.source_refs]);
 useEffect(()=>{let active=true;const owner=new AbortController(),signal=AbortSignal.any([owner.signal,props.signal]);
  const next=createOriginalFileCopies({node:props.node,writer:()=>latest.current.writer(),ports:props.ports,current:()=>active&&latest.current.current(),locked:()=>latest.current.disabled,signal,
   change:(files,busy,notice)=>{if(!active||signal.aborted)return;setFiles(files);setBusy(busy);setNotice(notice);latest.current.onBusy(busy);latest.current.onUnconfirmed(files.some(file=>file.state==='unconfirmed'));}});
  controller.current=next;void next.load().catch(()=>{if(active&&!signal.aborted)setNotice('Original message reference changed. Reopen this draft.');});return()=>{active=false;owner.abort();next.dispose();if(controller.current===next)controller.current=null;};
 },[sourceKey,props.ports,props.signal]);
 return <ExperienceRecordOriginalFilesView files={files} busy={busy} notice={notice} disabled={props.disabled} current={props.current()}
  include={ref=>void controller.current?.include(ref)} omit={ref=>controller.current?.omit(ref)} check={()=>void controller.current?.check()}/>;
}
export function ExperienceRecordOriginalFilesView(props:{files:readonly OriginalFileState[];busy:boolean;notice:string;disabled:boolean;current:boolean;include:(ref:string)=>void;omit:(ref:string)=>void;check:()=>void}){
 const {files,busy,notice}=props;
 return <section aria-label="Original attachments" className="space-y-2 pt-3"><h3 className="text-xs text-[var(--muted)]">Original attachments</h3>
  {files.map(({file,state,notice})=><div key={file.file_ref} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-container-low)] px-3 py-2 text-xs"><span className="min-w-0 flex-1 break-words">{file.filename} · {Math.ceil(file.size_bytes/1024).toLocaleString()} KB</span><span>{state==='saved'?'Included':state==='loading'?'Copying…':state==='source_only'?'Original only':state==='unconfirmed'?'Check status':state==='omitted'?'Omitted':state==='failed'?'Not included':'Available'}</span>
   {['available','failed','omitted'].includes(state)&&<button type="button" disabled={busy||props.disabled} onClick={()=>props.include(file.file_ref)}>Include</button>}
   {state==='available'&&<button type="button" disabled={busy||props.disabled} onClick={()=>props.omit(file.file_ref)}>Omit</button>}
   {state==='unconfirmed'&&<button type="button" disabled={busy||!props.current} onClick={()=>props.check()}>Check status</button>}{notice&&<p className="w-full text-[var(--muted)]">{notice}</p>}
  </div>)}{notice&&<p role="status" className="text-xs text-[var(--muted)]">{notice}</p>}{busy&&!files.length&&<p role="status" className="text-xs">Loading original attachments…</p>}
 </section>;
}
