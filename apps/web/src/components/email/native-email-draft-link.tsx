'use client';
import {useEffect,useRef} from 'react';
import {useSearchParams} from 'next/navigation';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createNativeDraftApi} from '@/lib/email-native-drafts';
import type {NativeComposeSelection} from './native-email-composer';

export function parseNativeDraftLink(search:string):{accountId:string;draftId:string}|null {
  const params=new URLSearchParams(search);
  if(!params.has('draft'))return null;
  const accountId=params.get('account'),draftId=params.get('draft');
  if(params.getAll('account').length!==1||params.getAll('draft').length!==1||params.has('message')||!accountId||accountId.length>256||/[\u0000-\u001f]/u.test(accountId)||!draftId||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(draftId))throw Error('This draft link is invalid.');
  return {accountId,draftId};
}
export function NativeEmailDraftLink({accountIds,ready,sessionScope,onOpen,onNotice}:{accountIds:string[];ready:boolean;sessionScope:string;onOpen:(selection:NativeComposeSelection)=>void;onNotice:(notice:string)=>void}) {
  const search=useSearchParams().toString(),scope=JSON.stringify(accountIds.slice().sort()),callbacks=useRef({onOpen,onNotice}),resolved=useRef('');
  callbacks.current={onOpen,onNotice};
  useEffect(()=>{
    if(!ready||resolved.current===search)return;
    let target:{accountId:string;draftId:string}|null;
    try {target=parseNativeDraftLink(search);}catch(error){callbacks.current.onNotice(error instanceof Error?error.message:'This draft link is invalid.');resolved.current=search;return;}
    if(!target)return;
    resolved.current=search;
    if(!(JSON.parse(scope) as string[]).includes(target.accountId)){callbacks.current.onNotice('This draft account is unavailable. Check the connection in Email settings.');return;}
    const anchor=api.getAccessToken();let active=true;
    const current=()=>active&&getActiveSessionCacheScope()===sessionScope&&isSameWebSession(anchor,api.getAccessToken());
    const client=createNativeDraftApi((path,init)=>api.fetch(path,init),current);
    void client.read(target.accountId,target.draftId).then(draft=>{if(!current())return;if(draft.status!=='draft')throw Error('This saved draft is no longer editable.');callbacks.current.onOpen({accountId:target!.accountId,draftId:draft.draft_id});}).catch(error=>{if(current())callbacks.current.onNotice(error instanceof Error?error.message:'The saved draft could not be opened.');});
    return()=>{active=false;resolved.current='';client.dispose();};
  },[search,scope,ready,sessionScope]);
  return null;
}
