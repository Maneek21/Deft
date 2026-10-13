'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {createEmailConnectedClient,EmailConnectedError} from '@/lib/email-native-connected';

export function useEmailConnectedResource<T>(accountId:string,sessionScope:string,suffix:string,parse:(raw:unknown)=>T,enabled=true) {
  const [value,setValue]=useState<T|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[uncertain,setUncertain]=useState(false),[attempt,setAttempt]=useState(0);
  const owner=useRef<{client:ReturnType<typeof createEmailConnectedClient>;current:()=>boolean}|null>(null),mutating=useRef(false),refreshing=useRef(false),readEpoch=useRef(0);
  useEffect(()=>{
    setValue(null);setNotice('');setUncertain(false);mutating.current=false;
    if(!enabled){setBusy(false);return;}
    const anchor=api.getAccessToken();let active=true;
    const current=()=>active&&!!anchor&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());
    const client=createEmailConnectedClient({accountId,current,fetch:(path,init)=>api.fetch(path,init)}),owned={client,current};owner.current=owned;setBusy(true);
    const checkSession=()=>{if(!current()){client.dispose();setValue(null);setNotice('');setBusy(false);}};
    addEventListener('storage',checkSession);
    void client.request(suffix,parse).then(result=>{if(current())setValue(result);}).catch(error=>{if(current())setNotice(error instanceof Error?error.message:'Settings are unavailable.');}).finally(()=>{if(current())setBusy(false);});
    return()=>{active=false;removeEventListener('storage',checkSession);client.dispose();if(owner.current===owned)owner.current=null;};
  },[accountId,sessionScope,suffix,parse,attempt,enabled]);
  const save=async(body:unknown)=>{
    const owned=owner.current;if(!owned||!owned.current()||mutating.current||busy||uncertain||!value)return null;
    mutating.current=true;readEpoch.current++;setBusy(true);setNotice('');
    try {const result=await owned.client.request(suffix,parse,body);if(owned.current()&&owner.current===owned){setValue(result);setNotice('Saved.');return result;}return null;}
    catch(error){if(owned.current()&&owner.current===owned){if(error instanceof EmailConnectedError&&error.kind==='denied')setValue(null);setUncertain(true);setNotice(error instanceof Error?error.message:'The saved result could not be confirmed.');}return null;}
    finally {if(owner.current===owned){mutating.current=false;if(owned.current())setBusy(false);}}
  };
  const refresh=useCallback(async()=>{
    const owned=owner.current;if(!owned?.current()||mutating.current||refreshing.current||busy||uncertain)return;
    refreshing.current=true;const ticket=readEpoch.current;
    try{const result=await owned.client.request(suffix,parse);if(owned.current()&&owner.current===owned&&ticket===readEpoch.current)setValue(result);}
    catch(error){if(owned.current()&&owner.current===owned&&error instanceof EmailConnectedError&&error.kind==='denied'){setValue(null);setNotice(error.message);}}
    finally{refreshing.current=false;}
  },[suffix,parse,busy,uncertain]);
  return {value,busy,notice,uncertain,save,refresh,reload:()=>{if(!mutating.current)setAttempt(value=>value+1);},current:sessionScope===getActiveSessionCacheScope()};
}
