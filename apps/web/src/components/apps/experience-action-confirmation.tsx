'use client';
import {useEffect,useRef,useState} from 'react';
import {AppDialog} from '@/components/overlay-primitives';
import {api} from '@/lib/api';
import {boundedConfirmationJson,createExperienceActionConfirmation,type ExperienceConfirmationRequest} from '@/lib/app-experience-action-confirmation';
export function ExperienceActionConfirmation({request,sessionId,pins,ensureAuthority,suspended,onClose,onResult}:{request:ExperienceConfirmationRequest;sessionId:string;pins:{app_version_id:string;grant_snapshot_id:string};ensureAuthority:()=>Promise<boolean>;suspended:boolean;onClose:(unknown?:boolean)=>void;onResult:(run:{id:string;state:string})=>void}){
 const [review,setReview]=useState<{label:string;rows:{label:string;value:string}[];expires_at:string}|null>(null),[notice,setNotice]=useState('Preparing current action…'),[busy,setBusy]=useState(false),[destructive,setDestructive]=useState(false);
 const active=useRef(false),controller=useRef<AbortController|null>(null),model=useRef<ReturnType<typeof createExperienceActionConfirmation>|null>(null),sending=useRef(false),paused=useRef(suspended);paused.current=suspended;
 useEffect(()=>{const abort=new AbortController();controller.current=abort;active.current=true;model.current=createExperienceActionConfirmation({request,sessionId,pins,current:()=>active.current&&!paused.current&&!abort.signal.aborted,call:async(path,body)=>{
  if(!active.current||paused.current||!await ensureAuthority()||abort.signal.aborted)throw Error('Action access changed');
  const result=await boundedConfirmationJson(await api.fetch(path,{signal:abort.signal,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})}));if(!active.current||paused.current||abort.signal.aborted||!await ensureAuthority())throw Error('Action access changed');return result;
 }});void model.current.load().then(value=>{if(active.current){setReview(value);setNotice('');}}).catch(()=>{if(active.current)setNotice('This action is unavailable or changed. Close this review and check your access.');});return()=>{active.current=false;abort.abort();};},[request,sessionId,pins.app_version_id,pins.grant_snapshot_id,ensureAuthority]);
 useEffect(()=>{if(suspended)controller.current?.abort();},[suspended]);
 async function confirm(){if(sending.current||!model.current||suspended)return;sending.current=true;setBusy(true);try{const run=await model.current.confirm(destructive);if(active.current)onResult(run);}catch{if(active.current)setNotice(model.current.dispatched?'Action outcome unknown. Check Activity before another change.':'The reviewed action changed. Close this review and try again.');}finally{if(active.current)setBusy(false);}}
 const danger=model.current?.destructive===true;
 return <AppDialog open title={review?.label||'Review action'} danger={danger} onClose={()=>onClose(model.current?.dispatched)} description="Confirm this exact action for the selected private records.">
  <div className="space-y-4 text-sm">{notice&&<p role="status">{notice}</p>}{review&&<dl className="space-y-5">{review.rows.map((row,i)=><div key={i}><dt className="text-xs text-[var(--on-surface-variant)]">{row.label}</dt><dd className="mt-1 whitespace-pre-wrap break-words leading-6">{row.value}</dd></div>)}</dl>}
  {danger&&<label className="flex items-start gap-3"><input type="checkbox" checked={destructive} disabled={busy||suspended} onChange={e=>setDestructive(e.target.checked)}/><span>I understand this permanently deletes the selected records and cannot be undone.</span></label>}
  <div className="flex flex-wrap gap-2 pt-3"><button className="deft-pill min-h-11" disabled={!review||busy||suspended||sending.current||danger&&!destructive||Date.parse(review.expires_at)<=Date.now()} onClick={()=>void confirm()}>{busy?'Confirming…':danger?'Delete permanently':'Confirm action'}</button><button className="deft-pill min-h-11" onClick={()=>onClose(model.current?.dispatched)}>Cancel</button></div></div>
 </AppDialog>;
}
