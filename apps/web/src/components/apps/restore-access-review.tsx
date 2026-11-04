'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isSameWebSession } from '@/lib/api';

/** Host-rendered Restore access review. The App never receives tokens or grants
 * from this surface: the Host calls the restore context -> review -> activate
 * routes itself and activates only the grants the owner ticks. */

type RestoreGrant = Readonly<{
  grant_id: string;
  kind: 'record_consent' | 'observation_consent' | 'action_consent' | 'capture_policy' | 'agent_policy_default' | 'defty_read_grant';
  store_key?: string;
  action_key?: string;
  resource_binding_id?: string;
  interval_seconds?: number;
  lifetime: Readonly<{ kind: 'duration'; seconds: number } | { kind: 'until_revoked' }>;
  restorable: boolean;
  preselected: boolean;
}>;

type RestoreContext = Readonly<{
  schema_version: 'deft.app_restore_access_context.v1';
  installation_id: string;
  target_key: string | null;
  account_ref: string | null;
  session_id: string | null;
  same_account: boolean;
  grants: readonly RestoreGrant[];
  next_step?: Readonly<{ kind: string; installation_id: string; target_key: string }>;
}>;

type RestoreReview = Readonly<{
  schema_version: 'deft.app_restore_access_review.v1';
  review_id: string;
  review_digest: string;
  review_expires_at: string;
  installation_id: string;
  target_key: string;
  account_ref: string;
  session_id: string;
  grants: readonly RestoreGrant[];
}>;

const KIND_LABEL: Readonly<Record<RestoreGrant['kind'], (grant: RestoreGrant) => string>> = {
  record_consent: grant => `Saved ${grant.store_key ?? 'records'} access`,
  observation_consent: grant => grant.interval_seconds ? `Background updates (every ${Math.round(grant.interval_seconds / 60)} minutes)` : 'Background updates',
  action_consent: grant => `${String(grant.action_key ?? 'action').replaceAll('_', ' ')} action access`,
  capture_policy: grant => `Knowledge capture for ${grant.store_key ?? 'this account'}`,
  agent_policy_default: grant => `Agent permission (${String(grant.action_key ?? 'action').replaceAll('_', ' ')})`,
  defty_read_grant: grant => `Workspace read access to ${grant.store_key ?? 'this account'}`,
};

function grantLabel(grant: RestoreGrant): string {
  return (KIND_LABEL[grant.kind] ?? (() => String(grant.kind).replaceAll('_', ' ')))(grant);
}
export { grantLabel };

