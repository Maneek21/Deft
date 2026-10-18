'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AppDialog } from '@/components/overlay-primitives';
import { RuntimeAppInputReview, type RuntimeReviewIdentity } from '@/components/runtime-app-input-review';
import { AppRunInspector } from './app-run-inspector';
import { api, isSameWebSession } from '@/lib/api';
import type { ExperienceRunReviewTarget } from '@/lib/app-experience-run-review';
import { readExperienceRunResult, type ExperienceRunResult } from '@/lib/app-experience-run-result';
import { runtimeSetupWebDeadline } from '@/lib/app-runtime-setup';

const requestStates: Record<string, { label: string; detail: string; attention?: boolean }> = {
  pending_approval: { label: 'Awaiting your approval', detail: 'Review the exact request below before allowing it to proceed.' },
  pending: { label: 'Request queued', detail: 'The request is waiting to run.' },
  running: { label: 'Request running', detail: 'Execution is in progress. Check status for the latest outcome.' },
  waiting_external: { label: 'Waiting for provider', detail: 'The provider outcome has not been confirmed yet.' },
  succeeded: { label: 'Execution succeeded', detail: 'Review the provider result for what happened. This status does not confirm message delivery.' },
  failed: { label: 'Request failed', detail: 'Review the result or receipts before making another request.', attention: true },
  unknown_outcome: { label: 'Outcome unknown', detail: 'Check status and review receipts before trying again. Repeating the request could duplicate an action.', attention: true },
  cancelled: { label: 'Request cancelled', detail: 'This request is no longer active.' },
  expired: { label: 'Request expired', detail: 'This request expired before completion.' },
};

/** Display only confirmed host state; a lost decision response overrides stale state. */
export function ExperienceRequestStatus({ state, uncertain = false }: { state: string; uncertain?: boolean }) {
  const status = uncertain ? { label: 'Decision not confirmed', detail: 'Check status before continuing. The decision will not be retried automatically.', attention: true }
    : requestStates[state] ?? { label: 'Status unavailable', detail: 'Check status to see the current request outcome.' };
  return <section aria-label="Request outcome" className="mb-4 rounded-xl px-4 py-3" style={{ background: 'var(--surface-container-low)' }}>
    <h3 className="text-sm font-medium" style={{ color: status.attention ? state === 'failed' && !uncertain ? 'var(--error)' : 'var(--warning)' : 'var(--foreground)' }}>{status.label}</h3>
    <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>{status.detail}</p>
  </section>;
}

export function ExperienceRunReview({ initial, refresh, onClose, returnFocusRef }: {
  returnFocusRef?: RefObject<HTMLElement | null>;
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
  return <AppDialog open onClose={onClose} returnFocusRef={returnFocusRef} title={target.approvalId ? 'Review request' : 'Request status'}
    description={target.approvalId ? 'Check the request details before approving. Approval allows the provider to carry out this request.'
      : 'Review the latest outcome and recovery details.'} width={620}
    footer={<div className="flex flex-wrap justify-end gap-2"><button className="deft-pill min-h-11" onClick={onClose}>Close</button>
      {target.approvalId && <><button className="deft-pill min-h-11" disabled={busy || uncertain} onClick={() => void decide('reject')}>Reject request</button>
        <button className="deft-pill min-h-11 disabled:opacity-50" style={{ background: 'var(--primary-container)', color: 'var(--on-primary-container)' }} disabled={busy || uncertain || reviewed?.runId !== target.runId || reviewed.bindingId !== target.bindingId} onClick={() => void decide('approve')}>Approve request</button></>}
    </div>}>
    <ExperienceRequestStatus state={target.state} uncertain={uncertain} />
    {target.approvalId && !uncertain && <RuntimeAppInputReview compact key={reviewEpoch} runId={target.runId} bindingId={target.bindingId} busy={busy} onReviewed={onReviewed} />}
    {notice && <p role="status" className="mt-3 rounded-xl bg-[var(--surface-container-low)] px-3 py-3 text-sm leading-6" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>{notice}</p>}
    {result && <section className="mt-6 pt-1" aria-label="Retained provider result">
      <h3 className="text-sm font-medium">Provider result</h3>
      <p className="mt-1 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>The provider reported {result.providerSucceeded ? 'success' : 'failure'}. Review the outcome details below.</p>
      <dl className="mt-4 space-y-4 text-sm">{result.fields.map(field => <div key={field.key} className="grid gap-1 sm:grid-cols-[130px_minmax(0,1fr)] sm:gap-4" style={{ borderColor: 'var(--outline-variant)' }}>
        <dt className="text-xs capitalize text-muted-foreground">{field.label}</dt>
        <dd className="whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">{field.value === null ? '—' : String(field.value)}</dd>
      </div>)}</dl>
    </section>}
    <div className="mt-4 flex flex-wrap gap-2"><button className="deft-pill min-h-11" disabled={busy} onClick={() => void check()}>Check status</button>
      <button className="deft-pill min-h-11" disabled={busy} onClick={() => void viewResult()}>View provider result</button></div>
    <details className="mt-6" style={{ borderColor: 'var(--border-default)' }}>
      <summary className="flex min-h-11 cursor-pointer items-center text-xs" style={{ color: 'var(--text-secondary)' }}>Request history and recovery</summary>
      <p className="mb-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>Receipts show what Deft recorded for this request. Use them to investigate a failed or uncertain outcome.</p>
      <button className="deft-pill min-h-11" disabled={busy} onClick={() => { setResult(null); setReceipts(true); }}>View receipts</button>
    </details>
  </AppDialog>;
}
