/**
 * `from=oauth` on the sign-in and two-step setup pages keeps them without
 * Cross-Origin-Opener-Policy (next.config.ts), so an outside MCP client's
 * pop-up keeps its opener through a reload while the person signs in on the
 * way to /oauth/authorize. The marker is honoured only while this tab holds
 * a saved /oauth/authorize destination; otherwise the page reloads without
 * it, so no ordinary sign-in continues into the app in a document without
 * COOP.
 */
export const OAUTH_MARKER_QUERY = 'from=oauth';

/** True when this tab will return to the MCP authorization page after sign-in. */
export function returnsToOAuthAuthorize(): boolean {
  if (typeof window === 'undefined') return false;
  const destination = sessionStorage.getItem('deft-redirect-after-login');
  return destination === '/oauth/authorize' || Boolean(destination?.startsWith('/oauth/authorize?'));
}

/** `?from=oauth` for a sign-in step on the way back to /oauth/authorize, else ''. */
export function oauthMarkerQuery(): string {
  return returnsToOAuthAuthorize() ? `?${OAUTH_MARKER_QUERY}` : '';
}

const OAUTH_SIGN_IN_PATHS = new Set(['/login', '/two-step-setup']);

/**
 * True when this document was served without COOP: its first URL was the
 * authorization page or a marked sign-in step. Soft navigations keep the
 * first response's headers, so this holds for the document's whole life.
 */
export function documentServedWithoutCoop(): boolean {
  if (typeof window === 'undefined') return false;
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const first = new URL(entry?.name || window.location.href);
  // Next matches header paths without regard to case (and a variant of an
  // exempt path serves the not-found page), so compare the same way.
  const path = first.pathname.toLowerCase();
  return path === '/oauth/authorize'
    || (OAUTH_SIGN_IN_PATHS.has(path) && first.searchParams.getAll('from').at(-1) === 'oauth');
}

/**
 * In a document served without COOP, every link to another page of this
 * origin is followed by a full load, so the destination's own COOP applies
 * (a sign-in step keeps the marker while it is backed). Returns the cleanup.
 */
export function followLinksWithFullLoads(): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    event.stopPropagation();
    if (OAUTH_SIGN_IN_PATHS.has(url.pathname.toLowerCase()) && returnsToOAuthAuthorize()) url.searchParams.set('from', 'oauth');
    window.location.assign(`${url.pathname}${url.search}${url.hash}`);
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}

/**
 * On a page that may carry the marker: when it does but nothing backs it,
 * load the same page without it (a full load, so COOP applies). Returns true
 * when it navigated away.
 */
export function dropUnbackedOAuthMarker(): boolean {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  if (!url.searchParams.getAll('from').includes('oauth') || returnsToOAuthAuthorize()) return false;
  url.searchParams.delete('from');
  window.location.replace(`${url.pathname}${url.search}${url.hash}`);
  return true;
}
