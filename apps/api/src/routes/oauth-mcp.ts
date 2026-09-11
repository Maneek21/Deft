import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { oauthClients, oauthGrants, oauthAccessTokens, oauthRefreshTokens, oauthAuditEvents } from '@deft/db/schema';
import {
  OAuthMcpError,
  REMOTE_MCP_AUTHORIZATION_SCOPES,
  REMOTE_MCP_SCOPES,
  authorizationScopeSelection,
  auditOAuth,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  isSafeRedirectUri,
  metadataUrls,
  normalizeScopes,
  profileForScopes,
  refreshOAuthAccessToken,
  revokeGrant,
  sha256,
  validateAuthorizeRequest,
} from '../lib/oauth-mcp.js';
import { isHttpsPublicUrl } from '../lib/public-url.js';
import { enrichOAuthAuditActions } from '../lib/oauth-audit-receipts.js';
import { oauthPublicGlobalLimiter, oauthPublicIpLimiter } from '../middleware/rate-limit.js';

export const oauthWellKnownRoutes = new Hono();
export const oauthPublicRoutes = new Hono();
export const oauthProtectedRoutes = new Hono();

const httpsMetadataUrl = z.string().max(2048).url().refine((value) => new URL(value).protocol === 'https:', {
  message: 'Metadata URLs must use HTTPS',
});

const dcrSchema = z.object({
  client_name: z.string().trim().min(1).max(160).default('Remote AI app'),
  application_type: z.enum(['native', 'web']).optional(),
  client_uri: httpsMetadataUrl.optional(),
  logo_uri: httpsMetadataUrl.optional(),
  redirect_uris: z.array(z.string().max(2048).url()).min(1).max(20),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).min(1).max(2).optional(),
  response_types: z.array(z.literal('code')).length(1).optional(),
  token_endpoint_auth_method: z.literal('none').optional(),
  scope: z.string().max(1024).optional(),
});

const tokenSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    client_id: z.string().min(1).max(256),
    code: z.string().min(1).max(8192),
    redirect_uri: z.string().max(2048).url(),
    code_verifier: z.string().min(16).max(256),
    resource: z.string().max(2048).url().optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    client_id: z.string().min(1).max(256),
    refresh_token: z.string().min(1).max(8192),
    resource: z.string().max(2048).url().optional(),
  }),
]);

const revokeSchema = z.object({
  token: z.string().max(8192).optional(),
  token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
  client_id: z.string().min(1).max(256).optional(),
});

const authorizeSchema = z.object({
  response_type: z.string(),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().min(16),
  code_challenge_method: z.string(),
  resource: z.string().url().optional(),
});

async function requestBody(c: any): Promise<Record<string, any>> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return await c.req.json().catch(() => ({}));
  }
  const form = await c.req.parseBody().catch(() => ({}));
  return form as Record<string, any>;
}

function oauthError(c: any, err: unknown) {
  if (err instanceof OAuthMcpError) {
    return c.json({ error: err.code, error_description: err.message }, err.status);
  }
  console.error('[oauth-mcp] unexpected request failure');
  return c.json({ error: 'server_error', error_description: 'OAuth request failed' }, 500);
}

oauthPublicRoutes.use('*', bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => c.json({ error: 'invalid_request', error_description: 'Request body is too large' }, 413),
}));
oauthPublicRoutes.use('*', oauthPublicGlobalLimiter, oauthPublicIpLimiter);

oauthWellKnownRoutes.get('/oauth-protected-resource', (c) => {
  const urls = metadataUrls();
  return c.json({
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: REMOTE_MCP_SCOPES,
    resource_documentation: `${urls.issuer}/docs/self-hosting#mcp-access`,
    token_endpoint_auth_methods_supported: ['none'],
  });
});

oauthWellKnownRoutes.get('/oauth-authorization-server', (c) => {
  const urls = metadataUrls();
  return c.json({
    issuer: urls.issuer,
    authorization_endpoint: urls.authorizationEndpoint,
    token_endpoint: urls.tokenEndpoint,
    registration_endpoint: urls.registrationEndpoint,
    revocation_endpoint: urls.revocationEndpoint,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: REMOTE_MCP_AUTHORIZATION_SCOPES,
  });
});

