'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, isSameWebSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { refreshApps } from '@/hooks/use-apps';
import { appApiError, type AppInstallation } from '@/lib/apps';

type Request = { schema_version:'deft.app_blob_review_request.v2';app_version_id:string;expected_package_digest:string;
  expected_requested_snapshot_digest:string;expected_lifecycle_epoch:number;expected_grant_epoch:number };
type Context = {schema_version:'deft.app_blob_review_context.v2';installation_id:string;app_version_id:string;protocol_version:'7';
  state:string;review_request:Request|null;current_activation:{grant_snapshot_id:string;review_digest:string}|null};
type Review = {schema_version:'deft.app_blob_review.v2';installation_id:string;request:Request;review_digest:string;
  authority:{sync_descriptors:{key:string;resource_type:string;attachments:{allowed_media_types:string[];max_attachment_bytes:number;retention_days:number}}[];
    private_state?:{key:string;label:string;max_records:number;max_record_bytes:number;max_total_bytes:number;retention_days:number}[];
    modules:{module_id:string;version:string;manifest_path:string;manifest_digest:string}[];
    runtime_actions:{key:string}[];experiences:{key:string;label:string}[];
    host_policy:{encrypted_custody:boolean;current_parent_required:boolean;provider_url_fetch:boolean;irrecoverable_host_purge:boolean;owner_only:boolean;stage_ceiling_seconds:number}}};
