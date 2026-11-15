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
type LinkHistory = { state: unknown; replaceState(data: unknown, unused: string, url?: string | null): void };

/**
 * Captures the page's one-time token once and removes it from the address bar
 * (and so from history, the screen and later same-origin Referers) by
 * replacing the address with `cleanPath`.
 *
 * `box` (a React ref) remembers the first result: React StrictMode runs mount
 * effects twice in development, and the second run would otherwise find the
 * address already stripped and report no token. `pathToken` is a token taken
 * from the route path, for old `/invite/<token>` links.
 */
export function captureLinkToken(
  box: LinkTokenBox,
  location: LinkLocation,
  history: LinkHistory,
  cleanPath: string,
  pathToken: string | null = null,
): string | null {
  if (box.current !== undefined) return box.current;
  const token = readLinkToken(location.hash, location.search) ?? (pathToken || null);
  box.current = token;
  if (token && (location.hash || location.search || location.pathname !== cleanPath)) {
    history.replaceState(history.state, '', cleanPath);
  }
  return token;
}
