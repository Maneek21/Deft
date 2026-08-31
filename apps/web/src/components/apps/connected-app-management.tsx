'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import {
  appApiError,
  isConnectedAppManifest,
  normalizeConnectedAppHealth,
  normalizeConnectedAppReview,
  type AppInstallation,
  type ConnectedAppHealth,
  type ConnectedAppReview,
} from '@/lib/apps';
import { refreshApps, useAppConnectors, useAppGrantManagement } from '@/hooks/use-apps';

export function ConnectedAppManagement({
  app,
  canManage,
  busy,
  onDisable,
}: {
  app: AppInstallation;
  canManage: boolean;
  busy: boolean;
  onDisable: () => void;
}) {
  const grantsState = useAppGrantManagement(app.id, canManage);
  const connectorState = useAppConnectors(canManage);
  const [connectorSelections, setConnectorSelections] = useState<Record<string, string>>({});
  const [review, setReview] = useState<ConnectedAppReview | null>(null);
  const [health, setHealth] = useState<ConnectedAppHealth | null>(null);
  const [acceptedPolicy, setAcceptedPolicy] = useState(false);
  const [working, setWorking] = useState<'review' | 'activate' | 'health' | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const grants = grantsState.grants;
  const manifest = isConnectedAppManifest(app.manifest) ? app.manifest : null;
  const version = grants?.versions.find((candidate) => candidate.id === app.version_id) ?? null;
  const requested = grants?.snapshots.find((snapshot) => snapshot.id === version?.requested_grant_snapshot_id) ?? null;
  const effective = grants?.snapshots.find((snapshot) => snapshot.id === grants.installation.active_grant_snapshot_id) ?? null;
  const activeConnectors = useMemo(
    () => connectorState.connectors.filter((connector) => connector.is_active && !connector.connection_error),
    [connectorState.connectors],
  );

  useEffect(() => {
    if (!manifest || activeConnectors.length === 0) return;
    setConnectorSelections((current) => {
      const next = { ...current };
      let changed = false;
      for (const requirement of manifest.connector_requirements) {
        if (!next[requirement.key]) {
          next[requirement.key] = activeConnectors[0].id;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [activeConnectors, manifest]);

  const reviewInput = useMemo(() => {
    if (!manifest || !requested) return null;
    const connectorSelectionsList = manifest.connector_requirements.map((requirement) => ({
      connector_requirement_key: requirement.key,
      mcp_connection_id: connectorSelections[requirement.key] ?? '',
    }));
    if (connectorSelectionsList.some((selection) => !selection.mcp_connection_id)) return null;
    return {
      app_version_id: app.version_id,
      expected_package_digest: app.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: app.lifecycle_epoch,
      expected_grant_epoch: app.grant_epoch,
      connector_selections: connectorSelectionsList,
    };
  }, [app.grant_epoch, app.lifecycle_epoch, app.package_digest, app.version_id, connectorSelections, manifest, requested]);

  if (!manifest) return null;
  if (!canManage) {
    return <p className="mt-4 border-t border-[var(--ghost-border)] pt-3 text-[11px]" style={{ color: 'var(--outline)' }}>An owner or admin can review connected permissions and health.</p>;
  }

  const runReview = async () => {
    if (!reviewInput) return;
    setWorking('review'); setMessage(null); setReview(null); setAcceptedPolicy(false);
    try {
      const response = await api.post(`/api/apps/${encodeURIComponent(app.id)}/review`, reviewInput);
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to review connected permissions.'));
      setReview(normalizeConnectedAppReview(await response.json()));
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to review connected permissions.' });
    } finally {
      setWorking(null);
    }
  };

  const activate = async () => {
    if (!reviewInput || !review || !acceptedPolicy) return;
    setWorking('activate'); setMessage(null);
    try {
      const response = await api.post(`/api/apps/${encodeURIComponent(app.id)}/review/activate`, {
        ...reviewInput,
        expected_review_digest: review.review_digest,
        accept_host_policy: true,
      });
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to activate this connected App.'));
      setReview(normalizeConnectedAppReview(await response.json()));
      setMessage({ tone: 'success', text: 'Connected App activated with the reviewed authority.' });
      await Promise.all([refreshApps(), grantsState.mutate()]);
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to activate this connected App.' });
    } finally {
      setWorking(null);
    }
  };

  const refreshHealth = async () => {
    setWorking('health'); setMessage(null);
    try {
      const response = await api.post(`/api/apps/${encodeURIComponent(app.id)}/health`, { refresh_provider_schemas: true });
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to inspect App health.'));
      setHealth(normalizeConnectedAppHealth(await response.json()));
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to inspect App health.' });
    } finally {
      setWorking(null);
    }
  };

  return (
    <section className="mt-4 space-y-4 border-t border-[var(--ghost-border)] pt-4" aria-label={`${app.name} connected App management`}>
      {message && <p role={message.tone === 'error' ? 'alert' : 'status'} className="rounded-lg px-3 py-2 text-xs" style={{ color: message.tone === 'error' ? 'var(--error)' : 'var(--status-green)', background: message.tone === 'error' ? 'var(--danger-subtle)' : 'rgba(48,164,108,.12)' }}>{message.text}</p>}
      {grantsState.isLoading ? <div className="flex min-h-16 items-center justify-center"><Loader2 size={16} className="animate-spin" aria-label="Loading connected App permissions" /></div>
        : grantsState.error || !grants ? <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{grantsState.error instanceof Error ? grantsState.error.message : 'Connected App permissions did not load.'}</p>
          : <>
            <div className="grid gap-3 sm:grid-cols-2">
              <AuthorityCard
                title="Requested authority"
                body={`${requested?.resource_rights.length ?? 0} resource right${requested?.resource_rights.length === 1 ? '' : 's'} · ${manifest.actions.length} action${manifest.actions.length === 1 ? '' : 's'} · ${manifest.connector_requirements.length} connector${manifest.connector_requirements.length === 1 ? '' : 's'}`}
                detail={requested ? shortDigest(requested.snapshot_digest) : 'Requested snapshot unavailable'}
              />
              <AuthorityCard
                title="Effective authority"
                body={effective ? `${effective.resource_rights.length} resource right${effective.resource_rights.length === 1 ? '' : 's'} · ${grants.action_bindings.length} active binding${grants.action_bindings.length === 1 ? '' : 's'}` : 'No effective authority'}
                detail={effective ? shortDigest(effective.snapshot_digest) : 'Activation is required'}
              />
            </div>

            <div>
              <h3 className="text-xs font-semibold">Dependencies and provenance</h3>
              <p className="mt-1 break-all text-[11px]" style={{ color: 'var(--outline)' }}>
                {manifest.provenance ? `${manifest.provenance.source_repository}@${manifest.provenance.source_commit}` : 'Local package without source provenance'}
              </p>
              <ul className="mt-2 space-y-1.5 text-[11px]">
                {(review?.dependencies ?? grants.dependencies).length === 0 ? <li style={{ color: 'var(--outline)' }}>No App dependencies.</li> : (review?.dependencies ?? grants.dependencies).map((dependency) => (
                  <li key={`${dependency.dependency_key}:${dependency.dependency_version_id}`} className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-container-high)' }}>
                    <span className="font-medium">{dependency.dependency_key}</span> · {dependency.required_app_id}@{dependency.required_version}
                    <span className="mt-0.5 block font-mono text-[9px]" style={{ color: 'var(--outline)' }}>{shortDigest(dependency.lock_digest)}</span>
                  </li>
                ))}
              </ul>
            </div>

            {app.state === 'staged' && <div className="space-y-3 rounded-xl p-3" style={{ background: 'var(--surface-container-high)' }}>
              <div><h3 className="text-xs font-semibold">Connector bindings</h3><p className="mt-1 text-[11px]" style={{ color: 'var(--outline)' }}>Choose exact workspace connectors, then review the resulting authority before activation.</p></div>
              {manifest.connector_requirements.map((requirement) => (
                <label key={requirement.key} className="block text-[11px] font-medium">
                  {requirement.key.replaceAll('_', ' ')}
                  <select
                    className="mt-1 min-h-11 w-full rounded-lg px-3 text-xs"
                    style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }}
                    value={connectorSelections[requirement.key] ?? ''}
                    onChange={(event) => {
                      setConnectorSelections((current) => ({ ...current, [requirement.key]: event.target.value }));
                      setReview(null); setAcceptedPolicy(false);
                    }}
                  >
                    <option value="">Select a healthy connector</option>
                    {activeConnectors.map((connector) => <option key={connector.id} value={connector.id}>{connector.name}</option>)}
                  </select>
                </label>
              ))}
              {manifest.connector_requirements.length > 0 && activeConnectors.length === 0 && <p role="alert" className="text-[11px]" style={{ color: 'var(--error)' }}>No active, healthy MCP connector is available. <Link href="/settings/integrations" className="underline">Configure one</Link>.</p>}
              <button type="button" className="deft-pill min-h-11" disabled={!reviewInput || working !== null} onClick={() => void runReview()}>{working === 'review' && <Loader2 size={13} className="animate-spin" />} Review exact authority</button>
            </div>}

            {review && <div className="space-y-3 rounded-xl p-3" style={{ background: review.permission_diff.kind === 'widening_or_incompatible' ? 'var(--danger-subtle)' : 'rgba(48,164,108,.10)', border: '1px solid var(--ghost-border)' }}>
              <div className="flex items-start gap-2"><ShieldCheck size={16} className="mt-0.5 flex-shrink-0" /><div><h3 className="text-xs font-semibold">{permissionDiffLabel(review.permission_diff.kind)}</h3><p className="mt-1 text-[11px]" style={{ color: 'var(--on-surface-variant)' }}>{review.permission_diff.changed_atoms.length === 0 ? 'The reviewed authority matches the prior surface.' : `${review.permission_diff.changed_atoms.length} authority atom${review.permission_diff.changed_atoms.length === 1 ? '' : 's'} changed.`}</p></div></div>
              {review.permission_diff.changed_atoms.length > 0 && <ul className="max-h-28 space-y-1 overflow-y-auto font-mono text-[9px]">{review.permission_diff.changed_atoms.map((atom) => <li key={atom} className="break-all">{atom}</li>)}</ul>}
              <div className="space-y-1.5 text-[11px]">
                {review.action_bindings.map((binding) => <div key={binding.binding_digest} className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-container-low)' }}><span className="font-medium">{binding.action_key.replaceAll('_', ' ')}</span><span className="block" style={{ color: 'var(--outline)' }}>{connectorName(binding.mcp_connection_id, connectorState.connectors)} · {binding.operation_name}</span></div>)}
              </div>
              <label className="flex min-h-11 items-start gap-2 rounded-lg px-2 py-2 text-[11px]" style={{ background: 'var(--surface-container-low)' }}><input type="checkbox" className="mt-0.5 h-4 w-4" checked={acceptedPolicy} onChange={(event) => setAcceptedPolicy(event.target.checked)} /><span>I accept Deft’s host-owned approval, retention, egress, and retry policy for these exact bindings.</span></label>
              <button type="button" className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }} disabled={!acceptedPolicy || working !== null} onClick={() => void activate()}>{working === 'activate' && <Loader2 size={13} className="animate-spin" />} Activate reviewed App</button>
            </div>}

            {grants.action_bindings.length > 0 && <div><h3 className="text-xs font-semibold">Effective action bindings</h3><ul className="mt-2 space-y-1.5">{grants.action_bindings.map((binding) => <li key={binding.id} className="rounded-lg px-2.5 py-2 text-[11px]" style={{ background: 'var(--surface-container-high)' }}><span className="font-medium">{binding.action_key.replaceAll('_', ' ')}</span><span className="block" style={{ color: 'var(--outline)' }}>{connectorName(binding.mcp_connection_id, connectorState.connectors)} · {binding.host_policy.review_requirement.replaceAll('_', ' ')} approval</span></li>)}</ul></div>}

            <div className="flex flex-wrap gap-2">
              <button type="button" className="deft-pill min-h-11" disabled={working !== null} onClick={() => void refreshHealth()}>{working === 'health' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh health</button>
              {app.state === 'active' && <button type="button" className="deft-pill min-h-11" disabled={busy || working !== null} onClick={onDisable}>Disable</button>}
            </div>
            {health && <div role="status" className="rounded-lg px-3 py-2 text-[11px]" style={{ background: health.status === 'healthy' ? 'rgba(48,164,108,.10)' : 'var(--danger-subtle)', color: health.status === 'healthy' ? 'var(--status-green)' : 'var(--error)' }}>
              <p className="flex items-center gap-1.5 font-semibold">{health.status === 'healthy' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {health.status === 'healthy' ? 'Healthy' : `${health.issues.length} health issue${health.issues.length === 1 ? '' : 's'}`}</p>
              {health.issues.length > 0 && <ul className="mt-1 space-y-1">{health.issues.map((issue) => <li key={`${issue.code}:${issue.subject_id}`}>{issue.message}</li>)}</ul>}
            </div>}

            <div><h3 className="text-xs font-semibold">Recent Runs</h3>{grants.recent_runs.length === 0 ? <p className="mt-1 text-[11px]" style={{ color: 'var(--outline)' }}>No App Runs yet.</p> : <ul className="mt-2 space-y-1.5">{grants.recent_runs.slice(0, 5).map((run) => <li key={run.id} className="flex items-start justify-between gap-3 rounded-lg px-2.5 py-2 text-[11px]" style={{ background: 'var(--surface-container-high)' }}><span className="min-w-0"><span className="block truncate font-medium">{run.title}</span><span className="block truncate" style={{ color: 'var(--outline)' }}>{run.outcome_summary ?? run.summary ?? new Date(run.created_at).toLocaleString()}</span></span><RunState state={run.state} /></li>)}</ul>}</div>
          </>}
    </section>
  );
}

function AuthorityCard({ title, body, detail }: { title: string; body: string; detail: string }) {
  return <div className="rounded-lg p-3" style={{ background: 'var(--surface-container-high)' }}><h3 className="text-[11px] font-semibold">{title}</h3><p className="mt-1 text-[11px]" style={{ color: 'var(--on-surface-variant)' }}>{body}</p><p className="mt-1 truncate font-mono text-[9px]" style={{ color: 'var(--outline)' }}>{detail}</p></div>;
}

function RunState({ state }: { state: string }) {
  const tone = state === 'succeeded' ? 'var(--status-green)' : state === 'failed' || state === 'expired' ? 'var(--error)' : 'var(--status-amber)';
  return <span className="flex-shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase" style={{ color: tone, background: 'var(--surface-container-low)' }}>{state.replaceAll('_', ' ')}</span>;
}

function connectorName(id: string, connectors: Array<{ id: string; name: string }>): string {
  return connectors.find((connector) => connector.id === id)?.name ?? `Connector ${id.slice(0, 8)}`;
}

function shortDigest(value: string): string {
  return value.length > 24 ? `${value.slice(0, 20)}…` : value;
}

function permissionDiffLabel(kind: ConnectedAppReview['permission_diff']['kind']): string {
  if (kind === 'initial') return 'Initial connected authority';
  if (kind === 'unchanged') return 'Authority unchanged';
  return 'Authority widened or changed incompatibly';
}
