'use client';
import { useEffect, useRef, useState } from 'react';
import { api, isSameWebSession } from '@/lib/api';
import { appConnectionSessionTag, type AppConnectionTarget } from '@/lib/app-connection-session-flow';
import { ownerConnectionContext, ownerConnectionReview, ownerResourceRequest, type OwnerPolicy, type OwnerResourceRequest } from '@/lib/app-owner-connection';
import { finishAcknowledgedInitialConnection, initialConnectChoice, initialConnectPlan, initialConnectPlanKey } from '@/lib/app-initial-connect-consent';

type Identity = { installationId: string; ownerId: string; orgId: string; sessionScope: string };
type Props = Identity & { targetKey?: string; disabled: boolean; onBusy: (busy: boolean) => void; onConfigured: () => void; onRecords: (enabled: boolean) => void };
type Review = { policy: OwnerPolicy; request: OwnerResourceRequest; digest: string; appVersion: string; grant: string };
const localDate = (value: number) => { const date = new Date(value), pad = (v: number) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };

/** A single initial decision covers the declared ordinary read/storage/sync purposes.
 * Existing account permissions retain their separate explicit renewal journey. */
export function ExperienceInitialConnectConsent(props: Props) {
  const [policies, setPolicies] = useState<OwnerPolicy[]>([]), [selected, setSelected] = useState('');
  const [finite, setFinite] = useState(false), [until, setUntil] = useState(() => localDate(Date.now() + 86400000));
  const [review, setReview] = useState<Review | null>(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null), working = useRef(false), notify = useRef(props.onBusy); notify.current = props.onBusy;
  useEffect(() => {
    const controller = new AbortController(), anchor = api.getAccessToken(); active.current = controller;
    setPolicies([]); setReview(null); setNotice(''); setBusy(false); working.current = false;
    void api.fetch(`/api/app-owner-connections/${props.installationId}/context`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) return; const value = ownerConnectionContext(await response.json(), props.installationId);
        if (!controller.signal.aborted && isSameWebSession(anchor, api.getAccessToken())) { setPolicies(value); setSelected(value[0]?.policy.key ?? ''); props.onRecords(value.some(policy => !!policy.record_store_keys?.length)); if (value.some(policy => !!policy.record_store_keys?.length) && !value.some(policy => policy.record_store_keys?.length && policy.admission)) setNotice('Your workspace needs to approve an account operator before you can connect.'); } })
      .catch(() => { /* Existing settings still expose supported recovery and reload. */ });
    return () => { controller.abort(); notify.current(false); };
  }, [props.installationId, props.ownerId, props.orgId, props.sessionScope]);
  const available = policies.filter(policy => !!policy.record_store_keys?.length && policy.admission && !policy.bindings.some(binding => binding.target_key === (props.targetKey ?? policy.admission!.resource_request.target_key)));
  const policy = available.find(row => row.policy.key === selected) ?? available[0];
  const persistent = policy?.policy.allow_until_revoked === true && !finite;
  async function act(accept: boolean) {
    if (!policy || working.current || props.disabled || document.hidden || active.current?.signal.aborted) return;
    const controller = active.current!, anchor = api.getAccessToken();
    const current = () => !controller.signal.aborted && !document.hidden && isSameWebSession(anchor, api.getAccessToken());
    working.current = true; setBusy(true); notify.current(true); setNotice('');
    try {
      if (!anchor || !current()) throw Error('Account setup session ended.');
      const request = review?.request ?? (() => { const choice = initialConnectChoice(policy.policy.allow_until_revoked === true, persistent ? new Date(Date.now() + 86400000).toISOString() : new Date(until).toISOString(), finite);
        const base = ownerResourceRequest(policy, Date.now(), props.targetKey);
        return { ...base, consent_expires_at: choice.expires_at, consent_lifetime: 'consent_lifetime' in choice ? choice.consent_lifetime : undefined }; })();
      if (accept) {
        // Storage must be usable before committing the initial permission.
        const probe = initialConnectPlanKey(props.orgId, props.ownerId, props.installationId, request.target_key) + ':probe';
        sessionStorage.setItem(probe, ''); sessionStorage.removeItem(probe);
      }
      const response = await api.fetch(`/api/app-owner-connections/resources/${accept ? 'activate' : 'review'}`, { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(accept ? { ...request, expected_review_digest: review!.digest, accept_host_policy: true } : request) });
      if (!response.ok) throw Error('Account access was not confirmed. Reload account setup before trying again.');
      const raw = await response.json(); if (!current()) return;
      if (!accept) {
        const checked = ownerConnectionReview(raw, { installationId: props.installationId, ownerId: props.ownerId, orgId: props.orgId, policy, kind: 'resources', request });
        setReview({ policy, request, digest: checked.digest, appVersion: raw.review.app_version_id, grant: raw.review.grant_snapshot_id });
      } else {
        const accepted = review!, binding = raw.binding;
        if (!binding || binding.app_version_id !== accepted.appVersion || binding.grant_snapshot_id !== accepted.grant || binding.resource_key !== accepted.policy.policy.resource_key)
          throw Error('Account permission acknowledgement changed. Check account setup.');
        const plan = initialConnectPlan({ schema_version: 'deft.initial_connect_consent.v1', org_id: props.orgId, owner_user_id: props.ownerId,
          installation_id: props.installationId, session_tag: await appConnectionSessionTag(props.sessionScope), target_key: request.target_key,
          resource_binding_id: binding.binding_id, app_version_id: accepted.appVersion, grant_snapshot_id: accepted.grant,
          resource_key: binding.resource_key, choice: { expires_at: request.consent_expires_at, ...(request.consent_lifetime ? { consent_lifetime: request.consent_lifetime } : {}) },
          completed_stores: [], pending_store: null, observation: null, phase: 'permissions' });
        if (!current()) return;
        sessionStorage.setItem(initialConnectPlanKey(props.orgId, props.ownerId, props.installationId, request.target_key), JSON.stringify(plan));
        setReview(null); setPolicies(previous => previous.filter(row => row.policy.key !== accepted.policy.policy.key));
        props.onConfigured(); setNotice('Account permission saved. Connect the account to finish private storage and background refresh automatically.');
      }
    } catch (error) { if (current()) { setNotice(error instanceof Error ? error.message : 'Account setup unavailable.'); if (accept) setPolicies([]); } }
    finally { working.current = false; if (current()) { setBusy(false); notify.current(false); } }
  }
  if (!policy && !notice) return null;
  return <section aria-label="Initial account permission" className="space-y-3 rounded-xl bg-[var(--surface-container-low)] p-4 text-sm">
    <h3 className="font-medium">Connect and keep synchronized</h3>
    {notice && <p role="status">{notice}</p>}
    {policy && <>
      {available.length > 1 && !review && <label className="block">Account provider<select className="mt-1 min-h-11 w-full rounded-xl bg-[var(--surface-container-high)] px-3" value={policy.policy.key} disabled={busy || props.disabled} onChange={event => setSelected(event.target.value)}>{available.map(row => <option key={row.policy.key} value={row.policy.key}>{row.policy.key.replaceAll('_', ' ')}</option>)}</select></label>}
      <p>Allow ordinary account reads, the app&apos;s declared private records and drafts, and background metadata refresh with one permission lifetime. Private files use each declared store&apos;s size limits.</p>
      <p>Sending, organizing provider records, provider draft mirroring, and assistant access require their own permissions.</p>
      {!review ? <>
        <label className="block">Permission lifetime<select className="mt-1 min-h-11 w-full rounded-xl bg-[var(--surface-container-high)] px-3" value={persistent ? 'until_revoked' : 'date'} disabled={busy || props.disabled} onChange={event => setFinite(event.target.value === 'date')}>
          {policy.policy.allow_until_revoked && <option value="until_revoked">Until revoked</option>}<option value="date">Until date</option>
        </select></label>
        {!persistent && <label className="block">End date<input type="datetime-local" className="mt-1 min-h-11 rounded-xl border bg-transparent px-3" value={until} max={localDate(Date.now() + policy.policy.max_consent_seconds * 1000)} disabled={busy || props.disabled} onChange={event => setUntil(event.target.value)} /></label>}
        {!persistent && <p>Automatic renewable background access is available with Until revoked. A date-limited permission keeps its selected end date.</p>}
        <button className="deft-pill min-h-11" type="button" disabled={busy || props.disabled} onClick={() => void act(false)}>Review account permission</button>
      </> : <div aria-label="Review initial account permission" className="space-y-3">
        <p>Allow {review.policy.admission!.operator_label} to read and synchronize this account, and keep its declared private records and draft files {review.request.consent_lifetime === 'until_revoked' ? 'until revoked' : `until ${new Date(review.request.consent_expires_at!).toLocaleString()}`}.</p>
        <p>Private record stores: {review.policy.record_store_keys!.map(key => key.replaceAll('_', ' ')).join(', ')}.</p>
        <p>Up to {review.request.limits.max_retained_records.toLocaleString()} saved records and {review.request.limits.max_retained_bytes.toLocaleString()} bytes. Idle refresh follows the reviewed interval; catch-up uses bounded consecutive pages.</p>
        <p>After the provider acknowledges the connection, Deft will apply this choice to private record storage and metadata observation{review.request.consent_lifetime === 'until_revoked' ? ' and install background access.' : '. Automatic renewable background access requires Until revoked.'}</p>
        <details><summary className="min-h-11 cursor-pointer py-3">Reviewed storage limits</summary><p>Each page can save up to {review.request.limits.max_records_per_page} records and {review.request.limits.max_page_bytes.toLocaleString()} bytes. Synchronized resource attachments may use {review.request.attachment_policy.allowed_media_types.join(', ')}, up to {review.request.attachment_policy.max_attachment_bytes.toLocaleString()} bytes each, retained for up to {review.request.attachment_policy.retention_days} days.</p></details>
        <button className="deft-pill min-h-11" type="button" disabled={busy || props.disabled} onClick={() => void act(true)}>Allow and continue to connect</button>
        <button className="deft-pill min-h-11" type="button" disabled={busy} onClick={() => setReview(null)}>Cancel</button>
      </div>}
    </>}
  </section>;
}

