'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { AppWindow, Check, Copy, FileUp, KeyRound, Loader2, Power, ShieldCheck, X } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { ConnectedAppManagement } from '@/components/apps/connected-app-management';
import { useSetPageContext } from '@/components/app-header-context';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { APP_PACKAGE_MAX_BYTES, appApiError, isConnectedAppManifest, normalizeAppInspection, type AppInspection, type AppInstallation } from '@/lib/apps';
import { refreshApps, useAppRealtime, useApps } from '@/hooks/use-apps';

export function AppsClient() {
  const { user } = useAuth();
  const { apps, isLoading, error, mutate } = useApps();
  useAppRealtime();
  useSetPageContext(<span className="text-[0.875rem] font-semibold">Settings · Apps</span>, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{
    source: string;
    inspection: AppInspection;
    upgradeTarget: AppInstallation | null;
  } | null>(null);
  const uploadTargetRef = useRef<AppInstallation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expires_at: string } | null>(null);
  const canManage = user?.role === 'owner' || user?.role === 'admin';

  const choosePackage = (upgradeTarget: AppInstallation | null = null) => {
    uploadTargetRef.current = upgradeTarget;
    setMessage(null);
    inputRef.current?.click();
  };
  const inspect = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    const upgradeTarget = uploadTargetRef.current;
    uploadTargetRef.current = null;
    event.currentTarget.value = '';
    if (!file) return;
    setPending(null); setMessage(null);
    try {
      if (!file.name.endsWith('.json')) throw new Error('Choose the JSON package produced by `deft app build`.');
      if (file.size > APP_PACKAGE_MAX_BYTES) throw new Error('App packages must be 1 MB or smaller.');
      const source = await file.text();
      const response = await api.fetch('/api/apps/inspect', { method: 'POST', headers: { 'Content-Type': 'application/vnd.deft.app.package+json' }, body: source });
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to inspect this App package.'));
      const inspection = normalizeAppInspection(await response.json());
      if (upgradeTarget && inspection.manifest.id !== upgradeTarget.app_id) {
        throw new Error(`This package is ${inspection.manifest.id}; choose an upgrade for ${upgradeTarget.app_id}.`);
      }
      if (upgradeTarget && inspection.manifest.compatibility.app_protocol === '0') {
        throw new Error('Connected App upgrades require an App Protocol v1 package.');
      }
      setPending({ source, inspection, upgradeTarget });
    } catch (reason) { setMessage({ tone: 'error', text: reason instanceof Error ? reason.message : 'Unable to inspect App.' }); }
  };

  const stage = async () => {
    if (!pending) return;
    setBusy('stage'); setMessage(null);
    try {
      const path = pending.upgradeTarget
        ? `/api/apps/${encodeURIComponent(pending.upgradeTarget.id)}/upgrades/stage?expected_lifecycle_epoch=${pending.upgradeTarget.lifecycle_epoch}`
        : '/api/apps/stage';
      const response = await api.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/vnd.deft.app.package+json' }, body: pending.source });
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to stage this App.'));
      await refreshApps();
      const connected = pending.inspection.manifest.compatibility.app_protocol !== '0';
      setPending(null);
      setMessage({ tone: 'success', text: pending.upgradeTarget
        ? `${pending.inspection.manifest.name} ${pending.inspection.manifest.version} staged for explicit upgrade review.`
        : connected
          ? 'Connected App staged for explicit authority review.'
          : 'App staged with no permissions and no workspace navigation.' });
    } catch (reason) { setMessage({ tone: 'error', text: reason instanceof Error ? reason.message : 'Unable to stage App.' }); }
    finally { setBusy(null); }
  };

  const activate = async (app: AppInstallation) => {
    setBusy(app.id); setMessage(null);
    try {
      const response = await api.post(`/api/apps/${encodeURIComponent(app.id)}/activate`, { expected_package_digest: app.package_digest });
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to activate this App.'));
      await refreshApps(); setMessage({ tone: 'success', text: `${app.name} is active in the workspace.` });
    } catch (reason) { setMessage({ tone: 'error', text: reason instanceof Error ? reason.message : 'Unable to activate App.' }); }
    finally { setBusy(null); }
  };

  const disable = async (app: AppInstallation) => {
    setBusy(app.id); setMessage(null);
    try {
      const response = await api.post(`/api/apps/${encodeURIComponent(app.id)}/disable`, { expected_lifecycle_epoch: app.lifecycle_epoch });
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to disable this App.'));
      await refreshApps(); setMessage({ tone: 'success', text: `${app.name} is disabled. Its data is preserved.` });
    } catch (reason) { setMessage({ tone: 'error', text: reason instanceof Error ? reason.message : 'Unable to disable App.' }); }
    finally { setBusy(null); }
  };

  const createPairing = async () => {
    setBusy('pairing'); setMessage(null);
    try {
      const response = await api.post('/api/apps/pairings');
      if (!response.ok) throw new Error(await appApiError(response, 'Developer pairing is unavailable.'));
      const body = await response.json() as { pairing: { code: string; expires_at: string } };
      setPairing(body.pairing);
    } catch (reason) { setMessage({ tone: 'error', text: reason instanceof Error ? reason.message : 'Unable to create pairing.' }); }
    finally { setBusy(null); }
  };

  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
    <PageHeader title="Apps" description="Expand this workspace with local, declarative App packages." compact secondary={canManage ? <div className="flex gap-2 px-1">
      <button type="button" onClick={() => void createPairing()} disabled={busy !== null} className="deft-pill min-h-11"><KeyRound size={14} /> Pair Codex</button>
      <button type="button" onClick={() => choosePackage()} disabled={busy !== null} className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }}><FileUp size={14} /> Inspect package</button>
    </div> : undefined} />
    <input ref={inputRef} type="file" accept="application/json,.json" onChange={(event) => void inspect(event)} className="sr-only" aria-label="Choose a Deft App package" />
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-3 md:px-6">
      <div className="mx-auto max-w-5xl space-y-4">
        {message && <div role={message.tone === 'error' ? 'alert' : 'status'} className="rounded-lg px-3 py-2 text-[13px]" style={{ background: message.tone === 'error' ? 'var(--danger-subtle)' : 'rgba(48,164,108,.12)', color: message.tone === 'error' ? 'var(--error)' : 'var(--status-green)' }}>{message.text}</div>}
        {pairing && <section className="rounded-xl p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }} aria-label="One-time developer pairing">
          <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">One-time Codex pairing</h2><p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>Enter this only in the CLI prompt. It expires at {new Date(pairing.expires_at).toLocaleTimeString()} and cannot be replayed.</p></div><button type="button" onClick={() => setPairing(null)} aria-label="Dismiss pairing"><X size={16} /></button></div>
          <div className="mt-3 flex items-center gap-2"><code className="rounded-lg px-3 py-2 text-base font-semibold tracking-widest" style={{ background: 'var(--surface-container-high)' }}>{pairing.code}</code><button type="button" className="deft-pill" onClick={() => void navigator.clipboard.writeText(pairing.code)}><Copy size={13} /> Copy</button></div>
        </section>}
        {pending && <InspectionCard pending={pending.inspection} upgradeTarget={pending.upgradeTarget} busy={busy === 'stage'} onCancel={() => setPending(null)} onStage={() => void stage()} />}
        {isLoading ? <div className="flex min-h-48 items-center justify-center"><Loader2 className="animate-spin" aria-label="Loading Apps" /></div>
          : error ? <EmptyState icon={<AppWindow size={20} />} title="Apps did not load" description={error instanceof Error ? error.message : 'Try again.'} action={{ label: 'Try again', onClick: () => void mutate() }} />
          : apps.length === 0 ? <EmptyState icon={<AppWindow size={20} />} title="No Apps installed" description="Build a declarative App with the public kit, then inspect its package here." action={canManage ? { label: 'Inspect a package', onClick: () => choosePackage() } : undefined} />
          : <div className="grid gap-3 md:grid-cols-2">{apps.map((app) => <AppCard key={app.id} app={app} canManage={canManage} busy={busy === app.id} onActivate={() => void activate(app)} onDisable={() => void disable(app)} onChooseUpgrade={() => choosePackage(app)} />)}</div>}
      </div>
    </div>
  </div>;
}

