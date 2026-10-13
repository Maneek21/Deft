'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {api,isSameWebSession} from '@/lib/api';
import {useAuth} from '@/lib/auth-context';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {completeDirectEmailConnection,directEmailSessionTag,directEmailStatusNotice,type DirectEmailStatus} from '@/lib/email-native-direct-connections';

export default function EmailConnectionCallbackPage(){
 const {sessionCacheScope}=useAuth();const query=useRef<string|undefined>(undefined),request=useRef<Promise<DirectEmailStatus>|null>(null),anchor=useRef<{scope:string;token:string|null}|null>(null);
 const [notice,setNotice]=useState('Checking your account connection…');
 useEffect(()=>{
  if(query.current===undefined){query.current=window.location.search;window.history.replaceState(null,'',window.location.pathname);}
  if(!sessionCacheScope)return;
  if(!request.current){const scope=sessionCacheScope,token=api.getAccessToken();anchor.current={scope,token};const search=query.current;
   const current=()=>scope===getActiveSessionCacheScope()&&isSameWebSession(token,api.getAccessToken());
   request.current=(async()=>{const tag=await directEmailSessionTag(scope);if(!current())throw Error('Your account session changed. Return to Email to continue.');return completeDirectEmailConnection({search,sessionTag:tag,storage:sessionStorage,current,fetch:(path,init)=>api.fetch(path,init)});})();
  }
  let subscribed=true;const current=()=>subscribed&&anchor.current?.scope===getActiveSessionCacheScope()&&isSameWebSession(anchor.current.token,api.getAccessToken());
  void request.current.then(result=>{if(current())setNotice(directEmailStatusNotice(result));},error=>{if(current())setNotice(error instanceof Error?error.message:'Account setup was not confirmed. Check its status in Email settings.');});
  // Effect replay subscribes to the same promise. Reload has no code in its
  // URL, so the retained exact request can only be checked with GET.
  return()=>{subscribed=false;};
 },[sessionCacheScope]);
 return <main className="mx-auto w-full max-w-xl space-y-4 p-6 sm:p-10"><h1 className="text-xl font-semibold">Account connection</h1><p role="status" className="text-sm text-[var(--on-surface-variant)]">{notice}</p><Link href="/email" className="deft-pill inline-flex items-center px-4 py-2 text-sm">Back to Email</Link></main>;
}
