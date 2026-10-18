'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ResourceRefV2 } from '@deft/shared/resources-v2';
import { api, isSameWebSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { appApiError } from '@/lib/apps';
import { PageHeader } from '@/components/page-header';

async function sharingApiError(response: Response, fallback: string) {
  const message = await appApiError(response, fallback);
  return /^[A-Z][A-Z0-9_]+$/.test(message) ? fallback : message;
}

const control = 'min-h-11 rounded border border-border px-3 py-2 text-sm';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
type Identity = { registrationId: string; resourceType: string; projectionId: string };
type Operation = 'cite' | 'read' | 'search';
type Review = { review_token: string; review_digest: string; record_label: string; selected_data:Record<string,string|number|boolean>;
  snapshot: { schema_version: string; purpose: string; app_installation_id: string; app_label: string;
    recipient_user_id: string; recipient_label: string; field_keys: string[]; operations: Operation[];
    expires_at: string; review_expires_at: string } };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Private access unavailable.');
  return value as Record<string, unknown>;
}
function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || !value.every(v => typeof v === 'string' && v.length <= 200)) throw new Error('Invalid private access response.');
  return value as string[];
}
function reviewResponse(value: unknown): Review {
  const r = object(value), s = object(r.snapshot);
  if(Object.keys(r).some(k=>!['snapshot','record_label','selected_data','review_digest','review_token'].includes(k))
    ||new TextEncoder().encode(JSON.stringify(r)).byteLength>131072)throw new Error('Invalid private access review.');
  if (s.schema_version !== 'deft.app_resource_access_snapshot.v1' || s.purpose !== 'human_view'
    || typeof r.review_token !== 'string' || r.review_token.length > 16384 || typeof r.review_digest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(r.review_digest) || typeof r.record_label !== 'string' || r.record_label.length > 200
    || typeof s.app_installation_id !== 'string' || !uuid.test(s.app_installation_id)
    || typeof s.recipient_user_id !== 'string' || !uuid.test(s.recipient_user_id)
    || typeof s.app_label !== 'string' || s.app_label.length > 200 || typeof s.recipient_label !== 'string' || s.recipient_label.length > 200
    || typeof s.expires_at !== 'string' || !Number.isFinite(Date.parse(s.expires_at))
    || typeof s.review_expires_at !== 'string' || !Number.isFinite(Date.parse(s.review_expires_at))) throw new Error('Invalid private access review.');
  const fields = strings(s.field_keys,32), operations = strings(s.operations,3);
  const data=object(r.selected_data);
  if (!fields.length || !operations.length || operations.some(v => !['cite','read','search'].includes(v))) throw new Error('Invalid private access review.');
  if(Object.keys(data).length!==fields.length||fields.some(k=>!Object.hasOwn(data,k))
    ||!Object.values(data).every(v=>typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)))throw new Error('Invalid private access review.');
  return { review_token:r.review_token,review_digest:r.review_digest,record_label:r.record_label,selected_data:data as Review['selected_data'],
    snapshot:{schema_version:s.schema_version,purpose:s.purpose,app_installation_id:s.app_installation_id,
      app_label:s.app_label,recipient_user_id:s.recipient_user_id,recipient_label:s.recipient_label,
      field_keys:fields,operations:operations as Operation[],expires_at:s.expires_at,review_expires_at:s.review_expires_at} };
}
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"><PageHeader title="Private App sharing" />
    <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3 md:px-6"><div className="max-w-2xl space-y-4">{children}</div></main></div>;
}
export function PrivateResourceShareReview(identity: Identity) {
  const {user,sessionCacheScope}=useAuth();
  if (!user || !sessionCacheScope) return null;
  return <ShareReviewView key={`${sessionCacheScope}/${identity.registrationId}/${identity.resourceType}/${identity.projectionId}`} {...identity} />;
}
function ShareReviewView(identity: Identity) {
  const [fields,setFields]=useState<string[]>([]),[selected,setSelected]=useState<string[]>([]);
  const [members,setMembers]=useState<{id:string;name:string}[]>([]),[recipient,setRecipient]=useState('');
  const [operations,setOperations]=useState<Operation[]>([]),[hours,setHours]=useState(1);
  const [review,setReview]=useState<Review|null>(null),[grant,setGrant]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(true);
  const generation=useRef(0),sourceExpiry=useRef(0),disposed=useRef(false);
  const ref: ResourceRefV2={schema_version:'deft.resource_ref.v2',provider:{kind:'app_runtime',provider_instance_id:identity.registrationId},resource_type:identity.resourceType,resource_id:identity.projectionId};
  const current=(request:number,session:string|null)=>!disposed.current && request===generation.current && !document.hidden
    && isSameWebSession(session,api.getAccessToken()) && sourceExpiry.current>Date.now();
  useLayoutEffect(()=>{
    disposed.current=false;let timer:ReturnType<typeof setTimeout>|undefined;
    const clear=()=>{generation.current++;sourceExpiry.current=0;setReview(null);setGrant(null);setFields([]);setSelected([]);setBusy(false);};
    const load=async()=>{
      const request=++generation.current,session=api.getAccessToken();setBusy(true);setError(null);setReview(null);setFields([]);
      try {
        const [source,people]=await Promise.all([api.get(`/api/app-resource-private/references/${identity.registrationId}/${identity.resourceType}/${identity.projectionId}`),api.get('/api/members')]);
        if(!source.ok)throw new Error(await sharingApiError(source,'Private access unavailable.'));
        if(!people.ok)throw new Error('Human recipients unavailable.');
        const body=object(await source.json()),data=object(body.data),actual=object(body.ref),provider=object(actual.provider);
        if(provider.provider_instance_id!==identity.registrationId || actual.resource_id!==identity.projectionId || actual.resource_type!==identity.resourceType
          || typeof body.consent_expires_at!=='string' || !Number.isFinite(Date.parse(body.consent_expires_at)))throw new Error('Private access unavailable.');
        const list=await people.json();if(!Array.isArray(list)||list.length>10000)throw new Error('Human recipients unavailable.');
        sourceExpiry.current=Date.parse(body.consent_expires_at);
        if(!current(request,session))return;
        setFields(Object.keys(data).filter(k=>k.length<=48).sort());
        setMembers(list.flatMap(v=>{const m=object(v);return m.kind==='human'&&typeof m.id==='string'&&uuid.test(m.id)&&typeof m.name==='string'&&m.role!=='guest'?[{id:m.id,name:m.name.slice(0,200)}]:[]}));
        clearTimeout(timer);timer=setTimeout(()=>{clear();setError('Owner consent expired.');},Math.min(sourceExpiry.current-Date.now(),2147483647));
      }catch(e){if(!disposed.current&&request===generation.current)setError(e instanceof Error?e.message:'Private access unavailable.');}
      finally{if(!disposed.current&&request===generation.current)setBusy(false);}
    };
    const visibility=()=>{if(document.hidden)clear();else void load();};
    document.addEventListener('visibilitychange',visibility);addEventListener('pagehide',clear);
    if(!document.hidden)void load();else setBusy(false);
    return()=>{disposed.current=true;generation.current++;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);removeEventListener('pagehide',clear);};
  },[identity.registrationId,identity.resourceType,identity.projectionId]);
  const change=()=>{generation.current++;setReview(null);setGrant(null);setError(null);setBusy(false);};
  const prepare=async()=>{
    const request=++generation.current,session=api.getAccessToken();setBusy(true);setError(null);setReview(null);
    try{
      const response=await api.post('/api/app-resource-access/reviews',{schema_version:'deft.app_resource_access_review.v1',ref,
        destination:{kind:'human',user_id:recipient},field_keys:[...selected].sort(),operations:[...operations].sort(),expires_at:new Date(Date.now()+hours*3600000).toISOString()});
      if(!response.ok)throw new Error(await sharingApiError(response,'Private sharing unavailable.'));
      const result=reviewResponse(await response.json());if(!current(request,session))return;
      if(result.snapshot.recipient_user_id!==recipient||JSON.stringify(result.snapshot.field_keys)!==JSON.stringify([...selected].sort())
        ||JSON.stringify(result.snapshot.operations)!==JSON.stringify([...operations].sort())||Date.parse(result.snapshot.review_expires_at)<=Date.now())throw new Error('Review expired or changed.');
      setReview(result);
    }catch(e){if(current(request,session))setError(e instanceof Error?e.message:'Private sharing unavailable.');}
    finally{if(current(request,session))setBusy(false);}
  };
  const accept=async()=>{
    if(!review)return;const request=++generation.current,session=api.getAccessToken();setBusy(true);setError(null);
    try{
      if(Date.parse(review.snapshot.review_expires_at)<=Date.now())throw new Error('Review expired. Review again.');
      const response=await api.post('/api/app-resource-access/grants',{review_token:review.review_token,review_digest:review.review_digest,accept_access:true});
      if(!response.ok)throw new Error(await sharingApiError(response,'Sharing was not accepted.'));
      const result=object(await response.json());if(!current(request,session))return;
      if(typeof result.grant_id!=='string'||!uuid.test(result.grant_id))throw new Error('Sharing status unavailable.');setGrant(result.grant_id);
    }catch(e){if(current(request,session))setError(e instanceof TypeError?'Sharing status unavailable. Retry acceptance to recover the same grant.':e instanceof Error?e.message:'Sharing status unavailable.');}
    finally{if(current(request,session))setBusy(false);}
  };
  return <Shell><p>Share one saved record with one human in this workspace. No Worker, agent or action authority is granted.</p>
    {busy&&<p role="status">Checking private access...</p>}{error&&<p role="alert">{error}</p>}
    {!!fields.length&&<><label className="block">Human recipient<select className={`${control} mt-1 block w-full`} value={recipient} onChange={e=>{change();setRecipient(e.target.value);}}><option value="">Choose a human</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <fieldset><legend>Selected fields</legend>{fields.map(k=><label className="flex min-h-11 items-center gap-2 break-all" key={k}><input type="checkbox" checked={selected.includes(k)} onChange={e=>{change();setSelected(v=>e.target.checked?[...v,k]:v.filter(x=>x!==k));}}/>{k}</label>)}</fieldset>
      <fieldset><legend>Selected operations</legend>{(['read','search','cite'] as Operation[]).map(op=><label className="flex min-h-11 items-center gap-2" key={op}><input type="checkbox" checked={operations.includes(op)} onChange={e=>{change();setOperations(v=>e.target.checked?[...v,op]:v.filter(x=>x!==op));}}/>{op==='read'?'Read selected fields':op==='search'?'Search selected fields':'Create a live-authorized citation'}</label>)}</fieldset>
      <label className="block">Maximum hours (owner consent may end sooner)<input className={`${control} mt-1 block w-full`} type="number" min={1} max={24} value={hours} onChange={e=>{change();setHours(Math.max(1,Math.min(24,Number(e.target.value)||1)));}}/></label>
      <button className={control} disabled={busy||!recipient||!selected.length||!operations.length} onClick={()=>void prepare()}>Review exact sharing</button></>}
    {review&&<section className="space-y-3 rounded border border-border p-4" aria-label="Exact sharing review"><h2 className="font-semibold">Review human access</h2><p className="break-words">{review.snapshot.app_label}: {review.record_label}</p><p className="break-words">Recipient: {review.snapshot.recipient_label}</p><p className="break-words">Fields: {review.snapshot.field_keys.join(', ')}</p><p>Operations: {review.snapshot.operations.join(', ')}</p><p>Ends: {new Date(review.snapshot.expires_at).toLocaleString()}</p><p>Access is pinned to this exact saved content. Changed content, lost owner consent or revocation makes the link unavailable.</p>
      <dl className="space-y-3" aria-label="Exact selected values">{Object.entries(review.selected_data).map(([k,v])=><div key={k}><dt className="font-semibold">{k}</dt><dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(v)}</dd></div>)}</dl>
      {!grant&&<div className="flex flex-wrap gap-2"><button className={control} disabled={busy} onClick={()=>void accept()}>Accept human access</button><button className={control} disabled={busy} onClick={()=>{generation.current++;setReview(null);}}>Cancel review</button></div>}
      {grant&&<p><Link className="inline-flex min-h-11 items-center underline" href={`/private-app-resources/shared/${grant}`}>Shared App record</Link></p>}
      <Link className="inline-flex min-h-11 items-center underline" href={`/private-app-resources/sharing/${review.snapshot.app_installation_id}`}>Manage this App’s sharing</Link></section>}
  </Shell>;
}

