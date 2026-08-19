'use client';

import { buildModuleCollectionNav } from '@/lib/module-collection-nav';

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
  if (!nav.show) return null;

  return (
    <nav
      className="flex flex-shrink-0 gap-1 overflow-x-auto px-3 py-2 md:gap-1.5 md:px-6 md:py-2.5"
      style={{ borderBottom: '1px solid var(--ghost-border)' }}
      aria-label={`${moduleName} collections`}
      role="tablist"
    >
      {nav.items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.current}
          aria-current={item.current ? 'page' : undefined}
          onClick={() => onSelect(item.key)}
          className="flex min-h-10 flex-shrink-0 items-center rounded-lg px-3 text-[0.8125rem] font-medium md:min-h-11 md:px-3.5"
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
