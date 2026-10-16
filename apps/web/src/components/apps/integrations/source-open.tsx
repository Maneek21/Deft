'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {api} from '@/lib/api';
import {appIntegrationSourceHref} from '@/lib/app-integration-source-navigation';
export function AppIntegrationSourceOpen({sourceId,kind='knowledge'}:{sourceId:string;kind?:'knowledge'|'transfer'|'attention'|'native-email'}){
 const router=useRouter(),[message,setMessage]=useState('Checking source access...'),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
 useEffect(()=>{const controller=new AbortController();let active=true;setFailed(false);setMessage('Checking source access...');
  void(async()=>{try{if(!(kind==='native-email'?/^[A-Za-z0-9_-]{1,512}$/u:/^[0-9a-f-]{36}$/u).test(sourceId))throw Error();
   const root={knowledge:'/api/app-integrations/knowledge/source/',transfer:'/api/app-integrations/destinations/source/',attention:'/api/app-integrations/destinations/attention/source/','native-email':'/api/email-adoption/source/'}[kind];
   const response=await api.fetch(root+encodeURIComponent(sourceId),{signal:controller.signal});
   if(!response.ok)throw Error();const href=appIntegrationSourceHref(await response.json());if(!href)throw Error();
   if(active&&!controller.signal.aborted)router.replace(href);
  }catch{if(active&&!controller.signal.aborted){setFailed(true);setMessage('The original source could not be opened. Check your app access and try again. The saved destination remains available under its own sharing settings.');}}})();
  return()=>{active=false;controller.abort();};
 },[sourceId,router,kind,attempt]);
 return <section className="space-y-3 p-6"><p role="status" className="text-sm text-muted-foreground">{message}</p>{failed&&<button type="button" className="deft-pill min-h-11" onClick={()=>setAttempt(value=>value+1)}>Try opening source again</button>}</section>;
}
