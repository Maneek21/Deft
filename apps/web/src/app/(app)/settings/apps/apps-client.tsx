'use client';

import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { AppWindow, Check, Copy, FileUp, Loader2, Power, ShieldCheck, X } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { AttachmentAppUpgrade } from '@/components/apps/attachment-app-upgrade';
import { InstallationUpgradeTrust } from '@/components/apps/installation-upgrade-trust';
import { attachmentUpgradeInspectionTarget,attachmentUpgradeStageRequest,parseAttachmentUpgradeStaged,type AttachmentUpgradeTarget } from '@/lib/app-attachment-upgrade';
import { ConnectedAppManagement } from '@/components/apps/connected-app-management';
import { ResourceAppReview } from '@/components/apps/resource-app-review';
import { AttachmentAppReview } from '@/components/apps/attachment-app-review';
import { RuntimeAppSetup } from '@/components/apps/runtime-app-setup';
import { AppInstallationStatus } from '@/components/apps/app-management-summary';
import { PublicCancellationOwnerPanel } from '@/components/apps/public-cancellation-owner-panel';
import { AppsHomeLists, AppsSearch, BuildYourOwnPanel } from '@/components/apps/home/apps-home';
import { ModuleUploadReview } from '@/components/apps/home/module-upload-review';
import type { AgentAccess } from '@/components/apps/home/app-tiles';
import { useSetPageContext } from '@/components/app-header-context';
import { api } from '@/lib/api';
import { APPS_ENABLED, APP_RESOURCE_SYNC_ENABLED, APP_ATTACHMENT_BROKER_ENABLED } from '@/lib/feature-flags';
import { useAuth } from '@/lib/auth-context';
import { appApiError, canEnableAppWithoutReview, canStageConnectedUpgrade, isConnectedAppManifest, normalizeAppInspection, type AppInspection, type AppInstallation } from '@/lib/apps';
import {
  moduleApiError,
  previewModuleManifestJson,
  type BundledModule,
  type ModuleInstallation,
  type ModuleManifestPreview,
  type ModuleManifestUploadDecision,
} from '@/lib/modules';
import {
  APP_PACKAGE_INSPECT_REQUEST,
  buildAppsHome,
  checkAppUploadFile,
  classifyAppUpload,
  developerPairingAvailable,
  moduleUploadRequest,
  planModuleUpload,
  readableManifestError,
} from '@/lib/app-upload-routing';
import { refreshApps, useAppRealtime, useApps } from '@/hooks/use-apps';
import { refreshModuleCaches, useBundledModules, useInstalledModules, useModuleRealtime } from '@/hooks/use-modules';

type UploadTarget = { kind: 'module'; module: ModuleInstallation } | { kind: 'package'; app: AppInstallation } | null;
type PendingModule = { source: string; preview: ModuleManifestPreview; decision: ModuleManifestUploadDecision };
type Message = { tone: 'error' | 'success'; text: string; href?: string; hrefLabel?: string };

const errorText = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;

