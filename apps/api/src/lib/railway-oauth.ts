/**
 * Phase 8 — Railway OAuth 2.0 + OIDC helper.
 *
 * Railway exposes a standard OAuth 2 authorization code flow rooted at
 * `railway.com/oauth/authorize` and `railway.com/oauth/token`. Deft
 * registers as an OAuth app (user-side — RAILWAY_OAUTH_CLIENT_ID and
 * RAILWAY_OAUTH_CLIENT_SECRET in env) and redirects the user through the
 * consent flow. The user selects which workspace to share; Deft only gets
 * access to that one workspace.
 *
 * Scopes we request:
 *   - openid email profile — OIDC basics
 *   - workspace:admin — full control of the selected workspace (needed to
 *     create projects, services, and trigger deploys programmatically)
 *   - offline_access — issues a refresh token (1-hour access TTL)
 *
 * `prompt=consent` forces Railway to return a fresh refresh token even on
 * re-authorization flows.
 */
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

export const RAILWAY_AUTHORIZE_URL =
  process.env.RAILWAY_AUTHORIZE_URL || 'https://railway.com/oauth/authorize';
export const RAILWAY_TOKEN_URL =
  process.env.RAILWAY_TOKEN_URL || 'https://railway.com/oauth/token';

export const RAILWAY_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'workspace:admin',
  'offline_access',
];

export type RailwayTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
};

/**
 * Build a Railway authorize URL with a signed state payload. The state is a
 * base64url-encoded JSON string with HMAC signature using JWT_SECRET so the
 * callback can verify the state wasn't tampered with.
 */
export function buildRailwayAuthorizeUrl(params: {
  orgId: string;
  userId: string;
  returnTo: string;
}): string {
  if (!env.RAILWAY_OAUTH_CLIENT_ID) {
    throw new Error(
      'RAILWAY_OAUTH_CLIENT_ID is not set. The administrator needs to register Deft as a Railway OAuth app at https://railway.com/account/apps and set RAILWAY_OAUTH_CLIENT_ID + RAILWAY_OAUTH_CLIENT_SECRET in .env.',
    );
  }
  const state = signState({
    orgId: params.orgId,
    userId: params.userId,
    returnTo: params.returnTo,
    nonce: randomBytes(16).toString('base64url'),
  });
  const qs = new URLSearchParams({
    client_id: env.RAILWAY_OAUTH_CLIENT_ID,
    redirect_uri: env.RAILWAY_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: RAILWAY_OAUTH_SCOPES.join(' '),
    state,
    prompt: 'consent',
  });
  return `${RAILWAY_AUTHORIZE_URL}?${qs.toString()}`;
}

type StatePayload = {
  orgId: string;
  userId: string;
  returnTo: string;
  nonce: string;
};

export function signState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', env.JWT_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyState(state: string): StatePayload {
  const [body, mac] = state.split('.');
  if (!body || !mac) throw new Error('Invalid state format');
  const expected = createHmac('sha256', env.JWT_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid state signature');
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as StatePayload;
  } catch {
    throw new Error('Malformed state body');
  }
}

/**
 * Exchange the authorization code for access + refresh tokens.
 */
export async function exchangeRailwayCode(
  code: string,
): Promise<RailwayTokenResponse> {
  const res = await fetch(RAILWAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.RAILWAY_OAUTH_CLIENT_ID,
      client_secret: env.RAILWAY_OAUTH_CLIENT_SECRET,
      redirect_uri: env.RAILWAY_OAUTH_REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Railway token exchange failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as RailwayTokenResponse;
}

/**
 * Refresh an access token using its refresh token.
 */
export async function refreshRailwayToken(
  refreshToken: string,
): Promise<RailwayTokenResponse> {
  const res = await fetch(RAILWAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.RAILWAY_OAUTH_CLIENT_ID,
      client_secret: env.RAILWAY_OAUTH_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Railway token refresh failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as RailwayTokenResponse;
}

export function isRailwayOAuthConfigured(): boolean {
  return Boolean(env.RAILWAY_OAUTH_CLIENT_ID && env.RAILWAY_OAUTH_CLIENT_SECRET);
}
