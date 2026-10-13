'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {api} from '@/lib/api';
import {appIntegrationSourceHref} from '@/lib/app-integration-source-navigation';
export function AppIntegrationSourceOpen({sourceId,kind='knowledge'}:{sourceId:string;kind?:'knowledge'|'transfer'|'attention'|'native-email'}){
 const router=useRouter(),[message,setMessage]=useState('Checking source access...');
 useEffect(()=>{const controller=new AbortController();let active=true;
  void(async()=>{try{if(!(kind==='native-email'?/^[A-Za-z0-9_-]{1,512}$/u:/^[0-9a-f-]{36}$/u).test(sourceId))throw Error();
   const root={knowledge:'/api/app-integrations/knowledge/source/',transfer:'/api/app-integrations/destinations/source/',attention:'/api/app-integrations/destinations/attention/source/','native-email':'/api/email-adoption/source/'}[kind];
   const response=await api.fetch(root+encodeURIComponent(sourceId),{signal:controller.signal});
   if(!response.ok)throw Error();const href=appIntegrationSourceHref(await response.json());if(!href)throw Error();
   if(active&&!controller.signal.aborted)router.replace(href);
  }catch{if(active&&!controller.signal.aborted)setMessage('The original source is unavailable or your access has ended. The retained Knowledge copy follows its own sharing settings.');}})();
  return()=>{active=false;controller.abort();};
 },[sourceId,router,kind]);
 return <p role="status" className="p-6 text-sm text-muted-foreground">{message}</p>;
}
