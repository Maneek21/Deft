import { moduleListParams, parseModuleListContext, type ModuleListContext } from './module-list-context';

export type ModuleSearchBuffer = { identity: string; value: string };

export function moduleSearchValue(buffer: ModuleSearchBuffer, identity: string, urlSearch: string): string {
  return buffer.identity === identity ? buffer.value : urlSearch;
}

export function reconcileModuleSearch(
  buffer: ModuleSearchBuffer,
  identity: string,
  urlSearch: string,
  renderedQuery: string,
  browserQuery: string,
): ModuleSearchBuffer {
  // An earlier useSearchParams render can arrive after another input event.
  // Only the browser's current URL is authoritative, including Back/Forward.
  if (renderedQuery !== browserQuery) return buffer;
  if (buffer.identity === identity && buffer.value === urlSearch) return buffer;
  return { identity, value: urlSearch };
}

export type ModuleListControlUpdate = Partial<Pick<ModuleListContext, 'search' | 'filters' | 'sort'>>;

export function moduleListControlsHref(currentHref: string, changes: ModuleListControlUpdate): string {
  const url = new URL(currentHref);
  const context = { ...parseModuleListContext(url.searchParams), ...changes };
  context.filtersExplicit = Boolean(context.savedViewId) || context.filters.length > 0;
  const canonical = moduleListParams(context);
  const keys = [
    ...('search' in changes ? ['q'] : []),
    ...('filters' in changes ? ['filters'] : []),
    ...('sort' in changes ? ['sort', 'direction'] : []),
  ];
  for (const key of keys) {
    const value = canonical.get(key);
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function moduleSearchHref(currentHref: string, value: string): string {
  return moduleListControlsHref(currentHref, { search: value });
}
