'use client';

import { useEffect, useRef } from 'react';

import { buildModuleCollectionNav } from '@/lib/module-collection-nav';

let pendingKeyboardFocus: string | null = null;

export function ModuleCollectionNav({
  moduleName,
  collections,
  activeKey,
  onSelect,
}: {
  moduleName: string;
  collections: ReadonlyArray<{ key: string; name: string }>;
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  const nav = buildModuleCollectionNav(collections, activeKey);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const selected = navRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (pendingKeyboardFocus !== `${moduleName}:${activeKey}`) return;
    selected?.focus({ preventScroll: true });
    pendingKeyboardFocus = null;
  }, [moduleName, activeKey]);
  if (!nav.show) return null;

  return (
    <nav
      ref={navRef}
      className="flex flex-shrink-0 gap-1 overflow-x-auto px-3 py-2 md:gap-1.5 md:px-6 md:py-2.5"
      style={{ borderBottom: '1px solid var(--ghost-border)' }}
      aria-label={`${moduleName} collections`}
      role="tablist"
    >
      {nav.items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.current}
          tabIndex={item.current || (!nav.items.some((entry) => entry.current) && index === 0) ? 0 : -1}
          onKeyDown={(event) => {
            const next = event.key === 'ArrowRight' ? (index + 1) % nav.items.length
              : event.key === 'ArrowLeft' ? (index - 1 + nav.items.length) % nav.items.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? nav.items.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
            buttons?.[next]?.focus();
            pendingKeyboardFocus = `${moduleName}:${nav.items[next].key}`;
            onSelect(nav.items[next].key);
          }}
          aria-current={item.current ? 'page' : undefined}
          onClick={() => onSelect(item.key)}
          className="flex min-h-10 flex-shrink-0 items-center rounded-full px-3 text-[0.8125rem] font-medium transition-colors md:px-3.5"
          style={{
            color: item.current ? 'var(--on-surface)' : 'var(--on-surface-variant)',
            background: item.current ? 'var(--bg-active)' : 'transparent',
          }}
        >
          {item.name}
        </button>
      ))}
    </nav>
  );
}
