/**
 * Phase 8 — Integrations route.
 *
 * Handles OAuth connect + callback flows for third-party providers Deft uses
 * to orchestrate managed employee deployments. Today: Railway.
 *
 * Routes:
 *   GET    /api/integrations                  — list org integrations
 *   GET    /api/integrations/railway/start    — initiate Railway OAuth flow
 *   GET    /api/integrations/railway/callback — OAuth callback handler
 *   DELETE /api/integrations/:id              — revoke integration
 *
 * Callback URL pattern matches existing `connections.ts` flows (path
 * includes `/callback`, so the authMiddleware skip rule lets it through).
 * `/start` requires the user to be authenticated since it reads org_id.
 */
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { integrations } from '@deft/db/schema';
import { encrypt } from '../lib/encryption.js';
import {
  buildRailwayAuthorizeUrl,
  exchangeRailwayCode,
  isRailwayOAuthConfigured,
  verifyState,
} from '../lib/railway-oauth.js';
import { getRailwayMe } from '../lib/railway-client.js';
import { env } from '../lib/env.js';

export const integrationsRoutes = new Hono();

// GET / — list integrations for the current org
integrationsRoutes.get('/', async (c) => {
  const user = c.get('user');
  const rows = await db
    .select({
      id: integrations.id,
      provider: integrations.provider,
      account_label: integrations.account_label,
      status: integrations.status,
      external_workspace_id: integrations.external_workspace_id,
      external_workspace_name: integrations.external_workspace_name,
      scopes: integrations.scopes,
      access_token_expires_at: integrations.access_token_expires_at,
      last_used_at: integrations.last_used_at,
      created_at: integrations.created_at,
    })
    .from(integrations)
    .where(eq(integrations.org_id, user.org_id))
    .orderBy(desc(integrations.created_at));
  return c.json(rows);
});

// GET /railway/start — redirect to Railway authorize URL
integrationsRoutes.get('/railway/start', async (c) => {
  const user = c.get('user');
  if (!isRailwayOAuthConfigured()) {
    return c.json(
      {
        error:
          'Railway OAuth is not configured. Set RAILWAY_OAUTH_CLIENT_ID and RAILWAY_OAUTH_CLIENT_SECRET in env.',
        code: 'NOT_CONFIGURED',
      },
      503,
    );
  }
  const returnTo = c.req.query('return_to') || '/settings/agent/deploy';
  const url = buildRailwayAuthorizeUrl({
    orgId: user.org_id,
    userId: user.id,
    returnTo,
  });
  return c.redirect(url);
});

// GET /railway/callback — exchange code for tokens
integrationsRoutes.get('/railway/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const errorParam = c.req.query('error');

  const appUrl = env.NEXT_PUBLIC_APP_URL;

  if (errorParam) {
    return c.redirect(
      `${appUrl}/settings/agent/deploy?railway_error=${encodeURIComponent(errorParam)}`,
    );
  }
  if (!code || !state) {
    return c.redirect(`${appUrl}/settings/agent/deploy?railway_error=missing_params`);
  }

  let statePayload;
  try {
    statePayload = verifyState(state);
  } catch {
    return c.redirect(`${appUrl}/settings/agent/deploy?railway_error=invalid_state`);
  }

  let tokens;
  try {
    tokens = await exchangeRailwayCode(code);
  } catch (err) {
    const msg = encodeURIComponent((err as Error).message);
    return c.redirect(`${appUrl}/settings/agent/deploy?railway_error=${msg}`);
  }

  // Try to fetch the authenticated workspace label for display.
  let workspaceId: string | null = null;
  let workspaceName: string | null = null;
  let email: string | null = null;
  try {
    const me = await getRailwayMe(tokens.access_token);
    email = me.email;
    workspaceId = me.workspaces[0]?.id ?? null;
    workspaceName = me.workspaces[0]?.name ?? null;
  } catch {
    // Fallback: no workspace label; the UI will still show "Connected".
  }

  const accessEnc = encrypt(tokens.access_token);
  const refreshEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;
  const scopes = tokens.scope ? tokens.scope.split(' ') : null;
  const label = workspaceName
    ? `${workspaceName} (${email ?? 'Railway'})`
    : email
    ? `Railway (${email})`
    : 'Railway account';

  // Upsert: one row per (org_id, provider).
  const existing = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.org_id, statePayload.orgId),
        eq(integrations.provider, 'railway'),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(integrations)
      .set({
        access_token_encrypted: accessEnc,
        refresh_token_encrypted: refreshEnc,
        access_token_expires_at: expiresAt,
        scopes,
        external_workspace_id: workspaceId,
        external_workspace_name: workspaceName,
        account_label: label,
        status: 'connected',
        connected_by: statePayload.userId,
        last_used_at: new Date(),
      })
      .where(eq(integrations.id, existing[0]!.id));
  } else {
    await db.insert(integrations).values({
      org_id: statePayload.orgId,
      provider: 'railway',
      account_label: label,
      access_token_encrypted: accessEnc,
      refresh_token_encrypted: refreshEnc,
      access_token_expires_at: expiresAt,
      scopes,
      external_workspace_id: workspaceId,
      external_workspace_name: workspaceName,
      status: 'connected',
      connected_by: statePayload.userId,
    });
  }

  return c.redirect(
    `${appUrl}${statePayload.returnTo}?railway=connected`,
  );
});

// DELETE /:id — revoke integration (blank tokens, flip status)
integrationsRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, id), eq(integrations.org_id, user.org_id)))
    .limit(1);
  if (!row) {
    return c.json({ error: 'Integration not found', code: 'NOT_FOUND' }, 404);
  }
  await db
    .update(integrations)
    .set({
      status: 'revoked',
      access_token_encrypted: '',
      refresh_token_encrypted: null,
    })
    .where(eq(integrations.id, id));
  return c.json({ ok: true });
});
