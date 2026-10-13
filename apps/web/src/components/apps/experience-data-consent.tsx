'use client';
import {useEffect,useRef,useState} from 'react';
import {api} from '@/lib/api';
import {RecordAccessStatusRow} from './record-access-status-row';
import {AppDialog} from '@/components/overlay-primitives';
import {AppDataContextSchema,AppDataConsentSnapshotSchema,AppDataConsentReferenceSchema} from '../../../../../packages/app-kit/src/app-data';
type Target=ReturnType<typeof AppDataContextSchema.parse>['targets'][number];
type Review={review_digest:string;snapshot:ReturnType<typeof AppDataConsentSnapshotSchema.parse>;target:Target};
/** Human record-write consent is separate from showing app data or Read OAuth. */
export function ExperienceDataConsent({installationId,targetKey,storeKeys,scopeKey,onChanged,showEnabled=false,onOpenSettings}:{installationId:string;targetKey:string;storeKeys:readonly string[];scopeKey:string;onChanged?:()=>void;showEnabled?:boolean;onOpenSettings?:()=>void}){
 const [targets,setTargets]=useState<Target[]>([]),[review,setReview]=useState<Review|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[blocked,setBlocked]=useState(false);
 const lifetime=useRef<AbortController|null>(null),generation=useRef(0);
 const current=(request:number)=>request===generation.current&&!lifetime.current?.signal.aborted;
 async function load(request=generation.current){const response=await api.fetch(`/api/app-data/installations/${encodeURIComponent(installationId)}/context?target_key=${encodeURIComponent(targetKey)}`,{signal:lifetime.current?.signal,cache:'no-store'});
  if(!response.ok)throw Error('Record access unavailable');const value=AppDataContextSchema.parse(await response.json());
  if(!current(request)||value.installation_id!==installationId)return;const selected=value.targets.filter(target=>target.target_key===targetKey);
  setTargets(selected);return value;
 }
 useEffect(()=>{const request=++generation.current,abort=new AbortController();lifetime.current=abort;setTargets([]);setReview(null);setBusy(false);setNotice('');setBlocked(false);
  void load(request).catch(()=>{if(current(request))setNotice('Connect an account to use private records.');});return()=>{abort.abort();generation.current++;};},[installationId,targetKey,scopeKey]);
 async function begin(target:Target,storeKey:string){if(busy)return;const request=generation.current;setBusy(true);setNotice('');setBlocked(false);
  try{const expires_at=new Date(Date.now()+24*60*60*1000).toISOString();const response=await api.fetch(`/api/app-data/connections/${encodeURIComponent(target.session_id)}/consent/review`,{
   method:'POST',signal:lifetime.current?.signal,body:JSON.stringify({store_key:storeKey,expires_at})});if(!response.ok)throw Error('Record access unavailable');
   const value=await response.json(),snapshot=AppDataConsentSnapshotSchema.parse(value.snapshot);
   if(!current(request)||snapshot.store.key!==storeKey||snapshot.connection.session_id!==target.session_id||snapshot.scope.installation_id!==installationId
    ||snapshot.scope.target_key!==target.target_key||!/^sha256:[a-f0-9]{64}$/u.test(value.review_digest)||Date.parse(snapshot.expires_at)<=Date.now())throw Error('Record review changed');
   setReview({review_digest:value.review_digest,snapshot,target});
  }catch{if(current(request))setNotice('Private record access could not be reviewed. Check the account, then try again.');}finally{if(current(request))setBusy(false);}}
 async function activate(){if(!review||busy||blocked)return;const request=generation.current,accepted=review;setBusy(true);setNotice('');
  try{const response=await api.fetch(`/api/app-data/connections/${encodeURIComponent(accepted.target.session_id)}/consent/activate`,{
   method:'POST',signal:lifetime.current?.signal,body:JSON.stringify({store_key:accepted.snapshot.store.key,expires_at:accepted.snapshot.expires_at,
    consent_id:accepted.snapshot.consent_id,expected_review_digest:accepted.review_digest,accept_host_policy:true})});
   if(!response.ok)throw Error('Record consent not confirmed');const consent=AppDataConsentReferenceSchema.parse(await response.json());
   if(!current(request)||consent.consent_id!==accepted.snapshot.consent_id||Date.parse(consent.expires_at)<=Date.now())throw Error('Record consent changed');
   await load(request);if(current(request)){setReview(null);setNotice('Private record access enabled.');onChanged?.();}
  }catch{if(current(request)){setBlocked(true);setNotice('Access could not be confirmed. Check its status before trying again.');}}finally{if(current(request))setBusy(false);}}
 const visibleTargets=targets.flatMap(target=>target.stores.filter(store=>storeKeys.includes(store.declaration.key)).map(store=>({target,store,active:!!store.consent&&Date.parse(store.consent.expires_at)>Date.now()})));
 const visibleNotice=showEnabled||notice!=='Private record access enabled.'?notice:'';
 if(!review&&!visibleNotice&&!visibleTargets.some(row=>showEnabled||!row.active))return null;
 if(!showEnabled&&onOpenSettings&&!review)return <section aria-label="Private record access" className="flex shrink-0 flex-wrap items-center gap-2 px-5 py-2 text-xs text-[var(--foreground-secondary)]">
  <p role="status">{visibleNotice||'Some features need access.'}</p>
  <button type="button" className="deft-pill" disabled={busy} onClick={onOpenSettings}>Review access</button>
 </section>;
 return <section aria-label="Private record access" className="mb-3 rounded-xl bg-[var(--surface-container-low)] px-3 py-2 text-xs">
  {visibleTargets.filter(row=>showEnabled||!row.active).map(({target,store,active})=><RecordAccessStatusRow key={`${target.session_id}/${store.declaration.key}`} label={target.account.label} storeKey={store.declaration.key} active={active} busy={busy} onReview={()=>void begin(target,store.declaration.key)}/>)}
  {visibleNotice&&<p role="status">{visibleNotice}</p>}
  {review&&<AppDialog open title="Allow private record storage" description="Review how this app can save your records for this connected account." onClose={()=>{if(!busy){setReview(null);setBlocked(false);}}}>
   <div className="space-y-4 text-sm"><p>{review.target.account.label}</p><p>This app may create, read, edit and archive its private {review.snapshot.store.key.replaceAll('_',' ')} records, and add or remove their files. Access ends {new Date(review.snapshot.expires_at).toLocaleString()}.</p>
    <details><summary className="min-h-10 cursor-pointer py-2">Storage limits</summary><p className="text-xs text-[var(--muted)]">{review.snapshot.store.max_record_bytes.toLocaleString()} bytes per record; up to {review.snapshot.store.max_files} files and {(review.snapshot.store.max_total_file_bytes/1048576).toLocaleString()} MiB of files per record.</p></details>
    <p>Sending or other external changes require a separate review.</p>{notice&&<p role="status">{notice}</p>}
    <div className="flex flex-wrap gap-2">{blocked?<button type="button" className="deft-pill min-h-11" disabled={busy} onClick={async()=>{const request=generation.current;setBusy(true);try{await load(request);if(current(request)){setReview(null);setBlocked(false);onChanged?.();}}catch{if(current(request))setNotice('Access status is unavailable.');}finally{if(current(request))setBusy(false);}}}>Check access status</button>
     :<button type="button" className="deft-pill min-h-11" disabled={busy} onClick={()=>void activate()}>{busy?'Enabling…':'Allow private records'}</button>}
     <button type="button" className="deft-pill min-h-11" disabled={busy} onClick={()=>setReview(null)}>Cancel</button></div>
   </div>
  </AppDialog>}
 </section>;
}
