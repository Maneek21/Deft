'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createNativeEmailUnread,nativeUnreadStateDisplay,nativeUnreadScopeKey,NATIVE_UNREAD_POLL_MS,type NativeUnreadState,type NativeUnreadDisplay} from '@/lib/email-native-unread';
export function NativeEmailUnreadBadge({value}:{value?:NativeUnreadDisplay|null}){
 if(!value||value.count===null||!Number.isSafeInteger(value.count)||value.count<=0)return null;
 return <span title={value.label} aria-label={value.label} className="shrink-0 rounded-full bg-[var(--accent-light)] px-2 py-0.5 text-[10px] text-[var(--primary)]">{value.count>99?'99+':value.count}</span>;
}
export function NativeEmailUnread({accountIds,sessionScope,revision=0,onChange,onDenied}:{accountIds:readonly string[];sessionScope:string;revision?:number;onChange?:(display:NativeUnreadDisplay)=>void;onDenied?:(accountId:string|null)=>void}){
 const key=nativeUnreadScopeKey(accountIds),[state,setState]=useState<{scope:string;value:NativeUnreadState}|null>(null),client=useRef<ReturnType<typeof createNativeEmailUnread>|null>(null),callbacks=useRef({onChange,onDenied});
 useEffect(()=>{callbacks.current={onChange,onDenied};},[onChange,onDenied]);
 useEffect(()=>{let active=true;const anchor=api.getAccessToken(),current=()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());const owned=createNativeEmailUnread({accountIds:JSON.parse(key),current,fetch:(path,init)=>api.fetch(path,init),change:value=>{setState({scope:sessionScope,value});callbacks.current.onChange?.(nativeUnreadStateDisplay(value));},denied:id=>callbacks.current.onDenied?.(id)});client.current=owned;setState(null);
  const refresh=()=>{if(document.visibilityState==='visible')void owned.load();};const interval=setInterval(refresh,NATIVE_UNREAD_POLL_MS);document.addEventListener('visibilitychange',refresh);
  return()=>{active=false;clearInterval(interval);document.removeEventListener('visibilitychange',refresh);owned.dispose();if(client.current===owned)client.current=null;};
 },[key,sessionScope]);
 useEffect(()=>{void client.current?.load();},[key,sessionScope,revision]);
 const value=nativeUnreadStateDisplay(state?.scope===sessionScope&&state.value.key===key?state.value:null);
 return accountIds.length?<span role="status" title={value.label} className="text-[11px] text-[var(--muted)]">{value.text}</span>:null;
}
export function NativeEmailNotificationsInfo(){
 return <section aria-label="Email notifications" className="space-y-2"><h3 className="text-sm font-medium">Notifications</h3><p className="text-xs text-[var(--muted)]">New mail appears in Deft Updates. Browser alerts for Email are off by default.</p><div className="flex flex-wrap gap-1"><Link href="/inbox?lane=updates" className="inline-flex rounded-full px-3 py-2 text-xs text-[var(--primary)] hover:bg-[var(--hover-tint)]">View updates</Link><Link href="/settings/profile" className="inline-flex rounded-full px-3 py-2 text-xs text-[var(--primary)] hover:bg-[var(--hover-tint)]">Browser notification settings</Link></div></section>;
}
