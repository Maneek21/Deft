'use client';

import {appConsentDeadline,appConsentExpiryValid} from '../../../../../packages/app-kit/src/consent-lifetime';
import { useEffect, useRef, useState } from 'react';
import { api, isSameWebSession } from '@/lib/api';
import { APP_CONNECTION_PENDING_KEY, connectionBegin, type PendingAppConnection } from '@/lib/app-connection-flow';
import { useAuth } from '@/lib/auth-context';
import type { ExistingAccountReview } from '@/lib/app-connection-reattachment';
import { ExperienceExistingAccountReview } from './experience-existing-account-review';
import { ExperienceConnectionStatus } from './experience-connection-status';
import {LegacyConnectionSettingsGate} from './experience-connection-surface';
import {verifiedExperienceAccountLabels} from '@/lib/app-experience-settings-display';
import {ExperienceCapabilityUpgradeSettings} from './experience-capability-upgrade';
import {ExperienceBackgroundRefresh} from './experience-background-refresh';
import {ExperienceConnectionForms} from './experience-connection-forms';
import {ExperienceConsentContinuation} from './experience-consent-continuation';
import { appConnectionSessionTag, createAppConnectionSessionFlow, type AppConnectionContext } from '@/lib/app-connection-session-flow';
import { appApiError } from '@/lib/apps';
import { ownerConnectionContext, ownerResourceRequest, ownerActionRequest, ownerConnectionReview,
  type OwnerPolicy, type OwnerResourceRequest } from '@/lib/app-owner-connection';

type SettingsProps = { onAccountLabels?:(labels:{key:string;label:string}[])=>void; appOwnedRecords?: boolean; sessionId?: string; targetKey?: string; installationId: string; experienceKey: string; ensureAuthority: () => Promise<boolean>;
  disabled: boolean; onBusy: (busy: boolean) => void; onSetupComplete?: (target: string) => void; onReadingPreferencesChanged?: () => void; onConnectionNavigation: (pending: PendingAppConnection | null) => void };
export function ExperienceConnectionSettings(props: SettingsProps) {
  const { user, org, sessionCacheScope } = useAuth();
  if (!user || !org || !sessionCacheScope || user.role === 'guest') return null;
  return <div key={`${sessionCacheScope}/${props.installationId}`} className="space-y-4">
    <GenericConnectionSettings {...props} ownerId={user.id} orgId={org.id} sessionScope={sessionCacheScope}/>
    <ExperienceConsentContinuation {...props} ownerId={user.id} orgId={org.id} sessionScope={sessionCacheScope}/>
    {props.appOwnedRecords&&<ExperienceConnectionForms {...props} ownerId={user.id} orgId={org.id} sessionScope={sessionCacheScope}/>}
    <LegacyConnectionSettingsGate appOwnedRecords={props.appOwnedRecords}>{(user.role === 'member' || !props.sessionId) && <OwnerConnectionSettings {...props} ownerId={user.id} orgId={org.id}/>}</LegacyConnectionSettingsGate>
  </div>;
}

