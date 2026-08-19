import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db.js';
import { appPublicUrl, mcpResourceUrl, oauthIssuerUrl } from './public-url.js';
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthAuditEvents,
  oauthClients,
  oauthGrants,
  oauthRefreshTokens,
  orgMembers,
} from '@deft/db/schema';

export const REMOTE_MCP_READ_SCOPES = [
  'read:workspace',
  'read:wiki',
  'read:tasks',
  'read:messages',
  'read:calendar',
  'read:modules',
] as const;

// Keep the historical scope-less grant least-privilege contract stable.
// Modules are advertised and selectable, but are never injected into an
// omitted/legacy request merely because the server learned a new scope.
export const REMOTE_MCP_DEFAULT_READ_SCOPES = [
  'read:workspace',
  'read:wiki',
  'read:tasks',
  'read:messages',
  'read:calendar',
] as const;

export const REMOTE_MCP_WRITE_SCOPES = [
  'write:tasks',
  'write:messages',
  'write:wiki',
  'write:calendar',
  'write:modules',
  'write:workspace',
] as const;

export const REMOTE_MCP_SCOPES = [
  ...REMOTE_MCP_READ_SCOPES,
  ...REMOTE_MCP_WRITE_SCOPES,
] as const;

// Authorization-only scope. It is advertised by the OAuth server, but not by
// the MCP protected resource because it does not grant access to workspace data.
export const REMOTE_MCP_AUTHORIZATION_SCOPES = [
  ...REMOTE_MCP_SCOPES,
  'offline_access',
] as const;

export type RemoteMcpScope = typeof REMOTE_MCP_SCOPES[number];
type RemoteMcpAuthorizationScope = typeof REMOTE_MCP_AUTHORIZATION_SCOPES[number];
export type ConnectorProfile = 'knowledge' | 'task-helper' | 'workspace-operator';
export type AuthorizationScopeSelectionMode = 'client-requested' | 'deft-choice';

export type OAuthAccessPrincipal = {
  kind: 'oauth';
  token_id: string;
  grant_id: string;
  org_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  client_id: string;
  scopes: string[];
  connector_profile: ConnectorProfile;
};

export class OAuthMcpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthMcpError';
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function normalizeScopes(value: string | string[] | undefined | null): string[] {
  const raw = Array.isArray(value) ? value.join(' ') : value ?? '';
  const requested = raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const allowed = new Set(REMOTE_MCP_AUTHORIZATION_SCOPES);
  const scopes = requested.length > 0
    ? requested.filter((s) => allowed.has(s as RemoteMcpAuthorizationScope))
    : [...REMOTE_MCP_DEFAULT_READ_SCOPES];
  return scopes.length > 0 ? Array.from(new Set(scopes)) : [...REMOTE_MCP_DEFAULT_READ_SCOPES];
}

export function authorizationScopeSelection(
  requestedScope: string | string[] | undefined | null,
  clientMetadata: Record<string, unknown> | null | undefined,
) {
  const registeredScope = typeof clientMetadata?.scope === 'string' && clientMetadata.scope.trim()
    ? clientMetadata.scope
    : null;
  const clientOmittedScope = registeredScope === null;
  const requestedScopes = normalizeScopes(requestedScope ?? registeredScope);
  const registeredScopes = registeredScope ? normalizeScopes(registeredScope) : null;
  const scopes = registeredScopes
    ? requestedScopes.filter((scope) => registeredScopes.includes(scope))
    : requestedScopes;

  return {
    scopes,
    availableScopes: clientOmittedScope
      ? [...REMOTE_MCP_AUTHORIZATION_SCOPES]
      : scopes,
    mode: (clientOmittedScope ? 'deft-choice' : 'client-requested') as AuthorizationScopeSelectionMode,
  };
}

export function profileForScopes(scopes: string[]): ConnectorProfile {
  if (scopes.includes('write:workspace') || scopes.includes('write:calendar')) {
    return 'workspace-operator';
  }
  return scopes.some((scope) => REMOTE_MCP_WRITE_SCOPES.includes(scope as typeof REMOTE_MCP_WRITE_SCOPES[number]))
    ? 'task-helper'
    : 'knowledge';
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function isSafeRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export async function auditOAuth(event: {
  orgId?: string | null;
  userId?: string | null;
  clientId?: string | null;
  event: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await db.insert(oauthAuditEvents).values({
      org_id: event.orgId ?? null,
      user_id: event.userId ?? null,
      client_id: event.clientId ?? null,
      event: event.event,
      metadata: event.metadata ?? {},
    });
  } catch (err) {
    console.warn('[oauth-mcp] audit failed:', err);
  }
}

export async function getOAuthClient(clientId: string) {
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.client_id, clientId)).limit(1);
  return client ?? null;
}

