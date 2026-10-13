'use client';
import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {api,isSameWebSession} from '@/lib/api';
import {createNativeEmailFolders,nativeFolderLabel,type NativeFolderState} from '@/lib/email-native-folders';
export function NativeEmailFolderPicker({accountId,address,sessionScope,onChoose,onClose,onDenied}:{accountId:string;address:string;sessionScope:string;onChoose:(destination:{accountId:string;token:string})=>void;onClose:()=>void;onDenied:(account:string)=>void}){
 const [state,setState]=useState<NativeFolderState|null>(null),[reload,setReload]=useState(0);const controller=useRef<ReturnType<typeof createNativeEmailFolders>|null>(null);
 const deny=useRef(onDenied);useEffect(()=>{deny.current=onDenied;},[onDenied]);
 useEffect(()=>{const anchor=api.getAccessToken();let active=true;const value=createNativeEmailFolders({accountIds:[accountId],current:()=>active&&isSameWebSession(anchor,api.getAccessToken()),fetch:(path,options)=>api.fetch(path,options),change:setState,denied:id=>deny.current(id)});controller.current=value;void value.start();return()=>{active=false;value.dispose();controller.current=null;};},[accountId,sessionScope,reload]);
 useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose();};document.addEventListener('keydown',close);return()=>document.removeEventListener('keydown',close);},[onClose]);
 const row=state?.accounts[0];
 return <section aria-label="Move destination" className="mx-5 my-3 space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4"><header className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-medium">Move to</h3><p className="text-xs text-[var(--muted)]">{address}</p></div><button type="button" aria-label="Close destinations" onClick={onClose} className="rounded-full p-2 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><X size={16}/></button></header>
  {(!state||state.busy)&&<p role="status" className="text-xs text-[var(--muted)]">Loading folders…</p>}
  {row?.notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{row.notice}</p>}
  <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto">{row?.items.filter(folder=>folder.destination_id).map(folder=><button key={folder.folder_id} type="button" disabled={state?.busy||row.state!=='available'} onClick={()=>onChoose({accountId,token:folder.destination_id!})} className="rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50">{nativeFolderLabel(folder,row.items)}</button>)}</div>
  {row&&row.state==='available'&&!state?.busy&&!row.items.some(folder=>folder.destination_id)&&<p className="text-xs text-[var(--muted)]">No move destinations are available in the loaded folders.</p>}
  <div className="flex gap-2">{row?.nextCursor&&<button disabled={state?.busy} onClick={()=>void controller.current?.more(accountId)} className="rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)]">More folders</button>}<button disabled={state?.busy} onClick={()=>setReload(value=>value+1)} className="rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)]">Reload folders</button></div>
 </section>;
}
