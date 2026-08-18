'use client';

import {
  BookOpen,
  Boxes,
  BriefcaseBusiness,
  CalendarDays,
  CircleAlert,
  ContactRound,
  Database,
  FolderKanban,
  Loader2,
  Package,
  RefreshCw,
  TableProperties,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

const MODULE_ICONS: Record<string, LucideIcon> = {
  book: BookOpen,
  briefcase: BriefcaseBusiness,
  calendar: CalendarDays,
  contacts: ContactRound,
  contact: ContactRound,
  database: Database,
  folder: FolderKanban,
  package: Package,
  table: TableProperties,
  users: UsersRound,
  boxes: Boxes,
};

export function ModuleIcon({ token, size = 18 }: { token?: string | null; size?: number }) {
  const Icon = token ? MODULE_ICONS[token.toLowerCase()] ?? Boxes : Boxes;
  return <Icon size={size} strokeWidth={1.6} aria-hidden />;
}

export function ModuleLoadingState({ label = 'Loading modules…' }: { label?: string }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-3" role="status">
      <Loader2 size={22} className="animate-spin" style={{ color: 'var(--primary)' }} />
      <span className="text-[0.8125rem]" style={{ color: 'var(--outline)' }}>{label}</span>
    </div>
  );
}

export function ModuleErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 px-5 text-center" role="alert">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: 'var(--danger-subtle)', color: 'var(--error)' }}>
        <CircleAlert size={20} />
      </span>
      <div>
        <p className="text-[0.875rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Modules could not be loaded</p>
        <p className="mt-1 max-w-sm text-[0.75rem]" style={{ color: 'var(--outline)' }}>{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="flex min-h-11 items-center gap-2 rounded-lg px-4 text-[0.8125rem] font-medium"
        style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
      >
        <RefreshCw size={14} /> Retry
      </button>
    </div>
  );
}

export function ModuleStatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[0.6875rem] font-medium"
      style={{
        background: enabled ? 'rgba(48,164,108,0.14)' : 'var(--surface-container-high)',
        color: enabled ? 'var(--status-green)' : 'var(--outline)',
      }}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}