export async function validateAuthorizeRequest(params: {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource?: string | null;
}) {
  if (params.responseType !== 'code') {
    throw new OAuthMcpError(400, 'unsupported_response_type', 'Only response_type=code is supported');
  }
  if (params.codeChallengeMethod !== 'S256' || !params.codeChallenge) {
    throw new OAuthMcpError(400, 'invalid_request', 'PKCE S256 code_challenge is required');
  }
  const client = await getOAuthClient(params.clientId);
  if (!client) throw new OAuthMcpError(400, 'invalid_client', 'Unknown OAuth client');
  if (!client.redirect_uris.includes(params.redirectUri)) {
    throw new OAuthMcpError(400, 'invalid_redirect_uri', 'redirect_uri is not registered for this client');
  }
  const resource = params.resource || mcpResourceUrl();
  if (resource !== mcpResourceUrl()) {
    throw new OAuthMcpError(400, 'invalid_target', 'resource does not match this Deft MCP server');
  }
  return { client, resource };
}

export async function createAuthorizationCode(params: {
  orgId: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  scopes: string[];
}) {
  const code = randomToken('deft_oac');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await db.insert(oauthAuthorizationCodes).values({
    code_hash: sha256(code),
    org_id: params.orgId,
    user_id: params.userId,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
    resource: params.resource,
    scopes: params.scopes,
    expires_at: expiresAt,
  });
  await auditOAuth({
    orgId: params.orgId,
    userId: params.userId,
    clientId: params.clientId,
    event: 'authorization_code_issued',
    metadata: { scopes: params.scopes, resource: params.resource },
  });
  return { code, expiresAt };
}

export async function exchangeAuthorizationCode(params: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string | null;
}) {
  const [row] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.code_hash, sha256(params.code)))
    .limit(1);
  if (!row) throw new OAuthMcpError(400, 'invalid_grant', 'Invalid authorization code');
  if (row.used_at) throw new OAuthMcpError(400, 'invalid_grant', 'Authorization code already used');
  if (row.expires_at.getTime() < Date.now()) throw new OAuthMcpError(400, 'invalid_grant', 'Authorization code expired');
  if (row.client_id !== params.clientId) throw new OAuthMcpError(400, 'invalid_grant', 'client_id mismatch');
  if (row.redirect_uri !== params.redirectUri) throw new OAuthMcpError(400, 'invalid_grant', 'redirect_uri mismatch');
  if (row.resource !== (params.resource || mcpResourceUrl())) throw new OAuthMcpError(400, 'invalid_target', 'resource mismatch');
  if (row.code_challenge !== pkceS256(params.codeVerifier)) {
    throw new OAuthMcpError(400, 'invalid_grant', 'PKCE verification failed');
  }

  await db.update(oauthAuthorizationCodes).set({ used_at: new Date() }).where(eq(oauthAuthorizationCodes.id, row.id));
  const client = await getOAuthClient(row.client_id);
  const connectorProfile = profileForScopes(row.scopes);
  const [grant] = await db.insert(oauthGrants).values({
    org_id: row.org_id,
    user_id: row.user_id,
    client_id: row.client_id,
    app_name: client?.client_name ?? 'Remote AI app',
    connector_profile: connectorProfile,
    scopes: row.scopes,
  }).returning();
  if (!grant) throw new OAuthMcpError(500, 'server_error', 'Failed to create OAuth grant');
  return issueTokensForGrant(grant.id, row.org_id, row.user_id, row.client_id, row.resource, row.scopes);
}

export async function issueTokensForGrant(
  grantId: string,
  orgId: string,
  userId: string,
  clientId: string,
  resource: string,
  scopes: string[],
  rotatedFromRefreshTokenId?: string,
) {
  const accessToken = randomToken('deft_oat');
  const refreshToken = randomToken('deft_ort');
  const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(oauthAccessTokens).values({
    token_hash: sha256(accessToken),
    grant_id: grantId,
    org_id: orgId,
    user_id: userId,
    client_id: clientId,
    resource,
    scopes,
    expires_at: accessExpiresAt,
  });
  await db.insert(oauthRefreshTokens).values({
    token_hash: sha256(refreshToken),
    grant_id: grantId,
    rotated_from: rotatedFromRefreshTokenId,
    expires_at: refreshExpiresAt,
  });
  await auditOAuth({ orgId, userId, clientId, event: 'token_issued', metadata: { grant_id: grantId, scopes, resource } });
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: scopes.join(' '),
  };
}