export function AppsClient({ selectedId }: { selectedId?: string } = {}) {
  const { user } = useAuth();
  const { apps, isLoading, error, mutate, data: appsResponse } = useApps();
  const installedModules = useInstalledModules();
  const bundledModules = useBundledModules();
  useAppRealtime();
  useModuleRealtime();
  useSetPageContext(<span className="text-[0.875rem] font-semibold">Settings · Apps</span>, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{
    source: string;
    inspection: AppInspection;
    upgradeTarget: AppInstallation | null;
  } | null>(null);
  const [pendingModule, setPendingModule] = useState<PendingModule | null>(null);
  const uploadTargetRef = useRef<UploadTarget>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [attachmentUpgrade,setAttachmentUpgrade]=useState<{installation_id:string;target:AttachmentUpgradeTarget}|null>(null);
  const [pairing, setPairing] = useState<{ code: string; expires_at: string } | null>(null);
  const [query, setQuery] = useState('');
  const selectedApp = apps.find((app) => app.id === selectedId);
  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const pairingAvailable = APPS_ENABLED && developerPairingAvailable(appsResponse);
  const home = useMemo(() => buildAppsHome({
    modules: installedModules.modules,
    bundled: bundledModules.modules,
    apps,
    query,
  }), [installedModules.modules, bundledModules.modules, apps, query]);

  const choosePackage = (target: UploadTarget = null) => {
    uploadTargetRef.current = target;
    setMessage(null);
    inputRef.current?.click();
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    const target = uploadTargetRef.current;
    uploadTargetRef.current = null;
    event.currentTarget.value = '';
    if (!file) return;
    setPending(null); setPendingModule(null); setMessage(null);
    try {
      checkAppUploadFile(file);
      const source = await file.text();
      const upload = classifyAppUpload(source, { appPackagesEnabled: APPS_ENABLED });
      if (upload.kind === 'module') {
        if (target?.kind === 'package') throw new Error(`This is an app file, not an App Kit package. Choose a new package for ${target.app.name}.`);
        const preview = await previewModuleManifestJson(source).catch((reason: unknown) => { throw new Error(readableManifestError(reason, source)); });
        const decision = planModuleUpload(preview, installedModules.modules, target?.kind === 'module' ? target.module.id : null);
        setPendingModule({ source, preview, decision });
        return;
      }
      if (target?.kind === 'module') throw new Error(`This is an App Kit package. To update ${target.module.manifest.name || target.module.slug}, choose its app file.`);
      await inspectPackage(source, target?.kind === 'package' ? target.app : null);
    } catch (reason) {
      setMessage({ tone: 'error', text: errorText(reason, 'Deft could not read this file.') });
    }
  };

  const inspectPackage = async (source: string, requestedTarget: AppInstallation | null) => {
    let upgradeTarget = requestedTarget;
    const response = await api.fetch(APP_PACKAGE_INSPECT_REQUEST.path, { method: 'POST', headers: { ...APP_PACKAGE_INSPECT_REQUEST.headers }, body: source });
    if (!response.ok) throw new Error(await appApiError(response, 'Unable to inspect this App package.'));
    const inspection = normalizeAppInspection(await response.json());
    upgradeTarget = attachmentUpgradeInspectionTarget(inspection,apps,upgradeTarget);
    if (upgradeTarget && inspection.manifest.id !== upgradeTarget.app_id) {
      throw new Error(`This package is ${inspection.manifest.id}; choose an upgrade for ${upgradeTarget.app_id}.`);
    }
    if (upgradeTarget && inspection.manifest.compatibility.app_protocol === '0') {
      throw new Error('Connected App upgrades require an App Protocol v1 package.');
    }
    setPending({ source, inspection, upgradeTarget });
  };

  const confirmModule = async () => {
    if (!pendingModule) return;
    const { decision, preview, source } = pendingModule;
    setBusy(preview.slug); setMessage(null);
    try {
      const request = moduleUploadRequest(decision);
      const response = await api.fetch(request.path, { method: 'POST', headers: request.headers, body: source });
      if (!response.ok) {
        throw new Error(await moduleApiError(response, decision.mode === 'upgrade' ? `Unable to update ${preview.name}.` : `Unable to install ${preview.name}.`));
      }
      await refreshModuleCaches(preview.slug);
      setPendingModule(null);
      setMessage(decision.mode === 'upgrade'
        ? { tone: 'success', text: `${preview.name} is updated to v${preview.version}. Every record was kept.` }
        : { tone: 'success', text: `${preview.name} is installed.`, href: `/modules/${encodeURIComponent(preview.slug)}`, hrefLabel: `Open ${preview.name}` });
    } catch (reason) {
      setMessage({ tone: 'error', text: errorText(reason, 'Unable to apply this app file.') });
    } finally { setBusy(null); }
  };

  const installBundled = async (module: BundledModule) => {
    setBusy(module.slug); setMessage(null);
    try {
      const response = await api.post(`/api/modules/bundled/${encodeURIComponent(module.slug)}/install`);
      if (!response.ok) throw new Error(await moduleApiError(response, `Unable to install ${module.name}.`));
      await refreshModuleCaches(module.slug);
      setMessage({ tone: 'success', text: `${module.name} is installed.`, href: `/modules/${encodeURIComponent(module.slug)}`, hrefLabel: `Open ${module.name}` });
    } catch (reason) {
      setMessage({ tone: 'error', text: errorText(reason, `Unable to install ${module.name}.`) });
    } finally { setBusy(null); }
  };

  const updateModule = async (module: ModuleInstallation, patch: { enabled?: boolean; agent_access?: AgentAccess }) => {
    const name = module.manifest.name || module.slug;
    setBusy(module.slug); setMessage(null);
    try {
      const response = await api.patch(`/api/modules/${encodeURIComponent(module.slug)}`, patch);
      if (!response.ok) throw new Error(await moduleApiError(response, `Unable to update ${name}.`));
      await refreshModuleCaches(module.slug);
      setMessage({ tone: 'success', text: patch.enabled === undefined
        ? patch.agent_access === 'none' ? `Defty and agents can no longer use ${name}.` : `Defty and agents can now ${patch.agent_access === 'write' ? 'read and change' : 'read'} ${name} records. Their changes still wait for approval.`
        : patch.enabled ? `${name} is on again.` : `${name} is off. Its records are kept, and you can turn it back on at any time.` });
    } catch (reason) {
      setMessage({ tone: 'error', text: errorText(reason, `Unable to update ${name}.`) });
    } finally { setBusy(null); }
  };

  const updateBundledVersion = async (module: ModuleInstallation) => {
    const name = module.manifest.name || module.slug;
    setBusy(module.slug); setMessage(null);
    try {
      const response = await api.post(`/api/modules/bundled/${encodeURIComponent(module.slug)}/update`);
      if (!response.ok) throw new Error(await moduleApiError(response, `Unable to update ${name}.`));
      await refreshModuleCaches(module.slug);
      setMessage({ tone: 'success', text: `${name} is updated. Every record was kept.` });
    } catch (reason) {
      setMessage({ tone: 'error', text: errorText(reason, `Unable to update ${name}.`) });
    } finally { setBusy(null); }
  };

  const stage = async () => {
    if (!pending) return;
    setBusy('stage'); setMessage(null);
    try {
      const attachment = pending.inspection.manifest.schema_version === '7';
      if (attachment && !APP_ATTACHMENT_BROKER_ENABLED) throw new Error('Attachment Apps are disabled on this host.');
      const attachmentUpgradeRequest = attachment && pending.upgradeTarget ? attachmentUpgradeStageRequest(pending.source,pending.inspection,pending.upgradeTarget) : null;
      const path = attachmentUpgradeRequest?.path ?? (attachment ? '/api/apps/blob/composition/stage' : pending.upgradeTarget
        ? `/api/apps/${encodeURIComponent(pending.upgradeTarget.id)}/upgrades/stage?expected_lifecycle_epoch=${pending.upgradeTarget.lifecycle_epoch}`
        : '/api/apps/stage');
      const response = await api.fetch(path, { method: 'POST', headers: { 'Content-Type': attachment ? 'application/json' : 'application/vnd.deft.app.package+json' }, body: attachmentUpgradeRequest ? JSON.stringify(attachmentUpgradeRequest.body) : pending.source });
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to stage this App.'));
      if (attachmentUpgradeRequest && pending.upgradeTarget) {const versionId=parseAttachmentUpgradeStaged(await response.json(),pending.upgradeTarget.id);setAttachmentUpgrade({installation_id:pending.upgradeTarget.id,target:{version_id:versionId,package_digest:pending.inspection.package_digest,version:pending.inspection.manifest.version}});}
      await refreshApps();
      const connected = pending.inspection.manifest.compatibility.app_protocol !== '0';
      setPending(null);
      setMessage({ tone: 'success', text: pending.upgradeTarget
        ? `${pending.inspection.manifest.name} ${pending.inspection.manifest.version} staged for explicit upgrade review.`
        : connected
          ? 'Connected App staged for explicit authority review.'
          : 'App staged with no permissions and no workspace navigation.' });
    } catch (reason) { if(pending.upgradeTarget&&pending.inspection.manifest.schema_version==='7'){setPending(null);setMessage({tone:'error',text:'Upgrade staging was not confirmed. Check staged versions before staging again.'});}else setMessage({ tone: 'error', text: reason instanceof Error ? reason.message : 'Unable to stage App.' }); }
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

  const enable = async (app: AppInstallation) => {
    setBusy(app.id); setMessage(null);
    try {
      const response = await api.post(`/api/apps/${encodeURIComponent(app.id)}/enable`, { expected_lifecycle_epoch: app.lifecycle_epoch });
      if (!response.ok) throw new Error(await appApiError(response, 'Unable to re-enable this App.'));
      await refreshApps(); setMessage({ tone: 'success', text: `${app.name} ${app.version} is active again. Connected upgrades still require review.` });
    } catch (reason) { setMessage({ tone: 'error', text: reason instanceof Error ? reason.message : 'Unable to re-enable App.' }); }
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

  const listLoading = (installedModules.isLoading && !installedModules.data) || (isLoading && !appsResponse);
  const listFailed = Boolean(installedModules.error) && (!APPS_ENABLED || Boolean(error));
  const retry = () => { void installedModules.mutate(); void bundledModules.mutate(); void mutate(); };

  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
    <input ref={inputRef} type="file" accept="application/json,.json" onChange={(event) => void handleFile(event)} className="sr-only" aria-label="Choose an app file" tabIndex={-1} />
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-3 md:px-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="sr-only md:not-sr-only md:pt-2"><h1 className="text-[1.5rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Apps</h1><p className="mt-1 text-[0.875rem]" style={{ color: 'var(--on-surface-variant)' }}>Add apps that come with Deft, or build your own.</p></header>
        {message && <div role={message.tone === 'error' ? 'alert' : 'status'} className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-[0.8125rem]" style={{ background: message.tone === 'error' ? 'var(--danger-subtle)' : 'rgba(48,164,108,.12)', color: message.tone === 'error' ? 'var(--error)' : 'var(--status-green)' }}>
          <p className="min-w-0 flex-1 whitespace-pre-line break-words leading-relaxed">{message.text}{message.href && <> <Link href={message.href} className="font-semibold underline underline-offset-2">{message.hrefLabel}</Link></>}</p>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss message" className="-my-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md"><X size={14} aria-hidden /></button>
        </div>}
        {pairing && <section className="rounded-xl p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }} aria-label="One-time developer pairing">
          <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">One-time Codex pairing</h2><p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>Enter this only in the CLI prompt. It expires at {new Date(pairing.expires_at).toLocaleTimeString()} and cannot be replayed.</p></div><button type="button" onClick={() => setPairing(null)} aria-label="Dismiss pairing"><X size={16} /></button></div>
          <div className="mt-3 flex items-center gap-2"><code className="rounded-lg px-3 py-2 text-base font-semibold tracking-widest" style={{ background: 'var(--surface-container-high)' }}>{pairing.code}</code><button type="button" className="deft-pill" onClick={() => void navigator.clipboard.writeText(pairing.code)}><Copy size={13} /> Copy</button></div>
        </section>}
        {pendingModule && <ModuleUploadReview preview={pendingModule.preview} decision={pendingModule.decision} busy={busy === pendingModule.preview.slug} onCancel={() => setPendingModule(null)} onConfirm={() => void confirmModule()} />}
        {pending && <InspectionCard pending={pending.inspection} upgradeTarget={pending.upgradeTarget} busy={busy === 'stage'} onCancel={() => setPending(null)} onStage={() => void stage()} />}
        {selectedId ? (
          isLoading ? <div className="flex min-h-48 items-center justify-center"><Loader2 className="animate-spin" aria-label="Loading Apps" /></div>
          : error ? <EmptyState icon={<AppWindow size={20} />} title="Apps did not load" description={error instanceof Error ? error.message : 'Try again.'} action={{ label: 'Try again', onClick: () => void mutate() }} />
          : !selectedApp ? <div className="space-y-3"><p>This App is unavailable in this workspace.</p><Link href="/settings/apps" className="deft-pill">All Apps</Link></div>
          : <>
            <Link href="/settings/apps" className="deft-pill min-h-11">← All Apps</Link>
            <AppCard key={selectedApp.id} app={selectedApp} canManage={canManage} busy={busy === selectedApp.id} onActivate={() => void activate(selectedApp)} onEnable={() => void enable(selectedApp)} onDisable={() => void disable(selectedApp)} onChooseUpgrade={() => choosePackage({ kind: 'package', app: selectedApp })} attachmentUpgrade={attachmentUpgrade?.installation_id===selectedApp.id?attachmentUpgrade.target:undefined} />
            {canManage && ['3', '4', '5', '6', '7'].includes(selectedApp.manifest.schema_version) && <InstallationUpgradeTrust key={selectedApp.id} installationId={selectedApp.id} />}
            {selectedApp.manifest.schema_version === '6' && <PublicCancellationOwnerPanel installationId={selectedApp.id} />}
          </>
        ) : <>
          <BuildYourOwnPanel canManage={canManage} busy={busy !== null} pairingAvailable={pairingAvailable} onUpload={() => choosePackage()} onPair={() => void createPairing()} />
          {canManage && APP_RESOURCE_SYNC_ENABLED && <Link className="deft-pill min-h-11" href="/settings/apps/private-resources">Your private App resources</Link>}
          {listLoading ? <div className="flex min-h-48 items-center justify-center"><Loader2 className="animate-spin" aria-label="Loading apps" style={{ color: 'var(--primary)' }} /></div>
            : listFailed ? <EmptyState icon={<AppWindow size={20} />} title="Apps did not load" description={errorText(installedModules.error, 'Try again.')} action={{ label: 'Try again', onClick: retry }} />
            : <>
              {(installedModules.error || (APPS_ENABLED && error) || bundledModules.error) && <p role="alert" className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[0.75rem]" style={{ background: 'var(--warning-subtle)', color: 'var(--on-surface)' }}>
                Some apps did not load, so this list may be incomplete.
                <button type="button" onClick={retry} className="font-semibold underline underline-offset-2">Try again</button>
              </p>}
              {home.total > 4 && <AppsSearch value={query} onChange={setQuery} />}
              <AppsHomeLists home={home} query={query} canManage={canManage} busyKey={busy} handlers={{
                onUpload: () => choosePackage(),
                onInstallBundled: (module) => void installBundled(module),
                onToggleModule: (module) => void updateModule(module, { enabled: !module.enabled }),
                onAgentAccess: (module, value) => void updateModule(module, { agent_access: value }),
                onUploadVersion: (module) => choosePackage({ kind: 'module', module }),
                onBundledUpdate: (module) => void updateBundledVersion(module),
              }} />
            </>}
        </>}
      </div>
    </div>
  </div>;
}

function InspectionCard({ pending, upgradeTarget, busy, onCancel, onStage }: { pending: AppInspection; upgradeTarget: AppInstallation | null; busy: boolean; onCancel: () => void; onStage: () => void }) {
  const connectedManifest = isConnectedAppManifest(pending.manifest) ? pending.manifest : null;
  const connected = Boolean(connectedManifest);
  const runtime = pending.manifest.compatibility.app_protocol === '3'
    || pending.manifest.compatibility.app_protocol === '4'
    || pending.manifest.compatibility.app_protocol === '5' || pending.manifest.compatibility.app_protocol === '7';
  return <section className="rounded-xl p-4" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--primary)' }}>
    <div className="flex items-start gap-3"><ShieldCheck size={20} style={{ color: 'var(--status-green)' }} /><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">Review {pending.manifest.name}{upgradeTarget ? ' upgrade' : ''}</h2><p className="mt-1 text-xs" style={{ color: 'var(--on-surface-variant)' }}>{pending.manifest.description ?? (pending.manifest.schema_version === '6' ? 'App with declared native Calendar actions.' : 'Declarative workspace App.')}</p></div></div>
    <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2"><Fact label="Identity" value={`${pending.manifest.id}@${pending.manifest.version}`} /><Fact label="Protocol" value={`App v${pending.manifest.compatibility.app_protocol}`} /><Fact label="Package format" value={pending.package_format} /><Fact label="License" value={pending.manifest.license} /><Fact label="Provenance" value={pending.manifest.provenance ? `Unsigned local · unverified ${pending.manifest.provenance.source_repository}@${pending.manifest.provenance.source_commit}` : 'Unsigned local package · no source attestation'} /><Fact label="Package digest" value={pending.package_digest} mono /></dl>
    {upgradeTarget && <p className="mt-3 rounded-lg px-3 py-2 text-[11px]" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>This stages {pending.manifest.version} beside active {upgradeTarget.version}. The active version and authority remain unchanged until an owner completes the exact upgrade review.</p>}
    <div className="mt-4"><h3 className="text-xs font-semibold">Exact included Modules</h3><ul className="mt-2 space-y-1">{pending.manifest.modules.map((module) => <li key={`${module.module_id}@${module.version}`} className="rounded-md px-2 py-1.5 font-mono text-[10px]" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>{module.module_id}@{module.version} · {module.manifest_digest}</li>)}</ul></div>
    <div className="mt-4 rounded-lg p-3" style={{ background: 'var(--surface-container-high)' }}><p className="flex items-center gap-2 text-xs font-semibold"><Check size={14} style={{ color: 'var(--status-green)' }} /> {connected || runtime || pending.manifest.schema_version === '6' ? 'No authority before review' : 'No connected permissions'}</p><p className="mt-1 text-[11px]" style={{ color: 'var(--on-surface-variant)' }}>{connectedManifest ? `Staging grants no authority. Owners must bind ${connectedManifest.connector_requirements.length} connector requirement${connectedManifest.connector_requirements.length === 1 ? '' : 's'} and accept Deft’s host policy before activation.` : pending.manifest.schema_version === '6' ? 'Declared native actions do not grant access. Exact App review and current Calendar owner binding consent govern native effects.' : runtime ? 'Staging grants no Runtime authority. An owner must review the exact version, grant and host policy before activation.' : `Staging grants no authority and adds no navigation. Activation installs ${pending.manifest.modules.length} exact Module artifact${pending.manifest.modules.length === 1 ? '' : 's'}.`}</p></div>
    <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" className="deft-pill min-h-11" onClick={onCancel}>Cancel</button><button type="button" className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }} disabled={busy} onClick={onStage}>{busy && <Loader2 size={13} className="animate-spin" />} {upgradeTarget ? 'Stage upgrade for review' : connected || runtime || pending.manifest.schema_version === '6' ? 'Stage for review' : 'Stage with no rights'}</button></div>
  </section>;
}

function AppCard({ app, canManage, busy, onActivate, onEnable, onDisable, onChooseUpgrade, attachmentUpgrade }: { attachmentUpgrade?:AttachmentUpgradeTarget; app: AppInstallation; canManage: boolean; busy: boolean; onActivate: () => void; onEnable: () => void; onDisable: () => void; onChooseUpgrade: () => void }) {
  const connected = isConnectedAppManifest(app.manifest);
  const runtime = app.manifest.compatibility.app_protocol === '3'
    || app.manifest.compatibility.app_protocol === '4'
    || app.manifest.compatibility.app_protocol === '5' || app.manifest.compatibility.app_protocol === '7';
  const showConnectedManagement = connected || canStageConnectedUpgrade(app);
  return <article className={`flex min-h-56 min-w-0 flex-col rounded-xl p-4 ${connected || runtime ? 'md:col-span-2' : ''}`} style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}>
    <div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-active)', color: 'var(--primary)' }}><AppWindow size={20} /></span><div className="min-w-0 flex-1"><h2 className="break-words text-base font-semibold">{app.name}</h2><AppInstallationStatus state={app.state} /><p className="mt-1 text-xs" style={{ color: 'var(--outline)' }}>Version {app.version}</p></div></div>
    {app.manifest.description && <p className="mt-3 text-xs leading-5" style={{ color: 'var(--on-surface-variant)' }}>{app.manifest.description}</p>}
    {!connected && !runtime && <div className="mt-auto flex items-center justify-between gap-3 pt-4"><span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--status-green)' }}><ShieldCheck size={13} /> {app.manifest.schema_version === '6' ? `${app.manifest.native_actions.length} declared native Calendar actions; current owner bindings govern access` : 'No connected permissions'}</span>{canManage && app.state === 'staged' ? <button type="button" className="deft-pill min-h-11 text-white" style={{ background: 'var(--primary-container)' }} disabled={busy} onClick={onActivate}>{busy && <Loader2 size={13} className="animate-spin" />} Activate</button> : canManage && app.state === 'active' ? <button type="button" className="deft-pill min-h-11" disabled={busy} onClick={onDisable}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} Disable</button> : canManage && canEnableAppWithoutReview(app) ? <button type="button" className="deft-pill min-h-11" disabled={busy} onClick={onEnable}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} Re-enable version {app.version}</button> : null}</div>}
    {runtime && <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
      {app.state === 'active' && (app.manifest.schema_version === '4' || app.manifest.schema_version === '5' || app.manifest.schema_version === '6' || app.manifest.schema_version === '7') && app.manifest.experiences.map((experience) =>
        <Link key={experience.key} className="deft-pill min-h-11" href={`/apps/${encodeURIComponent(app.id)}/${encodeURIComponent(experience.key)}`}>Open {experience.label}</Link>)}
      {canManage && APP_RESOURCE_SYNC_ENABLED && app.state === 'active' && (app.manifest.schema_version === '5' || app.manifest.schema_version === '7') && app.manifest.sync_descriptors.length > 0 && <Link className="deft-pill min-h-11" style={{ minHeight: 44 }} href="/settings/apps/private-resources">Manage connections</Link>}
    </div>}
    {canManage && APP_RESOURCE_SYNC_ENABLED && ['staged', 'disabled'].includes(app.state) && app.manifest.schema_version === '5' && app.manifest.runtime_actions.length === 0 && app.manifest.sync_descriptors.length > 0 && <ResourceAppReview app={app} />}
    {canManage && APP_ATTACHMENT_BROKER_ENABLED && ['staged', 'disabled'].includes(app.state) && app.manifest.schema_version === '7' && <AttachmentAppReview app={app} />}
    {runtime && canManage && app.state === 'active' && <details className="mt-4 border-t pt-2"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">App administration</summary><div className="space-y-3 pt-2">
      <p className="text-xs" style={{ color: 'var(--on-surface-variant)' }}>Connection and sync status are shown inside the app. Use these controls to manage actions and installed updates.</p>
      <div className="flex flex-wrap gap-2">{APP_ATTACHMENT_BROKER_ENABLED && app.manifest.schema_version==='7' && <button type="button" className="deft-pill min-h-11" disabled={busy} onClick={onChooseUpgrade}><FileUp size={13}/> Stage upgrade</button>}
      <button type="button" className="deft-pill min-h-11" disabled={busy} onClick={onDisable}><Power size={13} /> Disable</button></div>
      {APP_ATTACHMENT_BROKER_ENABLED && app.manifest.schema_version === '7' && app.manifest.runtime_actions.length > 0 && <RuntimeAppSetup app={app} />}
      {APP_ATTACHMENT_BROKER_ENABLED && app.manifest.schema_version==='7' && <AttachmentAppUpgrade app={app} seed={attachmentUpgrade}/>}
    </div></details>}
    {showConnectedManagement && <ConnectedAppManagement app={app} canManage={canManage} busy={busy} onDisable={onDisable} onChooseUpgrade={onChooseUpgrade} />}
    <details className="mt-3"><summary className="min-h-11 cursor-pointer py-3 text-xs">Package details</summary><dl className="grid gap-3 py-2 text-xs sm:grid-cols-2"><Fact label="App identity" value={`${app.app_id}@${app.version}`} /><Fact label="Protocol" value={`v${app.manifest.compatibility.app_protocol}`} /><Fact label="Included modules" value={String(app.manifest.modules.length)} /><Fact label="License" value={app.manifest.license} /></dl></details>
  </article>;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="min-w-0"><dt style={{ color: 'var(--outline)' }}>{label}</dt><dd className={`mt-0.5 break-words [overflow-wrap:anywhere] ${mono ? 'font-mono text-[10px]' : 'font-medium'}`}>{value}</dd></div>; }
