export type AppNavigationItem = {
  kind: 'app';
  name: string;
  href: string;
  icon: null;
};

export type AppNavigationResponseItem = {
  label: string;
  module_slug: string;
  collection_key: string;
};

export function appNavigationHref(item: AppNavigationResponseItem): string {
  return `/modules/${encodeURIComponent(item.module_slug)}/${encodeURIComponent(item.collection_key)}`;
}

export function getAppNavigationItems(items: readonly AppNavigationResponseItem[]): AppNavigationItem[] {
  return items.map((item) => ({ kind: 'app' as const, name: item.label, href: appNavigationHref(item), icon: null }));
}