export function RestoreAccessReview({ installationId, targetKey, onClose }: {
  installationId: string;
  targetKey: string;
  onClose: () => void;
}) {
  const [context, setContext] = useState<RestoreContext | null>(null);
  const [review, setReview] = useState<RestoreReview | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [notice, setNotice] = useState('Checking the previously connected account…');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const anchor = api.getAccessToken();
    if (!anchor || document.hidden) return;
    const current = () => mounted.current && !controller.signal.aborted && !document.hidden && isSameWebSession(anchor, api.getAccessToken());
    void (async () => {
      try {
        const contextResponse = await api.fetch(`/api/app-connection-sessions/installations/${encodeURIComponent(installationId)}/restore-context`, { signal: controller.signal, cache: 'no-store' });
        if (!contextResponse.ok) throw Error('The previous account access could not be read.');
        const contextValue = await contextResponse.json() as RestoreContext;
        if (!current()) return;
        setContext(contextValue);
        if (!contextValue.same_account || !contextValue.target_key) {
          setNotice('This account differs from the previously connected account. Reconnect the current account first.');
          return;
        }
        const reviewResponse = await api.fetch('/api/app-connection-sessions/restore/review', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ installation_id: installationId, target_key: contextValue.target_key }),
        });
        if (!reviewResponse.ok) throw Error('The previous account access could not be reviewed.');
        const reviewValue = await reviewResponse.json() as RestoreReview;
        if (!current()) return;
        setReview(reviewValue);
        setSelected(new Set(reviewValue.grants.filter(grant => grant.restorable && grant.preselected).map(grant => grant.grant_id)));
        setNotice('');
      } catch (error) {
        if (current()) setNotice(error instanceof Error ? error.message : 'The previous account access is unavailable.');
      }
    })();
    return () => { mounted.current = false; controller.abort(); };
  }, [installationId]);

  const toggle = useCallback((grantId: string) => {
    setSelected(previous => {
      if (!previous) return previous;
      const next = new Set(previous);
      if (next.has(grantId)) next.delete(grantId); else next.add(grantId);
      return next;
    });
  }, []);

  const activate = useCallback(async () => {
    if (!review || !selected || busy || document.hidden) return;
    setBusy(true); setNotice('');
    const anchor = api.getAccessToken();
    try {
      const grantIds = review.grants.filter(grant => grant.restorable && selected.has(grant.grant_id)).map(grant => grant.grant_id);
      const response = await api.fetch('/api/app-connection-sessions/restore/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_id: review.review_id, review_digest: review.review_digest, review_expires_at: review.review_expires_at,
          installation_id: review.installation_id, target_key: review.target_key, grant_ids: grantIds }),
      });
      if (!response.ok) throw Error('The restored access could not be saved. Review again before retrying.');
      if (!mounted.current || !isSameWebSession(anchor, api.getAccessToken())) return;
      setNotice('Access restored for the selected items.');
      onClose();
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : 'The restored access could not be saved.');
    } finally {
      setBusy(false);
    }
  }, [review, selected, busy, onClose]);

  const restorable = review?.grants.filter(grant => grant.restorable) ?? [];
  const allRestorable = review?.grants.filter(grant => grant.restorable) ?? [];
  const chosenCount = selected ? allRestorable.filter(grant => selected.has(grant.grant_id)).length : 0;

  return <section aria-label="Restore access" className="min-w-0 space-y-3 rounded-xl border p-4 text-sm leading-6"
    style={{ borderColor: 'var(--outline-variant)', background: 'var(--surface-container-low)' }}>
    <h4 className="text-base font-semibold">Restore access</h4>
    <p className="break-words">Reconnect the access you previously granted for this account. Each item is offered exactly as it was before; nothing is granted that you did not already allow.</p>
    {notice && <p role="status" className="break-words text-[var(--on-surface-variant)]">{notice}</p>}
    {review && selected && <ul className="space-y-2">
      {restorable.map(grant => {
        const checked = selected.has(grant.grant_id);
        return <li key={grant.grant_id} className="flex items-start gap-3">
          <input type="checkbox" checked={checked} disabled={busy} aria-label={grantLabel(grant)}
            onChange={() => toggle(grant.grant_id)} className="mt-1" />
          <span className="min-w-0">{grantLabel(grant)}
            {grant.lifetime.kind === 'until_revoked' ? ' · until revoked' : ` · ${Math.round(grant.lifetime.seconds / 86400)} days`}</span>
        </li>;
      })}
    </ul>}
    {review && !restorable.length && <p style={{ color: 'var(--text-secondary)' }}>No previous access is available to restore for this account.</p>}
    {review && selected && <div className="flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: 'var(--border-default)' }}>
      <button type="button" className="deft-pill min-h-11 font-semibold" style={{ background: 'var(--primary-container)', color: 'var(--on-primary-container)' }}
        disabled={busy} onClick={() => void activate()}>{busy ? 'Restoring access…' : `Restore ${chosenCount} item${chosenCount === 1 ? '' : 's'}`}</button>
      <button type="button" className="deft-pill min-h-11" disabled={busy} onClick={onClose}>Cancel</button>
    </div>}
    {!review && !context?.same_account && <button type="button" className="deft-pill min-h-11" onClick={onClose}>Close</button>}
  </section>;
}
