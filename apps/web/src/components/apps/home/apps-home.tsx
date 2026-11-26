'use client';

import type { ReactNode } from 'react';
import { ArrowUpRight, Blocks, FileUp, KeyRound, PowerOff, Search } from 'lucide-react';
import type { AppsHome } from '@/lib/app-upload-routing';
import { AvailableAppTile, ModuleAppTile, PackageAppTile, type AgentAccess } from './app-tiles';
import type { ModuleInstallation, BundledModule } from '@/lib/modules';

export const BUILD_YOUR_FIRST_APP_URL = 'https://deft.ing/docs/build-your-first-app';

export type AppsHomeHandlers = {
  onUpload: () => void;
  onPair?: () => void;
  onInstallBundled: (module: BundledModule) => void;
  onToggleModule: (module: ModuleInstallation) => void;
  onAgentAccess: (module: ModuleInstallation, value: AgentAccess) => void;
  onUploadVersion: (module: ModuleInstallation) => void;
  onBundledUpdate: (module: ModuleInstallation) => void;
  moduleActions?: (module: ModuleInstallation) => ReactNode;
};

export function BuildYourOwnPanel({
  canManage,
  busy,
  pairingAvailable,
  onUpload,
  onPair,
  children,
}: {
  canManage: boolean;
  busy: boolean;
  pairingAvailable: boolean;
  onUpload: () => void;
  onPair?: () => void;
  children?: ReactNode;
}) {
  return (
    <section
      aria-labelledby="build-your-own-title"
      className="relative overflow-hidden rounded-2xl p-5 md:p-6"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full opacity-60 blur-3xl"
        style={{ background: 'var(--bg-active)' }}
      />
      <div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="max-w-xl">
          <h2 id="build-your-own-title" className="text-[1.0625rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
            Build your own app
          </h2>
          <p className="mt-1.5 text-[0.8125rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
            An app is one file that describes your records, fields and views. Upload it and your team gets boards, tables and
            forms that search, link to tasks and work with your AI tools.
          </p>
          <a
            href={BUILD_YOUR_FIRST_APP_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex min-h-11 items-center gap-1 text-[0.8125rem] font-medium md:min-h-0"
            style={{ color: 'var(--primary)' }}
          >
            How to write an app file <ArrowUpRight size={13} aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
        {canManage ? (
          <div className="flex flex-col gap-2 sm:flex-row md:flex-col md:items-stretch lg:flex-row">
            <button
              id="apps-upload-button"
              type="button"
              onClick={onUpload}
              disabled={busy}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-[0.8125rem] font-semibold text-white disabled:opacity-60"
              style={{ background: 'var(--primary-container)' }}
            >
              <FileUp size={15} aria-hidden /> Upload an app
            </button>
            {pairingAvailable && onPair && (
              <button
                type="button"
                onClick={onPair}
                disabled={busy}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-[0.8125rem] font-medium disabled:opacity-60"
                style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
              >
                <KeyRound size={14} aria-hidden /> Pair Codex
              </button>
            )}
          </div>
        ) : (
          <p className="text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>Owners and admins add apps.</p>
        )}
      </div>
      {children && <div className="relative mt-4">{children}</div>}
    </section>
  );
}

function SectionHeading({ id, title, count, hint }: { id: string; title: string; count?: number; hint?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 id={id} className="flex items-center gap-2 text-[0.8125rem] font-semibold" style={{ color: 'var(--on-surface)' }}>
        {title}
        {count !== undefined && (
          <span className="rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>
            {count}
          </span>
        )}
      </h2>
      {hint && <p className="text-[0.6875rem]" style={{ color: 'var(--on-surface-variant)' }}>{hint}</p>}
    </div>
  );
}

export function AppsSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="relative block">
      <span className="sr-only">Find an app</span>
      <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--on-surface-variant)' }} />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type="search"
        placeholder="Find an app"
        className="min-h-11 w-full rounded-lg border py-2 pl-9 pr-3 text-[0.8125rem] md:min-h-10"
        style={{ background: 'var(--surface-container-low)', borderColor: 'var(--ghost-border)', color: 'var(--on-surface)' }}
      />
    </label>
  );
}

/** The installed and ready-to-install lists. */
export function AppsHomeLists({
  home,
  query,
  canManage,
  busyKey,
  handlers,
}: {
  home: AppsHome;
  query: string;
  canManage: boolean;
  busyKey: string | null;
  handlers: AppsHomeHandlers;
}) {
  const searching = query.trim().length > 0;
  if (searching && home.installed.length === 0 && home.available.length === 0) {
    return <p className="rounded-xl px-4 py-8 text-center text-[0.8125rem]" style={{ color: 'var(--on-surface-variant)', background: 'var(--surface-container-low)' }}>No app matches “{query.trim()}”.</p>;
  }
  return (
    <div className="space-y-8">
      <section aria-label="Installed apps">
        <SectionHeading id="installed-apps-title" title="Installed" count={home.installed.length} hint={canManage && home.installed.some((item) => item.kind === 'module') ? "The Defty and agents setting controls what Defty and agent employees may do in each app. Personal AI connections act as the person who connected them." : undefined} />
        {home.installed.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl px-4 py-10 text-center" style={{ border: '1px dashed var(--ghost-border)' }}>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: 'var(--surface-container-high)', color: 'var(--primary)' }}>
              <Blocks size={20} aria-hidden />
            </span>
            <p className="text-[0.875rem] font-semibold" style={{ color: 'var(--on-surface)' }}>No apps installed yet</p>
            <p className="max-w-sm text-[0.75rem]" style={{ color: 'var(--on-surface-variant)' }}>
              {canManage ? 'Install one that comes with Deft, or upload your own app file.' : 'Apps that an owner or admin installs will appear here.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {home.installed.map((item) => item.kind === 'module' ? (
              <ModuleAppTile
                key={item.key}
                module={item.module}
                bundled={item.bundled}
                canManage={canManage}
                busy={busyKey === item.module.slug}
                locked={busyKey !== null}
                onToggle={() => handlers.onToggleModule(item.module)}
                onAgentAccess={(value) => handlers.onAgentAccess(item.module, value)}
                onUploadVersion={() => handlers.onUploadVersion(item.module)}
                onBundledUpdate={() => handlers.onBundledUpdate(item.module)}
                extraActions={handlers.moduleActions?.(item.module)}
              />
            ) : (
              <PackageAppTile key={item.key} app={item.app} canManage={canManage} parts={item.parts} locked={busyKey !== null} onAgentAccess={handlers.onAgentAccess} />
            ))}
          </div>
        )}
      </section>

      {home.available.length > 0 && (
        <section aria-labelledby="available-apps-title">
          <SectionHeading id="available-apps-title" title="Comes with Deft" hint="Install in one click. Each one is ready to use." />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {home.available.map((module) => (
              <AvailableAppTile
                key={module.slug}
                module={module}
                canManage={canManage}
                busy={busyKey === module.slug}
                locked={busyKey !== null}
                onInstall={() => handlers.onInstallBundled(module)}
              />
            ))}
          </div>
        </section>
      )}

      <p className="flex items-start gap-2 text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
        <PowerOff size={14} aria-hidden className="mt-0.5 shrink-0" />
        <span>Installed apps can be turned off, but not deleted. Turning an app off hides it from everyone and keeps all of its records, so you can turn it back on later.</span>
      </p>
    </div>
  );
}
