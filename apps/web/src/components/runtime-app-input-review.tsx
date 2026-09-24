'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { parseRuntimeAppReview, type RuntimeAppReview } from '@/lib/runtime-app-review';

export type RuntimeReviewIdentity = Readonly<{ runId: string; bindingId: string }>;

export function RuntimeAppInputReview({ runId, bindingId, busy, onReviewed }: {
  runId: string | null;
  bindingId: string | null;
  busy: boolean;
  onReviewed(identity: RuntimeReviewIdentity | null): void;
}) {
  const [review, setReview] = useState<RuntimeAppReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const epoch = useRef(0);

  useEffect(() => {
    epoch.current += 1;
    setReview(null);
    setLoading(false);
    setError(false);
    onReviewed(null);
    return () => { epoch.current += 1; onReviewed(null); };
  }, [runId, bindingId, onReviewed]);

  async function load() {
    if (!runId || !bindingId || loading || busy) return;
    const current = ++epoch.current;
    setReview(null);
    onReviewed(null);
    setError(false);
    setLoading(true);
    try {
      const response = await api.fetch(`/api/app-runtime-actions/${encodeURIComponent(runId)}/review`, {
        method: 'GET', cache: 'no-store',
      });
      if (!response.ok) throw new Error('unavailable');
      const parsed = parseRuntimeAppReview(await response.json() as unknown, runId, bindingId);
      if (!parsed) throw new Error('invalid');
      if (epoch.current !== current) return;
      setReview(parsed);
      onReviewed({ runId, bindingId });
    } catch {
      if (epoch.current === current) setError(true);
    } finally {
      if (epoch.current === current) setLoading(false);
    }
  }

  return (
    <section aria-label="Runtime action input review" className="mt-3 min-w-0 rounded-xl border p-3 text-sm"
      style={{ borderColor: 'var(--border)' }}>
      <p className="font-semibold">Review exact Runtime input</p>
      {review ? (
        <>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            External write · approval required for this invocation · unsafe to retry automatically
          </p>
          <dl className="mt-2 max-h-72 space-y-2 overflow-y-auto break-words [overflow-wrap:anywhere]">
            {Object.entries(review.input).map(([key, item]) => (
              <div key={key}><dt className="text-xs font-medium">{key}</dt>
                <dd className="whitespace-pre-wrap">{String(item)}</dd></div>
            ))}
            {Object.keys(review.input).length === 0 && <div>No input fields</div>}
          </dl>
        </>
      ) : (
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Open the current validated input before approving this external action.
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--status-red)' }}>
        Input review is unavailable or authority changed. Refresh the review or dismiss this action.
      </p>}
      {!runId || !bindingId ? <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--status-red)' }}>
        This action has no verified Runtime review reference. Approval is unavailable.
      </p> : null}
      <button type="button" onClick={() => { void load(); }}
        disabled={!runId || !bindingId || loading || busy}
        className="mt-2 min-h-9 rounded-md border px-3 py-1 text-xs disabled:opacity-60"
        style={{ borderColor: 'var(--border)' }}>
        {loading ? 'Loading input…' : review ? 'Refresh exact input' : 'Review exact input'}
      </button>
    </section>
  );
}
