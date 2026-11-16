/**
 * Invite and password recovery links carry their one-time token after `#`
 * (`/invite#token=...`, `/reset-password#token=...`). Browsers never send the
 * fragment to a server, so the token stays out of web-server and proxy logs.
 *
 * Reads the token from the fragment, falling back to a `?token=` query
 * parameter for links issued before the change.
 */
export function readLinkToken(hash: string, search = ''): string | null {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  if (fromHash) return fromHash;
  const fromSearch = new URLSearchParams(search.replace(/^\?/, '')).get('token');
  return fromSearch || null;
}

export type LinkTokenBox = { current: string | null | undefined };
type LinkLocation = { hash: string; search: string; pathname: string };
type LinkHistory = { replaceState(data: unknown, unused: string, url?: string | null): void };

/**
 * Captures a newly supplied token and removes it from the address bar
 * (and so from history, the screen and later same-origin Referers) by
 * replacing the address with `cleanPath`.
 *
 * `box` remembers the current token when the address was already stripped
 * (including StrictMode effect replay), but a replacement link supersedes it.
 * A legacy path token applies only while that path is still in the address.
 */
export function captureLinkToken(
  box: LinkTokenBox,
  location: LinkLocation,
  history: LinkHistory,
  cleanPath: string,
  pathToken: string | null = null,
): string | null {
  const token = readLinkToken(location.hash, location.search)
    ?? (location.pathname !== cleanPath ? pathToken : null);
  if (token || box.current === undefined) box.current = token;
  if (token && (location.hash || location.search || location.pathname !== cleanPath)) {
    // Next copies its internal history state and synchronizes its canonical
    // URL for external changes; passing its own __NA state would skip that.
    history.replaceState(null, '', cleanPath);
  }
  return box.current;
}
