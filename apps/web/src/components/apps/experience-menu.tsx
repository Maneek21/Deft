"use client";
import {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppMenu} from '../overlay-primitives';
import {EXPERIENCE_ICON_PATHS,type ExperienceDocumentContext,type ExperienceRendererOptions} from '@/lib/app-experience-renderer';
import type {DeftExperienceMenuNode,DeftExperienceIcon} from '../../../../../packages/app-kit/src/experience-menu';
function Icon({name}:{name:DeftExperienceIcon}){
 return <svg viewBox="0 0 24 24" className="ex-icon" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={EXPERIENCE_ICON_PATHS[name]}/></svg>;
}
export function ExperienceMenu({node,select,context}:{node:DeftExperienceMenuNode;select:(id:string)=>unknown;context:ExperienceDocumentContext}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),pending=useRef(false),anchor=useRef<HTMLButtonElement>(null);
 const current=()=>context.current()&&!context.signal.aborted;
 const close=()=>{setOpen(false);requestAnimationFrame(()=>{if(current()&&!document.activeElement?.closest('[aria-modal="true"]'))anchor.current?.focus();});};
 return <><button type="button" ref={anchor} data-focus-key={node.id} data-icon={node.icon??'more'} title={node.label} aria-label={node.label} aria-haspopup="menu" aria-expanded={open}
   className="ex-button-ghost" disabled={node.disabled||busy} onClick={()=>{if(current())setOpen(value=>!value);}}
   onKeyDown={event=>{if(current()&&!node.disabled&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setOpen(true);}}}>
   <Icon name={node.icon??'more'}/><span className="ex-button-label">{node.label}</span></button>
   <AppMenu open={open} onClose={close} anchorRef={anchor} ariaLabel={node.label} items={node.items.map(item=>({label:item.label,
    icon:item.icon?<Icon name={item.icon}/>:undefined,disabled:node.disabled||busy||item.disabled,danger:item.danger,onSelect:async()=>{
     if(!current()||!open||node.disabled||item.disabled||pending.current)return;
     pending.current=true;setBusy(true);try{await select(item.id);}finally{pending.current=false;if(current())setBusy(false);}
    }}))}/></>;
}
/** Author nodes stay inert; only the trusted Host mounts shared overlays. */
export function createExperienceMenuHost():Pick<ExperienceRendererOptions,'mountMenu'>{
 return {mountMenu(node,wrapper,select,context){const root=createRoot(wrapper);root.render(<ExperienceMenu node={node} select={select} context={context}/>);return()=>root.unmount();}};
}
