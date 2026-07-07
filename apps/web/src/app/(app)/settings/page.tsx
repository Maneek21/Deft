'use client';

import Link from 'next/link';
import { useTheme } from '@/components/theme-provider';
import { useAuth } from '@/lib/auth-context';
import { settingsNavGroups } from '@/lib/settings-navigation';
import { Bot, CalendarDays, Code2, Moon, Settings2, Sun, User, Users, Workflow } from 'lucide-react';

const groupIcons = {
  Personal: User,
  Workspace: Users,
  'Work System': Workflow,
  'Agents & AI': Bot,
  Developer: Code2,
} as const;

export default function SettingsPage() {
  const { theme, toggleTheme } = useTheme();
  const { user, org } = useAuth();

  const currentTheme = theme;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-5 py-8 md:px-8 md:py-10">
        <header className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ background: 'var(--surface-container-low)', color: 'var(--text-secondary)' }}>
              <Settings2 size={13} />
              Workspace controls
            </div>
            <h1 className="text-[30px] font-semibold tracking-tight md:text-[36px]" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
              Settings
            </h1>
            <p className="mt-2 max-w-2xl text-[15px] leading-6" style={{ color: 'var(--text-secondary)' }}>
              Manage your profile, people, teams, agents, calendar feeds, templates, and developer access from one place.
            </p>
          </div>

          <div className="deft-soft-card p-4 lg:min-w-[280px]">
            <div className="flex items-center gap-3">
              {user?.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatar_url} alt="" className="h-11 w-11 rounded-full object-cover" />
              ) : (
                <div className="flex h-11 w-11 items-center justify-center rounded-full text-[15px] font-semibold text-white" style={{ background: 'var(--accent)' }}>
                  {user?.name?.charAt(0).toUpperCase() || '?'}
                </div>
              )}
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>{user?.name || 'Unknown user'}</div>
                <div className="truncate text-[12px]" style={{ color: 'var(--text-tertiary)' }}>{org?.name || user?.email || 'Workspace'}</div>
              </div>
            </div>
            <Link href="/settings/profile" className="deft-pill mt-3" style={{ color: 'var(--accent)' }}>
              Edit profile
            </Link>
          </div>
        </header>

        <section className="mb-8 grid gap-3 md:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              if (currentTheme !== 'light') toggleTheme();
            }}
            className="deft-soft-card flex items-center gap-3 p-4 text-left transition-colors"
            style={{
              background: currentTheme === 'light' ? 'var(--accent-subtle)' : 'var(--card-bg)',
              border: `1px solid ${currentTheme === 'light' ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            <Sun size={18} style={{ color: currentTheme === 'light' ? 'var(--accent)' : 'var(--text-secondary)' }} />
            <div>
              <div className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>Light mode</div>
              <div className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Use a brighter interface.</div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              if (currentTheme !== 'dark') toggleTheme();
            }}
            className="deft-soft-card flex items-center gap-3 p-4 text-left transition-colors"
            style={{
              background: currentTheme === 'dark' ? 'var(--accent-subtle)' : 'var(--card-bg)',
              border: `1px solid ${currentTheme === 'dark' ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            <Moon size={18} style={{ color: currentTheme === 'dark' ? 'var(--accent)' : 'var(--text-secondary)' }} />
            <div>
              <div className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>Dark mode</div>
              <div className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Use the focused workspace theme.</div>
            </div>
          </button>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          {settingsNavGroups.map((group) => {
            const Icon = groupIcons[group.label as keyof typeof groupIcons] || CalendarDays;
            return (
              <section key={group.label} className="deft-soft-card p-5">
                <div className="mb-4 flex items-start gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: 'var(--surface-container-low)', color: 'var(--accent)' }}>
                    <Icon size={17} />
                  </div>
                  <div>
                    <h2 className="text-[15px] font-semibold" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>{group.label}</h2>
                    <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-secondary)' }}>{group.description}</p>
                  </div>
                </div>
                <div>
                  {group.items.map((item, index) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="group flex items-center justify-between gap-4 py-3"
                      style={{ borderTop: index === 0 ? 'none' : '1px solid var(--outline-variant)' }}
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>{item.name}</div>
                        <div className="mt-0.5 text-[12px] leading-5" style={{ color: 'var(--text-tertiary)' }}>{item.description}</div>
                      </div>
                      <span className="text-[12px] transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--accent)' }}>
                        Open
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
