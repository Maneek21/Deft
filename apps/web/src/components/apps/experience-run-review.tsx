'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppDialog } from '@/components/overlay-primitives';
import { RuntimeAppInputReview, type RuntimeReviewIdentity } from '@/components/runtime-app-input-review';
import { AppRunInspector } from './app-run-inspector';
import { api, isSameWebSession } from '@/lib/api';
import type { ExperienceRunReviewTarget } from '@/lib/app-experience-run-review';
import { readExperienceRunResult, type ExperienceRunResult } from '@/lib/app-experience-run-result';
import { runtimeSetupWebDeadline } from '@/lib/app-runtime-setup';

export function ExperienceRunReview({ initial, refresh, onClose }: {
  initial: ExperienceRunReviewTarget; refresh: () => Promise<ExperienceRunReviewTarget>; onClose: () => void;
}) {
  const [target, setTarget] = useState(initial), [reviewed, setReviewed] = useState<RuntimeReviewIdentity | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [uncertain, setUncertain] = useState(false);
  const [receipts, setReceipts] = useState(false), [reviewEpoch, setReviewEpoch] = useState(0);
  const [result, setResult] = useState<ExperienceRunResult | null>(null);
  const resultPending = useRef<AbortController | null>(null), resultGeneration = useRef(0);
  const sessionAnchor = useRef(api.getAccessToken());
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const clear = () => { resultGeneration.current++; if (resultPending.current) { resultPending.current.abort(); resultPending.current = null; setBusy(false); } setResult(null); };
    const hidden = () => { if (document.hidden) clear(); };
    const storage = (event: StorageEvent) => { if (event.key === 'deft-access-token' || event.key === 'deft-refresh-token') clear(); };
    const timer = setInterval(() => {
      const token = api.getAccessToken();
      if (!isSameWebSession(sessionAnchor.current, token) || runtimeSetupWebDeadline(token) <= Date.now()) clear();
    }, 250);
    document.addEventListener('visibilitychange', hidden); addEventListener('storage', storage);
    return () => { active.current = false; resultPending.current?.abort();
      clearInterval(timer); document.removeEventListener('visibilitychange', hidden); removeEventListener('storage', storage); };
  }, []);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), Math.max(0, Math.min(Date.parse(result.expiresAt) - Date.now(), 2147483647)));
    return () => clearTimeout(timer);
  }, [result]);
  const onReviewed = useCallback((value: RuntimeReviewIdentity | null) => setReviewed(value), []);
  async function check() {
    setBusy(true); setResult(null);
    try { const value = await refresh(); if (active.current) { setTarget(value); setNotice('Status checked.'); } }
    catch { if (active.current) setNotice('Status is unavailable. No action was retried.'); }
    finally { if (active.current) setBusy(false); }
  }
  async function viewResult() {
    if (busy) return;
    resultPending.current?.abort(); const controller = new AbortController(); resultPending.current = controller;
    const generation = ++resultGeneration.current, token = api.getAccessToken();
    const current = () => active.current && !controller.signal.aborted && generation === resultGeneration.current
      && !document.hidden && isSameWebSession(token, api.getAccessToken()) && runtimeSetupWebDeadline(api.getAccessToken()) > Date.now();
    setBusy(true); setResult(null); setNotice('');
    try {
      const before = await refresh();
      if (!current() || before.runId !== target.runId || before.bindingId !== target.bindingId) throw new Error('Changed');
      const response = await api.fetch(`/api/app-runs/${encodeURIComponent(before.runId)}/result`, { signal: controller.signal, cache: 'no-store' });
      const value = await readExperienceRunResult(response, before.runId, controller.signal);
      const after = await refresh();
      if (!current() || after.runId !== before.runId || after.bindingId !== before.bindingId || Date.parse(value.expiresAt) <= Date.now()) throw new Error('Changed');
      setTarget(after); setResult(value);
    } catch { if (current()) setNotice('The retained result is unavailable, expired, or access changed. No action was retried.'); }
    finally { if (generation === resultGeneration.current) { resultPending.current = null; if (active.current) setBusy(false); } }
  }
  async function decide(decision: 'approve' | 'reject') {
    if (busy || uncertain || !target.approvalId || decision === 'approve'
      && (reviewed?.runId !== target.runId || reviewed.bindingId !== target.bindingId)) return;
    setBusy(true); setNotice(''); const token = api.getAccessToken(); let dispatched = false;
    try {
      const current = await refresh();
      if (!active.current || document.hidden || !isSameWebSession(token, api.getAccessToken())
        || current.approvalId !== target.approvalId || current.bindingId !== target.bindingId || current.state !== 'pending_approval') throw new Error('Changed');
      dispatched = true;
      const response = await api.post(`/api/agent/actions/${encodeURIComponent(current.approvalId!)}/${decision}`, {});
      if (!response.ok) throw new Error('Unavailable');
      if (!active.current) return;
      setReviewed(null); setReviewEpoch(value => value + 1);
      setNotice(decision === 'approve' ? 'Approved. The provider still needs to finish the request.' : 'Request rejected.');
      try { const latest = await refresh(); if (active.current) setTarget(latest); }
      catch { if (active.current) { setUncertain(true); setNotice('Decision returned, but current status could not be checked. Check status before continuing.'); } }
    } catch {
      if (active.current) { setReviewed(null); setReviewEpoch(value => value + 1); setUncertain(dispatched);
        setNotice(dispatched ? 'The response was not confirmed. Check status; this decision will not be retried automatically.' : 'This request changed or access ended. Check status before continuing.'); }
    } finally { if (active.current) setBusy(false); }
  }
  if (receipts) return <AppRunInspector runId={target.runId} onClose={() => setReceipts(false)} />;
  return <AppDialog open onClose={onClose} title={target.approvalId ? 'Review request' : 'Request status'}
    description={target.approvalId ? 'Check the request details before approving. Approval allows the provider to carry out this request.'
      : 'Check the outcome, view the provider’s result, or inspect the receipts.'} width={620}
    footer={<div className="flex flex-wrap justify-end gap-2"><button className="deft-pill min-h-11" onClick={onClose}>Close</button>
      {target.approvalId && <><button className="deft-pill min-h-11" disabled={busy || uncertain} onClick={() => void decide('reject')}>Reject request</button>
        <button className="deft-pill min-h-11 disabled:opacity-50" style={{ background: 'var(--primary-container)', color: 'var(--on-primary-container)' }} disabled={busy || uncertain || reviewed?.runId !== target.runId || reviewed.bindingId !== target.bindingId} onClick={() => void decide('approve')}>Approve request</button></>}
    </div>}>
    <p className="text-xs capitalize" style={{ color: 'var(--on-surface-variant)' }}>Status: {target.state.replaceAll('_', ' ')}</p>
    {target.approvalId && !uncertain && <RuntimeAppInputReview compact key={reviewEpoch} runId={target.runId} bindingId={target.bindingId} busy={busy} onReviewed={onReviewed} />}
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
    {result && <section className="mt-4 border-t pt-4" aria-label="Retained provider result">
      <h3 className="text-sm font-medium">Provider result</h3>
      <p className="mt-1 text-xs text-muted-foreground">The provider reported {result.providerSucceeded ? 'success' : 'failure'}. Review the outcome details below.</p>
      <dl className="mt-3 divide-y text-sm">{result.fields.map(field => <div key={field.key} className="grid gap-1 py-3 sm:grid-cols-[130px_minmax(0,1fr)] sm:gap-4" style={{ borderColor: 'var(--outline-variant)' }}>
        <dt className="text-xs capitalize text-muted-foreground">{field.label}</dt>
        <dd className="whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">{field.value === null ? '—' : String(field.value)}</dd>
      </div>)}</dl>
    </section>}
    <div className="mt-4 flex flex-wrap gap-3"><button className="deft-pill min-h-11" disabled={busy} onClick={() => void check()}>Check status</button>
      <button className="deft-pill min-h-11" disabled={busy} onClick={() => void viewResult()}>View result</button>
      <button className="deft-pill min-h-11" disabled={busy} onClick={() => { setResult(null); setReceipts(true); }}>View receipts</button></div>
  </AppDialog>;
}
