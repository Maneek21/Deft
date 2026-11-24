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
