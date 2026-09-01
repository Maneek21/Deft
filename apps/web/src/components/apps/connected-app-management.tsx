'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, FileUp, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { AppRunInspector } from '@/components/apps/app-run-inspector';
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
  onChooseUpgrade,
}: {
  app: AppInstallation;
  canManage: boolean;
  busy: boolean;
  onDisable: () => void;
  onChooseUpgrade: () => void;
}) {
  const grantsState = useAppGrantManagement(app.id, canManage);
  const connectorState = useAppConnectors(canManage);
  const [connectorSelections, setConnectorSelections] = useState<Record<string, string>>({});
  const [review, setReview] = useState<ConnectedAppReview | null>(null);
  const [health, setHealth] = useState<ConnectedAppHealth | null>(null);
  const [acceptedPolicy, setAcceptedPolicy] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [working, setWorking] = useState<'review' | 'activate' | 'health' | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const grants = grantsState.grants;
  const installedManifest = isConnectedAppManifest(app.manifest) ? app.manifest : null;
  const target = grants?.review_target ?? null;
  const manifest = target?.manifest ?? installedManifest;
  const effective = grants?.snapshots.find((snapshot) => snapshot.id === grants.installation.active_grant_snapshot_id) ?? null;
  useEffect(() => {
    if (!target) return;
    setConnectorSelections((current) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const requirement of target.connector_requirements) {
        const selected = current[requirement.key];
        const currentCandidate = requirement.current_binding?.configured
          ? requirement.current_binding.mcp_connection_id
          : null;
        const firstEligible = requirement.candidates.find((candidate) => candidate.eligible_for_review)?.id ?? '';
        const nextSelection = requirement.candidates.some(
          (candidate) => candidate.id === selected && candidate.eligible_for_review,
        ) ? selected : currentCandidate ?? firstEligible;
        next[requirement.key] = nextSelection;
        if (nextSelection !== selected) changed = true;
      }
      return changed || Object.keys(current).length !== Object.keys(next).length ? next : current;
    });
    setReview(null);
    setAcceptedPolicy(false);
  }, [target?.app_version_id, target?.requested_snapshot_digest]);

  const reviewInput = useMemo(() => {
    if (!grants || !target) return null;
    const connectorSelectionsList = target.connector_requirements.map((requirement) => ({
      connector_requirement_key: requirement.key,
      mcp_connection_id: connectorSelections[requirement.key] ?? '',
    }));
    if (connectorSelectionsList.some((selection) => !selection.mcp_connection_id)) return null;
    return {
      app_version_id: target.app_version_id,
      expected_package_digest: target.package_digest,
      expected_requested_snapshot_digest: target.requested_snapshot_digest,
      expected_lifecycle_epoch: grants.installation.lifecycle_epoch,
      expected_grant_epoch: grants.installation.grant_epoch,
      connector_selections: connectorSelectionsList,
    };
  }, [connectorSelections, grants, target]);

  if (!installedManifest) return null;
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
      const verb = target?.activation_kind === 'upgrade'
        ? 'upgraded'
        : target?.activation_kind === 'reenable'
          ? 're-enabled'
          : 'activated';
      setMessage({ tone: 'success', text: `Connected App ${verb} with freshly reviewed authority.` });
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
            <div className="rounded-lg px-3 py-2.5 text-[11px]" style={{ background: 'var(--surface-container-high)' }}>
              <h3 className="font-semibold">Supported local contract</h3>
              <p className="mt-1" style={{ color: 'var(--on-surface-variant)' }}>
                {grants.compatibility.app_kit.package} {grants.compatibility.app_kit.versions.join(', ')} · App Protocol v1 · {grants.compatibility.protocol_flows['1'].package_format} · {grants.compatibility.protocol_flows['1'].install_mode.replaceAll('_', ' ')}
              </p>
              <p className="mt-1" style={{ color: 'var(--outline)' }}>Local packages are unsigned. Source provenance is an unverified author claim, not a registry attestation.</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <AuthorityCard
                title={target ? `${activationLabel(target.activation_kind)} authority` : 'Requested authority'}
                body={target ? `${target.requested_authority.resource_rights.length} resource read${target.requested_authority.resource_rights.length === 1 ? '' : 's'} · ${target.manifest.actions.length} action${target.manifest.actions.length === 1 ? '' : 's'} · ${target.connector_requirements.length} connector${target.connector_requirements.length === 1 ? '' : 's'}` : 'No version is awaiting review'}
                detail={target ? shortDigest(target.requested_snapshot_digest) : 'No pending requested snapshot'}
              />
              <AuthorityCard
                title="Effective authority"
                body={effective ? `${effective.resource_rights.length} resource read${effective.resource_rights.length === 1 ? '' : 's'} · ${grants.action_bindings.length} active binding${grants.action_bindings.length === 1 ? '' : 's'}` : 'No effective authority'}
                detail={effective ? shortDigest(effective.snapshot_digest) : app.state === 'disabled' ? 'Revoked while disabled' : 'Activation is required'}
              />
            </div>

            <div>
              <h3 className="text-xs font-semibold">Package provenance</h3>
              <p className="mt-1 break-all text-[11px]" style={{ color: 'var(--outline)' }}>
                Local unsigned · {manifest?.provenance ? `unverified source claim ${manifest.provenance.source_repository}@${manifest.provenance.source_commit}` : 'no source claim'}
              </p>
            </div>

            {target && <div className="space-y-3">
              <div>
                <h3 className="text-xs font-semibold">Requested resource reads</h3>
                <ul className="mt-2 space-y-1.5 text-[11px]">
                  {target.requested_authority.resource_rights.map((right) => <li key={right.requirement_key} className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-container-high)' }}><span className="font-medium">{right.requirement_key.replaceAll('_', ' ')}</span> · {right.resource_type}<span className="mt-0.5 block" style={{ color: 'var(--outline)' }}>{right.fields.join(', ')}</span></li>)}
                </ul>
              </div>
              <div>
                <h3 className="text-xs font-semibold">Dependency requirements</h3>
                <ul className="mt-2 space-y-1.5 text-[11px]">
                  {target.dependency_requirements.map((dependency) => <li key={dependency.key} className="flex items-start justify-between gap-3 rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-container-high)' }}><span><span className="font-medium">{dependency.key}</span> · {dependency.app_id}@{dependency.version}{dependency.active_version && dependency.active_version !== dependency.version ? <span className="mt-0.5 block" style={{ color: 'var(--outline)' }}>Found {dependency.active_version}</span> : null}</span><RequirementState state={dependency.status} /></li>)}
                </ul>
              </div>
              <div>
                <h3 className="text-xs font-semibold">Capability requirements</h3>
                <ul className="mt-2 space-y-1.5 text-[11px]">
                  {target.manifest.capability_requirements.map((capability) => <li key={capability.key} className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-container-high)' }}><span className="font-medium">{capability.key.replaceAll('_', ' ')}</span><span className="mt-0.5 block font-mono text-[9px]" style={{ color: 'var(--outline)' }}>{capability.interface.namespace}:{capability.interface.key}@{capability.interface.version}</span></li>)}
                </ul>
              </div>
            </div>}

            {target && <div className="space-y-3 rounded-xl p-3" style={{ background: 'var(--surface-container-high)' }}>
              <div><h3 className="text-xs font-semibold">Connector bindings · {activationLabel(target.activation_kind)}</h3><p className="mt-1 text-[11px]" style={{ color: 'var(--outline)' }}>Choose exact configured connectors. Deft refreshes and verifies provider schemas only when you run the review.</p></div>
              {target.connector_requirements.map((requirement) => {
                const eligible = requirement.candidates.filter((candidate) => candidate.eligible_for_review);
                return <label key={requirement.key} className="block text-[11px] font-medium">
                  {requirement.key.replaceAll('_', ' ')} · MCP{requirement.required_operations.length > 0 ? ` · ${requirement.required_operations.join(', ')}` : ''}
                  <select
                    className="mt-1 min-h-11 w-full rounded-lg px-3 text-xs"
                    style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }}
                    value={connectorSelections[requirement.key] ?? ''}
                    onChange={(event) => {
                      setConnectorSelections((current) => ({ ...current, [requirement.key]: event.target.value }));
                      setReview(null); setAcceptedPolicy(false);
                    }}
                  >
                    <option value="">Select a configured connector</option>
                    {requirement.candidates.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={!candidate.eligible_for_review}>{candidate.name}{candidate.eligible_for_review ? '' : ` · ${candidate.status.replaceAll('_', ' ')}`}</option>)}
                  </select>
                  {eligible.length === 0 && <span role="alert" className="mt-1 block" style={{ color: 'var(--error)' }}>No connector currently enables this operation. <Link href="/settings/integrations" className="underline">Configure one</Link>.</span>}
                </label>;
              })}
              {target.missing_binding_keys.length > 0 && <p className="text-[11px]" style={{ color: 'var(--status-amber)' }}>{target.missing_binding_keys.length} requirement{target.missing_binding_keys.length === 1 ? '' : 's'} had no reusable current binding; select and review a connector above.</p>}
              <button type="button" className="deft-pill min-h-11" disabled={!reviewInput || !target.readiness.dependencies_ready || !target.readiness.connector_candidates_ready || working !== null} onClick={() => void runReview()}>{working === 'review' && <Loader2 size={13} className="animate-spin" />} Review exact {target.activation_kind === 'reenable' ? 're-enable' : target.activation_kind} authority</button>
            </div>}

            {target && review && <div className="space-y-3 rounded-xl p-3" style={{ background: review.permission_diff.kind === 'widening_or_incompatible' ? 'var(--danger-subtle)' : 'rgba(48,164,108,.10)', border: '1px solid var(--ghost-border)' }}>
              <div className="flex items-start gap-2"><ShieldCheck size={16} className="mt-0.5 flex-shrink-0" /><div><h3 className="text-xs font-semibold">{permissionDiffLabel(review.permission_diff.kind)}</h3><p className="mt-1 text-[11px]" style={{ color: 'var(--on-surface-variant)' }}>{review.permission_diff.changed_atoms.length === 0 ? 'The reviewed authority matches the prior surface.' : `${review.permission_diff.changed_atoms.length} authority area${review.permission_diff.changed_atoms.length === 1 ? '' : 's'} changed: ${review.permission_diff.changed_atoms.join(', ')}.`}</p></div></div>
              <div className="space-y-1.5 text-[11px]">
                {review.action_bindings.map((binding) => <div key={binding.binding_digest} className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-container-low)' }}><span className="font-medium">{binding.action_key.replaceAll('_', ' ')}</span><span className="block" style={{ color: 'var(--outline)' }}>{connectorName(binding.mcp_connection_id, connectorState.connectors)} · {binding.operation_name}</span></div>)}
              </div>
              <label className="flex min-h-11 items-start gap-2 rounded-lg px-2 py-2 text-[11px]" style={{ background: 'var(--surface-container-low)' }}><input type="checkbox" className="mt-0.5 h-4 w-4" checked={acceptedPolicy} onChange={(event) => setAcceptedPolicy(event.target.checked)} /><span>I accept Deft’s host-owned approval, retention, egress, and retry policy for these exact bindings.</span></label>
              <button type="button" className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }} disabled={!acceptedPolicy || working !== null} onClick={() => void activate()}>{working === 'activate' && <Loader2 size={13} className="animate-spin" />} {activationAction(target.activation_kind)} reviewed App</button>
            </div>}

            {grants.action_bindings.length > 0 && <div><h3 className="text-xs font-semibold">{grants.installation.active_grant_snapshot_id ? 'Effective action bindings' : 'Prior reviewed bindings'}</h3>{!grants.installation.active_grant_snapshot_id && <p className="mt-1 text-[11px]" style={{ color: 'var(--outline)' }}>These bindings are revoked while the App is disabled and are shown only as inputs to a fresh review.</p>}<ul className="mt-2 space-y-1.5">{grants.action_bindings.map((binding) => <li key={binding.id} className="rounded-lg px-2.5 py-2 text-[11px]" style={{ background: 'var(--surface-container-high)' }}><span className="font-medium">{binding.action_key.replaceAll('_', ' ')}</span><span className="block" style={{ color: 'var(--outline)' }}>{connectorName(binding.mcp_connection_id, connectorState.connectors)} · {binding.host_policy.review_requirement.replaceAll('_', ' ')} approval</span></li>)}</ul></div>}

            <div className="flex flex-wrap gap-2">
              {(app.state === 'active' || app.state === 'disabled') && target?.activation_kind !== 'upgrade' && <button type="button" className="deft-pill min-h-11" disabled={busy || working !== null} onClick={onChooseUpgrade}><FileUp size={13} /> Stage upgrade</button>}
              {app.state === 'active' && <button type="button" className="deft-pill min-h-11" disabled={working !== null} onClick={() => void refreshHealth()}>{working === 'health' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh health</button>}
              {app.state === 'active' && <button type="button" className="deft-pill min-h-11" disabled={busy || working !== null} onClick={onDisable}>Disable</button>}
            </div>
            {health && <div role="status" className="rounded-lg px-3 py-2 text-[11px]" style={{ background: health.status === 'healthy' ? 'rgba(48,164,108,.10)' : 'var(--danger-subtle)', color: health.status === 'healthy' ? 'var(--status-green)' : 'var(--error)' }}>
              <p className="flex items-center gap-1.5 font-semibold">{health.status === 'healthy' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {health.status === 'healthy' ? 'Healthy' : `${health.issues.length} health issue${health.issues.length === 1 ? '' : 's'}`}</p>
              {health.issues.length > 0 && <ul className="mt-1 space-y-1">{health.issues.map((issue) => <li key={`${issue.code}:${issue.subject_id}`}>{issue.message}</li>)}</ul>}
            </div>}

            <div><h3 className="text-xs font-semibold">Recent Runs</h3>{grants.recent_runs.length === 0 ? <p className="mt-1 text-[11px]" style={{ color: 'var(--outline)' }}>No App Runs yet.</p> : <ul className="mt-2 space-y-1.5">{grants.recent_runs.slice(0, 5).map((run) => <li key={run.id}><button type="button" className="flex min-h-11 w-full items-start justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[11px]" style={{ background: 'var(--surface-container-high)' }} onClick={() => setSelectedRunId(run.id)}><span className="min-w-0"><span className="block truncate font-medium">{run.title}</span><span className="block truncate" style={{ color: 'var(--outline)' }}>{run.outcome_summary ?? run.summary ?? new Date(run.created_at).toLocaleString()}</span></span><RunState state={run.state} /></button></li>)}</ul>}</div>
          </>}
      <AppRunInspector runId={selectedRunId} onClose={() => setSelectedRunId(null)} />
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

function activationLabel(kind: 'initial' | 'upgrade' | 'reenable'): string {
  if (kind === 'initial') return 'Initial';
  if (kind === 'upgrade') return 'Upgrade';
  return 'Re-enable';
}

function activationAction(kind: 'initial' | 'upgrade' | 'reenable'): string {
  if (kind === 'initial') return 'Activate';
  if (kind === 'upgrade') return 'Upgrade';
  return 'Re-enable';
}

function RequirementState({ state }: { state: 'ready' | 'missing' | 'disabled' | 'version_mismatch' }) {
  const color = state === 'ready' ? 'var(--status-green)' : 'var(--error)';
  return <span className="flex-shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase" style={{ color, background: 'var(--surface-container-low)' }}>{state.replaceAll('_', ' ')}</span>;
}
