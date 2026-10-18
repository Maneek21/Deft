'use client';
import {useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {appApiError} from '@/lib/apps';
import {appConnectionSessionTag} from '@/lib/app-connection-session-flow';
import {selectConsentTarget} from '@/lib/app-consent-target-selection';
import {createConsentContinuationFlow,type ConsentContinuationContext,type ConsentContinuationReview} from '@/lib/app-connection-consent-continuation';
type Props={installationId:string;ownerId:string;orgId:string;sessionScope:string;targetKey?:string;onBusy:(busy:boolean)=>void;onSetupComplete?:(target:string)=>void};
const localInput=(time:number)=>{const d=new Date(time),pad=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;};
/** Owner consent is independent of an expired operational Experience lease. */
export function ExperienceConsentContinuation(props:Props){
 const [lifetime,setLifetime]=useState<'date'|'until_revoked'>('date');
 const [context,setContext]=useState<ConsentContinuationContext|null>(null),[selected,setSelected]=useState(props.targetKey??''),[until,setUntil]=useState(''),[notice,setNotice]=useState(''),[working,setWorking]=useState(false),[reload,setReload]=useState(0),[version,setVersion]=useState(0);
 const flow=useRef<ReturnType<typeof createConsentContinuationFlow>|null>(null),generation=useRef(0),operation=useRef(false),onBusy=useRef(props.onBusy);onBusy.current=props.onBusy;
 useEffect(()=>{const ticket=++generation.current,anchor=api.getAccessToken();let alive=true;
  const current=()=>alive&&ticket===generation.current&&!document.hidden&&isSameWebSession(anchor,api.getAccessToken());
  const hidden=()=>{if(document.hidden){alive=false;flow.current?.dispose();flow.current=null;operation.current=false;setContext(null);setWorking(false);onBusy.current(false);}else setReload(n=>n+1);};document.addEventListener('visibilitychange',hidden);
  void(async()=>{if(!anchor||!current())return;const sessionTag=await appConnectionSessionTag(props.sessionScope);if(!current())return;
   const fetchJson=async(path:string,init?:RequestInit)=>{if(!current())throw Error('Account access changed.');const response=await api.fetch(path,init);if(!response.ok)throw Error(await appApiError(response,'Account permission is unavailable.'));const text=await response.text();if(text.length>256*1024)throw Error('Account permission response exceeds its limit.');return JSON.parse(text);};
   const base='/api/app-connection-sessions',client=createConsentContinuationFlow({identity:{installationId:props.installationId,ownerId:props.ownerId,orgId:props.orgId,sessionTag},storage:sessionStorage,current,
    get:()=>fetchJson(`${base}/installations/${encodeURIComponent(props.installationId)}/consent-continuation-context`),post:(kind,body)=>fetchJson(`${base}/consent-continuation/${kind}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});flow.current=client;
   const value=await client.load();if(!current())return;setContext(value);setSelected(previous=>selectConsentTarget(value.targets,props.targetKey,previous));setNotice('');
  })().catch(error=>{if(current()){setContext(null);setNotice(error instanceof Error?error.message:'Account permission is unavailable.');}});
  return()=>{alive=false;generation.current++;flow.current?.dispose();flow.current=null;operation.current=false;onBusy.current(false);document.removeEventListener('visibilitychange',hidden);};
 },[props.installationId,props.ownerId,props.orgId,props.sessionScope,props.targetKey,reload]);
 const target=context?.targets.find(t=>t.target_key===selected);let review:ConsentContinuationReview|null=null,pending=false,canReview=false;
 if(target&&flow.current){try{review=flow.current.visibleReview(selected);pending=!!flow.current.pending(selected)&&flow.current.pending(selected)?.phase!=='resolved';canReview=flow.current.canReview(selected);}catch{pending=true;}}
 useEffect(()=>{if(!target)return;setUntil(localInput(Math.min(Date.parse(target.max_consent_expires_at),Math.max(Date.now()+60*60*1000,target.source.scope.consent_expires_at===null?Date.now()+60*60*1000:Date.parse(target.source.scope.consent_expires_at)+60*1000))));},[target?.target_key,target?.source.session_id,target?.max_consent_expires_at]);
 useEffect(()=>{if(!review)return;const timer=setTimeout(()=>setVersion(n=>n+1),Math.max(1,Date.parse(review.expires_at)-Date.now()+1));return()=>clearTimeout(timer);},[review?.expires_at,version]);
 async function act(kind:'review'|'activate'|'status'){
  const client=flow.current,ticket=generation.current;if(!target||!client||operation.current||document.hidden)return;operation.current=true;setWorking(true);props.onBusy(true);setNotice('');
  const current=()=>ticket===generation.current&&flow.current===client&&!document.hidden;
  try{const result=kind==='review'?await client.prepare(selected,lifetime==='until_revoked'?{consent_expires_at:null,consent_lifetime:'until_revoked'}:new Date(until).toISOString()):kind==='activate'?await client.activate(selected):await client.check(selected);if(!current())return;
   setVersion(n=>n+1);setNotice(result.schema_version==='deft.app_connection_consent_continuation_review.v1'?'Review the account permission below.':result.state==='connected'?'Account permission renewed. Open the account with its current access.':result.state==='not_connected'?'The unstarted review is closed. You can review permission again.':'The request has an uncertain outcome. Check its original status.');
   const value=await client.load();if(!current())return;setContext(value);
  }catch(error){if(current()){setVersion(n=>n+1);setNotice(error instanceof Error?error.message:'Account permission was not confirmed. Check the original request status.');}}
  finally{if(current()){operation.current=false;setWorking(false);props.onBusy(false);}}
 }
 if(!context?.targets.length)return notice?<p role="status" className="text-sm text-[var(--on-surface-variant)]">{notice}</p>:null;
 return <section aria-label="Renew account permission" className="space-y-3 rounded-xl border p-4" style={{borderColor:'var(--outline-variant)',background:'var(--surface-container-low)'}}>
  <h4 className="font-semibold">Account permission</h4>
  {!props.targetKey&&context.targets.length>1&&<label className="block text-sm">Account<select className="mt-1 min-h-11 w-full rounded-xl bg-[var(--surface-container-high)] px-3" value={selected} disabled={working} onChange={event=>{setSelected(event.target.value);setNotice('');}}>{context.targets.map(t=><option key={t.target_key} value={t.target_key}>{t.account.label}</option>)}</select></label>}
  {!target&&props.targetKey&&<p className="text-sm">Renewal is unavailable for this account. Check its connection below.</p>}
  {target&&<><p className="break-words text-sm">{target.account.label} · Permission {target.source.scope.consent_lifetime==='until_revoked'?'continues until revoked':`${Date.parse(target.source.scope.consent_expires_at!)<=Date.now()?'ended':'ends'} ${new Date(target.source.scope.consent_expires_at!).toLocaleString()}`}.</p>
   <p className="text-sm">Renew permission for the same account and its existing actions. Saved messages and previous action results stay with this account.</p>
   {review?<div aria-label="Review renewed account permission" className="space-y-3"><p className="text-sm">Allow {review.account.label} {review.scope.consent_lifetime==='until_revoked'?'until revoked':`until ${new Date(review.scope.consent_expires_at!).toLocaleString()}`}.</p>
    <p className="text-sm">Actions: {review.action_consents.map(action=>action.action_key.replaceAll('_',' ')).join(', ')||'Read account records'}.</p>
    <button type="button" className="deft-pill min-h-11" disabled={working} onClick={()=>void act('activate')}>Allow renewed permission</button></div>:canReview?<div className="space-y-2"><label className="block text-sm">Permission lifetime<select className="mt-1 min-h-11 w-full rounded-xl border bg-[var(--surface-container-high)] px-3" value={lifetime} disabled={working} onChange={event=>setLifetime(event.target.value==='until_revoked'&&target.allow_until_revoked===true?'until_revoked':'date')}><option value="date">Until date</option>{target.allow_until_revoked===true&&<option value="until_revoked">Until revoked</option>}</select></label>{lifetime==='date'&&<label className="block text-sm">Allow account access until<input type="datetime-local" className="mt-1 min-h-11 w-full rounded-xl border bg-transparent px-3" value={until} max={localInput(Date.parse(target.max_consent_expires_at))} disabled={working} onChange={event=>setUntil(event.target.value)}/></label>}
    <button type="button" className="deft-pill min-h-11" disabled={working||(lifetime==='date'&&!until)} onClick={()=>void act('review')}>Review renewed permission</button></div>:null}
   {pending&&<button type="button" className="deft-pill min-h-11" disabled={working} onClick={()=>void act('status')}>Check original request status</button>}
   {!target.runtime_ready&&<p className="text-sm">The approved account operator must finish setup before permission can be renewed.</p>}
   {!pending&&props.onSetupComplete&&<button type="button" className="deft-pill min-h-11" disabled={working} onClick={()=>props.onSetupComplete?.(selected)}>Open account</button>}
  </>}
  {notice&&<p role="status" className="break-words text-sm text-[var(--on-surface-variant)]">{notice}</p>}
  <button type="button" className="deft-pill min-h-11" disabled={working} onClick={()=>setReload(n=>n+1)}>Reload account permission</button>
 </section>;
}
