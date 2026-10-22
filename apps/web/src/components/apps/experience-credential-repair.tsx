'use client';
import {AppRequestNotice} from './app-request-notice';
import {useEffect,useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {canonicalAppDataJson} from '../../../../../packages/app-kit/src/app-data';
import type {AppConnectionContext,AppConnectionTarget,createAppConnectionSessionFlow} from '@/lib/app-connection-session-flow';
import type {ConnectionRepairReview} from '@/lib/app-connection-repair';
type Flow=ReturnType<typeof createAppConnectionSessionFlow>;
export function ExperienceCredentialRepair({target,client,disabled,onBusy,onContext,onNavigate}:{target:AppConnectionTarget;client:Flow;disabled:boolean;
 onBusy:(busy:boolean)=>void;onContext:(context:AppConnectionContext)=>void;onNavigate:(url:string)=>void}){
 const [review,setReview]=useState<ConnectionRepairReview|null>(null),[pending,setPending]=useState(false),[working,setWorking]=useState(false),[notice,setNotice]=useState('');
 const alive=useRef(false),busy=useRef(false),token=useRef(api.getAccessToken());
 const current=()=>alive.current&&!document.hidden&&isSameWebSession(token.current,api.getAccessToken());
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{try{setReview(client.repairReview(target.target_key));setPending(client.repairPending(target.target_key));}catch{setReview(null);setPending(true);setNotice('Check reconnection status before continuing.');}},[client,target]);
 async function act(operation:'review'|'begin'|'status'|'cancel'|'close_uncertain'){
  if(busy.current||disabled||!current())return;busy.current=true;setWorking(true);onBusy(true);setNotice('');
  try{
   const context=await client.load();if(!current())return;onContext(context);
   const selected=context.targets.find(item=>item.target_key===target.target_key);
   if(!selected?.credential_repair||!selected.runtime_ready||canonicalAppDataJson(selected.scope)!==canonicalAppDataJson(target.scope))throw Error('Account access changed. Reload before reconnecting.');
   if(operation==='review'&&canonicalAppDataJson(selected.credential_repair.candidate)!==canonicalAppDataJson(target.credential_repair?.candidate))throw Error('The account changed. Review its current details first.');
   if(operation==='begin'){
    if(!review||canonicalAppDataJson(client.repairReview(target.target_key))!==canonicalAppDataJson(review))throw Error('The reviewed account changed. Check status before continuing.');
    const url=await client.beginRepair(target.target_key);if(current())onNavigate(url);return;
   }
   const result=operation==='review'?await client.reviewRepair(target.target_key):await client.checkRepair(target.target_key,operation==='cancel',operation==='close_uncertain');
   if(!current())return;const refreshed=await client.load();if(!current())return;onContext(refreshed);
   setReview(client.repairReview(target.target_key));setPending(client.repairPending(target.target_key));
   setNotice(result.schema_version==='deft.app_connection_credential_repair_review.v1'?'Review this same account before continuing.':result.state==='connected'?'Account reconnected.':result.state==='not_connected'?operation==='close_uncertain'?'Stalled reconnection closed. Its provider outcome remains unknown. You can review a fresh reconnection.':'Reconnection closed. Your existing account and saved records are preserved.':'Reconnection is pending. Check status; the provider exchange will not be repeated.');
  }catch(error){if(current())setNotice(error instanceof Error?error.message:'Reconnection was not confirmed. Check status.');}
  finally{busy.current=false;if(alive.current){setWorking(false);onBusy(false);}}
 }
 if(!target.credential_repair||target.session?.state==='connected'&&!target.credential_repair.pending)return null;
 const unavailable=disabled||working||!target.runtime_ready;
 return <section aria-label="Reconnect existing account" className="space-y-3 rounded-xl border border-[var(--ghost-border)] p-4 text-sm">
  <h4 className="font-semibold">{target.session?.state==='connected'?'Reconnection status':'Reconnect account'}</h4>
  <p>Restore the connection to this same account. Your saved records and existing permission expiry stay unchanged.</p>
  {notice&&<AppRequestNotice message={notice} role="status"/>}
  {target.session?.state!=='connected'&&!pending&&target.credential_repair.candidate&&<><p className="break-words">{target.credential_repair.candidate.account.label}</p><button type="button" className="deft-pill min-h-11" disabled={unavailable} onClick={()=>void act('review')}>Reconnect account</button></>}
  {review&&<><p className="break-words font-medium">{review.account.label}</p><p>Existing access {review.scope.consent_lifetime==='until_revoked'?'continues until revoked':`ends ${new Date(review.scope.consent_expires_at!).toLocaleString()}`}.</p>
   {review.action_consents.map(consent=><p key={consent.action_key}>{consent.action_key.replaceAll('_',' ')} — {consent.consent_lifetime==='until_revoked'?'until revoked':`until ${new Date(consent.expires_at!).toLocaleString()}`}</p>)}
   {Date.parse(review.expires_at)<=Date.now()
    ?<p role="status">This review expired before you continued. Check reconnection status to release the account, then start again.</p>
    :<button type="button" className="deft-pill min-h-11" disabled={unavailable} onClick={()=>void act('begin')}>Continue to provider</button>}</>}
  {pending&&<div className="flex flex-wrap gap-2"><button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={unavailable} onClick={()=>void act('status')}>Check reconnection status</button>
   {target.credential_repair.pending?.callback_consumed&&target.credential_repair.pending.state==='indeterminate'&&<><p>The previous provider outcome remains unknown. Closing this stalled reconnection will not retry it.</p><button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={unavailable} onClick={()=>void act('close_uncertain')}>Close stalled reconnection</button></>}
   {!target.credential_repair.pending?.begin_consumed&&<button type="button" className="deft-pill min-h-11 !bg-transparent" disabled={unavailable} onClick={()=>void act('cancel')}>Cancel reconnection</button>}</div>}
 </section>;
}
