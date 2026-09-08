import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { connectedAccounts, events } from '@deft/db/schema';

export const connectionRoutes = new Hono();

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
  return c.json({ error: 'Native provider linking is not supported', code: 'NOT_FOUND' }, 404);
});

// GET /api/connections/:provider/callback — OAuth callback handler
connectionRoutes.get('/:provider/callback', async (c) => {
  return c.json({ error: 'Native provider linking is not supported', code: 'NOT_FOUND' }, 404);
});

// POST /api/connections/:provider/sync — trigger manual sync
connectionRoutes.post('/:provider/sync', async (c) => {
  const user = c.get('user');
  const provider = c.req.param('provider');
  const [conn] = await db.select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(and(
      eq(connectedAccounts.user_id, user.id),
      eq(connectedAccounts.org_id, user.org_id),
      eq(connectedAccounts.provider, provider),
    ))
    .limit(1);
  if (!conn) return c.json({ error: 'Not connected' }, 404);

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
    .where(and(
      eq(connectedAccounts.user_id, user.id),
      eq(connectedAccounts.org_id, user.org_id),
      eq(connectedAccounts.provider, provider),
    ))
    .limit(1);

  if (conn) {
    await db.delete(events).where(eq(events.connected_account_id, conn.id));
    await db.delete(connectedAccounts).where(eq(connectedAccounts.id, conn.id));
  }

  return c.json({ success: true });
});
