'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { appApiError, type AppInstallation } from '@/lib/apps';
import { useAuth } from '@/lib/auth-context';
import { refreshApps } from '@/hooks/use-apps';

type ReviewRequest = { app_version_id: string; expected_package_digest: string; expected_requested_snapshot_digest: string; expected_lifecycle_epoch: number; expected_grant_epoch: number };
type Context = { installation_id: string; app_version_id: string; protocol_version: string; state: string; review_request: ReviewRequest | null; current_activation: { grant_snapshot_id: string; review_digest: string } | null };
type Review = ReviewRequest & { review_digest: string; authority: { sync_descriptors: Array<{ key: string; resource_type: string }>; modules: Array<{ module_id: string; version: string }>; experiences: Array<{ key: string; label: string }> } };
async function result<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await appApiError(response, 'Unable to review this App.'));
  return response.json() as Promise<T>;
}

export function ResourceAppReview({ app }: { app: AppInstallation }) {
  const { sessionCacheScope } = useAuth();
  if (!sessionCacheScope) return null;
  return <ReviewWorkspace key={`${sessionCacheScope}:${app.id}:${app.version_id}:${app.lifecycle_epoch}:${app.grant_epoch}`} app={app} />;
}

function ReviewWorkspace({ app }: { app: AppInstallation }) {
  const [review, setReview] = useState<Review | null>(null);
  const [request, setRequest] = useState<ReviewRequest | null>(null);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const base = `/api/app-runtime-review/${encodeURIComponent(app.id)}`;
  useEffect(() => {
    const clear = () => { generation.current += 1; setReview(null); setRequest(null); setBusy(false); };
    const hide = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', clear);
    return () => { generation.current += 1; document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', clear); };
  }, []);

  const context = () => api.get(`${base}/context?app_version_id=${encodeURIComponent(app.version_id)}`).then(result<Context>);
  const prepare = async () => {
    const current = ++generation.current;
    setBusy(true); setError(null); setNotice(null); setReview(null); setRequest(null);
    try {
      const target = await context();
      if (current !== generation.current || document.hidden) return;
      if (target.state === 'active' && target.current_activation) { setActive(true); await refreshApps(); return; }
      if (!target.review_request) throw new Error('This App version is not available for review.');
      const prepared = await result<Review>(await api.post(`${base}/review`, target.review_request));
      if (current !== generation.current || document.hidden) return;
      setRequest(target.review_request); setReview(prepared);
    } catch (reason) { if (current === generation.current) setError(reason instanceof Error ? reason.message : 'Unable to prepare App review.'); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const activate = async () => {
    if (!request || !review) return;
    const current = ++generation.current;
    setBusy(true); setError(null); setNotice(null);
    try {
      await result(await api.post(`${base}/activate`, { ...request, expected_review_digest: review.review_digest, accept_host_policy: true }));
      if (current !== generation.current || document.hidden) return;
      setActive(true); setReview(null); setRequest(null); await refreshApps();
    } catch (reason) {
      if (current !== generation.current || document.hidden) return;
      setReview(null); setRequest(null);
      try {
        // A committed activation may lose its response. Read its current state
        // without retrying the authority-changing operation.
        const target = await context();
        if (current !== generation.current || document.hidden) return;
        if (target.state === 'active' && target.current_activation) { setActive(true); await refreshApps(); return; }
      } catch { /* Preserve the original failure and require a fresh review. */ }
      if (current === generation.current) { setError(reason instanceof Error ? reason.message : 'Unable to confirm activation.'); setNotice('Review the current App version again before activating.'); }
    } finally { if (current === generation.current) setBusy(false); }
  };
  const buttonStyle = { minHeight: 44 };
  return <section aria-label="Resource App activation" className="mt-4 min-w-0 space-y-3 rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--ghost-border)' }}>
    {error && <p role="alert" className="break-words" style={{ color: 'var(--error)' }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">Checking the current App version…</p>}
    {active ? <><p role="status">This App version is active. Review a private connection to start syncing.</p><Link className="deft-pill" style={buttonStyle} href="/settings/apps/private-resources">Connect private resources</Link></> : review ? <>
      <h3 className="font-semibold">Activate {app.name} {app.version}?</h3>
      <p>This review activates the exact package below and installs its declared Modules. Private connections require their own consent after activation.</p>
      <dl className="space-y-2"><div><dt className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Modules to install or enable</dt><dd>{review.authority.modules.length ? review.authority.modules.map(module => `${module.module_id} ${module.version}`).join(', ') : 'None'}</dd></div><div><dt className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Private resources available to connect</dt><dd className="break-words">{review.authority.sync_descriptors.map(resource => `${resource.key} (${resource.resource_type})`).join(', ') || 'None'}</dd></div></dl>
      {review.authority.experiences.length > 0 && <p>Private access for this App’s Experiences requires a separate supported access review.</p>}
      <details><summary className="cursor-pointer py-2 text-xs">Package identity</summary><code className="block break-all text-xs">{request?.expected_package_digest}</code></details>
      <div className="flex flex-wrap gap-2"><button className="deft-pill" style={buttonStyle} disabled={busy} onClick={() => void activate()}>Accept review and activate</button><button className="deft-pill" style={buttonStyle} disabled={busy} onClick={() => { generation.current += 1; setReview(null); setRequest(null); }}>Cancel App review</button></div>
    </> : <><p>Review this version before enabling its declared App features. Resource consent and provider credentials are separate steps.</p><button className="deft-pill" style={buttonStyle} disabled={busy} onClick={() => void prepare()}>Review App activation</button></>}
  </section>;
}
