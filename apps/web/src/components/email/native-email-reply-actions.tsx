'use client';
import {Reply,ReplyAll,Forward} from 'lucide-react';
import {createNativeReplyCompose,type NativeReplyCompose,type NativeReplyMode} from '@/lib/email-native-reply';
import type {NativeReaderPresentation} from '@/lib/email-native-reader';
export function NativeEmailReplyActions({value,onCompose}:{value:NativeReaderPresentation;onCompose:(selection:NativeReplyCompose)=>void}){
 const buttons=[{mode:'reply' as const,label:'Reply',Icon:Reply},{mode:'reply_all' as const,label:'Reply all',Icon:ReplyAll},{mode:'forward' as const,label:'Forward',Icon:Forward}];
 const seeds=new Map<NativeReplyMode,NativeReplyCompose>();for(const item of buttons){try{seeds.set(item.mode,createNativeReplyCompose(value,item.mode));}catch{/* Leave unsupported recipient seeds disabled. */}}
 return <div className="space-y-1"><div role="group" aria-label="Reply and forward" className="flex flex-wrap gap-1">{buttons.map(({mode,label,Icon})=><button key={mode} type="button" aria-label={label} disabled={!seeds.has(mode)} onClick={()=>{const seed=seeds.get(mode);if(seed)onCompose(seed);}} className="flex items-center gap-2 rounded-full px-3 py-2 text-sm hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"><Icon size={16} aria-hidden="true"/>{label}</button>)}</div>
  {!seeds.has('reply_all')&&<p className="text-xs text-[var(--muted)]">{!seeds.has('reply')&&'Reply recipients could not be confirmed. Check the original message and this account in Email settings. '}Reply all is unavailable because the complete recipient list could not be confirmed. Download the original to review every recipient.</p>}
 </div>;
}
