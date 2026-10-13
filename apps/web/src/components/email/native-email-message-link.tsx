'use client';
import {useEffect,useRef} from 'react';
import {useSearchParams} from 'next/navigation';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createNativeMessageLinkResolver,createNativeMessageSummary} from '@/lib/email-native-message-links';
import type {NativeMessageTarget} from '@/lib/email-native-message-links';
import type {NativeEmailMessage} from '@/lib/email-native-search';
export function NativeEmailMessageLink({accountIds,ready,sessionScope,selected=null,onChange,onDenied,onOpening}:{accountIds:string[];ready:boolean;sessionScope:string;selected?:NativeEmailMessage|null;onChange:(row:NativeEmailMessage|null,notice:string)=>void;onDenied:(id:string)=>void;onOpening?:(target:NativeMessageTarget)=>void}){
 const search=useSearchParams().toString(),scope=JSON.stringify(accountIds.slice().sort()),callbacks=useRef({onChange,onDenied,selected,onOpening});useEffect(()=>{callbacks.current={onChange,onDenied,selected,onOpening};},[onChange,onDenied,selected,onOpening]);
 const resolver=useRef<ReturnType<typeof createNativeMessageLinkResolver>|null>(null);
 useEffect(()=>{const anchor=api.getAccessToken();let active=true;const current=()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken()),summary=createNativeMessageSummary({current,fetch:(path,init)=>api.fetch(path,init)}),owned=createNativeMessageLinkResolver({current,selected:()=>callbacks.current.selected,read:(target,signal)=>summary.read(target,signal),change:(row,notice)=>callbacks.current.onChange(row,notice),opening:target=>callbacks.current.onOpening?.(target),denied:id=>callbacks.current.onDenied(id)});resolver.current=owned;return()=>{active=false;owned.dispose();summary.dispose();resolver.current=null;};},[sessionScope]);
 useEffect(()=>{void resolver.current?.load(search,JSON.parse(scope),ready);},[search,scope,ready,sessionScope]);return null;
}
