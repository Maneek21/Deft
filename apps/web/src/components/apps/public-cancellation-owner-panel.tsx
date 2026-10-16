'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { parseCancellationContext, parseCancellationList, parseCancellationReview,
  type CancellationContext, type CancellationItem, type CancellationReview } from '@/lib/public-cancellation-owner';

type View = { scope: string; items: CancellationItem[]; next: string | null; context: CancellationContext | null;
  binding: string; review: CancellationReview | null; consent: boolean; runId: string | null };
const controlStyle = { minHeight: 44 };
const statusLabel: Record<CancellationItem['state'], string> = {
  released_before_effect: 'Withdrawn before effect', withdrawal_requested: 'Withdrawal requested',
  cancellation_unavailable: 'Owner review needed', cancel_run_pending: 'Owner approval or settlement pending',
  cancelled: 'Cancellation verified', cancel_failed: 'Cancellation failed; reservation retained', unknown_outcome: 'Outcome unknown; reservation retained',
};
async function responseBody(response: Response) {
  if (!response.ok) throw new Error('This cancellation is unavailable or its authority changed. Refresh and review again.');
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 32768) throw new Error('Cancellation response exceeds its display bound.');
  return JSON.parse(text) as unknown;
}

/** Every rendered private value carries the exact current owner/SID scope.
 * Passive cleanup is supplemental; a replaced session cannot paint old input. */