function GenericConnectionSettings(props:SettingsProps&{ownerId:string;orgId:string;sessionScope:string}){
  const [context,setContext]=useState<AppConnectionContext|null>(null),[selected,setSelected]=useState(props.targetKey??''),[notice,setNotice]=useState('Checking account connections…');
  const [working,setWorking]=useState(false),[reload,setReload]=useState(0),[reuseWorking,setReuseWorking]=useState<'review'|'activate'|'status'|null>(null);
  const [reuseReview,setReuseReview]=useState<ExistingAccountReview|null>(null),[reusePending,setReusePending]=useState(false),[reviewAvailable,setReviewAvailable]=useState(false),[clock,setClock]=useState(Date.now());
  const flow=useRef<ReturnType<typeof createAppConnectionSessionFlow>|null>(null),alive=useRef(false),operation=useRef(false),generation=useRef(0);
  useEffect(()=>{
    alive.current=true;const ticket=++generation.current,anchor=api.getAccessToken();let active=true;
    const current=()=>active&&alive.current&&ticket===generation.current&&!document.hidden&&isSameWebSession(anchor,api.getAccessToken());
    const hidden=()=>{if(document.hidden){active=false;flow.current?.dispose();operation.current=false;setWorking(false);setReuseWorking(null);setReuseReview(null);setReusePending(false);props.onBusy(false);}else setReload(n=>n+1);};
    document.addEventListener('visibilitychange',hidden);
    void (async()=>{
      if(!anchor||!current())return;setContext(null);setReuseReview(null);setReusePending(false);setNotice('Checking account connections…');
      const sessionTag=await appConnectionSessionTag(props.sessionScope);if(!current())return;
      const client=createAppConnectionSessionFlow({identity:{installationId:props.installationId,experienceKey:props.experienceKey,ownerId:props.ownerId,orgId:props.orgId,sessionTag},storage:sessionStorage,current,includeUpgrades:props.appOwnedRecords===true,fetch:(path,init)=>api.fetch(path,init)});
      flow.current=client;const value=await client.load();if(!current())return;
      setContext(value);setSelected(previous=>value.targets.some(t=>t.target_key===(props.targetKey??previous))?props.targetKey??previous:value.targets[0]?.target_key??'');setNotice('');
    })().catch(error=>{if(current()){setContext(null);setNotice(error instanceof Error?error.message:'Account connections are unavailable.');}});
    return()=>{active=false;alive.current=false;flow.current?.dispose();flow.current=null;operation.current=false;props.onBusy(false);document.removeEventListener('visibilitychange',hidden);};
  },[props.installationId,props.experienceKey,props.ownerId,props.orgId,props.sessionScope,props.targetKey,props.onBusy,reload]);
  useEffect(()=>{if(context&&context.installation_id===props.installationId&&context.org_id===props.orgId&&context.owner_user_id===props.ownerId)props.onAccountLabels?.(verifiedExperienceAccountLabels(context));},[context,props.onAccountLabels,props.installationId,props.orgId,props.ownerId]);
  const target=context?.targets.find(t=>t.target_key===selected),state=target?.session?.state;
  const visibleReview=reuseReview&&target&&JSON.stringify(reuseReview.scope)===JSON.stringify(target.scope)?reuseReview:null;
  useEffect(()=>{
    if(!context||!selected||!flow.current)return;
    try{const reviewed=flow.current.existingReview(selected);setReusePending(flow.current.existingPending(selected));setReuseReview(reviewed);setReviewAvailable(!!reviewed);setClock(Date.now());}
    catch{setReuseReview(null);setReviewAvailable(false);setReusePending(true);setNotice('Account reuse changed. Reload its status before continuing.');}
  },[context,selected]);
  useEffect(()=>{
    if(!reuseReview)return;const deadline=Date.parse(reuseReview.expires_at),timer=setTimeout(()=>setClock(Date.now()),Math.max(1,deadline-Date.now()+1));
    return()=>clearTimeout(timer);
  },[reuseReview]);
  async function reuse(kind:'review'|'activate'|'status'){
    if(operation.current||props.disabled||document.hidden||!flow.current||!target)return;
    const client=flow.current,ticket=generation.current,key=selected;operation.current=true;setWorking(true);setReuseWorking(kind);props.onBusy(true);setNotice('');
    const current=()=>alive.current&&ticket===generation.current&&!document.hidden&&flow.current===client;
    setReuseReview(null);setReviewAvailable(false);
    try{
      const result=kind==='review'?await client.reviewExisting(key):kind==='activate'?await client.activateExisting(key):await client.checkExisting(key);
      if(!current())return;
      const value=await client.load();if(!current())return;setContext(value);
      setNotice((result.schema_version==='deft.app_connection_reattach_review.v1'||result.schema_version==='deft.app_connection_reattach_review.v2')?'Review this account before continuing.':result.state==='connected'?'Account connected.':result.state==='not_connected'?'The expired review is closed. You can review this account again.':'Account reuse has an uncertain outcome. Check status; this attempt will not be repeated.');
    }catch(error){if(current()){
      await client.load().then(value=>{if(current())setContext(value);}).catch(()=>undefined);
      if(current()){setReusePending(true);setNotice(error instanceof Error?error.message:'Account reuse was not confirmed. Check status before continuing.');}
    }}finally{if(current()){operation.current=false;setWorking(false);setReuseWorking(null);props.onBusy(false);}}
  }
  async function act(kind:'begin'|'status'|'disconnect'){
    if(operation.current||props.disabled||document.hidden||!flow.current||!target)return;
    const client=flow.current,ticket=generation.current;operation.current=true;setWorking(true);props.onBusy(true);setNotice('');
    const current=()=>alive.current&&ticket===generation.current&&!document.hidden&&flow.current===client;
    try{
      if(kind==='begin'){
        // Generic OAuth custody is independent of the Experience/Worker lease.
        // Its own pending pointer is never passed as an Experience UUID.
        const url=await client.begin(selected);if(!current())return;props.onConnectionNavigation(null);window.location.assign(url);return;
      }
      const result=kind==='status'?await client.check(selected):await client.disconnect(selected);if(!current())return;
      setContext(previous=>previous?{...previous,targets:previous.targets.map(t=>t.target_key===selected?{...t,session:result}:t)}:previous);
      setNotice(result.state==='connected'?'Account connected.':result.state==='disconnected'?'Account disconnected.':result.state==='indeterminate'?'Connection outcome is uncertain. Check status; this attempt will not be repeated.':result.state==='awaiting_callback'?'Account setup is awaiting its original callback. Return using the same browser tab.':'Account is not connected.');
    }catch(error){if(current()){
      // Discover the durable receipt after an uncertain response; never repeat
      // Begin, disconnect or callback as recovery.
      await client.load().then(value=>{if(current())setContext(value);}).catch(()=>undefined);
      if(current())setNotice(error instanceof Error?error.message:'Account setup was not confirmed. Check status before continuing.');
    }}
    finally{if(current()){operation.current=false;setWorking(false);setReuseWorking(null);props.onBusy(false);}}
  }
  return <div className="space-y-3">
    {notice&&<p role="status" className="text-sm text-[var(--on-surface-variant)]">{notice}</p>}
    <button type="button" className="deft-pill min-h-11" disabled={working||props.disabled} onClick={()=>setReload(n=>n+1)}>Reload account connections</button>
    {!!context?.targets.length&&<section aria-label="Account connection" className="space-y-3">
      <h4 className="text-sm font-medium">Account connection</h4>
      {context.targets.length>1&&<label className="block text-sm">Account connection<select className="mt-1 min-h-11 w-full rounded-xl bg-[var(--surface-container-high)] px-3" value={selected} disabled={working||props.disabled} onChange={event=>{setSelected(event.target.value);setNotice('');}}>
        {context.targets.map(t=><option key={t.target_key} value={t.target_key}>{t.session?.account?.label??`${t.profile.label} · ${t.target_key.replaceAll('_',' ')}`}</option>)}
      </select></label>}
      {target?.upgrade&&!target.reattachment?.candidate&&!target.reattachment?.pending&&!reusePending&&flow.current?<ExperienceCapabilityUpgradeSettings key={JSON.stringify([selected,target.scope])} target={target} client={flow.current} disabled={working||props.disabled} ownerId={props.ownerId} orgId={props.orgId} appOwnedRecords={props.appOwnedRecords}
        onBusy={busy=>{operation.current=busy;setWorking(busy);props.onBusy(busy);}} onContext={setContext} onNavigate={url=>{props.onConnectionNavigation(null);window.location.assign(url);}}
        onUse={props.onSetupComplete?()=>props.onSetupComplete?.(selected):undefined} onConnect={()=>void act('begin')} onStatus={()=>void act('status')} onDisconnect={()=>void act('disconnect')}/>:target&&<><ExperienceConnectionStatus label={target.session?.account?.label??target.reattachment?.candidate?.account.label??visibleReview?.account.label??target.profile.label} state={state} reviewAvailable={reviewAvailable} reusePending={reusePending} working={reuseWorking}/>
        {!target.runtime_ready&&<p className="text-sm">Your workspace needs to finish configuring the approved account operator before connecting.</p>}

        <div className="flex flex-wrap gap-2">
          {(!state||state==='disconnected'||state==='not_connected')&&!reusePending&&<button type="button" className="deft-pill min-h-11" disabled={working||props.disabled||!target.runtime_ready} onClick={()=>void act('begin')}>{working?'Opening setup…':'Connect account'}</button>}
          {target.session&&!reusePending&&<button type="button" className="deft-pill min-h-11" disabled={working||props.disabled||!target.runtime_ready} onClick={()=>void act('status')}>Check connection status</button>}
          {!reusePending&&state==='connected'&&props.onSetupComplete&&<button type="button" className="deft-pill min-h-11" disabled={working||props.disabled} onClick={()=>props.onSetupComplete?.(selected)}>Use account</button>}
        </div>
        {target.reattachment?.candidate&&!reusePending&&<div className="space-y-2 text-sm">
          <p className="break-words">Existing account: {target.reattachment.candidate.account.label}</p>
          <button type="button" className="deft-pill min-h-11" disabled={working||props.disabled||!target.runtime_ready} onClick={()=>void reuse('review')}>Use existing account</button>
        </div>}
        <ExperienceExistingAccountReview review={visibleReview} uncertain={reusePending&&!reviewAvailable&&!reuseWorking}
          now={clock} disabled={working||props.disabled||!target.runtime_ready} onAllow={()=>void reuse('activate')} onCheck={()=>void reuse('status')}
          onClose={()=>{setReuseReview(null);setNotice('Review remains pending. Resume it or check status before continuing.');}}/>
        {reusePending&&!reuseReview&&reviewAvailable&&<div className="flex flex-wrap gap-2">
          <button type="button" className="deft-pill min-h-11" disabled={working||props.disabled} onClick={()=>{try{setReuseReview(flow.current?.existingReview(selected)??null);}catch{setNotice('Account reuse changed. Check status before continuing.');}}}>Resume review</button>
          <button type="button" className="deft-pill min-h-11" disabled={working||props.disabled||!target.runtime_ready} onClick={()=>void reuse('status')}>Check status</button>
        </div>}
        {!reusePending&&(state==='connected'||state==='not_connected')&&<details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">Manage connection</summary><button type="button" className="deft-pill min-h-11 text-[var(--error)]" disabled={working||props.disabled} onClick={()=>void act('disconnect')}>Disconnect account</button></details>}
        {props.appOwnedRecords&&state==='connected'&&<ExperienceBackgroundRefresh target={target} ownerId={props.ownerId} orgId={props.orgId} disabled={working||props.disabled} onBusy={busy=>{setWorking(busy);props.onBusy(busy);}}/>}
      </>}
    </section>}
    <LegacyConnectionSettingsGate appOwnedRecords={props.appOwnedRecords}>{context&&<RetainedConnectionSettings {...props} excludedTargets={context.targets.map(t=>t.target_key)}/>}</LegacyConnectionSettingsGate>
  </div>;
}

function RetainedConnectionSettings(props:SettingsProps&{excludedTargets?:string[]}){
  const [targets,setTargets]=useState<string[]>([]),[selected,setSelected]=useState(props.targetKey??''),[notice,setNotice]=useState('Checking retained accounts…');
  useEffect(()=>{
    const controller=new AbortController(),anchor=api.getAccessToken();let mounted=true;
    const current=()=>mounted&&!controller.signal.aborted&&!document.hidden&&isSameWebSession(anchor,api.getAccessToken());
    if(document.hidden||!anchor)return;
    void api.fetch(`/api/app-owner-connections/${encodeURIComponent(props.installationId)}/connections`,{signal:controller.signal,cache:'no-store'}).then(async response=>{
      if(!response.ok)throw Error('Retained account setup is unavailable.');
      const value=await response.json() as {targets?:{key?:unknown}[]};
      if(!Array.isArray(value.targets)||value.targets.length>32||value.targets.some(target=>typeof target.key!=='string'||!/^[a-z][a-z0-9_]{0,47}$/.test(target.key)))throw Error('Retained account setup is unavailable.');
      const allKeys=value.targets.map(target=>target.key as string);if(new Set(allKeys).size!==allKeys.length)throw Error('Retained account setup is unavailable.');
      const keys=allKeys.filter(key=>!props.excludedTargets?.includes(key));
      if(current()){setTargets(keys);setSelected(previous=>keys.includes(props.targetKey??previous)?props.targetKey??previous:keys[0]??'');setNotice('');}
    }).catch(error=>{if(current()){setTargets([]);setNotice(error instanceof Error?error.message:'Retained account setup is unavailable.');}});
    return()=>{mounted=false;controller.abort();};
  },[props.installationId,props.targetKey]);
  return <div>{notice&&<p role="status" className="text-sm">{notice}</p>}
    {targets.length>1&&<label className="block text-sm">Account connection<select className="mt-1 min-h-11 w-full rounded-xl border border-transparent bg-[var(--surface-container-high)] px-3 focus-visible:ring-2 focus-visible:ring-[var(--primary)]" value={selected} disabled={props.disabled} onChange={event=>setSelected(event.target.value)}>
      {targets.map(target=><option key={target} value={target}>{target.replaceAll('_',' ')}</option>)}
    </select></label>}
    {selected&&targets.includes(selected)&&<AdminConnectionSettings key={selected} {...props} targetKey={selected}
      sessionId={props.sessionId&&selected===(props.targetKey??'primary')?props.sessionId:undefined}/>}
  </div>;
}

type Status = { state: 'connected' | 'reauth_required' | 'revoked' | 'not_connected'; address?: string };
function statusView(value: unknown): Status {
  if (!value || typeof value !== 'object') throw Error('Connection status is unavailable.');
  const result = value as Record<string, unknown>;
  if (!['connected', 'reauth_required', 'revoked', 'not_connected'].includes(String(result.state))) throw Error('Connection status is unavailable.');
  const account = result.account && typeof result.account === 'object' ? result.account as Record<string, unknown> : null;
  if (result.state === 'connected' && (account?.health !== 'connected' || typeof account.primary_address !== 'string'
    || account.primary_address.length > 256 || /[\r\n\0]/.test(account.primary_address))) throw Error('Connection status is unavailable.');
  return { state: result.state as Status['state'], ...(result.state === 'connected' ? { address: account!.primary_address as string } : {}) };
}
function AdminConnectionSettings({ sessionId, targetKey, installationId, experienceKey, ensureAuthority, disabled, onBusy, onConnectionNavigation, onReadingPreferencesChanged }: {
  sessionId?: string; targetKey:string; installationId: string; experienceKey: string; ensureAuthority: () => Promise<boolean>;
  disabled: boolean; onBusy: (busy: boolean) => void; onConnectionNavigation: SettingsProps['onConnectionNavigation']; onReadingPreferencesChanged?: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState('Checking account setup…');
  const [working, setWorking] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusy(false); }; }, [onBusy]);
  const base = `/api/app-experiences/sessions/${encodeURIComponent(sessionId??'')}/connections`;
  const management=`/api/app-owner-connections/${encodeURIComponent(installationId)}/connections/${encodeURIComponent(targetKey)}/manage`;
  useEffect(() => {
    let current = true;
    const anchor=api.getAccessToken();if(document.hidden||!anchor)return;
    void api.fetch(management, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',cache:'no-store' }).then(async response => {
      if (!response.ok) throw Error(response.status === 503 ? 'Account setup needs server configuration.' : 'Account setup is unavailable.');
      const value = statusView(await response.json());
      if (current&&!document.hidden&&isSameWebSession(anchor,api.getAccessToken())) { setStatus(value); setNotice(''); }
    }).catch(error => { if (current) { setStatus(null); setNotice(error instanceof Error ? error.message : 'Account setup is unavailable.'); } });
    return () => { current = false; };
  }, [management]);
  async function act(operation: 'begin' | 'disconnect') {
    if (working || disabled || document.hidden) return;
    setWorking(true); onBusy(true); setNotice('');
    let navigating = false;
    const anchor = api.getAccessToken();
    try {
      if (!anchor || operation==='begin'&&(!sessionId||!await ensureAuthority()) || document.hidden || !isSameWebSession(anchor, api.getAccessToken())) throw Error('Account setup access ended.');
      const response = await api.fetch(operation==='begin'?`${base}/begin`:management, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: operation === 'begin' ? '{}' : JSON.stringify({ operation: 'disconnect' }),
      });
      if (!response.ok) throw Error('Account setup was not confirmed. Check its status before trying again.');
      const value: unknown = await response.json();
      if (!mounted.current || document.hidden || !isSameWebSession(anchor, api.getAccessToken())) throw Error('Account setup access ended.');
      if (operation === 'begin') {
        if(!sessionId)throw Error('Review account access before connecting.');
        const started = connectionBegin(value);
        const pending: PendingAppConnection = { sessionId, installationId, experienceKey, state: started.state, expiresAt: started.expiresAt };
        sessionStorage.setItem(APP_CONNECTION_PENDING_KEY, JSON.stringify(pending));
        onConnectionNavigation(pending);
        try { window.location.assign(started.authorizationUrl); }
        catch (error) { onConnectionNavigation(null); sessionStorage.removeItem(APP_CONNECTION_PENDING_KEY); throw error; }
        navigating = true;
      } else { setStatus(statusView(value)); setNotice('Account disconnected.'); }
    } catch (error) { if (mounted.current) setNotice(error instanceof Error ? error.message : 'Account setup was not confirmed.'); }
    finally { if (mounted.current && !navigating) { setWorking(false); onBusy(false); } }
  }
  const healthLabel = status?.state === 'connected' ? 'Connected' : status?.state === 'reauth_required' ? 'Reconnect needed'
    : status?.state === 'revoked' ? 'Disconnected' : 'Not connected';
  return <section aria-label="Account connection" className="min-w-0 space-y-3 pt-5" style={{ borderColor: 'var(--border-default)' }}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h4 className="text-sm font-medium">Account connection</h4>
        {status?.address && <p className="mt-1 break-words text-sm [overflow-wrap:anywhere]" style={{ color: 'var(--text-secondary)' }}>{status.address}</p>}
      </div>
      {status && <span className="rounded-md px-2 py-1 text-xs font-medium" style={{ background: 'var(--surface-container-low)', color: status.state === 'reauth_required' ? 'var(--error)' : 'var(--text-secondary)' }}>{healthLabel}</span>}
    </div>
    {status?.state === 'reauth_required' && <p className="text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Reconnect this account to restore provider access.</p>}
    {notice && <p role="status" className="text-sm text-[var(--on-surface-variant)]">{notice}</p>}
    {status && <div className="flex flex-wrap gap-2">
      {status.state !== 'connected' && sessionId && <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={disabled || working} onClick={() => void act('begin')}>
        {working ? 'Opening setup…' : status.state === 'reauth_required' ? 'Reconnect account' : 'Connect account'}
      </button>}
    </div>}
    {(status?.state === 'connected'||status?.state==='reauth_required') && <details className="text-sm">
      <summary className="flex min-h-11 cursor-pointer items-center" style={{ color: 'var(--text-secondary)' }}>Manage connection</summary>
      <button type="button" className="deft-pill" style={{ minHeight: 44, color: 'var(--error)' }} disabled={disabled || working} onClick={() => void act('disconnect')}>{working ? 'Disconnecting…' : 'Disconnect account'}</button>
    </details>}
  </section>;
}

