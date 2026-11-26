'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isSameWebSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { appApiError, type AppInstallation, type AppOwnerConnectionPolicy } from '@/lib/apps';
import { ownerConnectionContext, type OwnerPolicy } from '@/lib/app-owner-connection';
import { accountOperatorChoices, admissionRequest, admissionReview, ADMISSION_LIMIT_FIELDS, canAdmitAccountOperators,
  DEFAULT_ADMISSION_LIMITS, type AdmissionLimits, type AdmissionRequest, type AdmissionReview } from '@/lib/app-owner-connection-admission';

type Member = { id: string; name: string; kind?: string; role?: string };
type Pending = { policy: AppOwnerConnectionPolicy; request: AdmissionRequest; review: AdmissionReview };
const tap = { minHeight: 44 };
const label = (key: string) => key.replaceAll('_', ' ');
async function json<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw new Error(await appApiError(response, fallback));
  return response.json() as Promise<T>;
}

/** Admit or withdraw the account connections an active App declares, using the
 * existing admission endpoints. The server decides; this screen only asks. */
export function AccountOperatorAdmission({ app }: { app: AppInstallation }) {
  const { user, sessionCacheScope } = useAuth();
  const policies = app.manifest.schema_version === '7' ? app.manifest.owner_connections ?? [] : [];
  if (!user || !sessionCacheScope || app.state !== 'active' || !policies.length || !canAdmitAccountOperators(user.role)) return null;
  return <Admission key={`${sessionCacheScope}/${app.id}/${app.version_id}/${app.grant_epoch}`} app={app} policies={policies} userId={user.id} />;
}

