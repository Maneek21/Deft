'use client';
import {useState,type ReactNode} from 'react';

/** Mount on first opening; collapse only hides content, preserving local edits. */
export function NativeEmailAccountPreferences({accountLabel,children}:{accountLabel:string;children:ReactNode}){
 const [activated,setActivated]=useState(false);
 return <details className="rounded-xl bg-[var(--surface-container-low)] p-4" onToggle={event=>{if(event.currentTarget.open)setActivated(true);}}>
  <summary className="cursor-pointer text-sm focus-visible:ring-2 focus-visible:ring-[var(--accent)]">{accountLabel}</summary>
  {activated&&children}
 </details>;
}
