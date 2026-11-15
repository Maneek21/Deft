/**
 * Hosted workspaces: the buyer's setup link is /signup#setup=<token>.
 *
 * The token is read only from the part of the address after "#", which a
 * browser never sends to a server, and never from the query string. Once
 * read it is taken out of the address bar, so it does not stay in history or
 * get copied along with the address.
 */
export function takeSetupTokenFromAddress(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
): string | null {
  const match = /(?:^#|&)setup=([^&]+)/.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}
