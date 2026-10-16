'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { appApiError, type AppInstallation } from '@/lib/apps';
import { useAuth } from '@/lib/auth-context';
import { APP_ATTACHMENT_BROKER_ENABLED } from '@/lib/feature-flags';

type Limits = { max_records_per_page: number; max_page_bytes: number; max_retained_records: number; max_retained_bytes: number; min_interval_seconds: number };
type ConsentRequest = {
  installation_id: string; resource_key: string; operator_user_id: string;
  expected_app_version_id: string; expected_package_digest: string;
  expected_grant_snapshot_digest: string; expected_lifecycle_epoch: number;
  expected_grant_epoch: number; consent_expires_at: string; limits: Limits;
  schema_version?: 'deft.app_attachment_consent_request.v1'; attachment_policy?: AttachmentPolicy;
};
type AttachmentPolicy = {max_attachment_bytes:number;max_attachments_per_record:number;max_attachments_per_run:number;
  max_attachment_bytes_per_run:number;retention_days:number;allowed_media_types:string[]};
type Descriptor = {
  resource_key: string; resource_type: string; visibility: 'user_private'; descriptor_digest: string;
  consent_request: ConsentRequest;
  attachment_policy?: AttachmentPolicy;
  existing_binding: null | { binding_id: string; operator_user_id: string; state: 'active' | 'disabled'; consent_expires_at: string | null; requires_revoke: boolean; can_issue_session: boolean };
};
type Setup = {
  schema_version?:'deft.app_attachment_setup.v1';
  installation_id: string; descriptors: Descriptor[];
  host_limits: { max_consent_ms: number; session_ms: number; limits: Record<keyof Limits, { min: number; max: number }> };
};
type Review = { review_digest: string; consent_expires_at: string; limits: Limits; attachment_policy?:AttachmentPolicy };
type Operator = { user_id: string; name: string };
const legacyManagement = '/api/app-resource-sync-management';
const attachmentLabels:Record<Exclude<keyof AttachmentPolicy,'allowed_media_types'>,string>={
  max_attachment_bytes:'Maximum bytes per attachment',max_attachments_per_record:'Attachments per record',max_attachments_per_run:'Attachments per sync',
  max_attachment_bytes_per_run:'Attachment bytes per sync',retention_days:'Attachment retention days'};
const labels: Record<keyof Limits, string> = {
  max_records_per_page: 'Records per sync page', max_page_bytes: 'Bytes per sync page',
  max_retained_records: 'Maximum saved records', max_retained_bytes: 'Maximum saved bytes',
  min_interval_seconds: 'Minimum seconds between syncs',
};
async function response<T>(value: Response): Promise<T> {
  if (!value.ok) throw new Error(await appApiError(value, 'Unable to set up this connection.'));
  return value.json() as Promise<T>;
}

