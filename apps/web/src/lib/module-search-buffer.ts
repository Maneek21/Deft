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

export function moduleSearchHref(currentHref: string, value: string): string {
  const url = new URL(currentHref);
  if (value) url.searchParams.set('q', value.slice(0, 500));
  else url.searchParams.delete('q');
  return `${url.pathname}${url.search}${url.hash}`;
}