export function PublicCancellationOwnerPanel({ installationId }: { installationId: string }) {
  const { user, org, sessionCacheScope } = useAuth();
  const scope = user && org && sessionCacheScope ? JSON.stringify([org.id, user.id, sessionCacheScope, installationId]) : null;
  const current = useRef(scope); current.current = scope;
  const generation = useRef(0), active = useRef<AbortController | null>(null);
  const [stored, setStored] = useState<View | null>(null);
  const [notice, setNotice] = useState<{ scope: string; value: string } | null>(null);
  const [busy, setBusy] = useState<{ scope: string; value: string } | null>(null);
  const view = stored?.scope === scope ? stored : null;
  const review = view?.review && Date.parse(view.review.expires_at) > Date.now() ? view.review : null;
  const waiting = busy?.scope === scope;
  useEffect(() => {
    const clear = () => { generation.current++; active.current?.abort(); setStored(null); setNotice(null); setBusy(null); };
    clear();
    const hidden = () => { if (document.visibilityState !== 'visible') clear(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', clear);
    const timer = window.setInterval(() => setStored(value => value?.review && Date.parse(value.review.expires_at) <= Date.now()
      ? { ...value, review: null, consent: false } : value), 500);
    return () => { generation.current++; active.current?.abort(); clearInterval(timer);
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', clear); };
  }, [scope]);
  async function perform(label: string, task: (signal: AbortSignal, anchor: string) => Promise<View>) {
    if (!scope || current.current !== scope || document.visibilityState !== 'visible') return;
    const anchor = scope, epoch = ++generation.current;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setBusy({ scope: anchor, value: label }); setNotice(null);
    const matches = () => current.current === anchor && generation.current === epoch && !controller.signal.aborted && document.visibilityState === 'visible';
    try { const result = await task(controller.signal, anchor); if (matches()) setStored(result); }
    catch { if (matches()) setNotice({ scope: anchor, value: 'This cancellation is unavailable or changed. Refresh and review again.' }); }
    finally { if (matches()) setBusy(null); }
  }
  const load = (after?: string) => perform('Loading requests', async (signal, anchor) => {
    const params = new URLSearchParams({ installation_id: installationId }); if (after) params.set('after_cancellation_id', after);
    const result = parseCancellationList(await responseBody(await api.fetch(`/api/apps/public/cancellations/owner?${params}`, { cache: 'no-store', signal })), installationId);
    return { scope: anchor, items: result.items, next: result.next, context: null, binding: '', review: null, consent: false, runId: null };
  });
  const inspect = (item: CancellationItem) => perform('Loading current choices', async (signal, anchor) => {
    const context = parseCancellationContext(await responseBody(await api.fetch(`/api/apps/public/cancellations/${item.id}/owner/context`,
      { cache: 'no-store', signal })), installationId, item.id);
    return { ...view!, scope: anchor, context, binding: '', review: null, consent: false, runId: context.cancel_run_id };
  });
  const prepareReview = () => perform('Reviewing cancellation', async (signal, anchor) => {
    const context = view!.context!, choice = context.choices.find(item => item.native_binding_id === view!.binding)!;
    const request = { schema_version: 'deft.app_public_cancellation_owner_review_request.v1',
      native_binding_id: choice.native_binding_id, expected_consent_digest: choice.consent_digest };
    const value = parseCancellationReview(await responseBody(await api.fetch(`/api/apps/public/cancellations/${context.cancellation_id}/owner/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), cache: 'no-store', signal,
    })), context.cancellation_id, choice);
    return { ...view!, scope: anchor, review: value, consent: false, runId: null };
  });
  const submit = () => perform('Preparing owner approval', async (signal, anchor) => {
    if (!review || !view?.consent) throw new Error();
    const result = await responseBody(await api.fetch(`/api/apps/public/cancellations/${review.cancellation_id}/owner/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...review.request, review_token: review.review_token,
        expected_review_digest: review.review_digest, accept_host_policy: true }), cache: 'no-store', signal,
    })) as { schema_version?: unknown; run?: { id?: unknown }; replayed?: unknown };
    if (result.schema_version !== 'deft.app_public_cancellation_owner_submit_result.v1' || typeof result.replayed !== 'boolean'
      || typeof result.run?.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(result.run.id)) throw new Error();
    return { ...view!, scope: anchor, context: { ...view!.context!, state: 'cancel_run_pending' }, runId: result.run.id, review: null, consent: false };
  });
  if (!scope || user?.role === 'guest') return null;
  return <section aria-label="Your public cancellation requests" className="rounded-xl border p-4" style={{ borderColor: 'var(--ghost-border)', background: 'var(--surface-container-low)' }}>
    <h2 className="text-sm font-semibold">Your public cancellation requests</h2>
    <p className="mt-1 text-xs">Choose a current owner-consented cancellation action. Each effect still requires your exact-input approval in Inbox.</p>
    <button type="button" className="deft-pill mt-3" style={controlStyle} disabled={waiting} onClick={() => void load()}>Refresh requests</button>
    {waiting && <p role="status" className="mt-2 text-xs">{busy?.value}…</p>}
    {notice?.scope === scope && <p role="alert" className="mt-2 text-xs">{notice.value}</p>}
    {view && view.items.length === 0 && <p className="mt-3 text-sm">No cancellation requests for your Calendar.</p>}
    {view?.items.map(item => <div key={item.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3" style={{ borderColor: 'var(--ghost-border)' }}>
      <div className="min-w-0"><p className="text-sm">{statusLabel[item.state]}</p><p className="mt-1 text-xs">App v{item.original_version} · {new Date(item.accepted_at).toLocaleString()}</p></div>
      {['cancellation_unavailable', 'withdrawal_requested', 'cancel_run_pending', 'cancel_failed', 'unknown_outcome'].includes(item.state)
        && <button type="button" className="deft-pill" style={controlStyle} disabled={waiting} onClick={() => void inspect(item)}>Choose cancellation action</button>}
    </div>)}
    {view?.next && <button type="button" className="deft-pill mt-3" style={controlStyle} disabled={waiting} onClick={() => void load(view?.next ?? undefined)}>Next requests</button>}
    {view?.context && <div className="mt-4 space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--ghost-border)' }}>
      <h3 className="text-sm font-semibold">Current owner selection</h3>
      {!view.context.choices.length && !view.runId ? <p className="text-sm">No eligible current cancellation action. Ask an App manager to stage a current action, then review and consent to it as the Calendar owner.</p>
        : !view.runId && <><label className="block text-xs">Cancellation action<select aria-label="Cancellation action" className="mt-1 block w-full rounded-lg border px-2 text-sm" style={{ ...controlStyle, background: 'var(--surface-container)', borderColor: 'var(--border)' }}
          value={view.binding} disabled={waiting} onChange={event => { generation.current++; active.current?.abort(); setStored({ ...view, binding: event.target.value, review: null, consent: false }); }}>
          <option value="">Choose an action</option>{view.context.choices.map(choice => <option key={choice.native_binding_id} value={choice.native_binding_id}>{choice.action_label}{choice.historical_create_authorized ? ' · explicitly consented historical create' : ''}</option>)}
        </select></label><button type="button" className="deft-pill" style={controlStyle} disabled={waiting || !view.binding} onClick={() => void prepareReview()}>Review cancellation</button></>}
      {review && <div className="space-y-2 text-xs" aria-label="Exact cancellation input">
        <p>This cancels one event created by App v{view.context.original_version}. It does not execute the old grant or automatically rebind.</p>
        <dl className="space-y-1 break-all"><dt>Original create Run</dt><dd>{review.input.create_run_id}</dd><dt>Calendar event</dt><dd>{review.input.event_ref.resource_id}</dd><dt>Current cancellation binding</dt><dd>{review.native_binding_id}</dd></dl>
        <p>Review expires {new Date(review.expires_at).toLocaleTimeString()}.</p>
        <label className="flex items-center gap-2" style={controlStyle}><input type="checkbox" checked={view.consent} disabled={waiting}
          onChange={event => setStored({ ...view, consent: event.target.checked })} />I accept this current action and understand that Inbox approval is still required.</label>
        <button type="button" className="deft-pill" style={controlStyle} disabled={waiting || !view.consent} onClick={() => void submit()}>Prepare owner approval</button>
      </div>}
      {view.runId && <div role="status"><p className="text-sm">{statusLabel[view.context.state]}. Open Inbox to inspect the retained Run and any required exact-input approval.</p><Link href="/inbox" className="deft-pill mt-2" style={controlStyle}>Open Inbox</Link></div>}
    </div>}
  </section>;
}
