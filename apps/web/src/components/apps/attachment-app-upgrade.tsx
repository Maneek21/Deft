'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {useAuth} from '@/lib/auth-context';
import {refreshApps} from '@/hooks/use-apps';
import {appApiError,type AppInstallation} from '@/lib/apps';
import {createAttachmentUpgradeFlow,attachmentUpgradeTargets,attachmentUpgradeBlocked,type AttachmentUpgradeIdentity,type AttachmentUpgradeTarget,type AttachmentUpgradeReview} from '@/lib/app-attachment-upgrade';
import {AttachmentAppUpgradeReviewPanel} from './attachment-app-upgrade-review';
export function AttachmentAppUpgrade({app,seed}:{app:AppInstallation;seed?:AttachmentUpgradeTarget}){
 const {org,user,sessionCacheScope}=useAuth();if(!org||!user||!sessionCacheScope||app.manifest.schema_version!=='7'||app.state!=='active'||!app.active_version_id)return null;
 return <Workspace key={`${sessionCacheScope}/${app.id}/${app.active_version_id}/${app.lifecycle_epoch}/${app.grant_epoch}`} app={app} seed={seed} identity={{installation_id:app.id,app_id:app.app_id,prior_version_id:app.active_version_id,prior_package_digest:app.package_digest,lifecycle_epoch:app.lifecycle_epoch,grant_epoch:app.grant_epoch,org_id:org.id,owner_user_id:user.id,session_scope:sessionCacheScope}}/>;
}
function Workspace({app,identity,seed}:{app:AppInstallation;identity:AttachmentUpgradeIdentity;seed?:AttachmentUpgradeTarget}){
 const [targets,setTargets]=useState<AttachmentUpgradeTarget[]>([]),[selected,setSelected]=useState(seed?.version_id??''),[review,setReview]=useState<AttachmentUpgradeReview>(),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[uncertain,setUncertain]=useState(false);
 const lastSeed=useRef(seed?.version_id),alive=useRef(true),controller=useMemo(()=>new AbortController(),[]),anchor=useRef(api.getAccessToken()),generation=useRef(0),pending=useRef<AbortController|null>(null);
 const current=()=>alive.current&&!controller.signal.aborted&&!document.hidden&&isSameWebSession(anchor.current,localStorage.getItem('deft-access-token'));
 const storageKey=`deft-attachment-upgrade:${identity.session_scope}:${identity.installation_id}`;
 const read=async(path:string,init:RequestInit)=>{if(!current())throw Error('App review session ended');const response=await api.fetch(path,{...init,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000),...(pending.current?[pending.current.signal]:[])])});
  if(!response.ok)throw Error(await appApiError(response,'This App upgrade is unavailable.'));if(!response.body)throw Error('App response unavailable');const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(!current()||size>2097152)throw Error('App review changed or exceeded its display limit');parts.push(part.value);}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;part.fill(0);}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}finally{bytes.fill(0);}}
  finally{for(const part of parts)part.fill(0);await reader.cancel().catch(()=>{});reader.releaseLock();}};
 const setup=useMemo(()=>{try{return {flow:createAttachmentUpgradeFlow({identity,current,signal:controller.signal,call:read,load:()=>{const value=localStorage.getItem(storageKey);if(!value)return null;if(value.length>4096)throw Error('Upgrade recovery record unavailable');return JSON.parse(value);},store:value=>{if(value)localStorage.setItem(storageKey,JSON.stringify(value));else localStorage.removeItem(storageKey);}}),error:''};}catch{return {flow:undefined,error:'The saved upgrade recovery record is unavailable. Do not repeat activation.'};}},[]);
 const flow=setup.flow;
 const begin=()=>{pending.current?.abort();pending.current=new AbortController();setBusy(true);setNotice('');return ++generation.current;};
 const same=(id:number)=>current()&&id===generation.current&&!pending.current?.signal.aborted;
 const discover=async()=>{if(!flow)return;const id=begin();try{if(flow.pending){setUncertain(true);if(await flow.status()&&same(id)){setUncertain(false);setNotice('Upgrade confirmed. Review account and Runtime access separately.');await refreshApps();}else if(same(id))setNotice('Upgrade outcome is uncertain. Check status; do not activate again.');return;}
  const rows=attachmentUpgradeTargets(await read(`/api/apps/${encodeURIComponent(app.id)}/grants`,{cache:'no-store'}),identity);if(same(id)){setTargets(rows);setSelected(old=>rows.some(row=>row.version_id===old)?old:seed&&rows.some(row=>row.version_id===seed.version_id)?seed.version_id:rows.length===1?rows[0].version_id:'');}}
  catch(error){if(same(id))setNotice(error instanceof Error?error.message:'Upgrade details unavailable.');}finally{if(same(id))setBusy(false);}};
 useEffect(()=>{alive.current=true;void discover();const hidden=()=>{if(document.hidden){generation.current++;pending.current?.abort();flow?.clearReview();setReview(undefined);setAccepted(false);setBusy(false);}};document.addEventListener('visibilitychange',hidden);addEventListener('pagehide',hidden);
  return()=>{alive.current=false;generation.current++;pending.current?.abort();document.removeEventListener('visibilitychange',hidden);removeEventListener('pagehide',hidden);};},[]);
 useEffect(()=>{if(seed?.version_id!==lastSeed.current){lastSeed.current=seed?.version_id;if(seed&&!flow?.pending)void discover();}},[seed?.version_id]);
 const target=targets.find(target=>target.version_id===selected);
 return <section aria-label="App package upgrades" className="mt-4 space-y-3 border-t border-[var(--ghost-border)] pt-4 text-sm">
  {setup.error&&<p role="alert">{setup.error}</p>}{notice&&<p role="status">{notice}</p>}{busy&&<p role="status">Checking the current App version…</p>}
  {uncertain||flow?.pending?<button type="button" className="deft-pill min-h-11" disabled={busy} onClick={()=>void discover()}>Check upgrade status</button>:review?<AttachmentAppUpgradeReviewPanel review={review} busy={busy} accepted={accepted} onAccept={setAccepted} onClose={()=>{flow?.clearReview();setReview(undefined);setAccepted(false);setNotice('Review closed. The staged package remains available.');}} onActivate={()=>{if(!flow||!target||!accepted||attachmentUpgradeBlocked(review))return;const id=begin();void flow.activate(target).then(async complete=>{if(!same(id))return;setReview(undefined);setAccepted(false);setUncertain(!complete);setNotice(complete?'Upgrade confirmed. Review account and Runtime access separately.':'Upgrade outcome is uncertain. Check status; do not activate again.');if(complete)await refreshApps();}).catch(error=>{if(same(id))setNotice(error instanceof Error?error.message:'Upgrade unavailable.');}).finally(()=>{if(same(id))setBusy(false);});}}/>:targets.length>0?<>
   <label className="block">Staged version<select className="ml-2 rounded-lg bg-[var(--surface-container-low)] px-2 py-2" disabled={busy} value={selected} onChange={event=>{setSelected(event.target.value);setReview(undefined);setAccepted(false);}}><option value="">Choose a version</option>{targets.map(target=><option key={target.version_id} value={target.version_id}>{target.version}</option>)}</select></label>
   {target&&<details><summary className="cursor-pointer py-2">Exact staged package</summary><code className="block break-all text-xs">{target.package_digest}</code></details>}
   <button type="button" className="deft-pill min-h-11" disabled={busy||!target||!flow} onClick={()=>{if(!target||!flow)return;const id=begin();void flow.prepare(target).then(value=>{if(same(id)){setReview(value);setAccepted(false);}}).catch(error=>{if(same(id))setNotice(error instanceof Error?error.message:'Upgrade review unavailable.');}).finally(()=>{if(same(id))setBusy(false);});}}>Review staged upgrade</button>
  </>:<p>No upgrade is staged. Use Stage upgrade to inspect a package for this App.</p>}
  {!review&&!flow?.pending&&<button type="button" className="deft-pill min-h-11" disabled={busy||!flow} onClick={()=>void discover()}>Refresh staged versions</button>}
 </section>;
}
