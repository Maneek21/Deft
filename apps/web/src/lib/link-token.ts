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
