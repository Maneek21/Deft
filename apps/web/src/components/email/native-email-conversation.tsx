'use client';
import {useEffect,useRef,useState} from 'react';
import {ChevronDown,MessageSquare,RefreshCw,X} from 'lucide-react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createNativeEmailConversation,type NativeConversationState} from '@/lib/email-native-conversation';
import type {NativeEmailMessage} from '@/lib/email-native-search';
const control='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
export function NativeEmailConversation({accountId,anchorId,sessionScope,address,selectedId,open,supported=true,headerRelated=false,onOpen,onClose,onSelect,onDenied}:{accountId:string;anchorId:string;sessionScope:string;address:string;selectedId:string;open:boolean;supported?:boolean;headerRelated?:boolean;onOpen:()=>void;onClose:()=>void;onSelect:(message:NativeEmailMessage)=>void;onDenied:()=>void}){
 const [state,setState]=useState<NativeConversationState|null>(null),client=useRef<ReturnType<typeof createNativeEmailConversation>|null>(null);
 const denied=useRef(onDenied);useEffect(()=>{denied.current=onDenied;},[onDenied]);
 useEffect(()=>{
  if(!open||!supported)return;const token=api.getAccessToken();let active=true;
  const value=createNativeEmailConversation({accountId,anchorId,headerRelated,current:()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(token,api.getAccessToken()),fetch:(path,options)=>api.fetch(path,options),change:setState,denied:()=>denied.current()});client.current=value;void value.start();
  return()=>{active=false;value.dispose();if(client.current===value)client.current=null;};
 },[accountId,anchorId,sessionScope,open,supported,headerRelated]);
 if(!open||!supported)return <div className="contents"><button type="button" disabled={!supported} title={supported?'View related messages':'Conversation view is not available for this account provider.'} onClick={onOpen} aria-expanded={false} className={`${control} inline-flex items-center gap-2 text-[var(--text-secondary)]`}><MessageSquare size={14}/>{headerRelated?'Related messages':'Conversation'}</button></div>;
 return <NativeEmailConversationList state={state} address={address} selectedId={selectedId} headerRelated={headerRelated} onClose={onClose} onSelect={onSelect} onMore={()=>void client.current?.more()} onReload={()=>void client.current?.reload()}/>;
}
export function NativeEmailConversationList({state,address,selectedId,headerRelated=false,onClose,onSelect,onMore,onReload}:{state:NativeConversationState|null;address:string;selectedId:string;headerRelated?:boolean;onClose:()=>void;onSelect:(message:NativeEmailMessage)=>void;onMore:()=>void;onReload:()=>void}){
 const related=headerRelated||state?.threadBasis==='message_headers',label=related?'Related messages':'Conversation';
 return <section aria-label={label} className="order-last w-full space-y-2 rounded-xl bg-[var(--surface-container-low)] p-3"><header className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-medium">{label}</h3><p className="text-[11px] text-[var(--muted)]">{address}</p></div><div className="flex items-center gap-1"><button type="button" disabled={state?.busy||state?.state==='denied'} aria-label={related?'Reload related messages':'Reload conversation'} onClick={onReload} className={control}><RefreshCw size={14} className={state?.busy?'animate-spin':''}/></button><button type="button" aria-label={related?'Close related messages':'Close conversation'} onClick={onClose} className={control}><X size={14}/></button></div></header>
  <p role="status" className="text-xs text-[var(--text-secondary)]">{!state||state.busy?'Loading related messages…':`${state.items.length} messages loaded${state.complete?'':' · more messages may exist'}`}</p>
  {state?.notice&&<p role="status" className="text-xs text-[var(--text-secondary)]">{state.notice}</p>}
  {!!state?.items.length&&<div className="max-h-48 space-y-1 overflow-y-auto" aria-label="Related messages">{state.items.map(message=><button key={message.logical_message_id} type="button" aria-pressed={message.logical_message_id===selectedId} disabled={state.state!=='available'} onClick={()=>onSelect(message)} className={`flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50 ${message.logical_message_id===selectedId?'bg-[var(--accent-light)]':'hover:bg-[var(--hover-tint)]'}`}><span className="min-w-0"><span className="block truncate text-xs font-medium">{String(message.data.from||message.data.sender||'Message')}</span><span className="mt-0.5 block truncate text-xs text-[var(--text-secondary)]">{String(message.data.subject||'(No subject)')}</span></span><span className="shrink-0 text-[11px] text-[var(--muted)]">{message.received_at?new Date(message.received_at).toLocaleDateString(undefined,{month:'short',day:'numeric'}):''}</span></button>)}</div>}
  {state?.state==='available'&&!state.items.length&&<p className="text-xs text-[var(--muted)]">{state.complete?'No related messages found.':'No related messages loaded yet.'}</p>}
  {state?.nextCursor&&<button type="button" disabled={state.busy} onClick={onMore} className={`${control} inline-flex items-center gap-1 text-[var(--text-secondary)]`}>Load more<ChevronDown size={14}/></button>}
  <p className="text-[11px] text-[var(--muted)]">{related?'Messages are related by their headers. This may not include the full exchange.':'Conversation results can change while new mail arrives.'}</p>
 </section>;
}
