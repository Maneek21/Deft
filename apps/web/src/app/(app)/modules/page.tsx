'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Blocks, Check, Download, Loader2, Power } from 'lucide-react';
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
import { moduleApiError, type BundledModule, type ModuleInstallation } from '@/lib/modules';
import {
  refreshModuleCaches,
  useBundledModules,
  useInstalledModules,
  useModuleRealtime,
} from '@/hooks/use-modules';

type ModuleTab = 'installed' | 'available';

export default function ModulesPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<ModuleTab>('installed');
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const installed = useInstalledModules();
  const bundled = useBundledModules();
  useModuleRealtime();
  useSetPageContext(<span className="text-[0.875rem] font-semibold">Modules</span>, []);

  const canManage = user?.role === 'owner' || user?.role === 'admin';
  const installedSlugs = useMemo(() => new Set(installed.modules.map((module) => module.slug)), [installed.modules]);
  const available = bundled.modules.map((module) => ({
    ...module,
    installed: module.installed || installedSlugs.has(module.slug),
  }));

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

  const handleToggle = async (module: ModuleInstallation) => {
    setBusySlug(module.slug);
    setActionError(null);
    setNotice(null);
    try {
      const response = await api.patch(`/api/modules/${encodeURIComponent(module.slug)}`, {
        enabled: !module.enabled,
      });
      if (!response.ok) throw new Error(await moduleApiError(response, `Unable to ${module.enabled ? 'disable' : 'enable'} ${module.manifest.name}.`));
      await refreshModuleCaches(module.slug);
      setNotice(`${module.manifest.name} ${module.enabled ? 'disabled' : 'enabled'}. Its records were preserved.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update this module.');
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
        description="Add schema-driven tools to your workspace without changing Deft."
        compact
        secondary={
          <div className="flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="Module catalog">
            <TabButton active={tab === 'installed'} onClick={() => setTab('installed')}>
              Installed <Count value={installed.modules.length} />
            </TabButton>
            <TabButton active={tab === 'available'} onClick={() => setTab('available')}>
              Available <Count value={available.length} />
            </TabButton>
          </div>
        }
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
                  onToggle={() => void handleToggle(module)}
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
  onToggle,
}: {
  module: ModuleInstallation;
  canManage: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <article
      className="flex min-h-[190px] flex-col rounded-xl p-4"
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
            v{module.manifest.version ?? '—'} · {module.manifest.collections.length} collection{module.manifest.collections.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>
      <p className="mt-3 line-clamp-3 text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
        {module.manifest.description ?? 'A schema-driven workspace module.'}
      </p>
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
            onClick={onToggle}
            disabled={busy}
            className="flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium disabled:opacity-60"
            style={{ color: module.enabled ? 'var(--error)' : 'var(--status-green)', background: module.enabled ? 'var(--danger-subtle)' : 'rgba(48,164,108,0.12)' }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {module.enabled ? 'Disable' : 'Enable'}
          </button>
        )}
      </div>
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