oauthPublicRoutes.post('/register', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = dcrSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Invalid client metadata', details: parsed.error.flatten() }, 400);
    }
    const redirectUris = parsed.data.redirect_uris;
    if (redirectUris.some((uri) => !isSafeRedirectUri(uri))) {
      return c.json({ error: 'invalid_redirect_uri', error_description: 'Redirect URIs must be HTTPS or localhost' }, 400);
    }
    const grantTypes = parsed.data.grant_types ?? ['authorization_code', 'refresh_token'];
    const responseTypes = parsed.data.response_types ?? ['code'];
    const authMethod = parsed.data.token_endpoint_auth_method ?? 'none';
    if (authMethod !== 'none') {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Only token_endpoint_auth_method=none is supported in this build' }, 400);
    }
    if (!grantTypes.includes('authorization_code') || !responseTypes.includes('code')) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'authorization_code/code is required' }, 400);
    }
    const clientId = `deft_dcr_${crypto.randomUUID()}`;
    await db.insert(oauthClients).values({
      client_id: clientId,
      client_name: parsed.data.client_name,
      client_uri: parsed.data.client_uri ?? null,
      logo_uri: parsed.data.logo_uri ?? null,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: authMethod,
      metadata: parsed.data,
    });
    await auditOAuth({ clientId, event: 'client_registered', metadata: { client_name: parsed.data.client_name } });
    return c.json({
      client_id: clientId,
      client_name: parsed.data.client_name,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: authMethod,
      ...(parsed.data.application_type
        ? { application_type: parsed.data.application_type }
        : {}),
      ...(parsed.data.scope?.trim()
        ? { scope: normalizeScopes(parsed.data.scope).join(' ') }
        : {}),
    }, 201);
  } catch (err) {
    return oauthError(c, err);
  }
});

oauthPublicRoutes.post('/token', async (c) => {
  try {
    const body = await requestBody(c);
    const parsed = tokenSchema.safeParse(body);
    if (!parsed.success) throw new OAuthMcpError(400, 'invalid_request', 'Invalid token request');
    if (parsed.data.grant_type === 'authorization_code') {
      const result = await exchangeAuthorizationCode({
        code: parsed.data.code,
        clientId: parsed.data.client_id,
        redirectUri: parsed.data.redirect_uri,
        codeVerifier: parsed.data.code_verifier,
        resource: parsed.data.resource ?? null,
      });
      return c.json(result);
    }
    if (parsed.data.grant_type === 'refresh_token') {
      const result = await refreshOAuthAccessToken({
        refreshToken: parsed.data.refresh_token,
        clientId: parsed.data.client_id,
        resource: parsed.data.resource ?? null,
      });
      return c.json(result);
    }
    throw new OAuthMcpError(400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
  } catch (err) {
    return oauthError(c, err);
  }
});

oauthPublicRoutes.post('/revoke', async (c) => {
  try {
    const body = await requestBody(c);
    const parsed = revokeSchema.safeParse(body);
    if (!parsed.success) throw new OAuthMcpError(400, 'invalid_request', 'Invalid revocation request');
    const token = parsed.data.token ?? '';
    if (!token) return c.json({ ok: true });
    const tokenHash = sha256(token);
    await db.update(oauthAccessTokens).set({ revoked_at: new Date() }).where(eq(oauthAccessTokens.token_hash, tokenHash));
    await db.update(oauthRefreshTokens).set({ revoked_at: new Date() }).where(eq(oauthRefreshTokens.token_hash, tokenHash));
    return c.json({ ok: true });
  } catch (err) {
    return oauthError(c, err);
  }
});

oauthProtectedRoutes.get('/readiness', async (c) => {
  const urls = metadataUrls();
  return c.json({
    public_url: urls.issuer,
    mcp_endpoint_url: urls.resource,
    authorization_endpoint: urls.authorizationEndpoint,
    token_endpoint: urls.tokenEndpoint,
    registration_endpoint: urls.registrationEndpoint,
    protected_resource_metadata: urls.protectedResourceMetadata,
    authorization_server_metadata: urls.authorizationServerMetadata,
    https_ready: isHttpsPublicUrl(),
    scopes: REMOTE_MCP_SCOPES,
    profiles: ['knowledge', 'task-helper', 'workspace-operator'],
  });
});

oauthProtectedRoutes.get('/authorize/preview', async (c) => {
  try {
    const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    const parsed = authorizeSchema.safeParse(query);
    if (!parsed.success) {
      return c.json({ error: 'Invalid authorization request', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }
    const { client, resource } = await validateAuthorizeRequest({
      clientId: parsed.data.client_id,
      redirectUri: parsed.data.redirect_uri,
      responseType: parsed.data.response_type,
      codeChallenge: parsed.data.code_challenge,
      codeChallengeMethod: parsed.data.code_challenge_method,
      resource: parsed.data.resource,
    });
    const selection = authorizationScopeSelection(
      parsed.data.scope,
      client.metadata as Record<string, unknown>,
    );
    return c.json({
      issuer: metadataUrls().issuer,
      client: {
        client_id: client.client_id,
        client_name: client.client_name,
        client_uri: client.client_uri,
        logo_uri: client.logo_uri,
      },
      resource,
      scopes: selection.scopes,
      available_scopes: selection.availableScopes,
      scope_selection_mode: selection.mode,
      profile: profileForScopes(selection.scopes),
    });
  } catch (err) {
    return oauthError(c, err);
  }
});

oauthProtectedRoutes.post('/authorize', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));
    const parsed = authorizeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid authorization request', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }
    const { client, resource } = await validateAuthorizeRequest({
      clientId: parsed.data.client_id,
      redirectUri: parsed.data.redirect_uri,
      responseType: parsed.data.response_type,
      codeChallenge: parsed.data.code_challenge,
      codeChallengeMethod: parsed.data.code_challenge_method,
      resource: parsed.data.resource,
    });
    const requestedScopes = normalizeScopes(parsed.data.scope);
    const selection = authorizationScopeSelection(
      parsed.data.scope,
      client.metadata as Record<string, unknown>,
    );
    if (requestedScopes.some((scope) => !selection.scopes.includes(scope))) {
      throw new OAuthMcpError(400, 'invalid_scope', 'Requested scope exceeds this client registration');
    }
    const scopes = selection.scopes;
    const { code } = await createAuthorizationCode({
      orgId: user.org_id,
      userId: user.id,
      clientId: client.client_id,
      redirectUri: parsed.data.redirect_uri,
      codeChallenge: parsed.data.code_challenge,
      codeChallengeMethod: parsed.data.code_challenge_method,
      resource,
      scopes,
    });
    const redirect = new URL(parsed.data.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('iss', metadataUrls().issuer);
    if (parsed.data.state) redirect.searchParams.set('state', parsed.data.state);
    return c.json({ redirect_to: redirect.toString() });
  } catch (err) {
    return oauthError(c, err);
  }
});

