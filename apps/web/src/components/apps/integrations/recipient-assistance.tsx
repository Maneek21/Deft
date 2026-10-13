'use client';
import {useEffect,useState} from 'react';
export {AppIntegrationRecipientAssistanceResultSchema as RecipientAssistanceResultSchema} from '../../../../../../packages/app-kit/src/app-integration-destination';
import {AppIntegrationRecipientAssistanceResultSchema as RecipientAssistanceResultSchema,type AppIntegrationRecipientAssistanceResult as RecipientAssistanceResult} from '../../../../../../packages/app-kit/src/app-integration-destination';
export type {AppIntegrationRecipientAssistanceResult as RecipientAssistanceResult} from '../../../../../../packages/app-kit/src/app-integration-destination';
export type RecipientSearch=(query:string,signal:AbortSignal)=>Promise<RecipientAssistanceResult>;
export function RecipientAssistance({query,search,disabled,onSelect}:{query:string;search:RecipientSearch;disabled:boolean;onSelect:(row:RecipientAssistanceResult['items'][number])=>void}){
 const [result,setResult]=useState<RecipientAssistanceResult>(),[notice,setNotice]=useState('');
 useEffect(()=>{const controller=new AbortController();setResult(undefined);setNotice('');const text=query.trim();if(disabled||text.length<2||text.length>240)return()=>controller.abort();
  const timer=setTimeout(()=>{setNotice('Finding recipients…');void search(text,controller.signal).then(value=>{if(!controller.signal.aborted){setResult(RecipientAssistanceResultSchema.parse(value));setNotice('');}}).catch(()=>{if(!controller.signal.aborted)setNotice('Recipient assistance is unavailable. You can enter an address.');});},250);
  return()=>{clearTimeout(timer);controller.abort();};
 },[query,search,disabled]);
 if(!result&&!notice)return null;
 return <div className="ml-[4.25rem] min-w-0 rounded-xl bg-[var(--surface-container-low)] p-2">
  {notice&&<p role="status" className="px-2 py-1 text-xs text-[var(--muted)]">{notice}</p>}
  {result&&<><ul aria-label="Suggested recipients">{result.items.map(row=><li key={row.address}><button type="button" disabled={disabled} className="flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-[var(--surface-container-high)] focus-visible:ring-2 focus-visible:ring-[var(--primary)]" onPointerDown={event=>event.preventDefault()} onClick={()=>onSelect(row)}><span className="min-w-0"><span className="block truncate text-sm">{row.name||row.address}</span>{row.name&&<span className="block truncate text-xs text-[var(--muted)]">{row.address}</span>}</span><span className="shrink-0 text-xs text-[var(--muted)]">{row.provenance.map(value=>value==='contacts'?'Contacts':'Recent').join(' · ')}</span></button></li>)}</ul>
   <p role="status" className="px-2 py-1 text-xs text-[var(--muted)]">{result.items.length===0?'No matching recipients. ':''}{result.sources.contacts==='not_installed'?'Contacts is not installed. ':result.sources.contacts==='unavailable'?'Contacts is unavailable. ':''}{result.sources.recent==='unavailable'?'Recent recipients are unavailable. ':'Recent recipients cover known accepted sends only. '}{result.has_more?'Refine your search for more matches.':''}</p></>}
 </div>;
}