export async function refreshOAuthAccessToken(params: {
  refreshToken: string;
  clientId: string;
  resource?: string | null;
}) {
  const [refresh] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.token_hash, sha256(params.refreshToken)))
    .limit(1);
  if (!refresh || refresh.revoked_at) throw new OAuthMcpError(400, 'invalid_grant', 'Invalid refresh token');
  if (refresh.expires_at.getTime() < Date.now()) throw new OAuthMcpError(400, 'invalid_grant', 'Refresh token expired');
  const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, refresh.grant_id)).limit(1);
  if (!grant || grant.revoked_at) throw new OAuthMcpError(400, 'invalid_grant', 'OAuth grant revoked');
  if (grant.client_id !== params.clientId) throw new OAuthMcpError(400, 'invalid_grant', 'client_id mismatch');
  const resource = params.resource || mcpResourceUrl();
  if (resource !== mcpResourceUrl()) {
    throw new OAuthMcpError(400, 'invalid_target', 'resource does not match this Deft MCP server');
  }
  await db.update(oauthRefreshTokens).set({ revoked_at: new Date() }).where(eq(oauthRefreshTokens.id, refresh.id));
  return issueTokensForGrant(grant.id, grant.org_id, grant.user_id, grant.client_id, resource, grant.scopes, refresh.id);
}

export async function resolveOAuthAccessToken(bearer: string): Promise<OAuthAccessPrincipal> {
  const [row] = await db
    .select()
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.token_hash, sha256(bearer)))
    .limit(1);
  if (!row || row.revoked_at) throw new OAuthMcpError(401, 'unauthorized', 'Invalid OAuth access token');
  if (row.expires_at.getTime() < Date.now()) throw new OAuthMcpError(401, 'unauthorized', 'OAuth access token expired');
  if (row.resource !== mcpResourceUrl()) throw new OAuthMcpError(403, 'forbidden', 'OAuth token audience does not match this MCP server');
  const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, row.grant_id)).limit(1);
  if (!grant || grant.revoked_at) throw new OAuthMcpError(403, 'forbidden', 'OAuth grant revoked');
  const [member] = await db
    .select({ role: orgMembers.role, is_active: orgMembers.is_active })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, row.org_id), eq(orgMembers.user_id, row.user_id)))
    .limit(1);
  if (!member?.is_active) throw new OAuthMcpError(403, 'forbidden', 'OAuth token owner is not an active org member');
  await db.update(oauthAccessTokens).set({ last_used_at: new Date() }).where(eq(oauthAccessTokens.id, row.id));
  return {
    kind: 'oauth',
    token_id: row.id,
    grant_id: row.grant_id,
    org_id: row.org_id,
    user_id: row.user_id,
    role: member.role as OAuthAccessPrincipal['role'],
    client_id: row.client_id,
    scopes: row.scopes,
    connector_profile: grant.connector_profile as ConnectorProfile,
  };
}

export async function revokeGrant(grantId: string, orgId: string, userId: string) {
  const now = new Date();
  const [grant] = await db
    .update(oauthGrants)
    .set({ revoked_at: now })
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.org_id, orgId), eq(oauthGrants.user_id, userId), isNull(oauthGrants.revoked_at)))
    .returning();
  if (!grant) return false;
  await db.update(oauthAccessTokens).set({ revoked_at: now }).where(eq(oauthAccessTokens.grant_id, grantId));
  await db.update(oauthRefreshTokens).set({ revoked_at: now }).where(eq(oauthRefreshTokens.grant_id, grantId));
  await auditOAuth({ orgId, userId, clientId: grant.client_id, event: 'grant_revoked', metadata: { grant_id: grantId } });
  return true;
}

export function metadataUrls() {
  const issuer = oauthIssuerUrl();
  return {
    issuer,
    resource: mcpResourceUrl(),
    authorizationEndpoint: `${appPublicUrl()}/oauth/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    registrationEndpoint: `${issuer}/oauth/register`,
    revocationEndpoint: `${issuer}/oauth/revoke`,
    protectedResourceMetadata: `${issuer}/.well-known/oauth-protected-resource`,
    authorizationServerMetadata: `${issuer}/.well-known/oauth-authorization-server`,
  };
}