oauthProtectedRoutes.get('/grants', async (c) => {
  const user = c.get('user');
  const grants = await db
    .select({
      id: oauthGrants.id,
      client_id: oauthGrants.client_id,
      app_name: oauthGrants.app_name,
      connector_profile: oauthGrants.connector_profile,
      scopes: oauthGrants.scopes,
      created_at: oauthGrants.created_at,
      updated_at: oauthGrants.updated_at,
    })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.org_id, user.org_id), eq(oauthGrants.user_id, user.id), isNull(oauthGrants.revoked_at)))
    .orderBy(desc(oauthGrants.created_at));
  const rows = await Promise.all(grants.map(async (grant) => {
    const [lastUsed] = await db
      .select({ last_used_at: oauthAccessTokens.last_used_at })
      .from(oauthAccessTokens)
      .where(and(eq(oauthAccessTokens.grant_id, grant.id), isNotNull(oauthAccessTokens.last_used_at)))
      .orderBy(desc(oauthAccessTokens.last_used_at))
      .limit(1);
    const recentActions = await db
      .select({
        id: oauthAuditEvents.id,
        event: oauthAuditEvents.event,
        metadata: oauthAuditEvents.metadata,
        created_at: oauthAuditEvents.created_at,
      })
      .from(oauthAuditEvents)
      .where(and(
        eq(oauthAuditEvents.org_id, user.org_id),
        eq(oauthAuditEvents.user_id, user.id),
        eq(oauthAuditEvents.client_id, grant.client_id),
        sql`${oauthAuditEvents.metadata}->>'grant_id' = ${grant.id}`,
      ))
      .orderBy(desc(oauthAuditEvents.created_at))
      .limit(8);
    const enrichedActions = await enrichOAuthAuditActions(user.org_id, recentActions);
    return {
      ...grant,
      last_used_at: lastUsed?.last_used_at ?? null,
      recent_actions: enrichedActions,
    };
  }));
  return c.json({ grants: rows });
});

oauthProtectedRoutes.delete('/grants/:id', async (c) => {
  const user = c.get('user');
  const ok = await revokeGrant(c.req.param('id'), user.org_id, user.id);
  if (!ok) return c.json({ error: 'Grant not found', code: 'NOT_FOUND' }, 404);
  return c.json({ ok: true });
});
