'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from '@/components/theme-provider';
import { useAuth } from '@/lib/auth-context';
import { Sun, Moon } from 'lucide-react';

const settingsSections = [
  { name: 'General', href: '/settings' },
  { name: 'Members', href: '/settings/members' },
  { name: 'Groups', href: '/settings/groups' },
  { name: 'Tags', href: '/settings/tags' },
  { name: 'Integrations', href: '/settings/integrations' },
  { name: 'Agent', href: '/settings/agent' },
  { name: 'Agent Employees', href: '/settings/agent-employees' },
  { name: 'MCP Connections', href: '/settings/integrations' },
  { name: 'API Access', href: '/settings/api-access' },
];

export default function SettingsPage() {
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();
  const pathname = usePathname();

  const themes: { value: 'light' | 'dark'; label: string; icon: React.ReactNode }[] = [
    { value: 'light', label: 'Light', icon: <Sun size={18} strokeWidth={1.5} /> },
    { value: 'dark', label: 'Dark', icon: <Moon size={18} strokeWidth={1.5} /> },
  ];

  const currentTheme = theme; // 'light' or 'dark' from the provider

  return (
    <div className="h-full overflow-y-auto">
      {/* Mobile sub-navigation — only visible below md breakpoint */}
      <div className="md:hidden flex gap-1 px-4 pt-4 pb-0 overflow-x-auto flex-nowrap">
        {settingsSections.map((section) => {
          const active = pathname === section.href;
          return (
            <Link
              key={section.href}
              href={section.href}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors flex-shrink-0"
              style={{
                background: active ? 'var(--accent)' : 'var(--surface-container-low)',
                color: active ? 'white' : 'var(--text-secondary)',
              }}
            >
              {section.name}
            </Link>
          );
        })}
      </div>

      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1
          className="text-2xl font-semibold mb-8"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', letterSpacing: '-0.02em' }}
        >
          Settings
        </h1>

        {/* Profile Section */}
        <section className="mb-10">
          <h2
            className="text-sm font-semibold uppercase tracking-wide mb-4"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            Profile
          </h2>
          <div
            className="rounded-xl p-5"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-4">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-medium text-white"
                style={{ background: 'var(--accent)' }}
              >
                {user?.name?.charAt(0).toUpperCase() || '?'}
              </div>
              <div>
                <p
                  className="text-[15px] font-medium"
                  style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
                >
                  {user?.name || 'Unknown'}
                </p>
                <p className="text-[13px] mt-0.5" style={{ color: 'var(--muted)' }}>
                  {user?.email || 'No email'}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Appearance Section */}
        <section className="mb-10">
          <h2
            className="text-sm font-semibold uppercase tracking-wide mb-4"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
          >
            Appearance
          </h2>
          <div
            className="rounded-xl p-5"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--border)' }}
          >
            <p className="text-[14px] mb-4" style={{ color: 'var(--foreground-secondary)' }}>
              Choose your preferred theme
            </p>
            <div className="flex gap-3">
              {themes.map((t) => {
                const isActive = t.value === currentTheme;

                return (
                  <button
                    key={t.value}
                    onClick={() => {
                      if (currentTheme !== t.value) {
                        toggleTheme();
                      }
                    }}
                    className="flex flex-col items-center gap-2 px-5 py-4 rounded-xl transition-colors"
                    style={{
                      background: isActive ? 'var(--accent-light, rgba(124,107,79,0.12))' : 'var(--surface)',
                      border: `1.5px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                      color: isActive ? 'var(--accent)' : 'var(--muted)',
                    }}
                  >
                    {t.icon}
                    <span
                      className="text-[13px] font-medium"
                      style={{
                        color: isActive ? 'var(--accent)' : 'var(--foreground-secondary)',
                        fontFamily: 'var(--font-heading)',
                      }}
                    >
                      {t.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
