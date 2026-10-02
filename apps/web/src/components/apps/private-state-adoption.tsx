'use client';

import { useEffect, useRef, useState } from 'react';
import { PrivateStateAdoptionContext, reviewOutput, parseAdoptionActivation, type GroupValue } from '@/lib/private-state-adoption';
export { PrivateStateAdoptionContext };

/** Explicit human host control; no draft bodies or adoption authority enter the worker. */
export function PrivateStateAdoption({ label, groups, request, onAdopted }: { label: string; groups: GroupValue[];
  request: (operation: 'review' | 'activate', body: unknown) => Promise<unknown>; onAdopted: () => void }) {
  return <AdoptionControl key={JSON.stringify(groups)} {...{ label, groups, request, onAdopted }} />;
}
function AdoptionControl({ label, groups, request, onAdopted }: { label: string; groups: GroupValue[];
  request: (operation: 'review' | 'activate', body: unknown) => Promise<unknown>; onAdopted: () => void }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [review, setReview] = useState<{ source: string; token: string; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function prepare(group: GroupValue) {
    setBusy(true); setError('');
    try {
      const result = reviewOutput(await request('review', { source_artifact_digest: group.source_artifact_digest }));
      if (!mounted.current || result.source_artifact_digest !== group.source_artifact_digest) return;
      setReview({ source: result.source_artifact_digest, token: result.review_token, count: result.count });
    } catch { if (mounted.current) setError('Recovery review is unavailable. Refresh the App and try again.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function accept() {
    if (!review) return;
    setBusy(true); setError('');
    try {
      parseAdoptionActivation(await request('activate', {
        source_artifact_digest: review.source, review_token: review.token, accept_owner_adoption: true }));
      if (mounted.current) { setReview(null); onAdopted(); }
    } catch { if (mounted.current) { setReview(null); setError('Recovery changed or expired. Review it again.'); } }
    finally { if (mounted.current) setBusy(false); }
  }
  if (!groups.length) return null;
  return <section className="border-b border-border px-5 py-4" aria-label="Recover private App state">
    <p className="text-sm font-medium">Recover your {label.toLowerCase()}</p>
    <p className="mt-1 text-xs text-muted-foreground">Your prior App version has private saved records. Recovery moves only your records to this reviewed version and preserves their expiry.</p>
    {groups.map(group => <p key={group.source_artifact_digest} className="mt-2 text-xs text-muted-foreground" title={group.source_app_version_id}>Source version {group.source_version} · {group.count} records · {group.records.reduce((sum, item) => sum + item.byte_length, 0).toLocaleString()} bytes · Earliest original expiry {new Date(Math.min(...group.records.map(item => Date.parse(item.expires_at)))).toLocaleString()}</p>)}
    {review ? <div className="mt-3 flex flex-wrap items-center gap-3">
      <span className="text-sm">Recover {review.count} saved {review.count === 1 ? 'record' : 'records'}?</span>
      <button type="button" className="min-h-11 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" disabled={busy} onClick={() => void accept()}>Recover</button>
      <button type="button" className="min-h-11 px-3 py-2 text-sm" disabled={busy} onClick={() => setReview(null)}>Cancel</button>
    </div> : groups.map(group => <button key={group.source_artifact_digest} type="button" className="mt-3 min-h-11 rounded-md border border-border px-3 py-2 text-sm" disabled={busy} onClick={() => void prepare(group)}>Review recovery of {group.count} saved {group.count === 1 ? 'record' : 'records'}</button>)}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
  </section>;
}