type Scope = {field_keys:string[];operations:Operation[];expires_at:string};
type Hit = {grant_id:string;label:string;snippets:Record<string,string>};
export function SharedPrivateResource({grantId}:{grantId:string}) {
  const {user,sessionCacheScope}=useAuth();
  if(!user||!sessionCacheScope)return null;
  return <SharedResourceView key={`${sessionCacheScope}/${grantId}`} grantId={grantId}/>;
}
function SharedResourceView({grantId}:{grantId:string}) {
  const [scope,setScope]=useState<Scope|null>(null),[data,setData]=useState<Record<string,string|number|boolean>|null>(null);
  const [label,setLabel]=useState('Shared App record'),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(true);
  const [query,setQuery]=useState(''),[hits,setHits]=useState<Hit[]>([]),[cursor,setCursor]=useState<string|null>(null),[complete,setComplete]=useState<boolean|null>(null);
  const [reload,setReload]=useState(0);
  const generation=useRef(0),deadline=useRef(0),disposed=useRef(false);
  const current=(request:number,session:string|null)=>!disposed.current&&request===generation.current&&!document.hidden
    &&deadline.current>Date.now()&&isSameWebSession(session,api.getAccessToken());
  useLayoutEffect(()=>{
    disposed.current=false;let timer:ReturnType<typeof setTimeout>|undefined;
    const clear=()=>{generation.current++;deadline.current=0;setScope(null);setData(null);setHits([]);setCursor(null);setComplete(null);setLabel('Shared App record');setBusy(false);};
    const load=async()=>{
      const request=++generation.current,session=api.getAccessToken();setBusy(true);setError(null);setData(null);setHits([]);setCursor(null);setScope(null);
      try{
        const response=await api.get(`/api/app-resource-access/grants/${grantId}/scope`);
        if(!response.ok)throw new Error(await sharingApiError(response,'Shared access unavailable.'));
        const s=object(await response.json());const fields=strings(s.field_keys,32),ops=strings(s.operations,3);
        if(s.schema_version!=='deft.app_resource_access_scope.v1'||s.grant_id!==grantId||s.label!=='Shared App record'
          ||!fields.length||!ops.length||ops.some(v=>!['cite','read','search'].includes(v))||typeof s.expires_at!=='string'||!Number.isFinite(Date.parse(s.expires_at)))throw new Error('Shared access unavailable.');
        deadline.current=Date.parse(s.expires_at);if(!current(request,session))return;
        setScope({field_keys:fields,operations:ops as Operation[],expires_at:s.expires_at});
        clearTimeout(timer);timer=setTimeout(()=>{clear();setError('Shared access expired.');},Math.min(deadline.current-Date.now(),2147483647));
        if(ops.includes('read')){
          const read=await api.get(`/api/app-resource-access/grants/${grantId}/resource`);
          if(!read.ok)throw new Error(await sharingApiError(read,'Shared access unavailable.'));
          const r=object(await read.json()),body=object(r.data);
          if(r.schema_version!=='deft.app_resource_access_record.v1'||r.grant_id!==grantId||typeof r.label!=='string'||r.label.length>200
            ||Object.keys(body).some(k=>!fields.includes(k))||!Object.values(body).every(v=>typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))
            ||new TextEncoder().encode(JSON.stringify(r)).byteLength>65536)throw new Error('Shared access unavailable.');
          if(!current(request,session))return;setData(body as Record<string,string|number|boolean>);setLabel(r.label);
        }
      }catch(e){if(!disposed.current&&request===generation.current){setScope(null);setData(null);setHits([]);setError(e instanceof Error?e.message:'Shared access unavailable.');}}
      finally{if(!disposed.current&&request===generation.current)setBusy(false);}
    };
    const visible=()=>{if(document.hidden)clear();else void load();};document.addEventListener('visibilitychange',visible);addEventListener('pagehide',clear);
    if(!document.hidden)void load();else setBusy(false);
    return()=>{disposed.current=true;generation.current++;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);removeEventListener('pagehide',clear);};
  },[grantId,reload]);
  const search=async(next:boolean)=>{
    if(!scope)return;const request=++generation.current,session=api.getAccessToken();setBusy(true);setError(null);if(!next){setHits([]);setCursor(null);}
    try{
      const response=await api.post(`/api/app-resource-access/grants/${grantId}/search`,{query,field_keys:scope.field_keys,cursor:next?cursor:null});
      if(!response.ok){if([401,403,404].includes(response.status)&&current(request,session))setScope(null);throw new Error(await sharingApiError(response,response.status===409?'Saved data changed. Ask the owner to review access again.':'Shared search unavailable.'));}
      const r=object(await response.json());if(r.schema_version!=='deft.app_resource_access_search_page.v1'||!Array.isArray(r.hits)||r.hits.length>25
        ||typeof r.complete!=='boolean'||!(r.next_cursor===null||typeof r.next_cursor==='string'&&r.next_cursor.length<=8192)
        ||r.complete!==(r.next_cursor===null)||new TextEncoder().encode(JSON.stringify(r)).byteLength>65536)throw new Error('Shared search unavailable.');
      const page=r.hits.map(v=>{const h=object(v),snippets=object(h.snippets);if(typeof h.grant_id!=='string'||!uuid.test(h.grant_id)||typeof h.label!=='string'||h.label.length>200
        ||Object.entries(snippets).some(([k,text])=>!scope.field_keys.includes(k)||typeof text!=='string'||text.length>240))throw new Error('Shared search unavailable.');return{grant_id:h.grant_id,label:h.label,snippets:snippets as Record<string,string>};});
      if(!current(request,session))return;setHits(page);setCursor(r.next_cursor as string|null);setComplete(r.complete);
    }catch(e){if(current(request,session)){setHits([]);setCursor(null);setComplete(null);setData(null);setError(e instanceof Error?e.message:'Shared search unavailable.');}}
    finally{if(current(request,session))setBusy(false);}
  };
  const cite=async()=>{
    const request=++generation.current,session=api.getAccessToken();setBusy(true);setError(null);
    try{const response=await api.get(`/api/app-resource-access/grants/${grantId}/citation`);if(!response.ok)throw new Error(await sharingApiError(response,'Citation unavailable.'));
      const r=object(await response.json());if(r.schema_version!=='deft.app_resource_access_citation.v1'||r.grant_id!==grantId||r.href!==`/private-app-resources/shared/${grantId}`)throw new Error('Citation unavailable.');
      if(!current(request,session))return;await navigator.clipboard.writeText(`[Shared App record](${r.href})`);
      if(current(request,session))setError('Generic reference copied. Every viewer must have current access.');
    }catch(e){if(current(request,session))setError(e instanceof Error?e.message:'Citation unavailable.');}
    finally{if(current(request,session))setBusy(false);}
  };
  return <Shell><h2 className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{label}</h2><p>Exact owner-approved content. Provider freshness is unknown.</p>
    {busy&&<p role="status">Checking shared access...</p>}{error&&<p role="alert" className="break-words">{error}</p>}
    {data&&<dl className="space-y-4">{Object.entries(data).map(([k,v])=><div key={k}><dt className="font-semibold">{k}</dt><dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{String(v)}</dd></div>)}</dl>}
    {scope?.operations.includes('cite')&&<button className={control} disabled={busy} onClick={()=>void cite()}>Copy generic reference</button>}
    {scope?.operations.includes('search')&&<section className="space-y-3"><label className="block">Literal search of approved fields<input className={`${control} mt-1 block w-full`} disabled={busy} maxLength={200} value={query} onChange={e=>{generation.current++;setQuery(e.target.value);setHits([]);setCursor(null);setComplete(null);setBusy(false);}}/></label>
      <button className={control} disabled={busy||!query.trim()} onClick={()=>void search(false)}>Start search</button>
      {complete!==null&&<p>{complete?'Search complete for this snapshot.':'More approved grants remain. Continue to finish this snapshot.'}</p>}
      {hits.map(h=><article className="space-y-2 rounded border border-border p-3" key={h.grant_id}><Link className="inline-flex min-h-11 items-center break-words underline" href={`/private-app-resources/shared/${h.grant_id}`}>{h.label}</Link>{Object.entries(h.snippets).map(([k,text])=><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]" key={k}>{k}: {text}</p>)}</article>)}
      {cursor&&<button className={control} disabled={busy} onClick={()=>void search(true)}>Continue search</button>}</section>}
    <button className={control} disabled={busy} onClick={()=>setReload(v=>v+1)}>Refresh shared access</button>
    <Link className="inline-flex min-h-11 items-center underline" href="/private-app-resources/shared">Received sharing</Link></Shell>;
}

export function PrivateSharingInventory({appId}:{appId?:string}) {
  const {user,sessionCacheScope}=useAuth();if(!user||!sessionCacheScope)return null;
  return <InventoryView key={`${sessionCacheScope}/${appId??'received'}`} appId={appId}/>;
}
function InventoryView({appId}:{appId?:string}) {
  const [items,setItems]=useState<{grant_id:string;label:string;state:string;expires_at:string}[]>([]);
  const [cursor,setCursor]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(true);
  const generation=useRef(0),disposed=useRef(false);
  const current=(request:number,session:string|null)=>!disposed.current&&request===generation.current&&!document.hidden&&isSameWebSession(session,api.getAccessToken());
  const load=async(next:string|null=null)=>{
    const request=++generation.current,session=api.getAccessToken();setBusy(true);setError(null);setItems([]);setCursor(null);
    try{
      const response=await api.post('/api/app-resource-access/inventory',{view:appId?'owned':'received',...(appId?{app_installation_id:appId}:{}),cursor:next});
      if(!response.ok)throw new Error(await sharingApiError(response,'Sharing inventory unavailable.'));
      const r=object(await response.json());if(r.schema_version!=='deft.app_resource_access_inventory.v1'||!Array.isArray(r.items)||r.items.length>25
        ||!(r.next_cursor===null||typeof r.next_cursor==='string'&&r.next_cursor.length<=4096)||typeof r.complete!=='boolean'||r.complete!==(r.next_cursor===null)
        ||new TextEncoder().encode(JSON.stringify(r)).byteLength>65536)throw new Error('Sharing inventory unavailable.');
      const page=r.items.map(v=>{const i=object(v);if(typeof i.grant_id!=='string'||!uuid.test(i.grant_id)||i.label!=='Shared App record'
        ||typeof i.state!=='string'||!['active','expired','revoked'].includes(i.state)||typeof i.expires_at!=='string'||!Number.isFinite(Date.parse(i.expires_at)))throw new Error('Sharing inventory unavailable.');return{grant_id:i.grant_id,label:i.label,state:i.state,expires_at:i.expires_at};});
      if(current(request,session)){setItems(page);setCursor(r.next_cursor as string|null);}
    }catch(e){if(current(request,session))setError(e instanceof Error?e.message:'Sharing inventory unavailable.');}
    finally{if(current(request,session))setBusy(false);}
  };
  useLayoutEffect(()=>{disposed.current=false;const clear=()=>{generation.current++;setItems([]);setCursor(null);setBusy(false);};const visible=()=>{if(document.hidden)clear();else void load();};
    document.addEventListener('visibilitychange',visible);addEventListener('pagehide',clear);if(!document.hidden)void load();else setBusy(false);
    return()=>{disposed.current=true;generation.current++;document.removeEventListener('visibilitychange',visible);removeEventListener('pagehide',clear);};
  // This instance is keyed to SID and exact App; its initial load is deliberately fenced there.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[appId]);
  const revoke=async(id:string)=>{
    const request=++generation.current,session=api.getAccessToken();setBusy(true);setError(null);
    try{const response=await api.delete(`/api/app-resource-access/grants/${id}`);if(!response.ok)throw new Error(await sharingApiError(response,'Revocation unavailable.'));
      const r=object(await response.json());if(r.revoked!==true)throw new Error('Revocation unavailable.');if(current(request,session))await load();
    }catch(e){if(current(request,session)){setError(e instanceof Error?e.message:'Revocation unavailable.');setBusy(false);}}
  };
  return <Shell><h2 className="text-lg font-semibold">{appId?'Manage this App’s sharing':'Received sharing'}</h2><p>Grant metadata contains no private record labels or content. Each destination checks current authority again.</p>
    {busy&&<p role="status">Checking sharing inventory...</p>}{error&&<p role="alert">{error}</p>}
    {!busy&&!error&&!items.length&&<p>No sharing grants in this page.</p>}
    {items.map(i=><article className="space-y-2 rounded border border-border p-3" key={i.grant_id}><Link className="inline-flex min-h-11 items-center underline" href={`/private-app-resources/shared/${i.grant_id}`}>{i.label}</Link><p>Grant {i.state}. Ends {new Date(i.expires_at).toLocaleString()}.</p>
      {appId&&i.state!=='revoked'&&<button className={control} disabled={busy} onClick={()=>void revoke(i.grant_id)}>Revoke human access</button>}</article>)}
    {cursor&&<button className={control} disabled={busy} onClick={()=>void load(cursor)}>Next sharing page</button>}
    <button className={control} disabled={busy} onClick={()=>void load()}>Refresh sharing</button></Shell>;
}
