'use client';

import { useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { Blocks, Bot, Check, Download, FileUp, Loader2, Power, RefreshCw, X } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { useSetPageContext } from '@/components/app-header-context';
import {
  ModuleErrorState,
  ModuleIcon,
  ModuleLoadingState,
  ModuleStatusBadge,
} from '@/components/modules/module-primitives';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  moduleApiError,
  MODULE_MANIFEST_MAX_BYTES,
  previewModuleManifestJson,
  resolveModuleManifestUpload,
  type BundledModule,
  type ModuleInstallation,
  type ModuleManifestPreview,
  type ModuleManifestUploadDecision,
} from '@/lib/modules';
import {
  refreshModuleCaches,
  useBundledModules,
  useInstalledModules,
  useModuleRealtime,
} from '@/hooks/use-modules';

type ModuleTab = 'installed' | 'available';
type ModuleLifecyclePatch = { enabled?: boolean; agent_access?: 'none' | 'read' | 'write' };
type PendingManifest = {
  source: string;
  preview: ModuleManifestPreview;
  decision: ModuleManifestUploadDecision;
};

export default function ModulesPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<ModuleTab>('installed');
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingManifest, setPendingManifest] = useState<PendingManifest | null>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const installed = useInstalledModules();
  const bundled = useBundledModules();
  useModuleRealtime();
  useSetPageContext(<span className="text-[0.875rem] font-semibold">Settings · Modules</span>, []);

  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const installedSlugs = useMemo(() => new Set(installed.modules.map((module) => module.slug)), [installed.modules]);
  const available = bundled.modules.map((module) => ({
    ...module,
    installed: module.installed || installedSlugs.has(module.slug),
  }));
  const bundledBySlug = useMemo(
    () => new Map(bundled.modules.map((module) => [module.slug, module])),
    [bundled.modules],
  );

  const chooseManifest = (target?: ModuleInstallation) => {
    uploadTargetRef.current = target?.id ?? null;
    setActionError(null);
    setNotice(null);
    fileInputRef.current?.click();
  };

  const handleManifestFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    setActionError(null);
    setNotice(null);
    setPendingManifest(null);
    try {
      if (file.name !== 'deft.module.json') {
        throw new Error('Choose a file named deft.module.json. Modules cannot include code or assets.');
      }
      if (file.size > MODULE_MANIFEST_MAX_BYTES) {
        throw new Error(`Module manifest must be ${MODULE_MANIFEST_MAX_BYTES} bytes or smaller.`);
      }
      const source = await file.text();
      const preview = await previewModuleManifestJson(source);
      const decision = resolveModuleManifestUpload(
        preview,
        installed.modules,
        uploadTargetRef.current,
      );
      setPendingManifest({ source, preview, decision });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to read this module manifest.');
    } finally {
      uploadTargetRef.current = null;
    }
  };

  const confirmManifest = async () => {
    if (!pendingManifest) return;
    const { decision, preview, source } = pendingManifest;
    setBusySlug(preview.slug);
    setActionError(null);
    setNotice(null);
    try {
      const path = decision.mode === 'upgrade'
        ? `/api/modules/${encodeURIComponent(decision.target.slug)}/upgrade`
        : '/api/modules/sideload';
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (decision.mode === 'upgrade') {
        headers.set('If-Match', decision.target.manifestDigest!);
      }
      const response = await api.fetch(path, { method: 'POST', headers, body: source });
      if (!response.ok) {
        throw new Error(await moduleApiError(
          response,
          decision.mode === 'upgrade'
            ? `Unable to update ${preview.name}.`
            : `Unable to install ${preview.name}.`,
        ));
      }
      await refreshModuleCaches(preview.slug);
      setPendingManifest(null);
      setTab('installed');
      setNotice(decision.mode === 'upgrade'
        ? `${preview.name} updated to v${preview.version}.`
        : `${preview.name} installed from its local manifest.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to apply this module manifest.');
    } finally {
      setBusySlug(null);
    }
  };

  const handleInstall = async (module: BundledModule) => {
    setBusySlug(module.slug);
    setActionError(null);
    setNotice(null);
    try {
      const response = await api.post(`/api/modules/bundled/${encodeURIComponent(module.slug)}/install`);
      if (!response.ok) throw new Error(await moduleApiError(response, `Unable to install ${module.name}.`));
      await refreshModuleCaches(module.slug);
      setNotice(`${module.name} is installed and ready to configure.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to install this module.');
    } finally {
      setBusySlug(null);
    }
  };

  const handleUpdate = async (module: ModuleInstallation, patch: ModuleLifecyclePatch) => {
    setBusySlug(module.slug);
    setActionError(null);
    setNotice(null);
    try {
      const response = await api.patch(`/api/modules/${encodeURIComponent(module.slug)}`, patch);
      if (!response.ok) throw new Error(await moduleApiError(response, `Unable to update ${module.manifest.name}.`));
      await refreshModuleCaches(module.slug);
      setNotice(patch.enabled === undefined
        ? `${module.manifest.name} agent access updated.`
        : `${module.manifest.name} ${patch.enabled ? 'enabled' : 'disabled'}. Its records were preserved.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update this module.');
    } finally {
      setBusySlug(null);
    }
  };

  const handleBundledVersionUpdate = async (module: ModuleInstallation) => {
    setBusySlug(module.slug);
    setActionError(null);
    setNotice(null);
    try {
      const response = await api.post(`/api/modules/bundled/${encodeURIComponent(module.slug)}/update`);
      if (!response.ok) {
        throw new Error(await moduleApiError(response, `Unable to update ${module.manifest.name}.`));
      }
      await refreshModuleCaches(module.slug);
      setNotice(`${module.manifest.name} updated from the bundled catalog.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update this bundled module.');
    } finally {
      setBusySlug(null);
    }
  };

  const loading = tab === 'installed' ? installed.isLoading : bundled.isLoading;
  const error = tab === 'installed' ? installed.error : bundled.error;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        title="Modules"
        description="Install modules and control how they participate in this workspace."
        compact
        secondary={
          <div className="flex items-center gap-1 overflow-x-auto px-1">
            <div className="flex gap-1" role="tablist" aria-label="Module catalog">
              <TabButton active={tab === 'installed'} onClick={() => setTab('installed')}>
                Installed <Count value={installed.modules.length} />
              </TabButton>
              <TabButton active={tab === 'available'} onClick={() => setTab('available')}>
                Available <Count value={available.length} />
              </TabButton>
            </div>
            {canManage && (
              <button
                type="button"
                onClick={() => chooseManifest()}
                className="ml-1 flex min-h-11 flex-shrink-0 items-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium text-white"
                style={{ background: 'var(--primary-container)' }}
              >
                <FileUp size={14} /> Install local
              </button>
            )}
          </div>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        onChange={(event) => void handleManifestFile(event)}
        className="sr-only"
        aria-label="Choose deft.module.json"
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2 md:px-6">
        {(actionError || notice) && (
          <div
            role={actionError ? 'alert' : 'status'}
            className="mx-auto mb-4 max-w-5xl rounded-lg px-3 py-2 text-[0.8125rem]"
            style={{
              color: actionError ? 'var(--error)' : 'var(--status-green)',
              background: actionError ? 'var(--danger-subtle)' : 'rgba(48,164,108,0.12)',
            }}
          >
            {actionError ?? notice}
          </div>
        )}

        {pendingManifest && (
          <ManifestPreview
            pending={pendingManifest}
            busy={busySlug === pendingManifest.preview.slug}
            onCancel={() => setPendingManifest(null)}
            onConfirm={() => void confirmManifest()}
          />
        )}

        {loading ? (
          <ModuleLoadingState />
        ) : error ? (
          <ModuleErrorState
            message={error instanceof Error ? error.message : 'The module service did not respond.'}
            onRetry={() => void (tab === 'installed' ? installed.mutate() : bundled.mutate())}
          />
        ) : tab === 'installed' ? (
          installed.modules.length === 0 ? (
            <EmptyState
              icon={<Blocks size={20} style={{ color: 'var(--primary)' }} />}
              title="No modules installed"
              description="Install a bundled module to add a new workspace data surface."
              action={{ label: 'Browse available modules', onClick: () => setTab('available') }}
            />
          ) : (
            <div className="mx-auto grid max-w-5xl grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {installed.modules.map((module) => (
                <InstalledModuleCard
                  key={module.id}
                  module={module}
                  canManage={canManage}
                  busy={busySlug === module.slug}
                  bundledRelease={bundledBySlug.get(module.slug) ?? null}
                  onUpdate={(patch) => void handleUpdate(module, patch)}
                  onChooseManifest={() => chooseManifest(module)}
                  onBundledUpdate={() => void handleBundledVersionUpdate(module)}
                />
              ))}
            </div>
          )
        ) : available.length === 0 ? (
          <EmptyState
            icon={<Blocks size={20} style={{ color: 'var(--primary)' }} />}
            title="No bundled modules available"
            description="New modules will appear here when they are added to this Deft release."
          />
        ) : (
          <div className="mx-auto grid max-w-5xl grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {available.map((module) => (
              <AvailableModuleCard
                key={module.slug}
                module={module}
                canManage={canManage}
                busy={busySlug === module.slug}
                onInstall={() => void handleInstall(module)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InstalledModuleCard({
  module,
  canManage,
  busy,
  bundledRelease,
  onUpdate,
  onChooseManifest,
  onBundledUpdate,
}: {
  module: ModuleInstallation;
  canManage: boolean;
  busy: boolean;
  bundledRelease: BundledModule | null;
  onUpdate: (patch: ModuleLifecyclePatch) => void;
  onChooseManifest: () => void;
  onBundledUpdate: () => void;
}) {
  return (
    <article
      className="flex min-h-[220px] flex-col rounded-xl p-4"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}>
          <ModuleIcon token={module.manifest.icon} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[0.875rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{module.manifest.name}</h2>
            <ModuleStatusBadge enabled={module.enabled} />
          </div>
          <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
            v{module.manifest.version ?? '—'} · {module.source === 'sideloaded' ? 'Local' : 'Bundled'} · {module.manifest.collections.length} collection{module.manifest.collections.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>
      <p className="mt-3 line-clamp-3 text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
        {module.manifest.description ?? 'A schema-driven workspace module.'}
      </p>
      {canManage && (
        <label className="mt-4 flex min-h-10 items-center gap-2 rounded-lg px-3 text-[0.75rem]" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>
          <Bot size={14} className="flex-shrink-0" />
          <span>Agent access</span>
          <select
            value={module.agentAccess}
            onChange={(event) => onUpdate({ agent_access: event.target.value as ModuleLifecyclePatch['agent_access'] })}
            disabled={busy}
            className="ml-auto min-w-0 bg-transparent text-right text-[0.75rem] outline-none disabled:opacity-60"
            aria-label={`Agent access for ${module.manifest.name}`}
          >
            <option value="none">None</option>
            <option value="read">Read</option>
            <option value="write">Read &amp; write</option>
          </select>
        </label>
      )}
      <div className="mt-auto flex items-center gap-2 pt-4">
        <Link
          href={`/modules/${encodeURIComponent(module.slug)}`}
          className="flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-[0.8125rem] font-medium"
          style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
        >
          Open
        </Link>
        {canManage && (
          <button
            type="button"
            onClick={() => onUpdate({ enabled: !module.enabled })}
            disabled={busy}
            className="flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium disabled:opacity-60"
            style={{ color: module.enabled ? 'var(--error)' : 'var(--status-green)', background: module.enabled ? 'var(--danger-subtle)' : 'rgba(48,164,108,0.12)' }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {module.enabled ? 'Disable' : 'Enable'}
          </button>
        )}
      </div>
      {canManage && module.source === 'sideloaded' && (
        <button
          type="button"
          onClick={onChooseManifest}
          disabled={busy}
          className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg px-3 text-[0.75rem] font-medium disabled:opacity-60"
          style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
          Update local manifest
        </button>
      )}
      {canManage && module.source === 'bundled' && bundledRelease?.updateAvailable && (
        <button
          type="button"
          onClick={onBundledUpdate}
          disabled={busy}
          className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg px-3 text-[0.75rem] font-medium text-white disabled:opacity-60"
          style={{ background: 'var(--primary-container)' }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Update to v{bundledRelease.version ?? 'latest'}
        </button>
      )}
    </article>
  );
}

function AvailableModuleCard({
  module,
  canManage,
  busy,
  onInstall,
}: {
  module: BundledModule;
  canManage: boolean;
  busy: boolean;
  onInstall: () => void;
}) {
  return (
    <article
      className="flex min-h-[190px] flex-col rounded-xl p-4"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}>
          <ModuleIcon token={module.icon} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[0.875rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{module.name}</h2>
          <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
            v{module.version ?? '—'} · Bundled
          </p>
        </div>
      </div>
      <p className="mt-3 line-clamp-3 text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
        {module.description ?? 'A schema-driven workspace module.'}
      </p>
      <div className="mt-auto pt-4">
        {module.installed ? (
          <Link
            href={`/modules/${encodeURIComponent(module.slug)}`}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium"
            style={{ color: 'var(--status-green)', background: 'rgba(48,164,108,0.12)' }}
          >
            <Check size={14} /> Installed
          </Link>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={!canManage || busy}
            title={canManage ? undefined : 'Only workspace owners and admins can install modules.'}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--primary-container)' }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {canManage ? 'Install module' : 'Admin required'}
          </button>
        )}
      </div>
    </article>
  );
}

function ManifestPreview({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: PendingManifest;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { preview, decision } = pending;
  return (
    <section
      aria-label="Local module manifest preview"
      className="mx-auto mb-4 max-w-5xl rounded-xl p-4"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--primary-container)' }}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}>
          <FileUp size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide" style={{ color: 'var(--primary)' }}>
                {decision.mode === 'upgrade' ? 'Review local update' : 'Review local install'}
              </p>
              <h2 className="mt-0.5 text-[0.9375rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
                {preview.name} <span className="font-normal" style={{ color: 'var(--outline)' }}>v{preview.version}</span>
              </h2>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              aria-label="Cancel module manifest preview"
              className="flex h-9 w-9 items-center justify-center rounded-lg disabled:opacity-50"
              style={{ color: 'var(--outline)', background: 'var(--surface-container-high)' }}
            >
              <X size={15} />
            </button>
          </div>
          <dl className="mt-3 grid grid-cols-1 gap-2 text-[0.75rem] sm:grid-cols-2">
            <ManifestDetail label="Module id" value={preview.moduleId} mono />
            <ManifestDetail label="Slug" value={preview.slug} mono />
            <ManifestDetail label="Digest" value={preview.digest} mono wide />
            <ManifestDetail
              label="Collections"
              value={preview.collections.map((collection) => collection.name).join(', ')}
              wide
            />
          </dl>
          <p className="mt-3 text-[0.6875rem] leading-relaxed" style={{ color: 'var(--outline)' }}>
            Deft will store only this declarative manifest. It will not fetch URLs or install code, scripts, or assets.
          </p>
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="min-h-11 rounded-lg px-4 text-[0.8125rem] font-medium disabled:opacity-50"
              style={{ color: 'var(--on-surface)', background: 'var(--surface-container-high)' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-[0.8125rem] font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--primary-container)' }}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : decision.mode === 'upgrade' ? <RefreshCw size={14} /> : <Download size={14} />}
              {decision.mode === 'upgrade' ? 'Confirm update' : 'Confirm install'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ManifestDetail({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt style={{ color: 'var(--outline)' }}>{label}</dt>
      <dd
        className="mt-0.5 break-all"
        style={{ color: 'var(--on-surface-variant)', fontFamily: mono ? 'var(--font-mono)' : undefined }}
      >
        {value}
      </dd>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="flex min-h-11 flex-shrink-0 items-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium"
      style={{ color: active ? 'var(--on-surface)' : 'var(--outline)', background: active ? 'var(--bg-active)' : 'transparent' }}
    >
      {children}
    </button>
  );
}

function Count({ value }: { value: number }) {
  return <span className="rounded-full px-1.5 py-0.5 text-[0.625rem]" style={{ background: 'var(--surface-container-high)' }}>{value}</span>;
}
