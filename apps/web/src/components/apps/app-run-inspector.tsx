'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, ReceiptText, ShieldCheck } from 'lucide-react';
import { AppDialog } from '@/components/overlay-primitives';
import { api } from '@/lib/api';
import { appApiError, normalizeAppRunReceiptBundle, type AppRunReceiptBundle } from '@/lib/apps';

export function AppRunInspector({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const [bundle, setBundle] = useState<AppRunReceiptBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!runId) {
      setBundle(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setBundle(null);
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        const response = await api.fetch(`/api/app-runs/${encodeURIComponent(runId)}/receipts`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await appApiError(response, 'Unable to inspect this App Run.'));
        if (!controller.signal.aborted) setBundle(normalizeAppRunReceiptBundle(await response.json()));
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Unable to inspect this App Run.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [runId]);

  return <AppDialog
    open={runId !== null}
    onClose={onClose}
    title={bundle?.run.title ?? 'App Run receipts'}
    description="Actor-authorized, tenant-scoped Run metadata and server-verified receipt proofs. Raw provider envelopes and output are not exposed here."
    width={620}
    footer={<div className="flex justify-end"><button type="button" className="deft-pill min-h-11" onClick={onClose}>Close</button></div>}
  >
    {loading && <div className="flex min-h-40 items-center justify-center"><Loader2 className="animate-spin" aria-label="Loading App Run receipts" /></div>}
    {error && <div role="alert" className="flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'var(--danger-subtle)', color: 'var(--error)' }}><AlertTriangle size={15} className="mt-0.5 flex-shrink-0" /><span>{error}</span></div>}
    {bundle && <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl p-3" style={{ background: bundle.run.state === 'succeeded' ? 'rgba(48,164,108,.10)' : 'var(--surface-container-high)' }}>
        {bundle.run.state === 'succeeded' ? <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--status-green)' }} /> : <ReceiptText size={16} className="mt-0.5 flex-shrink-0" />}
        <div className="min-w-0"><h3 className="text-sm font-semibold">{bundle.run.state.replaceAll('_', ' ')}</h3><p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>{bundle.run.outcome_summary ?? bundle.run.summary ?? 'No additional safe summary was retained.'}</p></div>
      </div>
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <Fact label="Operation" value={bundle.run.operation_name} />
        <Fact label="Risk" value={bundle.run.risk_class.replaceAll('_', ' ')} />
        <Fact label="Review" value={`${bundle.run.review_requirement.replaceAll('_', ' ')} · ${bundle.run.review_scope.replaceAll('_', ' ')}`} />
        <Fact label="Retry" value={bundle.run.retry_class.replaceAll('_', ' ')} />
        <Fact label="Retention" value={bundle.run.retention_class.replaceAll('_', ' ')} />
        <Fact label="Result retention" value={bundle.run.result_purged_at ? `Purged ${formatTime(bundle.run.result_purged_at)}` : `Expires ${formatTime(bundle.run.result_expires_at)}`} />
      </dl>
      <div>
        <h3 className="flex items-center gap-1.5 text-xs font-semibold"><ShieldCheck size={14} style={{ color: 'var(--status-green)' }} /> Verified receipts</h3>
        {bundle.receipts.length === 0 ? <p className="mt-2 text-[11px]" style={{ color: 'var(--outline)' }}>No receipt has been emitted for this Run yet.</p> : <ul className="mt-2 space-y-2">{bundle.receipts.map((receipt) => <li key={receipt.receipt_id} className="rounded-lg p-3 text-[11px]" style={{ background: 'var(--surface-container-high)' }}>
          <div className="flex items-center justify-between gap-3"><span className="font-semibold">{receipt.receipt_kind.replaceAll('_', ' ')}</span><span className="rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase" style={{ color: 'var(--status-green)', background: 'var(--surface-container-low)' }}>Verified</span></div>
          <p className="mt-1" style={{ color: 'var(--on-surface-variant)' }}>{receipt.run_state.replaceAll('_', ' ')} · {formatTime(receipt.occurred_at)} · key {receipt.signing_key_version}</p>
          <p className="mt-1 break-all font-mono text-[9px]" style={{ color: 'var(--outline)' }}>{receipt.envelope_digest}</p>
        </li>)}</ul>}
      </div>
    </div>}
  </AppDialog>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-lg px-3 py-2" style={{ background: 'var(--surface-container-high)' }}><dt className="text-[10px] font-semibold uppercase" style={{ color: 'var(--outline)' }}>{label}</dt><dd className="mt-1 break-words">{value}</dd></div>;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}
