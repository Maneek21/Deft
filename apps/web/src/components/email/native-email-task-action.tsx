'use client';
import {useState} from 'react';
import {NativeEmailTaskBridge} from './native-email-task-bridge';
import type {NativeMessageTarget} from '@/lib/email-native-message-links';
/** Parent keys this small action by current session/account/message. Switching
 * readers unmounts its dialog; no copied subject or task intent follows a target. */
export function NativeEmailTaskAction({target,sessionScope}:{target:NativeMessageTarget;sessionScope:string}){
 const [open,setOpen]=useState(false),[notice,setNotice]=useState('');
 return <><button type="button" aria-label="Create task from email" onClick={()=>{setNotice('');setOpen(true);}} className="rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]">Create task</button>{notice&&<span role="status" className="px-3 py-1 text-xs text-[var(--muted)]">{notice}</span>}{open&&<NativeEmailTaskBridge target={target} sessionScope={sessionScope} onClose={()=>setOpen(false)} onCreated={()=>{setOpen(false);setNotice('Task created.');}}/>}</>;
}
