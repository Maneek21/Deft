'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ExperienceComposeFilesControl} from './experience-compose-controls';
import {createExperienceRecordDownloads} from '@/lib/app-experience-record-downloads';
import {recordFormFiles} from '@/lib/app-experience-record-form';
import type {ExperienceRecordRow} from '@/lib/app-experience-record-writer';
import type {ExperienceRecordFormNode,ExperienceRecordFormPorts} from './experience-record-form';
/** Download is a scoped read even when the saved record is submitted/archived. */
export function ExperienceRecordFiles({node,row,ports,signal,current,disabled=false,onSelectFiles,onRemove,onInsertImage,extraActions}:{node:ExperienceRecordFormNode;row:ExperienceRecordRow;ports:ExperienceRecordFormPorts;signal:AbortSignal;current:()=>boolean;disabled?:boolean;
 onSelectFiles?:(files:readonly File[])=>void;onRemove?:(id:string)=>void;onInsertImage?:(id:string)=>void;extraActions?:ReactNode}){
 const generation=useRef(0),recordIdentity=JSON.stringify([node.store_key,node.record_id,node.profile]),mounted=useRef(true),latest=useRef({row,current});latest.current={row,current};const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[archiveBusy,setArchiveBusy]=useState(false);
 const downloads=useRef<ReturnType<typeof createExperienceRecordDownloads>|null>(null);
 const download=()=>downloads.current??(downloads.current=createExperienceRecordDownloads({node,row:()=>latest.current.row,current:()=>latest.current.current(),signal,read:(record,file,readSignal)=>ports.readFile(node,record,file,readSignal)}));
 useEffect(()=>{mounted.current=true;generation.current++;setBusy(false);setArchiveBusy(false);setNotice('');return()=>{mounted.current=false;generation.current++;downloads.current?.dispose();downloads.current=null;};},[recordIdentity,signal,ports]);
 const files=recordFormFiles(row.value,node.profile);
 return <div><ExperienceComposeFilesControl label="Files" extraActions={extraActions} disabled={disabled||busy||signal.aborted||!current()} onSelectFiles={onSelectFiles} onRemove={onRemove} onInsertImage={onInsertImage?id=>{if(disabled||busy||signal.aborted||!current()||!files.some(file=>file.file_id===id&&['image/png','image/jpeg','image/gif','image/webp'].includes(file.media_type)))return;onInsertImage(id);}:undefined} archiveBusy={archiveBusy} onCancelArchive={()=>download().cancelArchive()} onArchive={()=>{if(busy||signal.aborted||!current())return;setBusy(true);const owned=generation.current;void download().downloadArchive((active,text)=>{if(mounted.current&&generation.current===owned&&!signal.aborted&&latest.current.current()){setArchiveBusy(active);setNotice(text);}}).finally(()=>{if(mounted.current&&generation.current===owned&&!signal.aborted&&latest.current.current()){setBusy(false);setArchiveBusy(false);}});}}
  files={files.map(file=>({key:file.file_id,filename:file.filename,byteCount:file.size_bytes,status:'ready',handle:file.file_id,mediaType:file.media_type,digest:'sha256:'+file.sha256,expiresAt:'',draft:{draftId:node.record_id,revision:row.revision,resourceTargetKey:node.store_key}}))}
  onDownload={id=>{const file=files.find(file=>file.file_id===id);if(!file||busy||signal.aborted||!current())return;setBusy(true);setNotice('');const owned=generation.current;void download().download(file).then(ok=>{if(mounted.current&&generation.current===owned&&!signal.aborted&&latest.current.current()){setBusy(false);if(!ok)setNotice('The file could not be downloaded. Reopen the saved record to check its current files.');}});}}/>
  {notice&&<p role="status" className="text-xs text-[var(--muted)]">{notice}</p>}</div>;
}
