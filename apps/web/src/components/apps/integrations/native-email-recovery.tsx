'use client';
import {useEffect,useState} from 'react';
import {api} from '@/lib/api';
type Kind='drafts'|'mailbox'|'history'|'send-history';
type Row=Record<string,unknown>;
const record=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Recovery has no edit, refresh, Send or provider path. Values render as text. */
export function NativeEmailRecovery({accountId,initialMessageId}:{accountId:string;initialMessageId?:string}){
 const [kind,setKind]=useState<Kind>(initialMessageId?'mailbox':'drafts'),[cursor,setCursor]=useState<string|null>(null),[next,setNext]=useState<string|null>(null);
 const [rows,setRows]=useState<Row[]>([]),[detail,setDetail]=useState<Row|null>(null),[status,setStatus]=useState('Checking recovery access…');
 const root='/api/email-adoption/recovery/'+encodeURIComponent(accountId);
 useEffect(()=>{const controller=new AbortController();setRows([]);setDetail(null);setNext(null);setStatus('Checking recovery access…');
  void(async()=>{try{const response=await api.fetch(root+'/'+kind+(cursor?'?cursor='+encodeURIComponent(cursor):''),{signal:controller.signal});
   if(!response.ok)throw Error();const page:unknown=await response.json();if(!record(page)||!Array.isArray(page.items)||!page.items.every(record))throw Error();
   let original:unknown=null;
   if(initialMessageId&&kind==='mailbox'&&!cursor){const response=await api.fetch(root+'/messages/'+encodeURIComponent(initialMessageId),{signal:controller.signal});if(!response.ok)throw Error();original=await response.json();if(!record(original))throw Error();}
   if(!controller.signal.aborted){setRows(page.items);setNext(typeof page.next_cursor==='string'?page.next_cursor:null);setDetail(record(original)?original:null);setStatus('Read-only recovery. Original account '+accountId);}
  }catch{if(!controller.signal.aborted){setRows([]);setDetail(null);setStatus('Recovery is unavailable or your access has ended.');}}})();
  return()=>controller.abort();
 },[root,kind,cursor,accountId,initialMessageId]);
 async function open(row:Row){try{const id=kind==='drafts'?row.draft_id:row.logical_message_id;
  if(typeof id!=='string'||(kind==='history'||kind==='send-history'))return;const response=await api.fetch(root+'/'+(kind==='drafts'?'drafts':'messages')+'/'+encodeURIComponent(id));
  if(!response.ok)throw Error();const value:unknown=await response.json();if(!record(value))throw Error();setDetail(value);
 }catch{setDetail(null);setStatus('Recovery is unavailable or your access has ended.');}}
 async function download(draftId:string,fileId:string){try{const response=await api.fetch(root+'/files/'+encodeURIComponent(draftId)+'/'+encodeURIComponent(fileId));if(!response.ok)throw Error();
  const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='recovered-attachment';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch{setStatus('Recovery is unavailable or your access has ended.');}}
 const attachments=detail&&record(detail.content)&&Array.isArray(detail.content.attachments)?detail.content.attachments.filter(record):[];
 return <main className="p-6 space-y-4"><h1>Original email recovery</h1><p role="status">{status}</p>
  <nav aria-label="Recovery records">{(['drafts','mailbox','history','send-history'] as const).map(value=><button key={value} className="mr-4 underline" onClick={()=>{setKind(value);setCursor(null);}}>{value}</button>)}</nav>
  <ul>{rows.map((row,index)=><li key={String(row.draft_id??row.logical_message_id??row.outbox_id??index)}>
   <button className="text-left underline" disabled={(kind==='history'||kind==='send-history')} onClick={()=>void open(row)}>{String(row.subject??row.draft_id??row.logical_message_id??row.outbox_id??'Original record')}</button>
   <pre className="whitespace-pre-wrap">{JSON.stringify(row,null,2)}</pre></li>)}</ul>
  {next&&<button onClick={()=>setCursor(next)}>Next page</button>}
  {detail&&<section><h2>Original record</h2><pre className="whitespace-pre-wrap">{JSON.stringify(detail,null,2)}</pre>
   {attachments.map(file=>typeof detail.draft_id==='string'&&typeof file.file_id==='string'?<button key={file.file_id} className="mr-4 underline" onClick={()=>void download(String(detail.draft_id),String(file.file_id))}>{String(file.filename??'Download attachment')}</button>:null)}</section>}
 </main>;
}
