'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { parseNativeAppReview, type NativeAppReview, type NativeReviewOperation } from '@/lib/native-app-review';

export type NativeReviewIdentity = Readonly<{ runId: string; bindingId: string; operation: NativeReviewOperation; scope: string; expiresAt: number }>;
export function NativeAppInputReview({ runId, bindingId, operation, ownerId, scope, busy, onReviewed }: {
  runId: string | null; bindingId: string | null; operation: NativeReviewOperation | null;
  ownerId: string | null; scope: string | null; busy: boolean;
  onReviewed(identity: NativeReviewIdentity | null): void;
}) {
  const [captured, setReview] = useState<{ value: NativeAppReview; identity: NativeReviewIdentity; ownerId: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const validUntil = useRef(0);
  useEffect(() => {
    function clear() {
      epoch.current += 1; controller.current?.abort(); controller.current = null; validUntil.current = 0;
      setReview(null); setLoading(false); setError(false); onReviewed(null);
    }
    clear();
    function hidden() { if (document.visibilityState !== 'visible') clear(); }
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', clear);
    const timer = window.setInterval(() => { if (validUntil.current && Date.now() >= validUntil.current) clear(); }, 500);
    return () => {
      epoch.current += 1; controller.current?.abort(); onReviewed(null);
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', clear);
      window.clearInterval(timer);
    };
  }, [runId, bindingId, operation, ownerId, scope, onReviewed]);

  async function load() {
    if (!runId || !bindingId || !operation || !ownerId || !scope || busy || loading || document.visibilityState !== 'visible') return;
    const current = ++epoch.current; controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setReview(null); onReviewed(null); setError(false); setLoading(true);
    try {
      const response = await api.fetch(`/api/apps/native/runs/${encodeURIComponent(runId)}/review`, {
        method: 'GET', cache: 'no-store', signal: abort.signal,
      });
      if (!response.ok) throw new Error('unavailable');
      const parsed = parseNativeAppReview(await response.json() as unknown, runId, bindingId, operation, ownerId);
      if (!parsed) throw new Error('invalid');
      if (epoch.current !== current || abort.signal.aborted || document.visibilityState !== 'visible') return;
      validUntil.current = Date.now() + 60_000;
      const identity = { runId, bindingId, operation, scope, expiresAt: validUntil.current };
      setReview({ value: parsed, identity, ownerId }); onReviewed(identity);
    } catch { if (epoch.current === current && !abort.signal.aborted) setError(true); }
    finally { if (epoch.current === current) setLoading(false); }
  }
  // Scope rendering synchronously: passive cleanup must never reveal the prior
  // owner's exact input during an auth/target replacement render.
  const review = captured?.ownerId === ownerId && captured.identity.scope === scope
    && captured.identity.runId === runId && captured.identity.bindingId === bindingId
    && captured.identity.operation === operation && Date.now() < captured.identity.expiresAt ? captured.value : null;
  const fields = review?.input;
  const attendees = fields?.attendees as ReadonlyArray<{ email: string; displayName?: string }> | undefined;
  return <section aria-label="Native Calendar input review" className="mt-3 min-w-0 rounded-xl border p-3 text-sm"
    style={{ borderColor: 'var(--border)' }}>
    <p className="font-semibold">Review exact Calendar input</p>
    {review ? <>
      <p className="mt-1">{review.action_label}</p>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>Your Calendar · approval required for this invocation</p>
      <dl className="mt-2 max-h-72 space-y-2 overflow-y-auto break-words [overflow-wrap:anywhere]">
        {review.operation_name === 'calendar.events.create.v1' ? <>
          {(['title', 'start', 'end', 'description', 'location'] as const).map(key => fields?.[key] === undefined ? null :
            <div key={key}><dt className="text-xs font-medium">{({ title: 'Title', start: 'Start (with UTC offset)', end: 'End (with UTC offset)', description: 'Description', location: 'Location' })[key]}</dt>
              <dd className="whitespace-pre-wrap">{String(fields[key])}</dd></div>)}
          {attendees && <div><dt className="text-xs font-medium">Attendees (stored; no invitations sent)</dt>
            <dd>{attendees.length ? attendees.map(a => <p key={a.email}>{a.displayName ? `${a.displayName} · ` : ''}{a.email}</p>) : 'None'}</dd></div>}
        </> : <>
          <div><dt className="text-xs font-medium">Calendar event</dt><dd>{String((fields?.event_ref as { resource_id: string }).resource_id)}</dd></div>
          <div><dt className="text-xs font-medium">Original creation Run</dt><dd>{String(fields?.create_run_id)}</dd></div>
          <p>Only this App-created event in your Calendar can be cancelled.</p>
        </>}
      </dl>
    </> : <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>Open the current validated input before approving this Calendar action.</p>}
    {error && <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--status-red)' }}>Input review is unavailable or authority changed. Refresh the review or dismiss this action.</p>}
    <button type="button" onClick={() => { void load(); }} disabled={!runId || !bindingId || !operation || !ownerId || !scope || busy || loading}
      className="mt-2 rounded-md border px-3 py-1 text-xs disabled:opacity-60" style={{ borderColor: 'var(--border)', minHeight: 44 }}>
      {loading ? 'Loading input…' : review ? 'Refresh exact input' : 'Review exact input'}
    </button>
  </section>;
}
