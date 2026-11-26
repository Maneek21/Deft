'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { AppWindow, Bot, Download, FileUp, Loader2, Power, RefreshCw } from 'lucide-react';
import { ModuleIcon } from '@/components/modules/module-primitives';
import type { AppInstallation } from '@/lib/apps';
import type { BundledModule, ModuleInstallation } from '@/lib/modules';

export type AgentAccess = 'none' | 'read' | 'write';

type Tone = 'on' | 'off' | 'review' | 'failed';

const TONES: Record<Tone, { background: string; color: string }> = {
  on: { background: 'rgba(48,164,108,0.14)', color: 'var(--status-green)' },
  off: { background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' },
  review: { background: 'var(--warning-subtle)', color: 'var(--warning)' },
  failed: { background: 'var(--danger-subtle)', color: 'var(--error)' },
};

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium" style={TONES[tone]}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
      {children}
    </span>
  );
}

function TileShell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <article
      aria-label={label}
      className="flex min-w-0 flex-col rounded-xl p-4"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--ghost-border)' }}
    >
      {children}
    </article>
  );
}

function TileHeading({ icon, name, status, meta }: { icon: ReactNode; name: string; status?: ReactNode; meta: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="min-w-0 truncate text-[0.875rem] font-semibold" style={{ color: 'var(--on-surface)' }}>{name}</h3>
          {status}
        </div>
        <p className="mt-1 text-[0.6875rem]" style={{ color: 'var(--on-surface-variant)' }}>{meta}</p>
      </div>
    </div>
  );
}

function Description({ text }: { text: string | null }) {
  return (
    <p className="mt-3 line-clamp-2 text-[0.75rem] leading-relaxed" style={{ color: 'var(--on-surface-variant)' }}>
      {text ?? 'Records, fields and views for your workspace.'}
    </p>
  );
}

const buttonBase = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-[0.8125rem] font-medium disabled:opacity-60 md:min-h-9';
const quiet = { background: 'var(--surface-container-high)', color: 'var(--on-surface)' };
const primary = { background: 'var(--primary-container)', color: 'var(--on-primary-container, #fff)' };

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function moduleTileMeta(module: ModuleInstallation): string {
  const origin = module.source === 'sideloaded' ? 'Built in this workspace' : module.source === 'bundled' ? 'Comes with Deft' : 'Installed';
  return [`v${module.manifest.version ?? '—'}`, origin, plural(module.manifest.collections.length, 'record type')].join(' · ');
}

export function ModuleAppTile({
  module,
  bundled,
  canManage,
  busy,
  onToggle,
  onAgentAccess,
  onUploadVersion,
  onBundledUpdate,
  extraActions,
}: {
  module: ModuleInstallation;
  bundled: BundledModule | null;
  canManage: boolean;
  busy: boolean;
  onToggle: () => void;
  onAgentAccess: (value: AgentAccess) => void;
  onUploadVersion: () => void;
  onBundledUpdate: () => void;
  extraActions?: ReactNode;
}) {
  const name = module.manifest.name || module.slug;
  return (
    <TileShell label={name}>
      <TileHeading
        icon={<ModuleIcon token={module.manifest.icon} size={20} />}
        name={name}
        status={<StatusPill tone={module.enabled ? 'on' : 'off'}>{module.enabled ? 'On' : 'Off'}</StatusPill>}
        meta={moduleTileMeta(module)}
      />
      <Description text={module.manifest.description} />
      {canManage && (
        <label className="mt-3 flex min-h-11 items-center gap-2 rounded-lg px-3 text-[0.75rem] md:min-h-9" style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface-variant)' }}>
          <Bot size={14} className="shrink-0" aria-hidden />
          <span>Defty and agents</span>
          <select
            value={module.agentAccess}
            onChange={(event) => onAgentAccess(event.target.value as AgentAccess)}
            disabled={busy}
            className="ml-auto min-w-0 bg-transparent text-right text-[0.75rem] font-medium outline-none disabled:opacity-60"
            style={{ color: 'var(--on-surface)' }}
            aria-label={`What Defty and agents can do in ${name}`}
          >
            <option value="none">No access</option>
            <option value="read">Read</option>
            <option value="write">Read and write</option>
          </select>
        </label>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {module.enabled ? (
          <Link href={`/modules/${encodeURIComponent(module.slug)}`} className={`${buttonBase} flex-1`} style={quiet}>
            Open
          </Link>
        ) : (
          <span className="flex-1 text-[0.6875rem]" style={{ color: 'var(--on-surface-variant)' }}>Off. Its records are kept.</span>
        )}
        {canManage && (
          <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className={buttonBase}
            style={module.enabled ? quiet : primary}
            aria-label={`${module.enabled ? 'Turn off' : 'Turn on'} ${name}`}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Power size={14} aria-hidden />}
            {module.enabled ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>
      {canManage && (module.source === 'sideloaded' || bundled?.updateAvailable || extraActions) && (
        <div className="mt-2 flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: 'var(--ghost-border)' }}>
          {module.source === 'sideloaded' && (
            <button type="button" onClick={onUploadVersion} disabled={busy} className={buttonBase} style={quiet} aria-label={`Upload a new version of ${name}`}>
              <FileUp size={14} aria-hidden /> Upload new version
            </button>
          )}
          {module.source === 'bundled' && bundled?.updateAvailable && (
            <button type="button" onClick={onBundledUpdate} disabled={busy} className={buttonBase} style={primary}>
              <RefreshCw size={14} aria-hidden /> Update to v{bundled.version ?? 'latest'}
            </button>
          )}
          {extraActions}
        </div>
      )}
    </TileShell>
  );
}

const PACKAGE_STATES: Record<AppInstallation['state'], { tone: Tone; label: string }> = {
  active: { tone: 'on', label: 'On' },
  disabled: { tone: 'off', label: 'Off' },
  staged: { tone: 'review', label: 'Needs review' },
  failed: { tone: 'failed', label: 'Setup failed' },
};

export function PackageAppTile({ app, canManage }: { app: AppInstallation; canManage: boolean }) {
  const state = PACKAGE_STATES[app.state];
  const href = `/settings/apps/${encodeURIComponent(app.id)}`;
  const meta = `v${app.version} · App Kit package`;
  return (
    <TileShell label={app.name}>
      <TileHeading icon={<AppWindow size={20} aria-hidden />} name={app.name} status={<StatusPill tone={state.tone}>{state.label}</StatusPill>} meta={meta} />
      <Description text={app.manifest.description ?? null} />
      <div className="mt-auto flex items-center gap-2 pt-4">
        <Link href={href} className={`${buttonBase} flex-1`} style={app.state === 'staged' && canManage ? primary : quiet}>
          {app.state === 'staged' && canManage ? 'Review and turn on' : canManage ? 'Manage' : 'Details'}
        </Link>
      </div>
    </TileShell>
  );
}

export function AvailableAppTile({
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
    <TileShell label={module.name}>
      <TileHeading icon={<ModuleIcon token={module.icon} size={20} />} name={module.name} meta={`v${module.version ?? '—'} · Comes with Deft`} />
      <Description text={module.description} />
      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={onInstall}
          disabled={!canManage || busy}
          className={`${buttonBase} w-full`}
          style={canManage ? primary : quiet}
          aria-label={canManage ? `Install ${module.name}` : `Only owners and admins can install ${module.name}`}
        >
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Download size={14} aria-hidden />}
          {canManage ? 'Install' : 'Owners and admins install apps'}
        </button>
      </div>
    </TileShell>
  );
}