function InspectionCard({ pending, upgradeTarget, busy, onCancel, onStage }: { pending: AppInspection; upgradeTarget: AppInstallation | null; busy: boolean; onCancel: () => void; onStage: () => void }) {
  const connectedManifest = isConnectedAppManifest(pending.manifest) ? pending.manifest : null;
  const connected = Boolean(connectedManifest);
  return <section className="rounded-xl p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--primary)' }}>
    <div className="flex items-start gap-3"><ShieldCheck size={20} style={{ color: 'var(--status-green)' }} /><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">Review {pending.manifest.name}{upgradeTarget ? ' upgrade' : ''}</h2><p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>{pending.manifest.description ?? 'Declarative workspace App.'}</p></div></div>
    <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2"><Fact label="Identity" value={`${pending.manifest.id}@${pending.manifest.version}`} /><Fact label="Protocol" value={`App v${pending.manifest.compatibility.app_protocol}`} /><Fact label="Package format" value={pending.package_format} /><Fact label="License" value={pending.manifest.license} /><Fact label="Provenance" value={pending.manifest.provenance ? `Unsigned local · unverified ${pending.manifest.provenance.source_repository}@${pending.manifest.provenance.source_commit}` : 'Unsigned local package · no source attestation'} /><Fact label="Package digest" value={pending.package_digest} mono /></dl>
    {upgradeTarget && <p className="mt-3 rounded-lg px-3 py-2 text-[11px]" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>This stages {pending.manifest.version} beside active {upgradeTarget.version}. The active version and authority remain unchanged until an owner completes the exact upgrade review.</p>}
    <div className="mt-4"><h3 className="text-xs font-semibold">Exact included Modules</h3><ul className="mt-2 space-y-1">{pending.manifest.modules.map((module) => <li key={`${module.module_id}@${module.version}`} className="rounded-md px-2 py-1.5 font-mono text-[10px]" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>{module.module_id}@{module.version} · {module.manifest_digest}</li>)}</ul></div>
    <div className="mt-4 rounded-lg p-3" style={{ background: 'var(--surface-container-high)' }}><p className="flex items-center gap-2 text-xs font-semibold"><Check size={14} style={{ color: 'var(--status-green)' }} /> {connected ? 'No authority before review' : 'No connected permissions'}</p><p className="mt-1 text-[11px]" style={{ color: 'var(--on-surface-variant)' }}>{connectedManifest ? `Staging grants no authority. Owners must bind ${connectedManifest.connector_requirements.length} connector requirement${connectedManifest.connector_requirements.length === 1 ? '' : 's'} and accept Deft’s host policy before activation.` : `Staging grants no authority and adds no navigation. Activation installs ${pending.manifest.modules.length} exact Module artifact${pending.manifest.modules.length === 1 ? '' : 's'}.`}</p></div>
    <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" className="deft-pill min-h-11" onClick={onCancel}>Cancel</button><button type="button" className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }} disabled={busy} onClick={onStage}>{busy && <Loader2 size={13} className="animate-spin" />} {upgradeTarget ? 'Stage upgrade for review' : connected ? 'Stage for review' : 'Stage with no rights'}</button></div>
  </section>;
}