type OwnerReview = { kind: 'resources' | 'actions'; policy: OwnerPolicy;
  request: OwnerResourceRequest | ReturnType<typeof ownerActionRequest>; digest: string };
const sizeLabel = (bytes: number) => `${(bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`;
const mediaLabels: Record<string, string> = { 'application/pdf': 'PDF', 'image/png': 'PNG images', 'image/jpeg': 'JPEG images',
  'image/gif': 'GIF images', 'image/webp': 'WebP images', 'text/plain': 'text files', 'text/csv': 'CSV files', 'application/json': 'JSON files' };
function OwnerConnectionSettings({ ownerId, orgId, onSetupComplete, ...props }: SettingsProps & { ownerId: string; orgId: string }) {
  const { installationId, disabled, onBusy } = props;
  const [policies, setPolicies] = useState<OwnerPolicy[] | null>(null), [selected, setSelected] = useState('');
  const [review, setReview] = useState<OwnerReview | null>(null), [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const [notice, setNotice] = useState('Checking account setup…'), [reload, setReload] = useState(0);
  const generation = useRef(0), pending = useRef<AbortController | null>(null), mounted = useRef(true), busyRef = useRef(false);
  const busyOperation = useRef<AbortController | null>(null);
  const contextPath = `/api/app-owner-connections/${encodeURIComponent(installationId)}/context`;
  useEffect(() => {
    mounted.current = true;
    const clear = () => { generation.current++; pending.current?.abort(); busyOperation.current = null; busyRef.current = false;
      if (mounted.current) { setReview(null); setBusy(false); } onBusy(false); };
    const hidden = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', hidden); addEventListener('pagehide', clear);
    return () => { mounted.current = false; clear();
      document.removeEventListener('visibilitychange', hidden); removeEventListener('pagehide', clear); };
  }, [onBusy]);
  useEffect(() => {
    if (disabled || document.hidden) return;
    const controller = new AbortController(), ticket = ++generation.current, token = api.getAccessToken(); pending.current?.abort(); pending.current = controller;
    const current = () => mounted.current && ticket === generation.current && !controller.signal.aborted && !document.hidden && isSameWebSession(token, api.getAccessToken());
    void Promise.resolve().then(async () => {
      if (!current()) return;
      setReview(null); setNotice('Checking account setup…');
      const response = await api.fetch(contextPath, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw Error(await appApiError(response, 'Personal account setup is unavailable.'));
      const value = ownerConnectionContext(await response.json(), installationId);
      if (current()) { setPolicies(value); setCheckedAt(Date.now()); setSelected(previous => value.some(item => item.policy.key === previous) ? previous : value[0]?.policy.key ?? ''); setNotice(''); }
    }).catch(error => { if (current()) { setPolicies(null); setNotice(error instanceof Error ? error.message : 'Personal account setup is unavailable.'); } });
    return () => controller.abort();
  }, [contextPath, installationId, disabled, reload]);
  const policy = policies?.find(item => item.policy.key === selected);
  const binding = policy?.bindings.find(item => (!props.targetKey || item.target_key === props.targetKey)
    && item.state === 'active' && appConsentExpiryValid(item.consent_expires_at,item.consent_lifetime) && appConsentDeadline(item.consent_expires_at,item.consent_lifetime) > checkedAt);
  const missingActions = policy?.policy.action_keys.filter(key => !binding?.actions.some(action => action.action_key === key && action.state === 'active')) ?? [];
  async function requestReview(kind: OwnerReview['kind'], actionKey?: string) {
    if (!policy || busyRef.current || disabled || document.hidden) return;
    await operate(async (signal, current) => {
      const request = kind === 'resources' ? ownerResourceRequest(policy) : binding && actionKey ? ownerActionRequest(policy, binding, actionKey) : null;
      if (!request) throw Error('Review account access before enabling an action.');
      const response = await api.fetch(`/api/app-owner-connections/${kind}/review`, { method: 'POST', body: JSON.stringify(request), signal });
      if (!response.ok) throw Error(await appApiError(response, 'Account access could not be reviewed.'));
      const value = ownerConnectionReview(await response.json(), { installationId, ownerId, orgId, policy, kind, request });
      if (current()) setReview({ kind, policy, request, digest: value.digest });
    });
  }
  async function activate() {
    if (!review || busyRef.current || disabled || document.hidden) return;
    const expected = review;
    await operate(async (signal, current) => {
      const response = await api.fetch(`/api/app-owner-connections/${expected.kind}/activate`, { method: 'POST', signal,
        body: JSON.stringify({ ...expected.request, expected_review_digest: expected.digest, accept_host_policy: true }) });
      if (!response.ok) throw Error('Account access was not confirmed. Reload its status before reviewing again.');
      // Recover acknowledged access only from current host context. Never replay
      // an activation after a lost response or nominate browser-chosen owners.
      if (current()) { setReview(null); setReload(value => value + 1); setNotice('Access saved. Checking account setup…'); }
    });
  }
  async function operate(action: (signal: AbortSignal, current: () => boolean) => Promise<void>) {
    if (busyRef.current || disabled || document.hidden) return;
    const controller = new AbortController(), ticket = ++generation.current, token = api.getAccessToken(); pending.current?.abort(); pending.current = controller;
    const current = () => mounted.current && ticket === generation.current && !controller.signal.aborted && !document.hidden && isSameWebSession(token, api.getAccessToken());
    busyOperation.current = controller; busyRef.current = true; setBusy(true); onBusy(true); setNotice('');
    try { if (!token || !current()) throw Error('Account setup access ended.'); await action(controller.signal, current); }
    catch (error) { if (current()) { setReview(null); setPolicies(null); setNotice(error instanceof Error ? error.message : 'Account setup was not confirmed. Reload its status.'); } }
    finally { if (mounted.current && busyOperation.current === controller) { busyOperation.current = null; busyRef.current = false; setBusy(false); onBusy(false); } }
  }
  return <div className="min-w-0 space-y-3" aria-label="Set up your account">
    <h3 className="text-sm font-medium">Account access</h3>
    {notice && <p role="status" className="break-words text-sm text-[var(--on-surface-variant)]">{notice}</p>}
    {!policies && <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={busy || disabled} onClick={() => setReload(value => value + 1)}>Reload account setup</button>}
    {policies?.length === 0 && <p className="text-sm">This app needs an administrator to enable personal account setup.</p>}
    {!!policies && policies.length > 1 && <label className="block text-sm">Account setup<select className="mt-1 min-h-11 w-full rounded-xl border border-transparent bg-[var(--surface-container-high)] px-3 focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      value={selected} disabled={busy || disabled} onChange={event => { setSelected(event.target.value); setReview(null); }}>
      {policies.map(item => <option key={item.policy.key} value={item.policy.key}>{item.policy.key.replaceAll('_', ' ')}</option>)}
    </select></label>}
    {policy?.status === 'deployment_review_required' && <p className="text-sm">An administrator needs to approve this app’s account operator before you can connect.</p>}
    {policy?.admission && <>
      {review ? <section aria-label="Review account access" className="space-y-3 rounded-xl border p-4 text-sm leading-6" style={{ borderColor: 'var(--outline-variant)', background: 'var(--surface-container-low)' }}>
        <h4 className="text-base font-semibold">{review.kind === 'resources' ? 'Review account access' : `Review ${'action_key' in review.request ? review.request.action_key.replaceAll('_', ' ') : 'this action'}`}</h4>
        <p className="break-words">Account operator: <span className="font-medium">{policy.admission.operator_label}</span>, approved by your workspace.</p>
        {review.kind === 'resources' && 'target_key' in review.request ? <>
          <p>The approved operator can save your account records {review.request.consent_lifetime==='until_revoked'?'until revoked':`until ${new Date(review.request.consent_expires_at!).toLocaleString()}`}. These records and attachments are private to you.</p>
          <p>Up to {review.request.limits.max_retained_records.toLocaleString()} saved records and {sizeLabel(review.request.limits.max_retained_bytes)} total;
            updates at most every {(review.request.limits.min_interval_seconds / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} minutes.</p>
          <p>Attachments: {review.request.attachment_policy.allowed_media_types.map(type => mediaLabels[type]).join(', ')}; up to {sizeLabel(review.request.attachment_policy.max_attachment_bytes)} each,
            retained for up to {review.request.attachment_policy.retention_days} days. Downloaded copies remain outside Deft’s controls.</p>
          <p>Connecting your account does not authorize actions. You review each available action separately.</p>
          <details className="border-t" style={{ borderColor: 'var(--border-default)' }}><summary className="min-h-11 cursor-pointer py-3">Source and storage details</summary><div className="space-y-2 pb-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>
            <p>Source: {policy.policy.resource_key.replaceAll('_', ' ')}. Each update can save up to {review.request.limits.max_records_per_page} records and {sizeLabel(review.request.limits.max_page_bytes)}.</p>
            <p>Up to {review.request.attachment_policy.max_attachments_per_record} attachments per record; {review.request.attachment_policy.max_attachments_per_run} per update,
              using at most {sizeLabel(review.request.attachment_policy.max_attachment_bytes_per_run)} per update.</p>
            <p>Saved attachments are encrypted. Only you can download them while your account access remains active. Expired or removed copies cannot be recovered from Deft.</p>
          </div></details>
        </> : <p>The approved operator may perform this action for your account. Each action still requires your confirmation; agent requests require a separate permission and your approval. An uncertain result is not retried automatically.</p>}
        <div className="flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: 'var(--border-default)' }}><button type="button" className="deft-pill" style={{ minHeight: 44, background: 'var(--primary-container)', color: 'var(--on-primary-container)' }} disabled={busy || disabled} onClick={() => void activate()}>{busy ? 'Saving access…' : 'Allow access'}</button>
          <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={busy} onClick={() => setReview(null)}>Cancel</button></div>
      </section> : <div className="space-y-3">
        {binding && <p className="text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>Account records are allowed {binding.consent_lifetime==='until_revoked'?'until revoked':`until ${new Date(binding.consent_expires_at!).toLocaleString()}`}. Action permissions are reviewed separately.</p>}
        <div className="flex flex-wrap gap-2">
        {!binding && <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={busy || disabled} onClick={() => void requestReview('resources')}>Review account access</button>}
        {binding && missingActions.map(action => <button type="button" key={action} className="deft-pill" style={{ minHeight: 44 }} disabled={busy || disabled}
          onClick={() => void requestReview('actions', action)}>Review {action.replaceAll('_', ' ')}</button>)}
        {binding && !props.sessionId && <>
          <button type="button" className="deft-pill" style={{ minHeight: 44 }} disabled={busy || disabled || !onSetupComplete}
            onClick={() => onSetupComplete?.(binding.target_key)}>Continue to connect account</button>
          {!onSetupComplete && <p className="w-full text-sm" style={{ color: 'var(--text-secondary)' }}>Return to the app and review private access before connecting this account.</p>}
        </>}
        </div>
      </div>}
    </>}
  </div>;
}