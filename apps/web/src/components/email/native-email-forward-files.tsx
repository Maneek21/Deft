'use client';
import {useState} from 'react';
import type {NativeForwardFilesState} from '@/lib/email-native-forward-files';
const pill='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
export function NativeEmailForwardFiles({value,disabled,onInclude,onOmit,onCheck}:{value:NativeForwardFilesState;disabled:boolean;onInclude:(refs:string[])=>void;onOmit:(ref:string)=>void;onCheck:()=>void}){
 const [chosen,setChosen]=useState(()=>new Set(value.files.map(f=>f.file_ref)));
 const available=value.files.filter(f=>['available','failed'].includes(f.state)),selected=available.filter(f=>chosen.has(f.file_ref)).map(f=>f.file_ref);
 return <section aria-label="Original attachments" className="space-y-2 rounded-xl bg-[var(--surface-container-low)] p-3">
  <div className="text-sm font-medium">Original attachments</div><p className="text-xs text-[var(--muted)]">Choose the files to include in this forward. They are saved to this draft before sending.</p>
  <ul className="space-y-1">{value.files.map(file=><li key={file.file_ref} className="flex flex-wrap items-center gap-2 text-xs">
   {['available','failed'].includes(file.state)&&<input type="checkbox" aria-label={`Include ${file.filename}`} checked={chosen.has(file.file_ref)} disabled={disabled||value.busy} onChange={event=>setChosen(previous=>{const next=new Set(previous);if(event.target.checked)next.add(file.file_ref);else next.delete(file.file_ref);return next;})}/>}
   <span className="min-w-0 truncate">{file.filename}</span><span className="text-[var(--muted)]">{(file.size_bytes/1024).toLocaleString(undefined,{maximumFractionDigits:1})} KiB · {file.state==='source_only'?'original message only':file.state==='available'?'not included':file.state==='saved'?'saved to draft':file.state==='loading'?'loading original…':file.state==='uploading'?'saving to draft…':file.state==='unconfirmed'?'save unconfirmed':file.state==='omitted'?'omitted':'not included'}</span>
   {file.state==='failed'&&<button className={pill} type="button" disabled={disabled||value.busy} onClick={()=>onOmit(file.file_ref)}>Omit {file.filename}</button>}
   {file.notice&&<span role="status" className="w-full text-[var(--text-secondary)]">{file.notice}</span>}
  </li>)}</ul>
  {!!available.length&&<button type="button" className={pill} disabled={disabled||value.busy||!selected.length} onClick={()=>onInclude(selected)}>Include selected originals</button>}
  {value.files.some(f=>f.state==='unconfirmed')&&<button type="button" className={pill} disabled={disabled||value.busy} onClick={onCheck}>Check saved attachments</button>}
  {value.blocked&&<p role="status" className="text-xs text-[var(--text-secondary)]">Finish including the selected files, or explicitly omit a failed file, before sending.</p>}
  {value.notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{value.notice}</p>}
 </section>;
}
