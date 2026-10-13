'use client';
import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {api,isSameWebSession} from '@/lib/api';
import {createNativeEmailFolders,nativeFolderLabel,type NativeFolderState} from '@/lib/email-native-folders';
import type {NativeTriageLabels} from '@/lib/email-native-triage';

export function NativeEmailLabelPicker({accountId,address,messageCount,sessionScope,returnFocus,onApply,onClose,onDenied}:{accountId:string;address:string;messageCount:number;sessionScope:string;returnFocus?:HTMLElement|null;onApply:(selection:NativeTriageLabels)=>void;onClose:()=>void;onDenied:(account:string)=>void}){
 const [state,setState]=useState<NativeFolderState|null>(null),[reload,setReload]=useState(0),[picked,setPicked]=useState<string[]>([]),[action,setAction]=useState<'add'|'remove'>('add'),[notice,setNotice]=useState(''),[submitted,setSubmitted]=useState(false);
 const controller=useRef<ReturnType<typeof createNativeEmailFolders>|null>(null),firstChoice=useRef<HTMLInputElement|null>(null);
 const owner=useRef({active:false,accountId,sessionScope,anchor:api.getAccessToken()}),latest=useRef(state),chosen=useRef(picked),intent=useRef(action),accepted=useRef(false);
 latest.current=state;chosen.current=picked;intent.current=action;
 const callbacks=useRef({onApply,onClose,onDenied});callbacks.current={onApply,onClose,onDenied};
 const current=()=>owner.current.active&&owner.current.accountId===accountId&&owner.current.sessionScope===sessionScope&&isSameWebSession(owner.current.anchor,api.getAccessToken());
 useEffect(()=>{
  const held={active:true,accountId,sessionScope,anchor:api.getAccessToken()};owner.current=held;latest.current=null;chosen.current=[];accepted.current=false;setState(null);setPicked([]);setNotice('');setSubmitted(false);
  const owns=()=>owner.current===held&&held.active&&isSameWebSession(held.anchor,api.getAccessToken());
  const value=createNativeEmailFolders({accountIds:[accountId],current:owns,fetch:(path,options)=>api.fetch(path,options),change:next=>{if(owns()){latest.current=next;setState(next);}},denied:id=>{if(owns()){chosen.current=[];setPicked([]);callbacks.current.onDenied(id);}}});controller.current=value;void value.start();firstChoice.current?.focus();
  return()=>{held.active=false;value.dispose();if(controller.current===value)controller.current=null;};
 },[accountId,sessionScope,reload]);
 const close=()=>{if(!current())return;owner.current.active=false;controller.current?.dispose();callbacks.current.onClose();if(returnFocus?.isConnected)returnFocus.focus();};
 const toggle=(folderId:string,checked:boolean)=>{
  if(!current()||accepted.current||latest.current?.busy)return;const row=latest.current?.accounts[0];if(row?.state!=='available'||!row.items.some(folder=>folder.folder_id===folderId&&folder.labels_allowed&&folder.kind==='label'&&folder.destination_id))return;
  const next=checked?[...chosen.current.filter(id=>id!==folderId),folderId]:chosen.current.filter(id=>id!==folderId);if(next.length>16){setNotice('Choose up to 16 labels per change.');return;}chosen.current=next;setPicked(next);setNotice('');
 };
 const apply=()=>{
  if(!current()||accepted.current||latest.current?.busy||!Number.isSafeInteger(messageCount)||messageCount<1||messageCount>100)return;
  const row=latest.current?.accounts[0];if(row?.state!=='available'||!chosen.current.length||chosen.current.length>16)return;
  const selected=chosen.current.map(id=>row.items.find(folder=>folder.folder_id===id&&folder.labels_allowed&&folder.kind==='label'&&folder.destination_id));
  if(selected.some(folder=>!folder)){setNotice('Some chosen labels are unavailable. Reload labels and choose again.');return;}
  const tokens=selected.map(folder=>folder!.destination_id!);if(new Set(tokens).size!==tokens.length){setNotice('Labels could not be confirmed. Reload labels and choose again.');return;}
  accepted.current=true;setSubmitted(true);owner.current.active=false;controller.current?.dispose();callbacks.current.onApply({accountId,action:intent.current,tokens});if(returnFocus?.isConnected)returnFocus.focus();
 };
 const scoped=owner.current.accountId===accountId&&owner.current.sessionScope===sessionScope?state:null,row=scoped?.accounts.find(account=>account.accountId===accountId),labels=row?.items.filter(folder=>folder.labels_allowed&&folder.kind==='label'&&folder.destination_id)??[],disabled=!!scoped?.busy||row?.state!=='available'||submitted;
 return <section role="dialog" aria-label="Change Gmail labels" data-email-menu-open="true" onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('[aria-modal="true"]')){event.preventDefault();event.stopPropagation();close();}}} className="mx-5 my-3 space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4 shadow-sm">
  <header className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-medium">Labels</h3><p className="break-all text-xs text-[var(--muted)]">{address} · {messageCount} {messageCount===1?'message':'messages'}</p></div><button type="button" aria-label="Close labels" onClick={close} className="rounded-full p-2 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><X size={16} aria-hidden="true"/></button></header>
  <fieldset className="flex flex-wrap gap-2" disabled={submitted}><legend className="sr-only">Label change</legend>{(['add','remove'] as const).map((value,index)=><label key={value} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)]"><input ref={index===0?firstChoice:undefined} type="radio" name="native-email-label-action" value={value} checked={action===value} onChange={()=>{if(current()&&!accepted.current){intent.current=value;setAction(value);}}} className="accent-[var(--primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"/>{value==='add'?'Add labels':'Remove labels'}</label>)}</fieldset>
  <p className="text-xs text-[var(--muted)]">Choose labels for this change. Existing message labels are kept unless you remove them.</p>
  {(!scoped||scoped.busy)&&<p role="status" className="text-xs text-[var(--muted)]">Loading labels…</p>}
  {(notice||row?.notice)&&<p role="status" className="text-xs text-[var(--text-secondary)]">{notice||row?.notice}</p>}
  <div className="max-h-64 space-y-1 overflow-y-auto">{labels.map(folder=><label key={folder.folder_id} className="flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-[var(--hover-tint)]"><input type="checkbox" aria-label={`Choose label ${nativeFolderLabel(folder,row!.items)}`} checked={picked.includes(folder.folder_id)} disabled={disabled||picked.length===16&&!picked.includes(folder.folder_id)} onChange={event=>toggle(folder.folder_id,event.target.checked)} className="h-4 w-4 shrink-0 accent-[var(--primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"/><span className="min-w-0 break-words">{nativeFolderLabel(folder,row!.items)}</span></label>)}</div>
  {row?.state==='available'&&!scoped?.busy&&!labels.length&&<p className="text-xs text-[var(--muted)]">No user labels are available in the loaded folders.</p>}
  <footer className="flex flex-wrap items-center gap-2">{row?.nextCursor&&<button type="button" disabled={scoped?.busy||submitted} onClick={()=>{if(current()&&!accepted.current)void controller.current?.more(accountId);}} className="rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)]">More labels</button>}<button type="button" disabled={scoped?.busy||submitted} onClick={()=>{if(current()&&!accepted.current)setReload(value=>value+1);}} className="rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)]">Reload labels</button><span className="text-xs text-[var(--muted)]">{picked.length} selected</span><button type="button" disabled={disabled||!picked.length} aria-label={`${action==='add'?'Add':'Remove'} ${picked.length} ${picked.length===1?'label':'labels'} ${action==='add'?'to':'from'} ${messageCount} ${messageCount===1?'message':'messages'}`} onClick={apply} className="ml-auto rounded-full bg-[var(--accent-light)] px-3 py-2 text-sm text-[var(--primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40">{action==='add'?'Add labels':'Remove labels'}</button></footer>
 </section>;
}
