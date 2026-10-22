'use client';
import {AppRequestNotice} from './app-request-notice';
import {useRef,useState} from 'react';
import {api,isSameWebSession} from '@/lib/api';
import {appApiError} from '@/lib/apps';
import type {AppConnectionTarget} from '@/lib/app-connection-session-flow';

type Result={installed:{kind:'action'|'observation'}[];skipped:{kind:'observation';reason:'permission_not_until_revoked'}[]};
function parse(value:unknown):Result{
 const result=value as Result;
 if(!result||!Array.isArray(result.installed)||!Array.isArray(result.skipped)||result.installed.some(item=>item?.kind!=='action'&&item?.kind!=='observation'))throw Error('Background access response unavailable');
 return result;
}
export function backgroundAccessSummary(result:Result){
 const actions=result.installed.filter(item=>item.kind==='action').length,refresh=result.installed.some(item=>item.kind==='observation');
 const parts=[actions?`${actions} reviewed ${actions===1?'action':'actions'}`:'',refresh?'background refresh':''].filter(Boolean);
 return `Re-established ${parts.join(' and ')||'nothing'}.`+(result.skipped.length?' Background refresh needs an account permission that lasts until revoked; renew the account permission to include it.':'');
}

// Manual recovery reissues only the current reviewed sessions.
// Trusted compatible upgrades ordinarily carry those approvals forward.
export function ExperienceBackgroundAccess({target,disabled,onBusy}:{target:AppConnectionTarget;disabled:boolean;onBusy:(busy:boolean)=>void}){
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),operation=useRef(false);
 if(target.session?.state!=='connected')return null;
 async function reestablish(){
  if(operation.current||disabled)return;operation.current=true;setBusy(true);onBusy(true);setNotice('');const anchor=api.getAccessToken();
  try{
   const response=await api.fetch(`/api/app-connection-sessions/installations/${encodeURIComponent(target.scope.installation_id)}/background-access`,
    {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target_key:target.target_key}),signal:AbortSignal.timeout(35000)});
   if(!isSameWebSession(anchor,api.getAccessToken()))throw Error('Your session changed. Reload and try again.');
   if(!response.ok)throw Error(await appApiError(response,'Background access could not be re-established. Check the account permission and try again.'));
   setNotice(backgroundAccessSummary(parse(await response.json())));
  }catch(error){setNotice(error instanceof Error?error.message:'Background access unavailable.');}
  finally{operation.current=false;setBusy(false);onBusy(false);}
 }
 return <section aria-label="Background access" className="space-y-2 border-t pt-4 text-sm" style={{borderColor:'var(--ghost-border)'}}>
  <h4 className="font-medium">Background access</h4>
  <p>Trusted compatible updates keep your existing approvals. If an approved background action or refresh stops working, restore its current access here. This does not add permissions or extend their expiry.</p>
  {notice&&<AppRequestNotice message={notice} role="status"/>}
  <button type="button" className="deft-pill min-h-11" disabled={busy||disabled} onClick={()=>void reestablish()}>{busy?'Re-establishing…':'Re-establish background access'}</button>
 </section>;
}
