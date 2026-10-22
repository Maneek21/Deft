'use client';
import {AppRequestNotice} from './app-request-notice';
import {appConsentDeadline} from '../../../../../packages/app-kit/src/consent-lifetime';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {createResourceObservationFlow,type ObservationIdentity} from '@/lib/app-resource-observation';
import type {AppConnectionTarget} from '@/lib/app-connection-session-flow';
import {observationIntervalChoices,observationIntervalLabel} from '@/lib/app-experience-settings-display';
import {ExperienceBackgroundRefreshReview} from './experience-background-refresh-review';
export function ExperienceBackgroundRefresh({target,ownerId,orgId,disabled,onBusy,description,troubleshooting}:{target:AppConnectionTarget;ownerId:string;orgId:string;disabled:boolean;onBusy:(busy:boolean)=>void;description?:string;troubleshooting?:ReactNode}){
 if(target.session?.state!=='connected'||!target.session.account)return null;
 const identity:ObservationIdentity={installation_id:target.scope.installation_id,owner_user_id:ownerId,org_id:orgId,target_key:target.target_key,scope:target.scope,connection_session_id:target.session.session_id,account_ref:target.session.account.account_ref};
 return <Workspace key={JSON.stringify(identity)} identity={identity} disabled={disabled} onBusy={onBusy} description={description} troubleshooting={troubleshooting}/>;
}
function Workspace({identity,disabled,onBusy,description,troubleshooting}:{identity:ObservationIdentity;disabled:boolean;onBusy:(busy:boolean)=>void;description?:string;troubleshooting?:ReactNode}){
 const [lifetime,setLifetime]=useState<'date'|'until_revoked'>('date');
 const [version,setVersion]=useState(0),[busy,setBusy]=useState(false),[notice,setNotice]=useState('Checking background refresh…'),[clock,setClock]=useState(Date.now()),[reload,setReload]=useState(0),[interval,setInterval]=useState(900),[hours,setHours]=useState(24);
 const troubleshootingPanel=useRef<HTMLDetailsElement>(null);
 const flow=useRef<ReturnType<typeof createResourceObservationFlow>|null>(null),generation=useRef(0),operation=useRef(false),notify=useRef(onBusy);notify.current=onBusy;
 useEffect(()=>{const request=++generation.current,controller=new AbortController(),anchor=api.getAccessToken();let active=true;
  const current=()=>active&&!controller.signal.aborted&&request===generation.current&&!document.hidden&&isSameWebSession(anchor,api.getAccessToken());
  const key=`deft-background-refresh:${identity.org_id}:${identity.owner_user_id}:${identity.installation_id}:${identity.connection_session_id}`;
  const read=async(path:string,init:RequestInit)=>{if(!current())throw Error('Background refresh session ended');const response=await api.fetch(path,{...init,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(35000)])});if(!current()||!response.ok||!response.body)throw Error('Background refresh status unavailable');
   const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(!current()||size>262144)throw Error('Background refresh response unavailable');parts.push(next.value);}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;part.fill(0);}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}finally{bytes.fill(0);}}
   finally{for(const part of parts)part.fill(0);await reader.cancel().catch(()=>{});reader.releaseLock();}};
  const refresh=()=>{if(current()){setClock(Date.now());setVersion(n=>n+1);}};
  const hidden=()=>{if(document.hidden){active=false;controller.abort();operation.current=false;setBusy(false);notify.current(false);}else setReload(n=>n+1);};
  document.addEventListener('visibilitychange',hidden);
  operation.current=true;setBusy(true);notify.current(true);
  void(async()=>{setNotice('Checking background refresh…');const client=createResourceObservationFlow({identity,current,signal:controller.signal,call:read,load:()=>{const value=localStorage.getItem(key);if(!value)return null;if(value.length>8192)throw Error('Background refresh recovery unavailable');return JSON.parse(value);},store:value=>{if(value)localStorage.setItem(key,JSON.stringify(value));else localStorage.removeItem(key);}});flow.current=client;await client.load();if(current()){setInterval(n=>Math.max(client.status?.review.interval_seconds??n,client.target!.min_interval_seconds));setLifetime(backgroundRefreshLifetime(client.target!.allow_until_revoked===true,identity.scope.consent_lifetime,client.status?.review.consent_lifetime,!!client.status));setNotice('');refresh();}})().catch(()=>{if(current()){setNotice('Background refresh could not be checked. Reload its status; do not repeat an uncertain activation.');refresh();}}).finally(()=>{if(current()){operation.current=false;setBusy(false);notify.current(false);}});
  return()=>{active=false;controller.abort();generation.current++;operation.current=false;flow.current=null;notify.current(false);document.removeEventListener('visibilitychange',hidden);};
 },[identity.org_id,identity.owner_user_id,identity.installation_id,identity.connection_session_id,reload]);
 const client=flow.current,review=client?.review,status=client?.status,min=client?.target?.min_interval_seconds??60;
 useEffect(()=>{const expires=review?.review_expires_at??review?.expires_at??status?.review.expires_at;if(!expires||Date.parse(expires)<=clock)return;const timer=setTimeout(()=>setClock(Date.now()),Math.min(2147483647,Math.max(1,Date.parse(expires)-Date.now()+1)));return()=>clearTimeout(timer);},[review?.expires_at,status?.review.expires_at,version,clock]);
 async function act(kind:'review'|'activate'|'revoke'|'status'){
  if(operation.current||disabled||document.hidden||!flow.current)return;const owned=flow.current,request=generation.current;operation.current=true;setBusy(true);notify.current(true);setNotice('');
  try{if(kind==='review')await owned.prepare(interval,lifetime==='until_revoked'?{expires_at:null,consent_lifetime:'until_revoked'}:new Date(Date.now()+hours*3600000).toISOString());else if(kind==='activate'){if(!await owned.activate())throw Error('Activation was not confirmed. Check status; do not enable it again.');}else if(kind==='revoke'){if(!await owned.revoke())throw Error('Opt-out was not confirmed. Check status; do not repeat the request.');}else await owned.check();
   if(request===generation.current&&owned===flow.current&&!document.hidden){setClock(Date.now());setVersion(n=>n+1);setNotice(kind==='activate'?'Background refresh enabled.':kind==='revoke'?'Background refresh turned off.':'');}
  }catch(error){if(request===generation.current&&owned===flow.current&&!document.hidden){setVersion(n=>n+1);setNotice(error instanceof Error?error.message:'Background refresh unavailable.');}}
  finally{if(request===generation.current&&owned===flow.current&&!document.hidden){operation.current=false;setBusy(false);notify.current(false);}}
 }
 const uncertain=client?.uncertain,expired=!!status&&appConsentDeadline(status.review.expires_at,status.review.consent_lifetime)<=clock;
 return <section aria-label="Background refresh" className="min-w-0 space-y-3 text-sm" style={{borderColor:'var(--ghost-border)'}}>
  {troubleshooting&&<p role="status" className="font-medium leading-6">Connected{status?.state==='active'&&!expired?` \u00b7 syncing every ${observationIntervalLabel(status.review.interval_seconds)}`:busy?' \u00b7 checking sync status':status?.state==='revoked'||client?.target?.consent===null?' \u00b7 background refresh off':expired?' \u00b7 refresh permission expired':' \u00b7 sync status needs checking'}</p>}
  {troubleshooting&&!busy&&(expired||status?.state==='unavailable'||!!notice)&&<button type="button" className="deft-pill min-h-11" disabled={disabled} onClick={()=>{if(troubleshootingPanel.current)troubleshootingPanel.current.open=true;}}>Check sync setup</button>}
  <details ref={troubleshootingPanel} className="min-w-0"><summary className="min-h-11 cursor-pointer py-3">Troubleshooting</summary><div className="space-y-4 pb-3">
  {troubleshooting}
  <h4 className="font-medium">Background refresh</h4><p>{description ?? "Keep this app's data current while it is closed."}</p>
  <p>Trusted compatible updates keep your existing approvals. Changes to permissions still require review. Files and attachments are not fetched in the background.</p>
  {notice&&<AppRequestNotice message={notice} role="status"/>}{busy&&<p role="status">{uncertain?'Checking background refresh…':'Checking reviewed access…'}</p>}
  {client?.target?.consent===null&&!client.pending&&!notice&&<p>Off</p>}
  {status&&<p>{status.state==='active'&&!expired?'Enabled':expired?'Expired':status.state==='proposed'?'Review needed':status.state==='revoked'?'Off':'Unavailable'}{status.state==='active'&&!expired&&` · at most every ${observationIntervalLabel(status.review.interval_seconds)} ${status.review.consent_lifetime==='until_revoked'?'until revoked':`until ${new Date(status.review.expires_at!).toLocaleString()}`}`}</p>}
  {uncertain?<><p role="status">The previous request was not confirmed. Check status before continuing; it will not be repeated automatically.</p><button type="button" className="deft-pill min-h-11" disabled={busy||disabled} onClick={()=>void act('status')}>Check status</button></>:review?<ExperienceBackgroundRefreshReview review={review} now={clock} busy={busy||disabled} onAllow={()=>void act('activate')} onCheck={()=>void act('status')} onClose={()=>{client?.closeReview();setVersion(n=>n+1);setNotice('Review remains pending. Check status to resume it.');}}/>:client?.pending?<button type="button" className="deft-pill min-h-11" disabled={busy||disabled} onClick={()=>void act('status')}>Resume review</button>:<>
   {status?.state==='active'&&!expired&&<button type="button" className="deft-pill min-h-11" disabled={busy||disabled} onClick={()=>void act('revoke')}>Turn off background refresh</button>}
   <div className="flex flex-wrap items-end gap-3"><ExperienceRefreshInterval min={min} value={interval} disabled={busy||disabled} onChange={setInterval}/>
    <label className="block">Permission lifetime<select className="mt-1 block min-h-11 rounded-xl bg-[var(--surface-container-high)] px-3" value={lifetime} disabled={busy||disabled} onChange={event=>setLifetime(event.target.value==='until_revoked'&&client?.target?.allow_until_revoked===true?'until_revoked':'date')}><option value="date">Until date</option>{client?.target?.allow_until_revoked===true&&<option value="until_revoked">Until revoked</option>}</select></label>{lifetime==='date'&&<label className="block">Requested duration<select className="mt-1 block min-h-11 rounded-xl bg-[var(--surface-container-high)] px-3" value={hours} disabled={busy||disabled} onChange={event=>setHours(Number(event.target.value))}><option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option></select></label>}
    <button type="button" className="deft-pill min-h-11" disabled={busy||disabled||!client?.target||!Number.isSafeInteger(interval)||interval<min||interval>86400} onClick={()=>void act('review')}>Review background refresh</button></div><p className="text-xs text-[var(--on-surface-variant)]">The review shows the exact lifetime, limited by the current account permission. Sending still requires its own review.</p>
  </>}
  <button type="button" className="deft-pill min-h-11" disabled={busy||disabled} onClick={()=>setReload(n=>n+1)}>Reload background status</button>
 </div></details></section>;
}

/** Presentation default only; the review flow still validates every consent choice. */
export function backgroundRefreshLifetime(allowed:boolean,accountLifetime?:string,currentLifetime?:string,hasCurrent=false):'date'|'until_revoked'{
 return allowed&&accountLifetime==='until_revoked'&&(!hasCurrent||currentLifetime==='until_revoked')?'until_revoked':'date';
}

export function ExperienceRefreshInterval({min,value,disabled,onChange}:{min:number;value:number;disabled:boolean;onChange:(seconds:number)=>void}){
 return <label className="block">Refresh interval<select className="mt-1 block min-h-11 w-40 rounded-xl bg-[var(--surface-container-high)] px-3" value={value} disabled={disabled} onChange={event=>{const seconds=Number(event.target.value);if(observationIntervalChoices(min,value).some(option=>option.value===seconds))onChange(seconds);}}>
  {observationIntervalChoices(min,value).map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
 </select></label>;
}
