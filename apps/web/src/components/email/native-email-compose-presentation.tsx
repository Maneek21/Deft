'use client';
import {useEffect,useRef} from 'react';
import {Maximize2,X} from 'lucide-react';
export type NativeComposePresentation='normal'|'minimized'|'expanded';
export type NativeComposePresentationSummary={subject:string;sender:string;locked:boolean;senderUnavailable:boolean};
export type NativeComposePresentationHandle={disabled:boolean;close:()=>void};
export function NativeEmailComposePresentation({value,closeDisabled,onRestore,onExpand,onClose}:{value:NativeComposePresentationSummary;closeDisabled:boolean;onRestore:()=>void;onExpand:()=>void;onClose:()=>void}){
 const restore=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>{restore.current?.focus();},[]);
 const label=value.locked?'send status':'draft',subject=value.subject||'No subject';
 return <aside aria-label="Minimized Email composer" className="absolute inset-x-3 bottom-3 z-40 flex items-center gap-2 rounded-2xl bg-[var(--surface-container-high)] p-3 shadow-lg sm:left-auto sm:w-96">
  <button ref={restore} type="button" aria-label={`Restore ${label}: ${subject}. From ${value.sender}${value.senderUnavailable?' (unavailable)':''}`} title={`Restore ${label}`} onClick={onRestore} className="min-w-0 flex-1 rounded-xl px-2 py-1 text-left hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
   <span className="block truncate text-sm font-medium" title={subject}>{value.locked?'Send status: ':''}{subject}</span>
   <span className="block truncate text-xs text-[var(--text-secondary)]" title={`From ${value.sender}${value.senderUnavailable?' (unavailable)':''}`}>From {value.sender}{value.senderUnavailable?' (unavailable)':''}</span>
  </button>
  <button type="button" aria-label={`Expand ${label}`} title={`Expand ${label}`} onClick={onExpand} className="shrink-0 rounded-full p-2 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><Maximize2 size={17}/></button>
  <button type="button" aria-label={value.locked?'Close send status':'Save draft and close'} title={value.locked?'Close send status':'Save draft and close'} disabled={closeDisabled} onClick={onClose} className="shrink-0 rounded-full p-2 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"><X size={17}/></button>
 </aside>;
}
