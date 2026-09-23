export type AppNavigationResponseItem = {
  app_installation_id: string;
  app_id: string;
  app_name: string;
  label: string;
  module_slug: string;
  collection_key: string;
  view_key?: string;
  key?: string;
  navigation_order?: number;
};

export type AppNavigationLink = AppNavigationResponseItem & { href: string };
export type AppNavigationItem = {
  kind: 'app'; name: string; href: string; icon: null; installationId: string; links: AppNavigationLink[];
};

export function appNavigationLinkKey(link: Pick<AppNavigationLink, 'key' | 'module_slug' | 'collection_key'>): string {
  return link.key ?? `${link.module_slug}:${link.collection_key}`;
}

export function appNavigationHref(item: Pick<AppNavigationResponseItem, 'module_slug' | 'collection_key' | 'view_key'>): string {
  const path = `/modules/${encodeURIComponent(item.module_slug)}/${encodeURIComponent(item.collection_key)}`;
  return item.view_key ? `${path}?view=${encodeURIComponent(item.view_key)}` : path;
}

export function isAppNavigationLinkActive(
  pathname: string,
  link: Pick<AppNavigationLink, 'href' | 'view_key'>,
  selectedViewKey?: string | null,
): boolean {
  const linkPathname = link.href.split('?', 1)[0]!;
  const pathMatches = pathname === linkPathname || pathname.startsWith(`${linkPathname}/`);
  if (!pathMatches || !selectedViewKey) return pathMatches;
  return !link.view_key || link.view_key === selectedViewKey;
}

export function getAppNavigationItems(items: readonly AppNavigationResponseItem[]): AppNavigationItem[] {
  const groups = new Map<string, AppNavigationItem>();
  for (const item of items) {
    const link = { ...item, href: appNavigationHref(item) };
    const group = groups.get(item.app_installation_id);
    if (group) group.links.push(link);
    else groups.set(item.app_installation_id, {
      kind: 'app', name: item.app_name, href: link.href, icon: null,
      installationId: item.app_installation_id, links: [link],
    });
  }
  return [...groups.values()].map((group) => {
    const links = group.links
      .map((link, index) => ({ link, index }))
      .sort((left, right) => (left.link.navigation_order ?? left.index) - (right.link.navigation_order ?? right.index))
      .map(({ link }) => link);
    return { ...group, links, href: links[0]?.href ?? group.href };
  });
}

export function appNavigationModuleSlug(pathname: string): string | null {
  const encoded = /^\/modules\/([^/?#]+)(?:\/|$)/.exec(pathname)?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function getAppNavigationModuleOwner(moduleSlug: string, groups: readonly AppNavigationItem[]): AppNavigationItem | null {
  const owners = groups.filter((group) => group.links.some((link) => link.module_slug === moduleSlug));
  return owners.length === 1 ? owners[0]! : null;
}

export function isAppNavigationGroupActive(pathname: string, group: AppNavigationItem, groups: readonly AppNavigationItem[]): boolean {
  const matches = groups.filter((candidate) => candidate.links.some((link) => isAppNavigationLinkActive(pathname, link)));
  if (matches.length > 0) return matches.length === 1 && matches[0]?.installationId === group.installationId;
  if (!/^\/modules\/[^/?#]+\/?$/.test(pathname)) return false;
  const moduleSlug = appNavigationModuleSlug(pathname);
  return Boolean(moduleSlug && getAppNavigationModuleOwner(moduleSlug, groups)?.installationId === group.installationId);
}

export function getVisibleModuleNavigationItems<T extends { href: string }>(
  modules: readonly T[],
  appItems: readonly AppNavigationResponseItem[],
  authoritative: boolean,
): T[] {
  if (!authoritative) return [...modules];
  const owners = new Map<string, Set<string>>();
  for (const item of appItems) {
    const set = owners.get(item.module_slug) ?? new Set<string>();
    set.add(item.app_installation_id);
    owners.set(item.module_slug, set);
  }
  return modules.filter((module) => {
    const slug = decodeURIComponent(module.href.slice('/modules/'.length));
    return (owners.get(slug)?.size ?? 0) !== 1;
  });
}
