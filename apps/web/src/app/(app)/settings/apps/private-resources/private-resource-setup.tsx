'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { appApiError, type AppInstallation } from '@/lib/apps';

type Limits = { max_records_per_page: number; max_page_bytes: number; max_retained_records: number; max_retained_bytes: number; min_interval_seconds: number };
type ConsentRequest = {
  installation_id: string; resource_key: string; operator_user_id: string;
  expected_app_version_id: string; expected_package_digest: string;
  expected_grant_snapshot_digest: string; expected_lifecycle_epoch: number;
  expected_grant_epoch: number; consent_expires_at: string; limits: Limits;
};
type Descriptor = {
  resource_key: string; resource_type: string; visibility: 'user_private'; descriptor_digest: string;
  consent_request: ConsentRequest;
  existing_binding: null | { binding_id: string; state: 'active' | 'disabled'; consent_expires_at: string | null; requires_revoke: boolean; can_issue_session: boolean };
};
type Setup = {
  installation_id: string; descriptors: Descriptor[];
  host_limits: { max_consent_ms: number; session_ms: number; limits: Record<keyof Limits, { min: number; max: number }> };
};
type Review = { review_digest: string; consent_expires_at: string; limits: Limits };
const management = '/api/app-resource-sync-management';
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
  const [installation, setInstallation] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [resource, setResource] = useState('');
  const [draft, setDraft] = useState<ConsentRequest | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [maxConsent, setMaxConsent] = useState('');
  const generation = useRef(0);
  const eligible = apps.filter(app => app.state === 'active' && app.manifest.schema_version === '5' && app.manifest.sync_descriptors.length > 0);
  const descriptor = setup?.descriptors.find(item => item.resource_key === resource);

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

  const discover = async (id: string, message?: string) => {
    const request = ++generation.current;
    setInstallation(id); setSetup(null); setDraft(null); setReview(null); setResource(''); setError(null); setNotice(message ?? null);
    if (!id) { setBusy(false); return; }
    setBusy(true);
    try {
      const body = await response<{ setup: Setup }>(await api.get(`${management}/setup?installation_id=${encodeURIComponent(id)}`));
      if (request !== generation.current || document.hidden) return;
      setSetup(body.setup);
      setMaxConsent(new Date(Date.now() + body.setup.host_limits.max_consent_ms).toISOString());
      const first = body.setup.descriptors[0];
      if (first) { setResource(first.resource_key); setDraft(first.consent_request); }
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to load setup.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const prepare = async () => {
    if (!draft) return;
    const request = ++generation.current;
    setBusy(true); setError(null); setNotice(null); setReview(null);
    try {
      const body = await response<{ review: Review }>(await api.post(`${management}/reviews/prepare`, draft));
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
      await discover(installation, 'Connection activated. Open operator setup to run its provider.');
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
      await response(await api.post(`${management}/bindings/${encodeURIComponent(descriptor.existing_binding.binding_id)}/revoke`));
      if (request !== generation.current || document.hidden) return;
      onChanged(); await discover(installation, 'Previous connection revoked. Review fresh consent below.');
    } catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to revoke connection.'); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const fieldClass = 'min-h-11 w-full min-w-0 rounded-lg border bg-transparent px-3 py-2 text-sm';
  return <section aria-label="Connect a private resource" className="min-w-0 space-y-4 rounded-xl border p-4" style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}>
    <div><h2 className="font-semibold">Connect a private resource</h2><p className="mt-1 text-sm" style={{ color: 'var(--on-surface-variant)' }}>Choose an active App. You own this connection and run its provider using your own short-lived credential.</p></div>
    <label className="block space-y-1 text-sm"><span>Active App</span><select aria-label="Active App" className={fieldClass} value={installation} disabled={busy} onChange={event => void discover(event.target.value)}><option value="">Choose an App</option>{eligible.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}</select></label>
    {eligible.length === 0 && <p className="text-sm">An App with reviewed private resources must be active before you can connect it.</p>}
    {busy && <p role="status" className="text-sm">Loading connection…</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {error && <p role="alert" className="break-words text-sm" style={{ color: 'var(--error)' }}>{error}</p>}
    {setup && setup.descriptors.length === 0 && <p className="text-sm">This App has no private resources to connect.</p>}
    {setup && descriptor && draft && <>
      <label className="block space-y-1 text-sm"><span>Resource</span><select aria-label="Resource" className={fieldClass} value={resource} disabled={busy || !!review} onChange={event => { const next = setup.descriptors.find(item => item.resource_key === event.target.value); setResource(event.target.value); setDraft(next?.consent_request ?? null); setReview(null); setError(null); }}>{setup.descriptors.map(item => <option key={item.resource_key} value={item.resource_key}>{item.resource_key} · {item.resource_type}</option>)}</select></label>
      {descriptor.existing_binding ? <div className="space-y-3 text-sm">
        <p>{descriptor.existing_binding.requires_revoke ? 'This connection has expired or is disabled. Revoke it before reviewing new consent.' : 'You already have a connection for this resource.'}</p>
        {descriptor.existing_binding.requires_revoke ? <><p>Revoking stops future syncs and reads. Previously delivered copies cannot be recalled.</p><button className="deft-pill min-h-11" disabled={busy} onClick={() => void revoke()}>Revoke previous connection</button></> : descriptor.existing_binding.can_issue_session ? <Link className="deft-pill min-h-11" href={`/settings/apps/private-resources/operator/${encodeURIComponent(descriptor.existing_binding.binding_id)}`}>Open operator setup</Link> : <p>The assigned operator must issue their own credential.</p>}
      </div> : <>
        <fieldset disabled={busy || !!review} className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm"><span>Consent ends</span><input aria-label="Consent ends" type="datetime-local" className={fieldClass} value={localDateTime(draft.consent_expires_at)} max={localDateTime(maxConsent)} onChange={event => { const date = new Date(event.target.value); if (Number.isFinite(date.getTime())) setDraft({ ...draft, consent_expires_at: date.toISOString() }); }} /></label>
          {(Object.keys(labels) as Array<keyof Limits>).map(key => <label key={key} className="space-y-1 text-sm"><span>{labels[key]}</span><input type="number" className={fieldClass} min={setup.host_limits.limits[key].min} max={setup.host_limits.limits[key].max} step={1} value={draft.limits[key]} onChange={event => setDraft({ ...draft, limits: { ...draft.limits, [key]: Number(event.target.value) } })} /></label>)}
        </fieldset>
        {review ? <div aria-label="Consent review" className="space-y-3 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--ghost-border)' }}>
          <p>Allow this App’s provider to save <strong>{descriptor.resource_key}</strong> privately for you until <strong>{new Date(review.consent_expires_at).toLocaleString()}</strong>?</p>
          <p>You are the owner and operator. The provider may save up to {review.limits.max_retained_records.toLocaleString()} records ({review.limits.max_retained_bytes.toLocaleString()} bytes), with at least {review.limits.min_interval_seconds} seconds between syncs. Each page allows {review.limits.max_records_per_page} records and {review.limits.max_page_bytes.toLocaleString()} bytes.</p>
          <p>This grants reviewed private sync only. A separate operator credential lasts up to {Math.floor(setup.host_limits.session_ms / 60_000)} minutes and cannot outlast consent. You can revoke the connection at any time.</p>
          <div className="flex flex-wrap gap-2"><button className="deft-pill min-h-11" disabled={busy} onClick={() => void activate()}>Accept and connect</button><button className="deft-pill min-h-11" disabled={busy} onClick={() => setReview(null)}>Cancel review</button></div>
        </div> : <button className="deft-pill min-h-11" disabled={busy} onClick={() => void prepare()}>Review consent</button>}
      </>}
    </>}
  </section>;
}

function localDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
