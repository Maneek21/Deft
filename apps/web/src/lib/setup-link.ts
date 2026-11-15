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

/**
 * The body of the signup request. A setup token read from the address
 * travels here, as setup_token, and nowhere else; without one the body is
 * exactly what a self-hosted signup has always sent.
 */
export function signupRequestBody(
  name: string,
  email: string,
  password: string,
  orgName: string,
  setupToken?: string,
): Record<string, string> {
  return {
    name,
    email,
    password,
    org_name: orgName,
    ...(setupToken ? { setup_token: setupToken } : {}),
  };
}
