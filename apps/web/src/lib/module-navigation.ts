export const MODULE_SETTINGS_HREF = '/settings/modules';

export type ModuleNavigationRole = 'owner' | 'admin' | 'member' | 'guest';

export type ModuleNavigationSource = {
  slug: string;
  enabled: boolean;
  manifest: {
    name: string;
    icon?: string | null;
  };
};

export type ModuleNavigationItem = {
  kind: 'module';
  name: string;
  href: string;
  icon: string | null;
};

export function moduleAppHref(slug: string): string {
  return `/modules/${encodeURIComponent(slug)}`;
}

export function getModuleNavigationItems(
  modules: readonly ModuleNavigationSource[],
  role?: ModuleNavigationRole | null,
): ModuleNavigationItem[] {
  if (!role || role === 'guest') return [];

  return modules
    .filter((module) => module.enabled)
    .map((module) => ({
      kind: 'module' as const,
      name: module.manifest.name,
      href: moduleAppHref(module.slug),
      icon: module.manifest.icon ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function isPrimaryNavigationItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
