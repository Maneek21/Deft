import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { connectedAccounts, events } from '@deft/db/schema';
import { env } from '../lib/env.js';
import { encrypt, decrypt } from '../lib/encryption.js';

export const connectionRoutes = new Hono();

// Provider configs
const PROVIDERS: Record<string, {
  name: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: () => string;
  clientSecret: () => string;
}> = {
  google_calendar: {
    name: 'Google Calendar',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'],
    clientId: () => env.GOOGLE_CLIENT_ID,
    clientSecret: () => env.GOOGLE_CLIENT_SECRET,
  },
  github: {
    name: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:org', 'read:user'],
    clientId: () => env.GITHUB_CLIENT_ID,
    clientSecret: () => env.GITHUB_CLIENT_SECRET,
  },
};

// GET /api/connections — list user's connections
connectionRoutes.get('/', async (c) => {
  const user = c.get('user');
  const connections = await db.select({
    id: connectedAccounts.id,
    provider: connectedAccounts.provider,
    provider_account_id: connectedAccounts.provider_account_id,
    scopes: connectedAccounts.scopes,
    metadata: connectedAccounts.metadata,
    last_sync_at: connectedAccounts.last_sync_at,
    sync_error: connectedAccounts.sync_error,
    token_expires_at: connectedAccounts.token_expires_at,
    created_at: connectedAccounts.created_at,
  })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.user_id, user.id), eq(connectedAccounts.org_id, user.org_id)));

  // Derive status for each connection
  const result = connections.map(conn => {
    let status: 'connected' | 'error' | 'expired' = 'connected';
    if (conn.sync_error) status = 'error';
    if (conn.token_expires_at && new Date(conn.token_expires_at) < new Date()) status = 'expired';
    return { ...conn, status };
  });

  return c.json(result);
});

// POST /api/connections/:provider/connect — initiate OAuth flow
connectionRoutes.post('/:provider/connect', async (c) => {
  const user = c.get('user');
  const provider = c.req.param('provider');
  const config = PROVIDERS[provider];

  if (!config) {
    return c.json({ error: 'Unknown provider', code: 'UNKNOWN_PROVIDER' }, 400);
  }

  if (!config.clientId()) {
    return c.json({ error: `${config.name} is not configured. Add credentials to .env`, code: 'NOT_CONFIGURED' }, 503);
  }

  const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/connections/${provider}/callback`;
  const state = Buffer.from(JSON.stringify({ user_id: user.id, org_id: user.org_id })).toString('base64url');

  const params = new URLSearchParams({
    client_id: config.clientId(),
    redirect_uri: redirectUri,
    scope: config.scopes.join(' '),
    state,
    response_type: 'code',
    access_type: 'offline', // Google-specific for refresh token
    prompt: 'consent',
  });

  return c.json({ url: `${config.authUrl}?${params.toString()}` });
});

// GET /api/connections/:provider/callback — OAuth callback handler
connectionRoutes.get('/:provider/callback', async (c) => {
  const provider = c.req.param('provider');
  const config = PROVIDERS[provider];
  if (!config) return c.json({ error: 'Unknown provider' }, 400);

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);

  // Decode state
  let stateData: { user_id: string; org_id: string };
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
  } catch {
    return c.json({ error: 'Invalid state' }, 400);
  }

  const redirectUri = `${env.NEXT_PUBLIC_APP_URL}/api/connections/${provider}/callback`;

  // Exchange code for tokens
  try {
    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.clientId(),
        client_secret: config.clientSecret(),
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json() as Record<string, any>;
    if (!tokenData.access_token) {
      return c.json({ error: 'Failed to get access token', details: tokenData }, 400);
    }

    // Encrypt tokens
    const accessTokenEncrypted = encrypt(tokenData.access_token);
    const refreshTokenEncrypted = tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null;
    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    // Get provider account ID
    let providerAccountId: string | null = null;
    if (provider === 'github') {
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `token ${tokenData.access_token}`, Accept: 'application/json' },
      });
      const ghUser = await userRes.json() as Record<string, any>;
      providerAccountId = String(ghUser.id);
    } else if (provider === 'google_calendar') {
      providerAccountId = tokenData.id_token ? 'google' : 'google-calendar';
    }

    // Upsert connection
    const existing = await db.select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.user_id, stateData.user_id), eq(connectedAccounts.provider, provider)))
      .limit(1);

    if (existing.length > 0) {
      await db.update(connectedAccounts)
        .set({
          access_token_encrypted: accessTokenEncrypted,
          refresh_token_encrypted: refreshTokenEncrypted,
          token_expires_at: expiresAt,
          scopes: config.scopes.join(' '),
          provider_account_id: providerAccountId,
          sync_error: null,
        })
        .where(eq(connectedAccounts.id, existing[0]!.id));
    } else {
      await db.insert(connectedAccounts).values({
        org_id: stateData.org_id,
        user_id: stateData.user_id,
        provider,
        provider_account_id: providerAccountId,
        access_token_encrypted: accessTokenEncrypted,
        refresh_token_encrypted: refreshTokenEncrypted,
        token_expires_at: expiresAt,
        scopes: config.scopes.join(' '),
      });
    }

    // Trigger immediate sync
    if (provider === 'google_calendar') {
      const [conn] = await db.select({ id: connectedAccounts.id })
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.user_id, stateData.user_id), eq(connectedAccounts.provider, provider)))
        .limit(1);
      if (conn) {
        import('../workers/calendar-sync.js').then(m => m.syncCalendarForUser(conn.id)).catch(console.error);
      }
    }
    if (provider === 'github') {
      const [conn] = await db.select({ id: connectedAccounts.id })
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.user_id, stateData.user_id), eq(connectedAccounts.provider, provider)))
        .limit(1);
      if (conn) {
        import('../workers/github-sync.js').then(m => m.syncGitHubForUser(conn.id)).catch(console.error);
      }
    }

    // Redirect back to settings
    return c.redirect(`${env.NEXT_PUBLIC_APP_URL}/settings/integrations?connected=${provider}`);
  } catch (err) {
    console.error(`OAuth callback error for ${provider}:`, err);
    return c.redirect(`${env.NEXT_PUBLIC_APP_URL}/settings/integrations?error=${provider}`);
  }
});

// POST /api/connections/:provider/sync — trigger manual sync
connectionRoutes.post('/:provider/sync', async (c) => {
  const user = c.get('user');
  const provider = c.req.param('provider');
  const [conn] = await db.select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.user_id, user.id), eq(connectedAccounts.provider, provider)))
    .limit(1);
  if (!conn) return c.json({ error: 'Not connected' }, 404);

  if (provider === 'google_calendar') {
    const { syncCalendarForUser } = await import('../workers/calendar-sync.js');
    const result = await syncCalendarForUser(conn.id);
    return c.json(result);
  }
  if (provider === 'github') {
    const { syncGitHubForUser } = await import('../workers/github-sync.js');
    const result = await syncGitHubForUser(conn.id);
    return c.json(result);
  }
  return c.json({ error: 'Unknown provider' }, 400);
});

// DELETE /api/connections/:provider — disconnect
connectionRoutes.delete('/:provider', async (c) => {
  const user = c.get('user');
  const provider = c.req.param('provider');

  // Delete synced events
  const [conn] = await db.select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.user_id, user.id), eq(connectedAccounts.provider, provider)))
    .limit(1);

  if (conn) {
    await db.delete(events).where(eq(events.connected_account_id, conn.id));
    await db.delete(connectedAccounts).where(eq(connectedAccounts.id, conn.id));
  }

  return c.json({ success: true });
});