function AppCard({ app, canManage, busy, onActivate, onDisable, onChooseUpgrade }: { app: AppInstallation; canManage: boolean; busy: boolean; onActivate: () => void; onDisable: () => void; onChooseUpgrade: () => void }) {
  const connected = app.manifest.compatibility.app_protocol !== '0';
  const tone = app.state === 'active' ? 'var(--status-green)' : app.state === 'disabled' ? 'var(--outline)' : 'var(--status-amber)';
  return <article className={`flex min-h-56 flex-col rounded-xl p-4 ${connected ? 'md:col-span-2' : ''}`} style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}>
    <div className="flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: 'var(--bg-active)', color: 'var(--primary)' }}><AppWindow size={20} /></span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="truncate text-sm font-semibold">{app.name}</h2><span className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase" style={{ color: tone, background: 'var(--surface-container-high)' }}>{app.state}</span></div><p className="mt-1 truncate font-mono text-[11px]" style={{ color: 'var(--outline)' }}>{app.app_id}@{app.version}</p></div></div>
    <p className="mt-3 line-clamp-2 text-xs leading-5" style={{ color: 'var(--on-surface-variant)' }}>{app.manifest.description ?? 'Declarative workspace App.'}</p>
    <div className="mt-3 text-[11px]" style={{ color: 'var(--outline)' }}>{app.manifest.modules.length} Module{app.manifest.modules.length === 1 ? '' : 's'} · Protocol v{app.manifest.compatibility.app_protocol} · {app.manifest.license}</div>
    {!connected && <div className="mt-auto flex items-center justify-between gap-3 pt-4"><span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--status-green)' }}><ShieldCheck size={13} /> No connected permissions</span>{canManage && app.state === 'staged' ? <button type="button" className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }} disabled={busy} onClick={onActivate}>{busy && <Loader2 size={13} className="animate-spin" />} Activate</button> : canManage && app.state === 'active' ? <button type="button" className="deft-pill min-h-11" disabled={busy} onClick={onDisable}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} Disable</button> : null}</div>}
    {connected && <ConnectedAppManagement app={app} canManage={canManage} busy={busy} onDisable={onDisable} onChooseUpgrade={onChooseUpgrade} />}
  </article>;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="min-w-0"><dt style={{ color: 'var(--outline)' }}>{label}</dt><dd className={`mt-0.5 truncate ${mono ? 'font-mono text-[10px]' : 'font-medium'}`}>{value}</dd></div>; }
