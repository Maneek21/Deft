'use client';
import { useEffect, useRef, useState } from 'react';
import { api, isSameWebSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { appApiError, type AppInstallation } from '@/lib/apps';
import { parseRuntimeSetupContext, runtimeSetupWebDeadline, type RuntimeSetupContext, type RuntimeSetupRequest } from '@/lib/app-runtime-setup';
type Review = { schema_version:'deft.app_runtime_management_review.v1';org_id:string;installation_id:string;app_version_id:string;
  grant_snapshot_id:string;grant_snapshot_digest:string;package_digest:string;lifecycle_epoch:number;grant_epoch:number;
  operator_user_id:string;action_key:string;operation_name:string;contract_digest:string;review_digest:string;
  host_policy:{risk_class:string;review_requirement:string;review_scope:string;retry_class:string;retention_class:string} };
type Credential = { session_id:string;session_token:string;expires_at:string };
const tap={minHeight:44};
const sha=(x:unknown)=>typeof x==='string'&&/^sha256:[a-f0-9]{64}$/.test(x);
const uuid=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
async function json(r:Response):Promise<unknown>{if(!r.ok)throw new Error(await appApiError(r,'Runtime setup is unavailable.'));const text=await r.text();if(text.length>65536)throw new Error('Runtime setup response is too large.');return JSON.parse(text);}
export function RuntimeAppSetup({app}:{app:AppInstallation}){
  const {sessionCacheScope,user}=useAuth();
  if(!sessionCacheScope||!user||app.state!=='active'||app.manifest.schema_version!=='7'||!app.manifest.runtime_actions.length)return null;
  return <Workspace key={`${sessionCacheScope}/${app.id}/${app.version_id}/${app.lifecycle_epoch}/${app.grant_epoch}`} app={app} operatorId={user.id}/>;
}
function Workspace({app,operatorId}:{app:AppInstallation;operatorId:string}){
  const [context,setContext]=useState<RuntimeSetupContext|null>(null),[review,setReview]=useState<{value:Review;request:RuntimeSetupRequest}|null>(null);
  const [credential,setCredential]=useState<Credential|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const sessionAnchor=useRef(api.getAccessToken());
  const generation=useRef(0),pending=useRef<AbortController|null>(null),credentialDeadline=useRef(0);
  const base='/api/apps/blob/composition/runtime';
  const clear=()=>{generation.current++;pending.current?.abort();credentialDeadline.current=0;setCredential(null);setReview(null);setContext(null);setBusy(false);setError(null);setNotice(null);};
  const begin=()=>{pending.current?.abort();const controller=new AbortController();pending.current=controller;return {id:++generation.current,controller,token:api.getAccessToken()};};
  const current=(s:ReturnType<typeof begin>)=>s.id===generation.current&&!s.controller.signal.aborted&&!document.hidden
    &&isSameWebSession(s.token,localStorage.getItem('deft-access-token'))&&runtimeSetupWebDeadline(localStorage.getItem('deft-access-token'))>Date.now();
  const fetchContext=async(signal:AbortSignal)=>{
    const body=parseRuntimeSetupContext(await json(await api.fetch(`/api/apps/blob/composition/${encodeURIComponent(app.id)}/runtime/context?app_version_id=${encodeURIComponent(app.version_id)}`,{signal,cache:'no-store'})));
    if(!body||body.installation_id!==app.id||body.app_version_id!==app.version_id||body.package_digest!==app.package_digest||body.lifecycle_epoch!==app.lifecycle_epoch||body.grant_epoch!==app.grant_epoch||body.operator_user_id!==operatorId)throw new Error('The App or operator changed. Refresh Apps before setup.');
    return body;
  };
  const load=async()=>{if(document.hidden)return;const s=begin();setBusy(true);setError(null);
    try{const body=await fetchContext(s.controller.signal);if(current(s))setContext(body);}catch(e){if(current(s))setError(e instanceof Error?e.message:'Runtime setup unavailable.');}finally{if(current(s))setBusy(false);}};
  useEffect(()=>{void load();const hidden=()=>{if(document.hidden)clear();else void load();};const storage=(event:StorageEvent)=>{if(['deft-access-token','deft-refresh-token'].includes(event.key||''))clear();};
    const timer=setInterval(()=>{const now=Date.now();if(!isSameWebSession(sessionAnchor.current,localStorage.getItem('deft-access-token'))||runtimeSetupWebDeadline(localStorage.getItem('deft-access-token'))<=now)clear();else if(credentialDeadline.current&&credentialDeadline.current<=now){credentialDeadline.current=0;setCredential(null);setNotice('The operator credential expired. Issue a new one explicitly when needed.');}},250);
    document.addEventListener('visibilitychange',hidden);addEventListener('pagehide',clear);addEventListener('storage',storage);
    return()=>{generation.current++;pending.current?.abort();credentialDeadline.current=0;clearInterval(timer);document.removeEventListener('visibilitychange',hidden);removeEventListener('pagehide',clear);removeEventListener('storage',storage);};
    // Workspace key fences the current auth scope and immutable App pins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const prepare=async(request:RuntimeSetupRequest)=>{const s=begin();setBusy(true);setReview(null);setCredential(null);credentialDeadline.current=0;setError(null);setNotice(null);
    try{const body=await json(await api.fetch(base+'/reviews/prepare',{method:'POST',body:JSON.stringify(request),signal:s.controller.signal})) as {review:Review};const value=body.review;
      if(!value||value.schema_version!=='deft.app_runtime_management_review.v1'||value.installation_id!==request.installation_id||value.app_version_id!==request.expected_app_version_id
        ||value.package_digest!==request.expected_package_digest||value.grant_snapshot_digest!==request.expected_grant_snapshot_digest||value.lifecycle_epoch!==request.expected_lifecycle_epoch||value.grant_epoch!==request.expected_grant_epoch
        ||value.operator_user_id!==request.operator_user_id||value.action_key!==request.action_key||value.grant_snapshot_id!==context?.grant_snapshot_id||!sha(value.review_digest)||!sha(value.contract_digest)
        ||value.host_policy?.risk_class!=='external_write'||value.host_policy.review_requirement!=='always'||value.host_policy.review_scope!=='per_invocation'||value.host_policy.retry_class!=='unsafe_or_unknown'||value.host_policy.retention_class!=='standard')throw new Error('The exact Runtime review changed. Reload setup.');
      if(current(s))setReview({value,request});
    }catch(e){if(current(s))setError(e instanceof Error?e.message:'Review unavailable.');}finally{if(current(s))setBusy(false);}};
  const activate=async()=>{if(!review)return;const expected=review,s=begin();setBusy(true);setError(null);
    try{await json(await api.fetch(base+'/bindings/activate',{method:'POST',signal:s.controller.signal,body:JSON.stringify({...expected.request,expected_review_digest:expected.value.review_digest,accept_host_policy:true})}));
      const body=await fetchContext(s.controller.signal);if(current(s)){setContext(body);setReview(null);setNotice('Operator binding active. Issue a credential only when configuring its provider.');}
    }catch{if(!current(s))return;setReview(null);try{const body=await fetchContext(s.controller.signal);if(current(s)){setContext(body);const found=body.actions.find(row=>row.key===expected.request.action_key)?.binding;
          if(found?.operator_user_id===operatorId&&found.state==='active'){setNotice('Operator binding is active. Activation was not repeated.');return;}}}catch{/* Never retry an ambiguous activation automatically. */}
      if(current(s))setError('Activation could not be confirmed. Reload setup before reviewing again.');
    }finally{if(current(s))setBusy(false);}};
  const issue=async(bindingId:string)=>{const s=begin();setBusy(true);setError(null);setCredential(null);credentialDeadline.current=0;setNotice(null);
    try{const body=await json(await api.fetch(`${base}/bindings/${encodeURIComponent(bindingId)}/sessions`,{method:'POST',body:'{}',signal:s.controller.signal})) as {session:Credential};const value=body.session;
      if(!value||Object.keys(value).sort().join(',')!=='expires_at,session_id,session_token'||!uuid(value.session_id)||typeof value.session_token!=='string'||value.session_token.length<32||value.session_token.length>512||typeof value.expires_at!=='string'||!Number.isFinite(Date.parse(value.expires_at)))throw new Error('Credential response unavailable.');
      const deadline=Math.min(Date.parse(value.expires_at),runtimeSetupWebDeadline(localStorage.getItem('deft-access-token')));
      if(current(s)&&deadline>Date.now()){credentialDeadline.current=deadline;setCredential(value);setNotice('Shown once in this page. Keep it private in your provider configuration.');}
    }catch{if(current(s))setError('Credential delivery could not be confirmed. No automatic reissue. Any created credential remains subject to its expiry.');}finally{if(current(s))setBusy(false);}};
  const showCredential=isSameWebSession(sessionAnchor.current,api.getAccessToken())&&credential&&credentialDeadline.current>Date.now()&&runtimeSetupWebDeadline(api.getAccessToken())>Date.now();
  return <section aria-label="Runtime action setup" className="mt-4 min-w-0 space-y-3 border-t pt-3 text-sm">
    <h3 className="font-semibold">Action operator setup</h3><p>Review each declared action with you as its operator. Every invocation still needs its own approval in Deft. A binding does not prove that its provider is connected.</p>
    {busy&&<p role="status">Checking Runtime setup…</p>}{error&&<p role="alert" className="break-words">{error}</p>}{notice&&<p role="status" className="break-words">{notice}</p>}
    {!context&&!busy&&<button className="deft-pill" style={tap} onClick={()=>void load()}>Reload setup</button>}
    {review?<div className="space-y-2"><h4 className="font-semibold">Review {context?.actions.find(row=>row.key===review.request.action_key)?.label||review.request.action_key}</h4>
      <p>You will operate this exact App version and action. Effects require per-invocation approval; unsafe or unknown outcomes are never automatically retried.</p>
      <details><summary className="cursor-pointer py-2">Exact package and action</summary><p className="break-words text-xs">{review.value.action_key}</p><code className="block break-all text-xs">{review.value.package_digest}</code></details><div className="flex flex-wrap gap-2"><button className="deft-pill" style={tap} disabled={busy} onClick={()=>void activate()}>Accept operator review</button><button className="deft-pill" style={tap} disabled={busy} onClick={()=>setReview(null)}>Cancel review</button></div></div>
      :context&&<ul className="space-y-3">{context.actions.map(action=><li key={action.key} className="min-w-0 space-y-1"><p className="font-medium break-words">{action.label}</p>
        <p className="text-xs">{action.binding?`Binding ${action.binding.state}; ${action.binding.operator_user_id===operatorId?'you are its operator':'assigned to another operator'}.`:'No operator binding.'}</p>
        {action.binding?<button className="deft-pill" style={tap} disabled={busy||!action.binding.can_issue_session} onClick={()=>void issue(action.binding!.id)}>Issue provider credential</button>
          :<button className="deft-pill" style={tap} disabled={busy} onClick={()=>void prepare(action.review_request)}>Review operator setup</button>}</li>)}</ul>}
    {showCredential&&<div className="space-y-2"><p className="font-semibold">One-time operator credential</p><p>Expires {new Date(credential.expires_at).toLocaleString()}. Hiding this display does not revoke the credential.</p>
      <textarea aria-label="Operator provider credential" readOnly className="w-full min-w-0 break-all rounded border p-2 font-mono text-xs" rows={5} value={JSON.stringify(credential,null,2)}/>
      <button className="deft-pill" style={tap} onClick={()=>{setCredential(null);credentialDeadline.current=0;setNotice('Credential display cleared. Its existing expiry still applies.');}}>Hide credential</button></div>}
  </section>;
}
