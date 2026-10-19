'use client';
import { useEffect, useRef, useState } from 'react';
import { api, isSameWebSession } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { appApiError } from '@/lib/apps';
import { runtimeSetupWebDeadline, type RuntimeSetupContext, type RuntimeSetupTarget } from '@/lib/app-runtime-setup';
import { parseSyncClosureCandidates, HistoricalSyncClosureResultSchema, parseHistoricalSyncClosureReview, readPendingSyncClosureReceipt, lookupHistoricalSyncClosureReceipt,
  type HistoricalSyncClosureReview, type HistoricalSyncClosureResult, type SyncClosureCandidate } from '@/lib/private-sync-closure';
type Candidate = SyncClosureCandidate;
const base = '/api/apps/blob/sync/unknown-runs';
async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(await appApiError(response, 'Private sync recovery is unavailable.'));
  const text = await response.text(); if (text.length > 65536) throw new Error('Private sync review is too large.');
  return JSON.parse(text);
}
/** Explicit one-obligation acknowledgement. No automatic review, close, retry,
 * provider request, or account operation runs when this component mounts. */
export function PrivateSyncClosure({ context, target, actorId }: {
  context: RuntimeSetupContext; target: RuntimeSetupTarget; actorId: string;
}) {
  const { sessionCacheScope } = useAuth();
  const storageKey = sessionCacheScope ? `deft-private-sync-closure:${JSON.stringify([sessionCacheScope, actorId,
    context.installation_id, context.app_version_id, context.grant_snapshot_id, context.lifecycle_epoch, context.grant_epoch,
    target.resource_binding_id, context.actions.map(row => [row.binding?.registration_id,row.binding?.registration_state])])}` : null;
  const [runs, setRuns] = useState<Candidate[] | null>(null), [selected, setSelected] = useState<Candidate | null>(null);
  const [review, setReview] = useState<HistoricalSyncClosureReview | null>(null);
  const [receipt, setReceipt] = useState<HistoricalSyncClosureResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [unconfirmed, setUnconfirmed] = useState(false);
  const [pendingReceipt, setPendingReceipt] = useState<{ run_id: string; review_digest: string } | null>(null);
  const generation = useRef(0), pending = useRef<AbortController | null>(null);
  useEffect(() => { if (!storageKey) return;
    const value = readPendingSyncClosureReceipt(sessionStorage, storageKey);
    if (value) { setPendingReceipt(value); setUnconfirmed(true); }
  }, [storageKey]);
  const begin = () => { pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    return { id: ++generation.current, token: api.getAccessToken(), controller }; };
  const current = (s: ReturnType<typeof begin>) => s.id === generation.current && !s.controller.signal.aborted && !document.hidden
    && isSameWebSession(s.token, api.getAccessToken()) && runtimeSetupWebDeadline(api.getAccessToken()) > Date.now();
  useEffect(() => { const hide = () => { if (document.hidden) { generation.current++; pending.current?.abort();
    setReview(null); setReceipt(null); setRuns(null); setSelected(null); setBusy(false); } };
    document.addEventListener('visibilitychange', hide); return () => { generation.current++; pending.current?.abort(); document.removeEventListener('visibilitychange', hide); };
  }, []);
  const request = async (path: string, init: RequestInit, s: ReturnType<typeof begin>) => {
    const timeout = setTimeout(() => s.controller.abort(), 15_000);
    try { return await json(await api.fetch(path, { ...init, signal: s.controller.signal, cache: 'no-store' })); }
    finally { clearTimeout(timeout); }
  };
  const load = async () => { const s = begin(); setBusy(true); setError(null); setReview(null); setReceipt(null); setSelected(null);
    try { const raw = parseSyncClosureCandidates(await request(`${base}/candidates?current_resource_binding_id=${encodeURIComponent(target.resource_binding_id)}`, {}, s));
      if (raw.current_resource_binding_id !== target.resource_binding_id || raw.target_key !== target.target_key || raw.resource_key !== target.resource_key) throw Error('Account target changed. Reload setup.');
      if (current(s)) setRuns(raw.runs);
    } catch (e) { if (current(s) || s.id === generation.current) setError(e instanceof Error ? e.message : 'Private sync history unavailable.'); }
    finally { if (s.id === generation.current) setBusy(false); } };
  const prepare = async (candidate: Candidate) => { const s = begin(); setSelected(candidate); setReview(null); setReceipt(null); setUnconfirmed(false); setBusy(true); setError(null);
    try { const raw = await request(`${base}/review`, { method: 'POST', body: JSON.stringify({ run_id: candidate.run_id, current_resource_binding_id: target.resource_binding_id }) }, s) as { review: unknown };
      const value = parseHistoricalSyncClosureReview(raw.review, { candidate, target, context, actorId }); if (current(s)) setReview(value);
    } catch (e) { if (current(s) || s.id === generation.current) setError(e instanceof Error ? e.message : 'Private sync review unavailable.'); }
    finally { if (s.id === generation.current) setBusy(false); } };
  const acknowledge = async () => { if (!review || !storageKey) return; const expected = review;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ run_id: expected.run_id, review_digest: expected.review_digest })); }
    catch { setError('The pending receipt reference could not be retained. No acknowledgement was sent.'); return; }
    const s = begin(); setBusy(true); setError(null);
    setPendingReceipt({ run_id: expected.run_id, review_digest: expected.review_digest });
    try { const raw = await request(`${base}/activate`, { method: 'POST', body: JSON.stringify({ run_id: expected.run_id,
      current_resource_binding_id: target.resource_binding_id, expected_review_digest: expected.review_digest, accept_host_policy: true }) }, s) as { closure: unknown };
      const value = HistoricalSyncClosureResultSchema.parse(raw.closure);
      if (value.run_id !== expected.run_id || value.review_digest !== expected.review_digest) throw Error('Closure receipt did not match this review.');
      if (current(s)) { setReceipt(value); setUnconfirmed(false); setPendingReceipt(null); try { sessionStorage.removeItem(storageKey); } catch {} }
    } catch { if (s.id === generation.current) { setUnconfirmed(true); setError('Acknowledgement is unconfirmed. Check the same signed receipt; no sync or provider request will be retried.'); } }
    finally { if (s.id === generation.current) setBusy(false); } };
  const checkReceipt = async () => { if (!pendingReceipt) return; const expected = pendingReceipt, s = begin(); setBusy(true); setError(null);
    try { const value = await lookupHistoricalSyncClosureReceipt(expected, target.resource_binding_id, (path, init) => request(path, init, s));
      if (!value) { if (current(s)) setError('No signed closure receipt is confirmed. The provider outcome remains unknown. Nothing was activated or retried.'); return; }
      if (current(s)) { setReceipt(value); setUnconfirmed(false); setPendingReceipt(null); try { if (storageKey) sessionStorage.removeItem(storageKey); } catch {} }
    } catch { if (s.id === generation.current) setError('The closure receipt could not be confirmed. No activation or retry was sent.'); }
    finally { if (s.id === generation.current) setBusy(false); } };
  return <section aria-label="Historical private sync recovery" className="mt-4 space-y-3 border-t pt-3 text-sm">
    <h3 className="font-semibold">Historical private sync recovery</h3>
    <p>A prior sync may have reached its provider without a confirmed Host result. Review one obligation at a time. Closing it preserves the unknown outcome and never retries it.</p>
    {error && <p role="alert" className="break-words">{error}</p>}{busy && <p role="status">Checking private sync recovery…</p>}
    {!review && !pendingReceipt && <button className="deft-pill min-h-11" disabled={busy} onClick={() => void load()}>Check prior sync obligations</button>}
    {pendingReceipt && <div><p>Acknowledgement for Run {pendingReceipt.run_id} is unconfirmed. Checking its signed receipt does not activate closure.</p><button className="deft-pill min-h-11" disabled={busy} onClick={() => void checkReceipt()}>Check signed closure receipt</button></div>}
    {runs?.length === 0 && <p>No unknown sync obligations are listed for this target.</p>}
    {!review && !pendingReceipt && runs?.map(run => <div key={run.run_id} className="space-y-1"><p>{run.operation_name} · {new Date(run.created_at).toLocaleString()}</p>
      <code className="block break-all text-xs">{run.run_id}</code><button className="deft-pill min-h-11" disabled={busy} onClick={() => void prepare(run)}>Review this obligation</button></div>)}
    {review && selected && <div className="space-y-3"><p className="font-semibold">{review.historical_closure.operation_name} · {target.target_key} / {target.resource_key}</p>
      <p>Run {review.run_id}, created {new Date(review.historical_closure.run_created_at).toLocaleString()}. Provider outcome: UNKNOWN. This records the local obligation as failed with unavailable result. It does not prove provider failure or successful ingestion. No retry, provider call, credential or access grant is issued.</p>
      <details><summary className="cursor-pointer py-2">Original and current review pins</summary><div className="max-h-80 overflow-auto rounded border p-2"><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify({ original: {
        app_version_id: review.app_version_id, grant_snapshot_id: review.grant_snapshot_id, package_digest: review.package_digest,
        lifecycle_epoch: review.lifecycle_epoch, grant_epoch: review.grant_epoch, runtime_epoch: review.runtime_epoch,
        resource_binding_id: review.resource_binding_id, runtime_registration_id: review.runtime_registration_id,
        consent_expires_at: review.consent_expires_at, consent_lifetime: review.consent_lifetime }, current: review.historical_closure,
        owner_user_id: review.owner_user_id, operator_user_id: review.operator_user_id, review_digest: review.review_digest }, null, 2)}</pre></div></details>
      {!receipt && !pendingReceipt && !unconfirmed && <button className="deft-pill min-h-11" disabled={busy} onClick={() => void acknowledge()}>Acknowledge unknown outcome; close local obligation</button>}
      {!receipt && !pendingReceipt && !unconfirmed && <button className="deft-pill ml-2 min-h-11" disabled={busy} onClick={() => { setReview(null); setSelected(null); }}>Cancel review</button>}
      {receipt && <div role="status"><p>Local obligation closed. Provider outcome remains UNKNOWN; no retry.</p><p>Signed receipt verified by Host.</p><code className="block break-all text-xs">{receipt.receipt.receipt_id}</code><code className="block break-all text-xs">{receipt.receipt.envelope_digest}</code></div>}
    </div>}
    {receipt && !review && <div role="status"><p>Local obligation closed. Provider outcome remains UNKNOWN; no retry. Signed receipt verified by Host.</p><code className="block break-all text-xs">{receipt.receipt.receipt_id}</code><code className="block break-all text-xs">{receipt.receipt.envelope_digest}</code></div>}
  </section>;
}
