'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isSameWebSession } from '@/lib/api';
import { AppRunInspector } from './app-run-inspector';
import { batchFieldText, readBatchReview, readBatchStatus, visibleBatchItems, type BatchStatus, type BatchReview } from '@/lib/action-batch-review';

export function ActionBatchReview({ batchId }: { batchId: string }) {
  const [batch, setBatch] = useState<BatchStatus | null>(null);
  const [review, setReview] = useState<BatchReview | null>(null);
  const [labels, setLabels] = useState<{ app: string; action: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(0);
  const [receiptRun, setReceiptRun] = useState<string | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);
  const reviewedSession = useRef<string | null>(null);
  const base = `/api/app-action-batches/${encodeURIComponent(batchId)}`;
  const checkStatus = useCallback(async () => {
    const token = api.getAccessToken();
    const epoch = generation.current;
    try {
      const response = await api.fetch(base, { cache: 'no-store' });
      if (!response.ok) throw new Error('Unavailable');
      const value = readBatchStatus(await response.json(), batchId);
      if (!mounted.current || epoch !== generation.current || !isSameWebSession(token, api.getAccessToken())) throw new Error('Session changed');
      setBatch(value); setUncertain(false);
      if (value.batch.state !== 'pending_approval') { setReview(null); reviewedSession.current = null; }
      return value;
    } catch (error) {
      if (mounted.current && epoch === generation.current) { setReview(null); reviewedSession.current = null; }
      throw error;
    }
  }, [base, batchId]);

  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(checkStatus).catch(() => { if (mounted.current) setNotice('The batch is unavailable. Check status to try again.'); });
    const clearReview = () => { generation.current++; reviewedSession.current = null;
      if (mounted.current) setReview(null); };
    const timer = setInterval(() => { setNow(Date.now());
      if (reviewedSession.current && !isSameWebSession(reviewedSession.current, api.getAccessToken())) clearReview(); }, 250);
    document.addEventListener('visibilitychange', clearReview);
    window.addEventListener('storage', clearReview);
    return () => { mounted.current = false; clearReview(); clearInterval(timer);
      document.removeEventListener('visibilitychange', clearReview); window.removeEventListener('storage', clearReview); };
  }, [checkStatus]);

  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(() => { setReview(null); reviewedSession.current = null;
      setNotice('This review expired. Refresh it and inspect the saved inputs again before approving.'); }, Math.max(0, Date.parse(review.expires_at) - Date.now()));
    return () => clearTimeout(timer);
  }, [review]);

  useEffect(() => {
    if (batch?.batch.state !== 'approved' || !batch.items.some(item => ['pending', 'pending_approval', 'running', 'waiting_external'].includes(item.state))) return;
    const timer = setInterval(() => { if (!pending.current && !document.hidden) void checkStatus().catch(() => {}); }, 3000);
    return () => clearInterval(timer);
  }, [batch, checkStatus]);

  async function requestReview() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setReview(null); reviewedSession.current = null; setNotice('');
    const epoch = ++generation.current;
    const token = api.getAccessToken();
    try {
      const response = await api.post(`${base}/review`, {});
      if (!response.ok) throw new Error('Unavailable');
      const value = readBatchReview(await response.json(), batchId);
      if (mounted.current && epoch === generation.current && !document.hidden && isSameWebSession(token, api.getAccessToken())) {
        reviewedSession.current = api.getAccessToken();
        setNow(Date.now()); setReview(value); setBatch(readBatchStatus(value, batchId)); setLabels({ app: value.app_label, action: value.action_label });
      }
    } catch { if (mounted.current) setNotice('The saved inputs could not be reviewed. Check status and try again.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  async function decide(action: 'approve' | 'cancel') {
    if (pending.current || document.hidden || uncertain || action === 'approve' && (!review || Date.parse(review.expires_at) <= Date.now()
      || !isSameWebSession(reviewedSession.current, api.getAccessToken()))) return;
    pending.current = true; setBusy(true); setNotice('');
    const epoch = ++generation.current;
    const snapshot = review;
    setReview(null); reviewedSession.current = null;
    try {
      const response = await api.post(`${base}/${action}`, action === 'approve'
        ? { ticket: snapshot!.ticket, expected_digest: snapshot!.digest } : {});
      if (!mounted.current || epoch !== generation.current) return;
      if (!response.ok) { setNotice('The request was not accepted. Check status and refresh the review before approving.'); }
      else setNotice(action === 'approve' ? 'Batch approved. Check each item’s progress below.' : 'Cancellation requested for unsent items. Already dispatched actions cannot be recalled.');
      await checkStatus();
    } catch { if (mounted.current && epoch === generation.current) { setUncertain(true); setNotice('The response could not be confirmed. Check status before continuing. This request will not be retried automatically.'); } }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  const expired = !!review && Date.parse(review.expires_at) <= now;
  const awaiting = batch?.batch.state === 'pending_approval';
  const displayed = visibleBatchItems(review, batch, now);
  return <main className="mx-auto h-full min-h-0 w-full max-w-4xl min-w-0 overflow-y-auto px-4 py-6 sm:px-8 sm:py-10">
    <p className="text-xs text-muted-foreground">Deft · Action batch</p>
    <h1 className="mt-2 break-words text-2xl font-semibold">{batch?.batch.title ?? 'Review action batch'}</h1>
    {batch && <p className="mt-2 text-sm text-muted-foreground">{labels && <>{labels.app} · {labels.action} · </>}{batch.items.length} items · {batch.batch.state.replaceAll('_', ' ')}</p>}
    <p className="mt-4 max-w-2xl text-sm">Review the exact saved inputs for every item. One approval authorizes this batch. Text supplied by apps and agents is shown as plain text.</p>
    <div className="mt-5 flex flex-wrap gap-3">
      {awaiting && <button type="button" className="deft-pill min-h-11 disabled:opacity-50" disabled={busy || uncertain} onClick={() => void requestReview()}>{review ? 'Refresh review' : 'Review saved inputs'}</button>}
      <button type="button" className="deft-pill min-h-11 disabled:opacity-50" disabled={busy} onClick={() => { setBusy(true); void checkStatus().catch(() => setNotice('Status could not be checked.')).finally(() => setBusy(false)); }}>Check status</button>
    </div>
    {notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
    {review && <p role="status" className="mt-4 text-sm">{expired ? 'This review expired. Refresh it and inspect the saved inputs again before approving.' : `Review expires at ${new Date(review.expires_at).toLocaleTimeString()}.`}</p>}
    <ol className="mt-6 divide-y border-y" style={{ borderColor: 'var(--outline-variant)' }}>
      {displayed.map((item, index) => <li key={item.key} className="py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="min-w-0 break-words font-medium">{index + 1}. {item.label}</h2><span className="text-xs text-muted-foreground">{(batch?.items.find(current => current.key === item.key)?.state ?? item.state).replaceAll('_', ' ')}</span></div>
        {item.input && <dl className="mt-3 divide-y" style={{ borderColor: 'var(--outline-variant)' }}>{Object.entries(item.input).map(([key, value]) => <div key={key} className="grid min-w-0 gap-1 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-5">
          <dt className="break-words text-xs font-medium text-muted-foreground">{key}</dt><dd className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{batchFieldText(value)}</dd>
        </div>)}</dl>}
        {item.run_id && <button type="button" className="mt-2 min-h-11 text-sm underline" onClick={() => setReceiptRun(item.run_id)}>View receipts for item {index + 1}</button>}
      </li>)}
    </ol>
    {batch && <div className="mt-6 flex flex-wrap gap-3">
      {awaiting && <button type="button" className="deft-pill min-h-11 disabled:opacity-50" style={{ background: 'var(--primary-container)', color: 'var(--on-primary-container)' }} disabled={busy || uncertain || !review || expired} onClick={() => void decide('approve')}>Approve all {batch.items.length} items</button>}
      <button type="button" className="deft-pill min-h-11 disabled:opacity-50" disabled={busy || uncertain || batch.batch.state === 'cancelled' || !batch.items.some(item => ['pending', 'pending_approval', 'running', 'waiting_external'].includes(item.state))} onClick={() => void decide('cancel')}>Cancel unsent items</button>
    </div>}
    <p className="mt-3 text-xs text-muted-foreground">Cancellation stops unsent items. It cannot recall already dispatched actions.</p>
    {receiptRun && <AppRunInspector runId={receiptRun} onClose={() => setReceiptRun(null)} />}
  </main>;
}
