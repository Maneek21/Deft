/**
 * Links that carry a one-time secret (invites, password recovery) put the
 * secret after `#`. Browsers never send the fragment to a server, so the
 * secret stays out of web-server, proxy and API request logs. The page reads
 * the fragment and sends the secret to the API in a POST body.
 */
function withSecretFragment(appUrl: string, path: string, token: string): string {
  const base = appUrl.replace(/\/+$/, '');
  return `${base}${path}#token=${encodeURIComponent(token)}`;
}

export function buildInviteUrl(appUrl: string, token: string): string {
  return withSecretFragment(appUrl, '/invite', token);
}

export function buildRecoveryUrl(appUrl: string, token: string): string {
  return withSecretFragment(appUrl, '/reset-password', token);
}
