'use client';
import {useEffect,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {useAuth} from '@/lib/auth-context';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {readNativeEmailAvailability,unavailableNativeEmail,type NativeEmailAvailability} from '@/lib/email-native-navigation';

/** Host availability only selects a navigation destination; each Email API still checks its own authority. */
export function useNativeEmailAvailability(enabled:boolean){
 const {sessionCacheScope}=useAuth();
 const [state,setState]=useState<{scope:string|null;value:NativeEmailAvailability}>({scope:null,value:unavailableNativeEmail});
 useEffect(()=>{
  if(!enabled||!sessionCacheScope)return;
  const anchor=api.getAccessToken();let active=true,pending:AbortController|null=null;
  const current=()=>active&&sessionCacheScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
  const refresh=async()=>{if(pending||!current())return;const controller=new AbortController();pending=controller;
   try{const value=await readNativeEmailAvailability({fetch:(path,init)=>api.fetch(path,init),current},controller.signal);if(current())setState({scope:sessionCacheScope,value});}
   finally{if(pending===controller)pending=null;}
  };
  void refresh();window.addEventListener('focus',refresh);window.addEventListener('online',refresh);
  return()=>{active=false;pending?.abort();window.removeEventListener('focus',refresh);window.removeEventListener('online',refresh);};
 },[enabled,sessionCacheScope]);
 return enabled&&sessionCacheScope&&state.scope===sessionCacheScope?state.value:unavailableNativeEmail;
}
