'use client';
import {useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {canonicalAppDataJson} from '../../../../../packages/app-kit/src/app-data';
import type {AppConnectionContext,AppConnectionTarget,createAppConnectionSessionFlow} from '@/lib/app-connection-session-flow';
import type {ConnectionUpgradeReview} from '@/lib/app-connection-upgrade';
import {ExperienceConnectionStatus} from './experience-connection-status';
import {ExperienceBackgroundRefresh} from './experience-background-refresh';
import {ExperienceCredentialRepair} from './experience-credential-repair';
export function ExperienceCapabilityUpgradeReview({review,now,disabled,onAllow,onCheck,onClose}:{review:ConnectionUpgradeReview;now:number;disabled:boolean;onAllow:()=>void;onCheck:()=>void;onClose:()=>void}){
 const expired=Date.parse(review.expires_at)<=now;
 return <section aria-label="Review account update" className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4 text-sm leading-6">
  <h4 className="font-semibold">Update existing account access</h4><p className="break-words font-medium">{review.account.label}</p>
  <p>Your saved records and drafts stay with this same account. Continue to the provider to approve the listed access.</p>
  <dl className="space-y-2"><div><dt className="font-medium">Read account records</dt><dd>{review.scope.consent_lifetime==='until_revoked'?'Until revoked':`Until ${new Date(review.scope.consent_expires_at!).toLocaleString()}`}</dd></div>
   {review.action_consents.map(consent=><div key={consent.action_key}><dt className="font-medium capitalize">{consent.action_key.replaceAll('_',' ')}</dt><dd>{consent.consent_lifetime==='until_revoked'?'Separately reviewed until revoked':`Separately reviewed until ${new Date(consent.expires_at!).toLocaleString()}`}</dd></div>)}</dl>
  <p>Only these reviewed permissions are included. Each action still requires its own confirmation. Draft access and background refresh remain separate.</p>
  <p className="text-xs text-[var(--on-surface-variant)]">To change permissions, review their account bindings separately, then review this update again.</p>
  {expired&&<p role="status">This review expired. Check status before reviewing again.</p>}
  <div className="flex flex-wrap gap-2">{expired?<button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={disabled} onClick={onCheck}>Check status</button>
   :<button type="button" className="deft-pill min-h-11" disabled={disabled} onClick={onAllow}>Allow and connect</button>}
   <button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={disabled} onClick={onClose}>Close</button></div>
  <p className="text-xs text-[var(--on-surface-variant)]">Closing leaves the review pending.</p>
 </section>;
}
type Flow=ReturnType<typeof createAppConnectionSessionFlow>;
export function ExperienceCapabilityUpgradeSettings({target,client,disabled,onBusy,onContext,onNavigate,onUse,onConnect,onStatus,onDisconnect,ownerId,orgId,appOwnedRecords}:{
 target:AppConnectionTarget;client:Flow;disabled:boolean;onBusy:(busy:boolean)=>void;onContext:(value:AppConnectionContext)=>void;
 onNavigate:(url:string)=>void;onUse?:()=>void;onConnect:()=>void;onStatus:()=>void;onDisconnect:()=>void;ownerId:string;orgId:string;appOwnedRecords?:boolean;
}){
 const [review,setReview]=useState<ConnectionUpgradeReview|null>(null),[pending,setPending]=useState(false),[closed,setClosed]=useState(false),[working,setWorking]=useState<'review'|'begin'|'status'|null>(null),[notice,setNotice]=useState(''),[clock,setClock]=useState(Date.now());
 const alive=useRef(false),busy=useRef(false),token=useRef(api.getAccessToken()),visibility=useRef(0);
 const current=()=>alive.current&&!document.hidden&&isSameWebSession(token.current,api.getAccessToken());
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{try{setReview(client.upgradeReview(target.target_key));setPending(client.upgradePending(target.target_key));setClock(Date.now());}catch{setReview(null);setPending(true);setNotice('Account update changed. Reload its status before continuing.');}},[client,target]);
 useEffect(()=>{if(!review)return;const timer=setTimeout(()=>setClock(Date.now()),Math.max(1,Date.parse(review.expires_at)-Date.now()+1));return()=>clearTimeout(timer);},[review]);
 useEffect(()=>{let active=true;const expectedScope=canonicalAppDataJson(target.scope);
  const changed=()=>{if(document.hidden){visibility.current++;setReview(null);setPending(true);setClosed(false);setNotice('Account update paused. Check status before continuing.');return;}
   const ticket=visibility.current,valid=()=>active&&current()&&ticket===visibility.current;
   if(!valid())return;void client.load().then(value=>{if(!valid())return;const selected=value.targets.find(item=>item.target_key===target.target_key);
    if(!selected||canonicalAppDataJson(selected.scope)!==expectedScope)throw Error('Account access changed. Reload before continuing.');
    const nextReview=client.upgradeReview(target.target_key),nextPending=client.upgradePending(target.target_key);if(!valid())return;
    onContext(value);setReview(nextReview);setPending(nextPending);setClock(Date.now());setNotice(nextPending?'Resume the pending review or check its original status.':'');
   }).catch(()=>{if(valid()){setReview(null);setPending(true);setNotice('Account update was not confirmed. Reload or check status before continuing.');}});
  };document.addEventListener('visibilitychange',changed);return()=>{active=false;document.removeEventListener('visibilitychange',changed);};
 },[client,target.target_key,target.scope,onContext]);
 async function act(kind:'review'|'begin'|'status'){
  if(busy.current||disabled||!current())return;const expectedScope=target.scope,ticket=visibility.current,live=()=>current()&&ticket===visibility.current;busy.current=true;setWorking(kind);onBusy(true);setNotice('');
  try{
   const fresh=await client.load();if(!live())return;onContext(fresh);const selected=fresh.targets.find(item=>item.target_key===target.target_key);
   if(!selected||canonicalAppDataJson(selected.scope)!==canonicalAppDataJson(expectedScope)||!selected.upgrade)throw Error('Account access changed. Reload before continuing.');
   if(kind==='review'&&canonicalAppDataJson(selected.upgrade.candidate)!==canonicalAppDataJson(target.upgrade?.candidate??null))throw Error('The existing account changed. Review its current details first.');
   if(kind==='begin'&&(!review||canonicalAppDataJson(client.upgradeReview(target.target_key))!==canonicalAppDataJson(review)))throw Error('The reviewed permissions changed. Review this update again.');
   if(kind==='begin'){const url=await client.beginUpgrade(target.target_key);if(live())onNavigate(url);return;}
   const result=kind==='review'?await client.reviewUpgrade(target.target_key):await client.checkUpgrade(target.target_key);
   if(!live())return;const value=await client.load();if(!live())return;onContext(value);setClosed(false);
   setNotice(result.schema_version==='deft.app_connection_upgrade_review.v1'?'Review the account and permissions before continuing.':result.state==='connected'?'Account connected.':result.state==='not_connected'?'The expired review is closed. You can review this account again.':'Account update is awaiting its original callback or has an uncertain outcome. Check status; setup will not be repeated.');
  }catch(error){if(live()){await client.load().then(value=>{if(live())onContext(value);}).catch(()=>{});
   if(live()){setPending(true);setNotice(error instanceof Error?error.message:'Account update was not confirmed. Check status before continuing.');}}}
  finally{if(alive.current){busy.current=false;setWorking(null);onBusy(false);}}
 }
 const shown=closed?null:review,state=target.session?.state,label=target.session?.account?.label??review?.account.label??target.upgrade?.candidate?.account.label??target.profile.label;
 if(target.credential_repair?.pending)return <ExperienceCredentialRepair target={target} client={client} disabled={disabled||!!working} onBusy={onBusy} onContext={onContext} onNavigate={onNavigate}/>;
 return <div className="space-y-3">
  <ExperienceCredentialRepair target={target} client={client} disabled={disabled||!!working} onBusy={onBusy} onContext={onContext} onNavigate={onNavigate}/>
  <ExperienceConnectionStatus label={label} state={state} reviewAvailable={!!review} reusePending={pending} working={working==='begin'?'activate':working}/>
  {notice&&<p role="status" className="text-sm text-[var(--on-surface-variant)]">{notice}</p>}
  {!target.runtime_ready&&<p className="text-sm">Your workspace needs to finish configuring the approved account operator before connecting.</p>}
  {!pending&&target.upgrade?.candidate&&<div className="space-y-2 text-sm"><p className="break-words">Existing account: {target.upgrade.candidate.account.label}</p>
   <button type="button" className="deft-pill min-h-11" disabled={!!working||disabled||!target.runtime_ready} onClick={()=>void act('review')}>Review account update</button></div>}
  {shown&&<ExperienceCapabilityUpgradeReview review={shown} now={clock} disabled={!!working||disabled||!target.runtime_ready} onAllow={()=>void act('begin')} onCheck={()=>void act('status')} onClose={()=>{setClosed(true);setNotice('Review remains pending. Resume it or check status before continuing.');}}/>}
  {pending&&!shown&&<div className="space-y-2 text-sm">{!review&&!working&&<p>Account update is pending. Use its original callback or check status. This attempt will not be repeated.</p>}
   <div className="flex flex-wrap gap-2">{review&&<button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={!!working||disabled} onClick={()=>setClosed(false)}>Resume review</button>}
    <button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={!!working||disabled||!target.runtime_ready} onClick={()=>void act('status')}>Check status</button></div></div>}
  {!pending&&(!state||state==='not_connected'||state==='disconnected')&&<button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={!!working||disabled||!target.runtime_ready} onClick={onConnect}>Connect a new account</button>}
  {!pending&&target.session&&<button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={!!working||disabled||!target.runtime_ready} onClick={onStatus}>Check connection status</button>}
  {!pending&&state==='connected'&&onUse&&<button type="button" className="deft-pill min-h-11" disabled={!!working||disabled} onClick={onUse}>Use account</button>}
  {!pending&&(state==='connected'||state==='not_connected')&&<details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">Manage connection</summary><button type="button" className="deft-pill min-h-11 !bg-transparent text-[var(--error)]" disabled={!!working||disabled} onClick={onDisconnect}>Disconnect account</button></details>}
  {appOwnedRecords&&!pending&&state==='connected'&&<ExperienceBackgroundRefresh target={target} ownerId={ownerId} orgId={orgId} disabled={!!working||disabled} onBusy={onBusy}/>}
 </div>;
}
