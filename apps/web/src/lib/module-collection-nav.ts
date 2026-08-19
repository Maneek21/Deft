export type ModuleCollectionNavItem = {
  key: string;
  name: string;
  current: boolean;
};

export type ModuleCollectionNavModel = {
  show: boolean;
  items: ModuleCollectionNavItem[];
};

export function buildModuleCollectionNav(
  collections: ReadonlyArray<{ key: string; name: string }>,
  activeKey: string | null,
): ModuleCollectionNavModel {
  if (collections.length <= 1) {
    return { show: false, items: [] };
  }

  return {
    show: true,
    items: collections.map((collection) => ({
      key: collection.key,
      name: collection.name,
      current: collection.key === activeKey,
    })),
  };
}