export function ExperienceInitialConnectCompletion(props: Identity & { target: Pick<AppConnectionTarget,'target_key'|'scope'|'session'>; disabled: boolean }) {
  const [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    if (props.disabled || props.target.session?.state !== 'connected') return;
    const abort = new AbortController(), anchor = api.getAccessToken();
    const current = () => !abort.signal.aborted && !document.hidden && isSameWebSession(anchor, api.getAccessToken());
    const key = initialConnectPlanKey(props.orgId, props.ownerId, props.installationId, props.target.target_key);
    const stored = sessionStorage.getItem(key); if (!stored) return;
    void (async () => {
      const plan = initialConnectPlan(JSON.parse(stored)); if (plan.phase === 'complete') return;
      setNotice('Finishing approved private storage and background refresh…');
      await finishAcknowledgedInitialConnection({ target: props.target, org: props.orgId, owner: props.ownerId, installation: props.installationId,
        sessionTag: await appConnectionSessionTag(props.sessionScope), current, signal: abort.signal, storage: sessionStorage,
        fetch: (path, init) => api.fetch(path, init) });
      if (current()) setNotice('Private records and background refresh are ready.');
    })().catch(error => { if (current()) setNotice(error instanceof Error ? error.message : 'Check approved account setup status.'); });
    return () => abort.abort();
  }, [props.installationId, props.ownerId, props.orgId, props.sessionScope, props.target.session?.session_id, props.disabled, reload]);
  return notice ? <div className="space-y-2 text-sm"><p role="status">{notice}</p><button type="button" className="deft-pill min-h-11" disabled={props.disabled} onClick={() => setReload(value => value + 1)}>Check approved setup status</button></div> : null;
}
