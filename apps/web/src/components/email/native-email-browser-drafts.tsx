'use client';
import {useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {getActiveSessionCacheScope} from '@/lib/session-cache';
import {checkNativeBrowserDraftSource,createNativeBrowserDraftDiscovery} from '@/lib/email-native-browser-drafts';
import {createNativeEmailOfflineDraftJournal,type NativeOfflineDraftMetadata} from '@/lib/email-native-offline-drafts';
import {emailReadingPreferenceRequest} from '@/lib/email-reading-preferences';
import type {NativeComposeAccount,NativeComposeSelection} from './native-email-composer';
export type BrowserDraftRow={accountId:string;metadata:NativeOfflineDraftMetadata};
const pill='rounded-full px-3 py-2 text-xs hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50';
export function NativeEmailBrowserDraftRows({rows,accounts,busy,onOpen,onSaved}:{rows:BrowserDraftRow[];accounts:NativeComposeAccount[];busy:boolean;onOpen:(row:BrowserDraftRow)=>void;onSaved:(row:BrowserDraftRow)=>void}){
 if(!rows.length)return null;const addresses=new Map(accounts.map(account=>[account.account_id,account.primary_address]));
 return <section aria-label="Browser drafts" className="space-y-2 px-3 py-3"><h3 className="text-sm font-medium">Browser drafts</h3><p className="text-xs text-[var(--muted)]">Recover text saved in this browser. New copies need their attachments added again.</p>
  {rows.map(row=><div key={JSON.stringify([row.accountId,row.metadata.draftId,row.metadata.branchId])} className="rounded-xl bg-[var(--surface-container-low)] p-3"><p className="text-xs text-[var(--text-secondary)]">{addresses.get(row.accountId)||'Email account'} · {row.metadata.branchId?'Another tab’s recovery copy':'Browser recovery copy'}</p><p className="mt-1 text-xs text-[var(--muted)]">{new Date(row.metadata.updatedAt).toLocaleString()}{row.metadata.sendOutcome==='unknown'?' · Sending outcome needs checking':''}</p><div className="mt-2 flex flex-wrap gap-1">{row.metadata.sendOutcome==='none'&&<button type="button" className={pill} disabled={busy} onClick={()=>onOpen(row)}>Open browser text as new draft</button>}{row.metadata.baseServerRevision>0&&<button type="button" className={pill} disabled={busy} onClick={()=>onSaved(row)}>Open saved draft</button>}</div></div>)}
 </section>;
}
export function NativeEmailBrowserDrafts({accounts,sessionScope,owner,refreshKey,onOpen}:{accounts:NativeComposeAccount[];sessionScope:string;owner:{orgId:string;userId:string}|null;refreshKey:string;onOpen:(selection:NativeComposeSelection)=>void}){
 const [rows,setRows]=useState<BrowserDraftRow[]>([]),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const controller=useRef<ReturnType<typeof createNativeBrowserDraftDiscovery>|null>(null),live=useRef<(()=>boolean)|null>(null),opening=useRef(false);
 const accountKey=JSON.stringify(accounts.map(account=>account.account_id)),ownerKey=JSON.stringify(owner);
 useEffect(()=>{
  let active=true;const anchor=api.getAccessToken(),current=()=>active&&sessionScope===getActiveSessionCacheScope()&&isSameWebSession(anchor,api.getAccessToken());live.current=current;setRows([]);setNotice('');setBusy(false);opening.current=false;
  const recoveryOwner=JSON.parse(ownerKey) as {orgId:string;userId:string}|null;if(!recoveryOwner)return()=>{active=false;live.current=null;};
  const discovery=createNativeBrowserDraftDiscovery({owner:recoveryOwner,current,prove:async(accountId,signal)=>{await emailReadingPreferenceRequest(accountId,{current,fetch:(path,init)=>api.fetch(path,init)},undefined,signal);},open:(scope,authorize)=>createNativeEmailOfflineDraftJournal(scope,{authorize}),checkSource:(accountId,draftId,signal)=>checkNativeBrowserDraftSource(accountId,draftId,{current,fetch:(path,init)=>api.fetch(path,init)},signal)});controller.current=discovery;
  const ids=JSON.parse(accountKey) as string[];let cursor=0;const found:BrowserDraftRow[]=[];let failed=false;
  const worker=async()=>{while(cursor<ids.length&&current()){const accountId=ids[cursor++];try{const metadata=await discovery.list(accountId);if(current())found.push(...metadata.map(value=>({accountId,metadata:value})));}catch{if(current())failed=true;}}};
  void Promise.all([worker(),worker()]).then(()=>{if(current()){setRows(found.sort((a,b)=>b.metadata.updatedAt-a.metadata.updatedAt));if(failed)setNotice('Some browser drafts could not be checked. Reconnect the account or try Refresh.');}});
  return()=>{active=false;discovery.dispose();if(controller.current===discovery){controller.current=null;live.current=null;}};
 },[accountKey,ownerKey,sessionScope,refreshKey]);
 const open=async(row:BrowserDraftRow)=>{const discovery=controller.current,current=live.current;if(!discovery||!current?.()||opening.current)return;opening.current=true;setBusy(true);setNotice('');
  try{const selection=await discovery.open(row.accountId,row.metadata);if(current())onOpen(selection);}catch(error){if(current())setNotice(error instanceof Error?error.message:'Browser text could not be opened. Try Refresh.');}finally{if(current()){opening.current=false;setBusy(false);}}
 };
 return <>{notice&&<p role="status" className="px-3 text-xs text-[var(--text-secondary)]">{notice}</p>}<NativeEmailBrowserDraftRows rows={rows} accounts={accounts} busy={busy} onOpen={row=>void open(row)} onSaved={row=>{if(live.current?.())onOpen({accountId:row.accountId,draftId:row.metadata.draftId});}}/></>;
}
