'use client';
import {appConsentDeadline} from '../../../../../packages/app-kit/src/consent-lifetime';
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
 const [permissionLifetime,setPermissionLifetime]=useState<'date'|'until_revoked'>('date'),[until,setUntil]=useState(()=>{const d=new Date(Date.now()+24*60*60*1000),pad=(v:number)=>String(v).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;}),[clock,setClock]=useState(Date.now());
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
  try{const selected=permissionLifetime==='until_revoked'?{expires_at:null,consent_lifetime:'until_revoked' as const}:{expires_at:new Date(until).toISOString()};if(permissionLifetime==='until_revoked'&&target.allow_until_revoked!==true||appConsentDeadline(selected.expires_at,selected.consent_lifetime)<=Date.now())throw Error('Invalid record lifetime');const response=await api.fetch(`/api/app-data/connections/${encodeURIComponent(target.session_id)}/consent/review`,{
   method:'POST',signal:lifetime.current?.signal,body:JSON.stringify({store_key:storeKey,...selected})});if(!response.ok)throw Error('Record access unavailable');
   const value=await response.json(),snapshot=AppDataConsentSnapshotSchema.parse(value.snapshot);
   if(!current(request)||snapshot.store.key!==storeKey||snapshot.connection.session_id!==target.session_id||snapshot.connection.account_ref!==target.account.account_ref||snapshot.scope.installation_id!==installationId
    ||snapshot.scope.target_key!==target.target_key||!/^sha256:[a-f0-9]{64}$/u.test(value.review_digest)||snapshot.consent_lifetime!==selected.consent_lifetime||appConsentDeadline(snapshot.expires_at,snapshot.consent_lifetime)>appConsentDeadline(selected.expires_at,selected.consent_lifetime)||appConsentDeadline(snapshot.expires_at,snapshot.consent_lifetime)<=Date.now()||Date.parse(snapshot.review_expires_at??snapshot.expires_at!)<=Date.now())throw Error('Record review changed');
   setReview({review_digest:value.review_digest,snapshot,target});
  }catch{if(current(request))setNotice('Private record access could not be reviewed. Check the account, then try again.');}finally{if(current(request))setBusy(false);}}
 async function activate(){if(!review||busy||blocked)return;if(Date.parse(review.snapshot.review_expires_at??review.snapshot.expires_at!)<=Date.now()){setNotice('This review expired. Review private record access again.');setReview(null);return;}const request=generation.current,accepted=review;setBusy(true);setNotice('');
  try{const response=await api.fetch(`/api/app-data/connections/${encodeURIComponent(accepted.target.session_id)}/consent/activate`,{
   method:'POST',signal:lifetime.current?.signal,body:JSON.stringify({store_key:accepted.snapshot.store.key,expires_at:accepted.snapshot.expires_at,
    ...(accepted.snapshot.consent_lifetime?{consent_lifetime:accepted.snapshot.consent_lifetime}:{}),consent_id:accepted.snapshot.consent_id,expected_review_digest:accepted.review_digest,accept_host_policy:true})});
   if(!response.ok)throw Error('Record consent not confirmed');const consent=AppDataConsentReferenceSchema.parse(await response.json());
   if(!current(request)||consent.consent_id!==accepted.snapshot.consent_id||consent.expires_at!==accepted.snapshot.expires_at||consent.consent_lifetime!==accepted.snapshot.consent_lifetime||appConsentDeadline(consent.expires_at,consent.consent_lifetime)<=Date.now())throw Error('Record consent changed');
   await load(request);if(current(request)){setReview(null);setNotice('Private record access enabled.');onChanged?.();}
  }catch{if(current(request)){setBlocked(true);setNotice('Access could not be confirmed. Check its status before trying again.');}}finally{if(current(request))setBusy(false);}}
 useEffect(()=>{if(!review)return;const deadline=Date.parse(review.snapshot.review_expires_at??review.snapshot.expires_at!);const timer=setTimeout(()=>setClock(Date.now()),Math.max(1,deadline-Date.now()+1));return()=>clearTimeout(timer);},[review]);
 async function revoke(target:Target,storeKey:string,consentId:string){if(busy)return;const request=generation.current;setBusy(true);setNotice('');
  try{const fresh=await load(request),matched=fresh?.targets.find(item=>item.target_key===targetKey&&item.session_id===target.session_id&&item.account.account_ref===target.account.account_ref),consent=matched?.stores.find(item=>item.declaration.key===storeKey)?.consent;
   if(!current(request)||!matched||!consent||consent.consent_id!==consentId)throw Error('Record access changed');
   const response=await api.fetch(`/api/app-data/connections/${encodeURIComponent(matched.session_id)}/consent/revoke`,{method:'POST',signal:lifetime.current?.signal,body:JSON.stringify({consent_id:consentId})});
   if(!response.ok)throw Error('Revocation not confirmed');const result=await response.json();if(!current(request))return;if(!result||result.revoked!==true||Object.keys(result).length!==1)throw Error('Revocation not confirmed');
   await load(request);if(current(request)){setNotice('Private record access revoked. Saved records were not deleted.');onChanged?.();}
  }catch{if(current(request)){setNotice('Revocation was not confirmed. Check access status before trying again.');await load(request).catch(()=>undefined);}}finally{if(current(request))setBusy(false);}}
 const visibleTargets=targets.flatMap(target=>target.stores.filter(store=>storeKeys.includes(store.declaration.key)).map(store=>({target,store,active:!!store.consent&&appConsentDeadline(store.consent.expires_at,store.consent.consent_lifetime)>Date.now()})));
 const visibleNotice=showEnabled||notice!=='Private record access enabled.'?notice:'';
 if(!showEnabled&&!storeKeys.length)return null;
 if(!review&&!visibleNotice&&!visibleTargets.some(row=>showEnabled||!row.active))return null;
 if(!showEnabled&&onOpenSettings&&!review)return <section aria-label="Private record access" className="flex shrink-0 flex-wrap items-center gap-2 px-5 py-2 text-xs text-[var(--foreground-secondary)]">
  <p role="status">{visibleNotice||`Saving ${visibleTargets.filter(row=>!row.active).map(row=>row.store.declaration.key.replaceAll('_',' ')).join(', ')} needs access.`}</p>
  <button type="button" className="deft-pill" disabled={busy} onClick={onOpenSettings}>Review record access</button>
 </section>;
 return <section aria-label="Private record access" className="mb-3 rounded-xl bg-[var(--surface-container-low)] px-3 py-2 text-xs">
  {!review&&visibleTargets.some(row=>!row.active)&&<div className="flex flex-wrap items-end gap-3 py-2"><label className="block">Permission lifetime<select className="mt-1 min-h-11 rounded-xl bg-[var(--surface-container-high)] px-3" value={permissionLifetime} disabled={busy} onChange={event=>setPermissionLifetime(event.target.value==='until_revoked'&&visibleTargets.some(row=>row.target.allow_until_revoked===true)?'until_revoked':'date')}><option value="date">Until date</option>{visibleTargets.some(row=>row.target.allow_until_revoked===true)&&<option value="until_revoked">Until revoked</option>}</select></label>{permissionLifetime==='date'&&<label className="block">Allow private records until<input type="datetime-local" className="mt-1 min-h-11 rounded-xl border bg-transparent px-3" value={until} disabled={busy} onChange={event=>setUntil(event.target.value)}/></label>}</div>}
  {visibleTargets.filter(row=>showEnabled||!row.active).map(({target,store,active})=><RecordAccessStatusRow key={`${target.session_id}/${store.declaration.key}`} label={target.account.label} storeKey={store.declaration.key} active={active} busy={busy} onReview={()=>void begin(target,store.declaration.key)} onRevoke={showEnabled&&store.consent?()=>void revoke(target,store.declaration.key,store.consent!.consent_id):undefined}/>)}
  {visibleNotice&&<p role="status">{visibleNotice}</p>}
  {review&&<AppDialog open title="Allow private record storage" description="Review how this app can save your records for this connected account." onClose={()=>{if(!busy){setReview(null);setBlocked(false);}}}>
   <div className="space-y-4 text-sm"><p>{review.target.account.label}</p><p>This app may create, read, edit and archive its private {review.snapshot.store.key.replaceAll('_',' ')} records, and add or remove their files. Access {review.snapshot.consent_lifetime==='until_revoked'?'continues until revoked':`ends ${new Date(review.snapshot.expires_at!).toLocaleString()}`}.</p>
    <details><summary className="min-h-10 cursor-pointer py-2">Storage limits</summary><p className="text-xs text-[var(--muted)]">{review.snapshot.store.max_record_bytes.toLocaleString()} bytes per record; up to {review.snapshot.store.max_files} files and {(review.snapshot.store.max_total_file_bytes/1048576).toLocaleString()} MiB of files per record.</p></details>
    <p>Sending or other external changes require a separate review.</p>{Date.parse(review.snapshot.review_expires_at??review.snapshot.expires_at!)<=clock&&<p role="status">This review expired. Close it and review access again.</p>}{notice&&<p role="status">{notice}</p>}
    <div className="flex flex-wrap gap-2">{blocked?<button type="button" className="deft-pill min-h-11" disabled={busy} onClick={async()=>{const request=generation.current;setBusy(true);try{await load(request);if(current(request)){setReview(null);setBlocked(false);onChanged?.();}}catch{if(current(request))setNotice('Access status is unavailable.');}finally{if(current(request))setBusy(false);}}}>Check access status</button>
     :<button type="button" className="deft-pill min-h-11" disabled={busy||Date.parse(review.snapshot.review_expires_at??review.snapshot.expires_at!)<=clock} onClick={()=>void activate()}>{busy?'Enabling…':'Allow private records'}</button>}
     <button type="button" className="deft-pill min-h-11" disabled={busy} onClick={()=>setReview(null)}>Cancel</button></div>
   </div>
  </AppDialog>}
 </section>;
}