function Admission({ app, policies, userId }: { app: AppInstallation; policies: AppOwnerConnectionPolicy[]; userId: string }) {
  const [status, setStatus] = useState<OwnerPolicy[] | null>(null), [members, setMembers] = useState<Member[]>([]);
  const [operator, setOperator] = useState(userId), [limits, setLimits] = useState<AdmissionLimits>(DEFAULT_ADMISSION_LIMITS);
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null), [reload, setReload] = useState(0);
  const generation = useRef(0);
  const begin = () => { const id = ++generation.current, token = api.getAccessToken();
    return () => id === generation.current && !document.hidden && isSameWebSession(token, api.getAccessToken()); };
  const base = '/api/app-owner-connections';
  useEffect(() => {
    const current = begin();
    void (async () => {
      const [context, people] = await Promise.all([
        api.fetch(`${base}/${encodeURIComponent(app.id)}/context`, { cache: 'no-store' }).then(r => json<unknown>(r, 'Account connections are unavailable.')),
        api.fetch('/api/members', { cache: 'no-store' }).then(r => json<Member[]>(r, 'Members are unavailable.'))]);
      if (current()) { setStatus(ownerConnectionContext(context, app.id)); setMembers(accountOperatorChoices(people)); }
    })().catch(error => { if (current()) { setStatus(null); setNotice(error instanceof Error ? error.message : 'Account connections are unavailable.'); } });
  }, [app.id, reload]);
  const run = useCallback(async (work: (current: () => boolean) => Promise<void>) => {
    const current = begin(); setBusy(true); setNotice(null);
    try { await work(current); }
    catch (error) { if (current()) { setPending(null); setNotice(error instanceof Error ? error.message : 'The admission was not confirmed. Reload before trying again.'); } }
    finally { if (current()) setBusy(false); }
  }, []);
  const review = (policy: AppOwnerConnectionPolicy) => run(async current => {
    const grants = await json<unknown>(await api.fetch(`/api/apps/${encodeURIComponent(app.id)}/grants`, { cache: 'no-store' }), 'This App is unavailable.');
    const request = admissionRequest(app, grants, policy, operator, limits);
    const checked = admissionReview(await json(await api.fetch(`${base}/admissions/review`, { method: 'POST', body: JSON.stringify(request) }), 'The admission could not be reviewed.'), request);
    if (current()) setPending({ policy, request, review: checked });
  });
  const admit = () => pending && run(async current => {
    const expected = pending;
    // Never repeat an activation after a lost answer: reload the current status instead.
    const response = await api.fetch(`${base}/admissions/activate`, { method: 'POST', body: JSON.stringify({ ...expected.request, expected_review_digest: expected.review.digest, accept_host_policy: true }) });
    if (current()) { setPending(null); setNotice(response.ok ? `${label(expected.policy.key)} admitted.` : await appApiError(response, 'The admission was not confirmed.')); setReload(value => value + 1); }
  });
  const withdraw = (admissionId: string, key: string) => run(async current => {
    await json(await api.fetch(`${base}/admissions/${encodeURIComponent(admissionId)}/revoke`, { method: 'POST', body: '{}' }), 'The admission could not be withdrawn.');
    if (current()) { setNotice(`${label(key)} withdrawn.`); setReload(value => value + 1); }
  });
  const operatorName = (id: string) => members.find(member => member.id === id)?.name ?? 'the selected member';
  return <section aria-label="Account connections" className="mt-4 min-w-0 space-y-3 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--ghost-border)' }}>
    <h3 className="font-semibold">Account connections</h3>
    <p>A connection profile is this workspace&apos;s setting for how the App reaches an outside account provider, such as a mail server, and which member is recorded as its account operator. Until a profile is admitted here, no member can connect an account through it.</p>
    {notice && <p role="status" className="break-words">{notice}</p>}
    {!status && !notice && <p role="status">Checking account connections…</p>}
    {status && <ul className="space-y-3">{policies.map(policy => {
      const current = status.find(row => row.policy.key === policy.key), admission = current?.status === 'admitted' ? current.admission : null;
      return <li key={policy.key} className="space-y-2 rounded-lg border p-3" style={{ borderColor: 'var(--ghost-border)' }}>
        <p className="font-medium">{label(policy.key)}{policy.provider_profile_key ? ` · profile ${policy.provider_profile_key}` : ''}</p>
        {admission ? <><p>Admitted. Account operator: {admission.operator_label}.</p>
          <p>Withdrawing stops members from setting up new accounts through it, and accounts already connected through it can no longer be used.</p>
          <button type="button" className="deft-pill" style={tap} disabled={busy} onClick={() => void withdraw(admission.admission_id, policy.key)}>Withdraw {label(policy.key)}</button></>
          : pending?.policy.key === policy.key ? <div aria-label={`Review ${label(policy.key)}`} className="space-y-2">
            <p>Admitting {label(policy.key)} lets each member of this workspace connect their own {label(pending.review.resource_key)} account to {app.name}, with {operatorName(pending.request.operator_user_id)} recorded as its account operator{pending.review.profile ? `, through ${pending.review.profile.provider_id} at ${pending.review.profile.authorization_origin}` : ''}.</p>
            <p>It does not connect any account or read anything. Each member still reviews and allows their own account, within these ceilings: up to {pending.review.limits.max_retained_records.toLocaleString()} saved records and {pending.review.limits.max_retained_bytes.toLocaleString()} bytes per account, syncing at most every {pending.review.limits.min_interval_seconds.toLocaleString()} seconds.</p>
            <p>{pending.review.action_keys.length ? `The App may later ask to ${pending.review.action_keys.map(label).join(' and ')}; each of those needs its own approval and is not allowed by admitting.` : 'It allows no App actions.'} If this App version or its approval changes, this admission stops applying; it continues only through a new admission, which a trusted compatible update can carry over.</p>
            <div className="flex flex-wrap gap-2"><button type="button" className="deft-pill" style={tap} disabled={busy} onClick={() => void admit()}>Admit {label(policy.key)}</button>
              <button type="button" className="deft-pill" style={tap} disabled={busy} onClick={() => setPending(null)}>Cancel</button></div>
          </div> : <>
            <p>Not admitted. Members cannot connect an account through it yet.</p>
            <label className="block space-y-1">Account operator<select aria-label={`Account operator for ${label(policy.key)}`} className="block min-h-11 w-full rounded border bg-transparent px-3" value={operator} disabled={busy} onChange={event => setOperator(event.target.value)}>
              {!members.some(member => member.id === userId) && <option value={userId}>You</option>}
              {members.map(member => <option key={member.id} value={member.id}>{member.name}{member.id === userId ? ' (you)' : ''}</option>)}</select></label>
            <details><summary className="cursor-pointer py-2">Ceilings for members&apos; accounts</summary><div className="grid gap-2 sm:grid-cols-2">{ADMISSION_LIMIT_FIELDS.map(field =>
              <label key={field.key} className="space-y-1"><span className="block">{field.label}</span><input type="number" className="block min-h-11 w-full rounded border bg-transparent px-3" min={field.min} max={field.max} step={1}
                value={limits[field.key]} disabled={busy} onChange={event => setLimits({ ...limits, [field.key]: Number(event.target.value) })} /></label>)}</div></details>
            <button type="button" className="deft-pill" style={tap} disabled={busy || !!pending} onClick={() => void review(policy)}>Review admitting {label(policy.key)}</button></>}
      </li>;
    })}</ul>}
  </section>;
}
