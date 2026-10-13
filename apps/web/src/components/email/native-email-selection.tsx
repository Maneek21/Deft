'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {SquareCheck} from 'lucide-react';

/** Selection is deliberate; reading a message never selects it for a bulk action. */
export function NativeEmailSelection({active,count,loaded,busy,onStart,onAll,onClear,onDone}:{active:boolean;count:number;loaded:number;busy:boolean;onStart:()=>void;onAll:()=>void;onClear:()=>void;onDone:()=>void}){
 const id=useId(),menu=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false);
 const close=()=>{setOpen(false);trigger.current?.focus();};
 useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(menu.current&&!menu.current.contains(event.target as Node))close();};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[open]);
 const choose=(action:()=>void)=>{close();action();};
 const item='w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40';
 return <div ref={menu} data-email-menu-open={open?'true':undefined} className="relative" onKeyDown={event=>{if(open&&event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('[aria-modal="true"]')){event.preventDefault();event.stopPropagation();close();}}}>
  <button ref={trigger} type="button" aria-label="Message selection" title="Message selection" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)} className={`flex items-center gap-1 rounded-full p-2 focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${active?'bg-[var(--accent-light)] text-[var(--primary)]':'hover:bg-[var(--hover-tint)]'}`}><SquareCheck size={17} aria-hidden="true"/>{active&&count>0&&<span className="text-xs">{count}</span>}</button>
  <div id={id} hidden={!open} role="group" aria-label="Selection options" className="absolute right-0 z-30 mt-2 w-60 max-w-[calc(100vw-2rem)] rounded-xl bg-[var(--surface-container-low)] p-1.5 shadow-xl ring-1 ring-[var(--border)]">
   {!active&&<button type="button" aria-label="Select messages" disabled={!loaded||busy} onClick={()=>choose(onStart)} className={item}>Select messages</button>}
   <button type="button" aria-label="Select all loaded messages" disabled={!loaded||busy} onClick={()=>choose(onAll)} className={item}>Select all loaded messages<span className="mt-0.5 block text-xs text-[var(--muted)]">{loaded>100?'First 100 messages':`${loaded} messages`}</span></button>
   {active&&<><button type="button" aria-label="Clear selection" disabled={!count||busy} onClick={()=>choose(onClear)} className={item}>Clear selection</button><button type="button" aria-label="Done selecting" disabled={busy} onClick={()=>choose(onDone)} className={item}>Done selecting</button></>}
  </div>
 </div>;
}