const tap={minHeight:44};
async function result<T>(r:Response):Promise<T>{if(!r.ok)throw new Error(await appApiError(r,'This App review is unavailable.'));return r.json() as Promise<T>;}
export function AttachmentAppReview({app}:{app:AppInstallation}){
  const {sessionCacheScope}=useAuth();if(!sessionCacheScope||app.manifest.schema_version!=='7')return null;
  return <Workspace key={`${sessionCacheScope}/${app.id}/${app.version_id}/${app.lifecycle_epoch}/${app.grant_epoch}`} app={app}/>;
}
function Workspace({app}:{app:AppInstallation}){
  const [review,setReview]=useState<Review|null>(null),[busy,setBusy]=useState(false),[active,setActive]=useState(app.state==='active'),[error,setError]=useState<string|null>(null);
  const generation=useRef(0),pending=useRef<AbortController|null>(null);
  const base=`/api/apps/blob/composition/${encodeURIComponent(app.id)}`;
  useEffect(()=>{const clear=()=>{generation.current++;pending.current?.abort();setReview(null);setBusy(false);};const hidden=()=>{if(document.hidden)clear();};
    document.addEventListener('visibilitychange',hidden);addEventListener('pagehide',clear);
    return()=>{generation.current++;pending.current?.abort();document.removeEventListener('visibilitychange',hidden);removeEventListener('pagehide',clear);};},[]);
  const begin=()=>{pending.current?.abort();const controller=new AbortController();pending.current=controller;return {id:++generation.current,controller,token:api.getAccessToken()};};
  const current=(s:ReturnType<typeof begin>)=>s.id===generation.current&&!s.controller.signal.aborted&&!document.hidden&&isSameWebSession(s.token,localStorage.getItem('deft-access-token'));
  const context=(signal:AbortSignal)=>api.fetch(`${base}/context?app_version_id=${encodeURIComponent(app.version_id)}`,{signal,cache:'no-store'}).then(result<Context>);
  const prepare=async()=>{const s=begin();setBusy(true);setReview(null);setError(null);
    try{const target=await context(s.controller.signal);
      if(target.schema_version!=='deft.app_blob_review_context.v2'||target.installation_id!==app.id||target.app_version_id!==app.version_id||target.protocol_version!=='7')throw new Error('The App version changed. Refresh before reviewing.');
      if(target.state==='active'&&target.current_activation){if(current(s))setActive(true);return;}
      const request=target.review_request;if(!request||request.schema_version!=='deft.app_blob_review_request.v2'||request.app_version_id!==app.version_id
        ||request.expected_package_digest!==app.package_digest||request.expected_lifecycle_epoch!==app.lifecycle_epoch||request.expected_grant_epoch!==app.grant_epoch)throw new Error('The App version changed. Refresh before reviewing.');
      const body=await result<{review:Review}>(await api.fetch(`${base}/review`,{method:'POST',body:JSON.stringify(request),signal:s.controller.signal}));
      if(body.review.schema_version!=='deft.app_blob_review.v2'||body.review.installation_id!==app.id||JSON.stringify(body.review.request)!==JSON.stringify(request)
        ||!/^sha256:[a-f0-9]{64}$/.test(body.review.review_digest)||body.review.authority.sync_descriptors.length>8||body.review.authority.runtime_actions.length>16||body.review.authority.experiences.length>1
        ||!Array.isArray(body.review.authority.modules)||body.review.authority.modules.length>15
        ||body.review.authority.modules.some(m=>Object.keys(m).sort().join(',')!=='manifest_digest,manifest_path,module_id,version'
          ||typeof m.module_id!=='string'||m.module_id.length>128||typeof m.version!=='string'||m.version.length>64
          ||typeof m.manifest_path!=='string'||m.manifest_path.length>256||!/^sha256:[a-f0-9]{64}$/.test(m.manifest_digest))
        ||JSON.stringify(body.review.authority.modules)!==JSON.stringify(app.manifest.modules)
        ||body.review.authority.host_policy.encrypted_custody!==true||body.review.authority.host_policy.current_parent_required!==true
        ||body.review.authority.host_policy.provider_url_fetch!==false||body.review.authority.host_policy.irrecoverable_host_purge!==true
        ||body.review.authority.host_policy.owner_only!==true||body.review.authority.host_policy.stage_ceiling_seconds!==3600)throw new Error('The App review changed. Refresh before activating.');
      if(current(s))setReview(body.review);
    }catch(e){if(current(s))setError(e instanceof Error?e.message:'App review unavailable.');}finally{if(current(s))setBusy(false);}};
  const activate=async()=>{if(!review)return;const expected=review,s=begin();setBusy(true);setError(null);
    try{await result(await api.fetch(`${base}/activate`,{method:'POST',signal:s.controller.signal,body:JSON.stringify({...expected.request,expected_review_digest:expected.review_digest,accept_host_policy:true})}));
      if(current(s)){setReview(null);setActive(true);await refreshApps();}
    }catch{if(!current(s))return;setReview(null);
      try{const found=await context(s.controller.signal);if(current(s)&&found.state==='active'&&found.current_activation){setActive(true);await refreshApps();return;}}catch{/* Recover by current status only, never resubmit activation. */}
      if(current(s))setError('Activation could not be confirmed. Review the current version before trying again.');
    }finally{if(current(s))setBusy(false);}};
  return <section aria-label="Attachment App activation" className="mt-4 min-w-0 space-y-3 rounded-lg border p-3 text-sm">
    {busy&&<p role="status">Checking the current App version…</p>}{error&&<p role="alert" className="break-words">{error}</p>}
    {active?<><p>This reviewed App is active. Private resource consent and action operator consent are separate steps.</p><Link className="deft-pill" style={tap} href="/settings/apps/private-resources">Connect private resources</Link></>:review?<>
      <h3 className="font-semibold">Activate {app.name} {app.version}?</h3><p>This exact package declares saved private resources and the actions below. Activation does not grant access to your mailbox or attachments.</p>
      <ul className="space-y-2">{review.authority.sync_descriptors.map(d=><li key={d.key} className="break-words">{d.key} ({d.resource_type}) · declared attachment types: {d.attachments.allowed_media_types.join(', ')} · at most {d.attachments.max_attachment_bytes.toLocaleString()} bytes each, {d.attachments.retention_days} day retention ceiling</li>)}</ul>
      {review.authority.private_state?.map(state=><p key={state.key}>Private App state: {state.label} · up to {state.max_records} encrypted records, {state.max_record_bytes} bytes each / {state.max_total_bytes} bytes total · {state.retention_days} days from creation. The owner must separately approve each session. Other artifacts cannot automatically adopt these records.</p>)}
      <p>Declared actions: {review.authority.runtime_actions.map(a=>a.key).join(', ')||'None'}. Every effect requires its reviewed operator binding and normal approval.</p>
      <p>Activation installs or re-enables {review.authority.modules.length} declared workspace modules.</p>
      {review.authority.modules.length>0&&<ul>{review.authority.modules.map(m=><li key={m.module_id} className="break-words">{m.module_id} · version {m.version}<code className="block break-all text-xs">{m.manifest_digest}</code></li>)}</ul>}
      <p>Declared App interface: {review.authority.experiences.map(e=>`${e.label} (${e.key})`).join(', ')||'None'}.</p>
      <p>Saved attachments are encrypted and only their current owner can download them while the parent connection remains authorized. Deft does not fetch provider URLs. Expired or purged copies cannot be recovered from Deft; downloaded copies remain outside these controls.</p>
      <details><summary className="cursor-pointer py-2">Exact package</summary><code className="block break-all">{review.request.expected_package_digest}</code></details>
      <div className="flex flex-wrap gap-2"><button className="deft-pill" style={tap} disabled={busy} onClick={()=>void activate()}>Accept review and activate</button><button className="deft-pill" style={tap} disabled={busy} onClick={()=>setReview(null)}>Cancel App review</button></div>
    </>:<><p>Review this App version before using its private resources, attachments, or declared actions.</p><button className="deft-pill" style={tap} disabled={busy} onClick={()=>void prepare()}>Review App activation</button></>}
  </section>;
}
