'use client';
import {useEffect,useRef,useState} from 'react';
import {Archive,ChevronDown,RefreshCw} from 'lucide-react';
import {api,isSameWebSession} from '@/lib/api';
import {createNativeDraftApi,NativeDraftError} from '@/lib/email-native-drafts';
import {createNativeDraftSummaryApi,mergeNativeDraftSummaries,type NativeDraftSummary} from '@/lib/email-native-draft-summaries';
import {NativeEmailBrowserDrafts} from './native-email-browser-drafts';
import type {NativeComposeAccount,NativeComposeSelection} from './native-email-composer';
type ScopedDraft={accountId:string;draft:NativeDraftSummary};
type AccountPage={cursor:string|null;hasMore:boolean;loading:boolean};
export function NativeEmailDrafts({accounts,sessionScope,revision,recoveryOwner=null,onOpen}:{accounts:NativeComposeAccount[];sessionScope:string;revision:number;recoveryOwner?:{orgId:string;userId:string}|null;onOpen:(value:NativeComposeSelection)=>void}){
 const [rows,setRows]=useState<ScopedDraft[]>([]),[pages,setPages]=useState<Record<string,AccountPage>>({}),[loading,setLoading]=useState(true),[notice,setNotice]=useState(''),[reload,setReload]=useState(0),[archiving,setArchiving]=useState('');
 const generation=useRef(0),pageLoads=useRef(new Set<string>()),archiveClients=useRef(new Set<ReturnType<typeof createNativeDraftApi>>()),summaryClient=useRef<ReturnType<typeof createNativeDraftSummaryApi>|null>(null),summaryCurrent=useRef<(()=>boolean)|null>(null);
 const accountKey=JSON.stringify(accounts.map(row=>row.account_id));
 useEffect(()=>{
  const ticket=++generation.current;let active=true;const anchor=api.getAccessToken(),current=()=>active&&ticket===generation.current&&isSameWebSession(anchor,api.getAccessToken());
  const ownedArchives=archiveClients.current,client=createNativeDraftSummaryApi((path,options)=>api.fetch(path,options),current);summaryClient.current=client;summaryCurrent.current=current;
  setLoading(true);setNotice('');setRows([]);setPages({});setArchiving('');
  const ids=JSON.parse(accountKey) as string[],found:ScopedDraft[]=[],initial:Record<string,AccountPage>={},failed:string[]=[];let cursor=0;
  const worker=async()=>{while(cursor<ids.length&&current()){const accountId=ids[cursor++];try{const page=await client.query(accountId);if(!current())return;
    found.push(...page.items.map(draft=>({accountId,draft})));
    initial[accountId]={cursor:page.next_cursor,hasMore:page.has_more,loading:false};
   }catch(error){if(current()){initial[accountId]={cursor:null,hasMore:false,loading:false};failed.push(error instanceof NativeDraftError&&error.kind==='denied'?'Some account connections need attention.':'Some drafts could not be loaded.');}}}};
  void Promise.all([worker(),worker()]).then(()=>{if(!current())return;setRows(mergeNativeDraftSummaries(found.map(row=>row.draft)).map(draft=>({accountId:draft.account_id,draft})));setPages(initial);setNotice([...new Set(failed)].join(' '));setLoading(false);});
  return()=>{active=false;generation.current++;client.dispose();if(summaryClient.current===client){summaryClient.current=null;summaryCurrent.current=null;}for(const owned of ownedArchives)owned.dispose();ownedArchives.clear();};
 },[accountKey,sessionScope,revision,reload]);
 const loadMore=async(accountId:string)=>{
  const state=pages[accountId],client=summaryClient.current,current=summaryCurrent.current;if(!state?.hasMore||!state.cursor||state.loading||pageLoads.current.has(accountId)||!client||!current?.())return;
  pageLoads.current.add(accountId);
  const ticket=generation.current,cursor=state.cursor;setPages(previous=>({...previous,[accountId]:{...state,loading:true}}));
  try{const page=await client.query(accountId,cursor);if(!current()||ticket!==generation.current)return;
   setRows(previous=>mergeNativeDraftSummaries(previous.map(row=>row.draft),page.items).map(draft=>({accountId:draft.account_id,draft})));
   setPages(previous=>({...previous,[accountId]:{cursor:page.next_cursor,hasMore:page.has_more,loading:false}}));
  }catch(error){if(!current()||ticket!==generation.current)return;
   if(error instanceof NativeDraftError&&error.kind==='denied')setRows(previous=>previous.filter(row=>row.accountId!==accountId));
   const invalidCursor=error instanceof NativeDraftError&&(error.kind==='invalid'||error.kind==='missing');
   setPages(previous=>({...previous,[accountId]:error instanceof NativeDraftError&&error.kind==='denied'||invalidCursor?{cursor:null,hasMore:false,loading:false}:{...state,loading:false}}));
   setNotice(error instanceof NativeDraftError&&error.kind==='denied'?'An account connection changed. Refresh Drafts to continue.':invalidCursor?'This draft page expired. Refresh Drafts to continue.':'More drafts could not be loaded. Your list is unchanged.');
  }finally{pageLoads.current.delete(accountId);}
 };
 const archive=async(row:ScopedDraft)=>{
  if(archiving||row.draft.status!=='draft')return;const ticket=generation.current,anchor=api.getAccessToken(),current=()=>ticket===generation.current&&isSameWebSession(anchor,api.getAccessToken());
  const client=createNativeDraftApi((path,options)=>api.fetch(path,options),current);archiveClients.current.add(client);
  const key=row.accountId+'/'+row.draft.draft_id;setArchiving(key);setNotice('');
  try{await client.archive(row.accountId,row.draft.draft_id,row.draft.revision);if(current())setRows(previous=>previous.filter(value=>value.accountId+'/'+value.draft.draft_id!==key));}
  catch(error){if(current()){if(error instanceof NativeDraftError&&error.kind==='denied')setRows(previous=>previous.filter(value=>value.accountId!==row.accountId));setNotice(error instanceof NativeDraftError&&error.kind==='conflict'?'This draft changed elsewhere. Refresh Drafts before archiving it.':'Archiving could not be confirmed. Refresh Drafts before trying again.');}}
  finally{client.dispose();archiveClients.current.delete(client);if(current())setArchiving('');}
 };
 const addresses=new Map(accounts.map(value=>[value.account_id,value.primary_address]));
 const unsent=rows.filter(row=>row.draft.status==='draft'),submitted=rows.filter(row=>row.draft.status==='submitted');
 const renderRow=(row:ScopedDraft)=><div key={row.accountId+'/'+row.draft.draft_id} className="group flex items-center gap-1 rounded-xl hover:bg-[var(--hover-tint)]">
   <button className="min-w-0 flex-1 rounded-xl px-3 py-3 text-left focus-visible:ring-2 focus-visible:ring-[var(--accent)]" onClick={()=>onOpen({accountId:row.accountId,draftId:row.draft.draft_id})}><div className="flex items-center gap-2"><p className="min-w-0 flex-1 truncate text-sm font-medium">{row.draft.subject||'(No subject)'}</p>{row.draft.status==='submitted'&&<span className="shrink-0 rounded-full bg-[var(--surface-container-low)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]">Send status</span>}</div><p className="mt-1 truncate text-xs text-[var(--text-secondary)]">{addresses.get(row.accountId)||'Email account'}</p></button>
   {row.draft.status==='draft'&&<button aria-label={`Archive draft ${row.draft.subject||'without subject'}`} title="Archive draft" disabled={!!archiving} onClick={()=>void archive(row)} className="mr-1 rounded-full p-2 text-[var(--muted)] hover:bg-[var(--surface-container-low)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"><Archive size={16}/></button>}
  </div>;
 return <div className="space-y-2"><div className="flex justify-end px-3"><button aria-label="Refresh drafts" disabled={loading} onClick={()=>setReload(value=>value+1)} className="rounded-full p-2 hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><RefreshCw size={15} className={loading?'animate-spin':''}/></button></div>
  <NativeEmailBrowserDrafts accounts={accounts} sessionScope={sessionScope} owner={recoveryOwner} refreshKey={`${revision}/${reload}`} onOpen={onOpen}/>
  {notice&&<p role="status" className="px-3 text-xs text-[var(--text-secondary)]">{notice}</p>}
  {loading?<p role="status" className="px-3 py-8 text-sm text-[var(--muted)]">Loading drafts…</p>:<>
   {unsent.length?unsent.map(renderRow):<p className="px-3 py-8 text-sm text-[var(--muted)]">No unsent drafts loaded in this view.</p>}
   {!!submitted.length&&<details className="group mt-3 pt-2"><summary className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><ChevronDown size={14} aria-hidden="true" className="shrink-0 group-open:rotate-180"/>Submitted messages ({submitted.length} loaded)</summary><p className="px-3 py-2 text-xs text-[var(--muted)]">Open a message to check its sending status. Submitted messages cannot be edited.</p>{submitted.map(renderRow)}</details>}
  </>}
  {!loading&&Object.entries(pages).filter(([,page])=>page.hasMore).map(([accountId,page])=><div key={`more-${accountId}`} className="flex items-center justify-between border-t border-[var(--border-subtle)] px-3 pt-2">
   <span className="truncate text-xs text-[var(--muted)]">{addresses.get(accountId)||'Email account'}</span>
   <button onClick={()=>void loadMore(accountId)} disabled={page.loading} aria-busy={page.loading} className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--hover-tint)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50">{page.loading?'Loading…':'Load more'}<ChevronDown size={14}/></button>
  </div>)}
 </div>;
}