export function PrivateResourceSetup({ apps, onChanged }: { apps: AppInstallation[]; onChanged: () => void }) {
  const { user } = useAuth();
  const [operatorId, setOperatorId] = useState(user?.id ?? '');
  const [operators, setOperators] = useState<Operator[]>([]);
  const [operatorAfter, setOperatorAfter] = useState<string | null>(null);
  const [operatorsBusy, setOperatorsBusy] = useState(false);
  const operatorGeneration = useRef(0);
  const [installation, setInstallation] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [resource, setResource] = useState('');
  const [draft, setDraft] = useState<ConsentRequest | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [maxConsent, setMaxConsent] = useState('');
  const [allowAttachments,setAllowAttachments]=useState(false);
  const generation = useRef(0);
  const eligible = apps.filter(app => app.state === 'active' && (app.manifest.schema_version === '5'
    ||APP_ATTACHMENT_BROKER_ENABLED&&app.manifest.schema_version==='7') && app.manifest.sync_descriptors.length > 0);
  const attachment=eligible.find(app=>app.id===installation)?.manifest.schema_version==='7';
  const management=attachment?'/api/apps/blob/sync':legacyManagement;
  const descriptor = setup?.descriptors.find(item => item.resource_key === resource);
  const operatorName = operators.find(item => item.user_id === operatorId)?.name ?? (operatorId === user?.id ? user.name : 'Selected operator');
  const loadOperators = useCallback(async (after?: string) => {
    const request = ++operatorGeneration.current;
    setOperatorsBusy(true);
    try {
      const body = await response<{ operators: Operator[]; next_after: string | null }>(await api.get(`${management}/operators?limit=20${after ? `&after=${encodeURIComponent(after)}` : ''}`));
      if (request !== operatorGeneration.current || document.hidden) return;
      setOperators(previous => after ? [...previous, ...body.operators.filter(item => !previous.some(old => old.user_id === item.user_id))] : body.operators);
      setOperatorAfter(body.next_after);
    } catch (reason) { if (request === operatorGeneration.current) setError(reason instanceof Error ? reason.message : 'Unable to load operators.'); }
    finally { if (request === operatorGeneration.current) setOperatorsBusy(false); }
  }, [management]);
  useEffect(() => { void loadOperators(); return () => { operatorGeneration.current += 1; }; }, [loadOperators]);

  useEffect(() => {
    const hide = () => {
      if (!document.hidden) return;
      generation.current += 1; setSetup(null); setDraft(null); setReview(null); setInstallation(''); setResource(''); setBusy(false);
    };
    document.addEventListener('visibilitychange', hide);
    return () => { generation.current += 1; document.removeEventListener('visibilitychange', hide); };
  }, []);
  useEffect(() => {
    if (!review) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = new Date(review.consent_expires_at).getTime() - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        generation.current += 1; setBusy(false); setReview(null);
        setError('Consent has expired. Choose a later end time and review again.'); return;
      }
      timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    timer = setTimeout(check, 0);
    return () => clearTimeout(timer);
  }, [review]);

  const discover = async (id: string, message?: string, nominated = operatorId) => {
    const request = ++generation.current;
    setInstallation(id); setSetup(null); setDraft(null); setReview(null); setResource('');setAllowAttachments(false);setError(null); setNotice(message ?? null);
    if (!id) { setBusy(false); return; }
    setBusy(true);
    try {
      const selectedBase=eligible.find(app=>app.id===id)?.manifest.schema_version==='7'?'/api/apps/blob/sync':legacyManagement;
      const body = await response<{ setup: Setup }>(await api.get(`${selectedBase}/setup?installation_id=${encodeURIComponent(id)}&operator_user_id=${encodeURIComponent(nominated)}`));
      if(selectedBase==='/api/apps/blob/sync'&&(body.setup.schema_version!=='deft.app_attachment_setup.v1'
        ||body.setup.installation_id!==id||!Array.isArray(body.setup.descriptors)||body.setup.descriptors.length>8
        ||body.setup.descriptors.some(d=>!d.attachment_policy||d.visibility!=='user_private'
          ||d.consent_request.schema_version!=='deft.app_attachment_consent_request.v1'
          ||d.consent_request.installation_id!==id||d.consent_request.operator_user_id!==nominated
          ||!Array.isArray(d.attachment_policy.allowed_media_types)||!d.attachment_policy.allowed_media_types.length)))throw new Error('Attachment setup changed. Refresh the selected App.');
      if (request !== generation.current || document.hidden) return;
      setSetup(body.setup);
      setMaxConsent(new Date(Date.now() + body.setup.host_limits.max_consent_ms).toISOString());
      const first = body.setup.descriptors[0];
      if (first) {setResource(first.resource_key);setDraft(first.attachment_policy?{...first.consent_request,attachment_policy:{...first.attachment_policy,allowed_media_types:[]}}:first.consent_request);}
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to load setup.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const prepare = async () => {
    if (!draft||attachment&&(!allowAttachments||!draft.attachment_policy?.allowed_media_types.length)) return;
    const request = ++generation.current;
    setBusy(true); setError(null); setNotice(null); setReview(null);
    try {
      const body = await response<{ review: Review }>(await api.post(`${management}/reviews/prepare`, draft));
      if(attachment&&(!body.review.attachment_policy||JSON.stringify(body.review.attachment_policy)!==JSON.stringify(draft.attachment_policy)
        ||body.review.consent_expires_at!==draft.consent_expires_at||!/^sha256:[a-f0-9]{64}$/.test(body.review.review_digest)))throw new Error('The attachment review changed. Review again before connecting.');
      if (request === generation.current && !document.hidden) {
        if (!Number.isFinite(new Date(body.review.consent_expires_at).getTime()) || new Date(body.review.consent_expires_at).getTime() <= Date.now()) setError('Consent has expired. Choose a later end time and review again.');
        else setReview(body.review);
      }
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to prepare consent.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const activate = async () => {
    if (!draft || !review) return;
    const request = ++generation.current;
    setBusy(true); setError(null);
    try {
      await response(await api.post(`${management}/bindings/activate`, { ...draft, expected_review_digest: review.review_digest, accept_host_policy: true }));
      if (request !== generation.current || document.hidden) return;
      onChanged();
      await discover(installation, 'Connection activated. The assigned operator can find it in their private resource assignments.');
    } catch (reason) {
      if (request !== generation.current) return;
      // Activation can commit before its response is lost. Discover the current
      // binding before offering another explicit review; never retry the write.
      onChanged();
      await discover(installation, `${reason instanceof Error ? reason.message : 'Activation was not confirmed.'} Current connection status is shown below.`);
    } finally { if (request === generation.current) setBusy(false); }
  };
  const revoke = async () => {
    if (!descriptor?.existing_binding) return;
    const request = ++generation.current;
    setBusy(true); setError(null);
    try {
      await response(await api.post(`${management}/bindings/${encodeURIComponent(descriptor.existing_binding.binding_id)}/revoke`,attachment?{}:undefined));
      if (request !== generation.current || document.hidden) return;
      onChanged(); await discover(installation, 'Previous connection revoked. Review fresh consent below.');
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to revoke connection.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const fieldClass = 'min-h-11 w-full min-w-0 rounded-lg border bg-transparent px-3 py-2 text-sm';
  return <section aria-label="Connect a private resource" className="min-w-0 space-y-4 rounded-xl border p-4" style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}>
    <div><h2 className="font-semibold">Connect a private resource</h2><p className="mt-1 text-sm" style={{ color: 'var(--on-surface-variant)' }}>Choose an active App and a human to run its provider. Saved records stay private to you.</p></div>
    <label className="block space-y-1 text-sm"><span>Assigned operator</span><select aria-label="Assigned operator" className={fieldClass} value={operatorId} disabled={busy || !!review || operatorsBusy} onChange={event => { const id = event.target.value; setOperatorId(id); if (installation) void discover(installation, undefined, id); }}>
      {user && !operators.some(item => item.user_id === user.id) && <option value={user.id}>{user.name} (you)</option>}
      {operators.map(item => <option key={item.user_id} value={item.user_id}>{item.name}{item.user_id === user?.id ? ' (you)' : ''}</option>)}
    </select></label>
    {operatorAfter && <button className="deft-pill min-h-11" disabled={operatorsBusy || busy || !!review} onClick={() => void loadOperators(operatorAfter)}>Load more operators</button>}
    <label className="block space-y-1 text-sm"><span>Active App</span><select aria-label="Active App" className={fieldClass} value={installation} disabled={busy} onChange={event => void discover(event.target.value)}><option value="">Choose an App</option>{eligible.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}</select></label>
    {eligible.length === 0 && <p className="text-sm">An App with reviewed private resources must be active before you can connect it.</p>}
    {busy && <p role="status" className="text-sm">Loading connection…</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {error && <p role="alert" className="break-words text-sm" style={{ color: 'var(--error)' }}>{error}</p>}
    {setup && setup.descriptors.length === 0 && <p className="text-sm">This App has no private resources to connect.</p>}
    {setup && descriptor && draft && <>
      <label className="block space-y-1 text-sm"><span>Resource</span><select aria-label="Resource" className={fieldClass} value={resource} disabled={busy || !!review} onChange={event => { const next = setup.descriptors.find(item => item.resource_key === event.target.value); setResource(event.target.value);setDraft(next?.attachment_policy?{...next.consent_request,attachment_policy:{...next.attachment_policy,allowed_media_types:[]}}:next?.consent_request??null);setAllowAttachments(false);setReview(null); setError(null); }}>{setup.descriptors.map(item => <option key={item.resource_key} value={item.resource_key}>{item.resource_key} · {item.resource_type}</option>)}</select></label>
      {descriptor.existing_binding ? <div className="space-y-3 text-sm">
        <p>{descriptor.existing_binding.requires_revoke ? 'This connection has expired or is disabled. Revoke it before reviewing new consent.' : 'You already have a connection for this resource.'}</p>
        {attachment&&<Link className="deft-pill" style={{minHeight:44}} href={`/app-attachments/${encodeURIComponent(descriptor.existing_binding.binding_id)}`}>Open saved resources and attachments</Link>}
        {descriptor.existing_binding.requires_revoke || descriptor.existing_binding.operator_user_id !== operatorId ? <><p>Revoke this connection before reviewing a replacement operator. Revoking stops future syncs and reads; previously delivered copies cannot be recalled.</p><button className="deft-pill min-h-11" disabled={busy} onClick={() => void revoke()}>Revoke previous connection</button></> : descriptor.existing_binding.can_issue_session ? <Link className="deft-pill min-h-11" href={attachment?`/settings/apps/private-resources/attachment-operator/${encodeURIComponent(descriptor.existing_binding.binding_id)}`:`/settings/apps/private-resources/operator/${encodeURIComponent(descriptor.existing_binding.binding_id)}`}>Open operator setup</Link> : <p>The assigned operator must issue their own credential.</p>}
      </div> : <>
        <fieldset disabled={busy || !!review} className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm"><span>Consent ends</span><input aria-label="Consent ends" type="datetime-local" className={fieldClass} value={localDateTime(draft.consent_expires_at)} max={localDateTime(maxConsent)} onChange={event => { const date = new Date(event.target.value); if (Number.isFinite(date.getTime())) setDraft({ ...draft, consent_expires_at: date.toISOString() }); }} /></label>
          {(Object.keys(labels) as Array<keyof Limits>).map(key => <label key={key} className="space-y-1 text-sm"><span>{labels[key]}</span><input type="number" className={fieldClass} min={setup.host_limits.limits[key].min} max={setup.host_limits.limits[key].max} step={1} value={draft.limits[key]} onChange={event => setDraft({ ...draft, limits: { ...draft.limits, [key]: Number(event.target.value) } })} /></label>)}
        </fieldset>
        {attachment&&descriptor.attachment_policy&&draft.attachment_policy&&<fieldset disabled={busy||!!review} className="space-y-3 rounded border p-3">
          <legend className="px-1 text-sm font-semibold">Separate attachment consent</legend>
          <label className="flex items-center gap-3 text-sm" style={{minHeight:44}}><input type="checkbox" checked={allowAttachments} onChange={e=>setAllowAttachments(e.target.checked)}/>Allow encrypted attachments under the limits I select below</label>
          <p className="text-sm">Downloads remain owner-only. Ending access cannot recall copies already downloaded.</p>
          {descriptor.attachment_policy.allowed_media_types.map(type=><label key={type} className="flex items-center gap-3 text-sm" style={{minHeight:44}}><input type="checkbox" checked={draft.attachment_policy!.allowed_media_types.includes(type)}
            onChange={e=>{const policy=draft.attachment_policy!;setDraft({...draft,attachment_policy:{...policy,allowed_media_types:e.target.checked?[...policy.allowed_media_types,type].sort():policy.allowed_media_types.filter(value=>value!==type)}});}}/>{type}</label>)}
          <div className="grid gap-3 sm:grid-cols-2">{(Object.keys(attachmentLabels) as Exclude<keyof AttachmentPolicy,'allowed_media_types'>[]).map(key=><label key={key} className="space-y-1 text-sm"><span>{attachmentLabels[key]}</span>
            <input type="number" className={fieldClass} style={{minHeight:44}} min={1} max={descriptor.attachment_policy![key]} step={1} value={draft.attachment_policy![key]}
              onChange={e=>setDraft({...draft,attachment_policy:{...draft.attachment_policy!,[key]:Number(e.target.value)}})}/></label>)}</div>
        </fieldset>}
        {review ? <div aria-label="Consent review" className="space-y-3 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--ghost-border)' }}>
          <p>Allow this App’s provider to save <strong>{descriptor.resource_key}</strong> privately for you until <strong>{new Date(review.consent_expires_at).toLocaleString()}</strong>?</p>
          <p>You own the saved records. <strong>{operatorName}</strong> will run the provider and can issue its temporary sync credential. This assignment does not let them read your saved records.</p>
          <p>The provider may save up to {review.limits.max_retained_records.toLocaleString()} records ({review.limits.max_retained_bytes.toLocaleString()} bytes), with at least {review.limits.min_interval_seconds} seconds between syncs. Each page allows {review.limits.max_records_per_page} records and {review.limits.max_page_bytes.toLocaleString()} bytes.</p>
          {review.attachment_policy&&<p>Selected attachment types: {review.attachment_policy.allowed_media_types.join(', ')}. At most {review.attachment_policy.max_attachment_bytes.toLocaleString()} bytes each, {review.attachment_policy.max_attachments_per_record} per record, {review.attachment_policy.max_attachments_per_run} per sync, {review.attachment_policy.max_attachment_bytes_per_run.toLocaleString()} bytes per sync; retained at most {review.attachment_policy.retention_days} days. Only you may download their bytes.</p>}
          <p>This grants reviewed private sync only. A separate operator credential lasts up to {Math.floor(setup.host_limits.session_ms / 60_000)} minutes and cannot outlast consent. You can revoke the connection at any time.</p>
          <div className="flex flex-wrap gap-2"><button className="deft-pill min-h-11" disabled={busy} onClick={() => void activate()}>Accept and connect</button><button className="deft-pill min-h-11" disabled={busy} onClick={() => setReview(null)}>Cancel review</button></div>
        </div> : <button className="deft-pill min-h-11" style={{minHeight:44}} disabled={busy||attachment&&(!allowAttachments||!draft.attachment_policy?.allowed_media_types.length)} onClick={() => void prepare()}>Review consent</button>}
      </>}
    </>}
  </section>;
}

function localDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
