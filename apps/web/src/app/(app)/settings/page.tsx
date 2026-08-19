'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTheme } from '@/components/theme-provider';
import { useAuth } from '@/lib/auth-context';
import { getSettingsNavGroups } from '@/lib/settings-navigation';
import {
  Bot,
  Boxes,
  CalendarDays,
  ChevronRight,
  Moon,
  Search,
  Settings2,
  Sun,
  UserRound,
  Users,
  Workflow,
} from 'lucide-react';

const overviewCards = [
  { title: 'Profile', body: 'Identity, status, notifications, and security.', href: '/settings/profile', icon: UserRound, admin: false },
  { title: 'People & teams', body: 'Membership, access, ownership, and team context.', href: '/settings/members', icon: Users, admin: true },
  { title: 'Modules', body: 'Install workspace modules and govern their agent access.', href: '/settings/modules', icon: Boxes, admin: true },
  { title: 'Calendar', body: 'Bring external calendar context into Deft or subscribe to Deft events.', href: '/settings/calendar', icon: CalendarDays, admin: false },
  { title: 'AI connections', body: 'Connect Codex, Claude, ChatGPT, and other MCP clients.', href: '/settings/mcp-access', icon: Workflow, admin: false },
  { title: 'Agent employees', body: 'Operate shared agents as accountable members of the workspace.', href: '/settings/agent-employees', icon: Bot, admin: true },
] as const;

export default function SettingsPage() {
  const { theme, toggleTheme } = useTheme();
  const { user, org } = useAuth();
  const [query, setQuery] = useState('');
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const groups = getSettingsNavGroups(user?.role ?? 'member');
  const availableItems = groups.flatMap((group) => group.items);
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return availableItems.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(normalized));
  }, [availableItems, query]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-5 py-8 md:px-8 md:py-10">
        <header className="mb-6">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ background: 'var(--surface-container-low)', color: 'var(--text-secondary)' }}>
            <Settings2 size={13} /> Workspace controls
          </div>
          <h1 className="text-[30px] font-semibold tracking-tight md:text-[36px]" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>Settings</h1>
          <p className="mt-2 max-w-2xl text-[15px] leading-6" style={{ color: 'var(--text-secondary)' }}>
            Manage your account and the parts of the workspace you are responsible for.
          </p>
        </header>

        <div className="relative mb-6">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a setting..."
            className="h-11 w-full rounded-full pl-10 pr-4 text-[13px] outline-none"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
          />
          {query.trim() && (
            <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-lg" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
              {results.length === 0 ? (
                <p className="px-4 py-5 text-[13px]" style={{ color: 'var(--text-secondary)' }}>No settings match “{query}”.</p>
              ) : results.map((item) => (
                <Link key={item.href} href={item.href} className="flex items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--border-default)' }}>
                  <span className="min-w-0"><span className="block text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>{item.name}</span><span className="block truncate text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{item.description}</span></span>
                  <ChevronRight size={15} style={{ color: 'var(--accent)' }} />
                </Link>
              ))}
            </div>
          )}
        </div>

        <section className="mb-6 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <Link href="/settings/profile" className="deft-soft-card flex min-w-0 items-center gap-3 p-4">
            {user?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatar_url} alt="" className="h-11 w-11 shrink-0 rounded-full object-cover" />
            ) : (
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white" style={{ background: 'var(--accent)' }}>{user?.name?.charAt(0).toUpperCase() || '?'}</div>
            )}
            <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>{user?.name || 'Unknown user'}</div><div className="truncate text-[12px]" style={{ color: 'var(--text-tertiary)' }}>{org?.name || user?.email || 'Workspace'}</div></div>
            <ChevronRight size={16} style={{ color: 'var(--accent)' }} />
          </Link>
          <div className="deft-soft-card flex items-center gap-1 p-1.5" aria-label="Theme">
            <button type="button" onClick={() => theme !== 'light' && toggleTheme()} className="deft-pill" data-active={theme === 'light'} style={{ background: theme === 'light' ? 'var(--accent-subtle)' : 'transparent', color: theme === 'light' ? 'var(--accent)' : 'var(--text-secondary)' }}><Sun size={15} /> Light</button>
            <button type="button" onClick={() => theme !== 'dark' && toggleTheme()} className="deft-pill" data-active={theme === 'dark'} style={{ background: theme === 'dark' ? 'var(--accent-subtle)' : 'transparent', color: theme === 'dark' ? 'var(--accent)' : 'var(--text-secondary)' }}><Moon size={15} /> Dark</button>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.07em]" style={{ color: 'var(--text-tertiary)' }}>Common settings</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {overviewCards.filter((card) => !card.admin || isAdmin).map(({ title, body, href, icon: Icon }) => (
              <Link key={href} href={href} className="deft-soft-card group flex items-start gap-3 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--surface-container-low)', color: 'var(--accent)' }}><Icon size={17} /></div>
                <div className="min-w-0 flex-1"><h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>{title}</h3><p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-secondary)' }}>{body}</p></div>
                <ChevronRight size={15} className="mt-1 transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--accent)' }} />
              </Link>
            ))}
          </div>
        </section>

        {isAdmin && (
          <section className="mt-6 border-t pt-5" style={{ borderColor: 'var(--border-default)' }}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>Advanced administration</h2><p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Automation, recovery, providers, governance, and developer access live in the Advanced section of the sidebar.</p></div>
              <Link href="/settings/library" className="deft-pill" style={{ color: 'var(--accent)', border: '1px solid var(--border)' }}>Open task settings <ChevronRight size={13} /></Link>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
