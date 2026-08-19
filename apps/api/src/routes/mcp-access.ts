import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { mcpTokens, oauthAccessTokens, oauthAuditEvents, oauthGrants } from '@deft/db/schema';
import { issuePersonalMcpToken } from '../lib/mcp-token.js';
import { enrichOAuthAuditActions } from '../lib/oauth-audit-receipts.js';

export const mcpAccessRoutes = new Hono();

const ALLOWED_SCOPES = [
  'read:workspace',
  'read:wiki',
  'read:tasks',
  'read:messages',
  'read:calendar',
  'read:modules',
  'write:tasks',
  'write:messages',
  'write:wiki',
  'write:calendar',
  'write:modules',
  'write:workspace',
] as const;

const createTokenSchema = z.object({
  name: z.string().min(1).max(120).default('Personal AI client'),
  scopes: z.array(z.enum(ALLOWED_SCOPES)).min(1).max(ALLOWED_SCOPES.length),
});

function endpointUrl(): string {
  const base = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.API_PORT || '3001'}`;
  return `${base.replace(/\/$/, '')}/api/mcp/v1`;
}

async function recentActionsForPersonalToken(orgId: string, userId: string, tokenId: string, limit = 8) {
  const actions = await db
    .select({
      id: oauthAuditEvents.id,
      event: oauthAuditEvents.event,
      metadata: oauthAuditEvents.metadata,
      created_at: oauthAuditEvents.created_at,
    })
    .from(oauthAuditEvents)
    .where(and(
      eq(oauthAuditEvents.org_id, orgId),
      eq(oauthAuditEvents.user_id, userId),
      eq(oauthAuditEvents.client_id, `personal-token:${tokenId}`),
    ))
    .orderBy(desc(oauthAuditEvents.created_at))
    .limit(limit);
  return enrichOAuthAuditActions(orgId, actions);
}

async function recentActionsForGrant(orgId: string, userId: string, clientId: string, grantId: string, limit = 8) {
  const actions = await db
    .select({
      id: oauthAuditEvents.id,
      event: oauthAuditEvents.event,
      metadata: oauthAuditEvents.metadata,
      created_at: oauthAuditEvents.created_at,
    })
    .from(oauthAuditEvents)
    .where(and(
      eq(oauthAuditEvents.org_id, orgId),
      eq(oauthAuditEvents.user_id, userId),
      eq(oauthAuditEvents.client_id, clientId),
      sql`${oauthAuditEvents.metadata}->>'grant_id' = ${grantId}`,
    ))
    .orderBy(desc(oauthAuditEvents.created_at))
    .limit(limit);
  return enrichOAuthAuditActions(orgId, actions);
}

mcpAccessRoutes.get('/tokens', async (c) => {
  const user = c.get('user');
  const rows = await db
    .select({
      id: mcpTokens.id,
      name: mcpTokens.name,
      token_prefix: mcpTokens.token_prefix,
      scopes: mcpTokens.scopes,
      last_used_at: mcpTokens.last_used_at,
      created_at: mcpTokens.created_at,
    })
    .from(mcpTokens)
    .where(and(
      eq(mcpTokens.org_id, user.org_id),
      eq(mcpTokens.user_id, user.id),
      eq(mcpTokens.principal_kind, 'human'),
      isNull(mcpTokens.revoked_at),
    ))
    .orderBy(desc(mcpTokens.created_at));

  const tokens = await Promise.all(rows.map(async (token) => {
    const recentActions = await recentActionsForPersonalToken(user.org_id, user.id, token.id);
    return { ...token, recent_actions: recentActions };
  }));

  return c.json({ tokens, mcp_endpoint_url: endpointUrl(), allowed_scopes: ALLOWED_SCOPES });
});

mcpAccessRoutes.get('/history', async (c) => {
  const user = c.get('user');
  const [tokenRows, grantRows] = await Promise.all([
    db
      .select({
        id: mcpTokens.id,
        name: mcpTokens.name,
        token_prefix: mcpTokens.token_prefix,
        scopes: mcpTokens.scopes,
        last_used_at: mcpTokens.last_used_at,
        created_at: mcpTokens.created_at,
        revoked_at: mcpTokens.revoked_at,
      })
      .from(mcpTokens)
      .where(and(
        eq(mcpTokens.org_id, user.org_id),
        eq(mcpTokens.user_id, user.id),
        eq(mcpTokens.principal_kind, 'human'),
        isNotNull(mcpTokens.revoked_at),
      ))
      .orderBy(desc(mcpTokens.revoked_at))
      .limit(20),
    db
      .select({
        id: oauthGrants.id,
        client_id: oauthGrants.client_id,
        app_name: oauthGrants.app_name,
        connector_profile: oauthGrants.connector_profile,
        scopes: oauthGrants.scopes,
        created_at: oauthGrants.created_at,
        updated_at: oauthGrants.updated_at,
        revoked_at: oauthGrants.revoked_at,
      })
      .from(oauthGrants)
      .where(and(
        eq(oauthGrants.org_id, user.org_id),
        eq(oauthGrants.user_id, user.id),
        isNotNull(oauthGrants.revoked_at),
      ))
      .orderBy(desc(oauthGrants.revoked_at))
      .limit(20),
  ]);

  const revokedTokens = await Promise.all(tokenRows.map(async (token) => ({
    ...token,
    recent_actions: await recentActionsForPersonalToken(user.org_id, user.id, token.id, 10),
  })));

  const revokedGrants = await Promise.all(grantRows.map(async (grant) => {
    const [lastUsed] = await db
      .select({ last_used_at: oauthAccessTokens.last_used_at })
      .from(oauthAccessTokens)
      .where(and(eq(oauthAccessTokens.grant_id, grant.id), isNotNull(oauthAccessTokens.last_used_at)))
      .orderBy(desc(oauthAccessTokens.last_used_at))
      .limit(1);
    return {
      ...grant,
      last_used_at: lastUsed?.last_used_at ?? null,
      recent_actions: await recentActionsForGrant(user.org_id, user.id, grant.client_id, grant.id, 10),
    };
  }));

  return c.json({ revoked_tokens: revokedTokens, revoked_grants: revokedGrants });
});

mcpAccessRoutes.post('/tokens', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = createTokenSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }
  const issued = await issuePersonalMcpToken({
    orgId: user.org_id,
    userId: user.id,
    createdBy: user.id,
    name: parsed.data.name,
    scopes: parsed.data.scopes,
  });
  await db.insert(oauthAuditEvents).values({
    org_id: user.org_id,
    user_id: user.id,
    client_id: `personal-token:${issued.tokenId}`,
    event: 'token_issued',
    metadata: {
      principal_kind: 'human',
      token_id: issued.tokenId,
      token_name: parsed.data.name,
      scopes: parsed.data.scopes,
      surface: 'mcp-access',
    },
  });
  return c.json({
    token: issued.raw,
    token_id: issued.tokenId,
    token_prefix: issued.prefix,
    mcp_endpoint_url: endpointUrl(),
    scopes: parsed.data.scopes,
  }, 201);
});

mcpAccessRoutes.delete('/tokens/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const [row] = await db
    .update(mcpTokens)
    .set({ revoked_at: new Date() })
    .where(and(
      eq(mcpTokens.id, id),
      eq(mcpTokens.org_id, user.org_id),
      eq(mcpTokens.user_id, user.id),
      eq(mcpTokens.principal_kind, 'human'),
      isNull(mcpTokens.revoked_at),
    ))
    .returning({ id: mcpTokens.id });
  if (!row) return c.json({ error: 'Token not found', code: 'NOT_FOUND' }, 404);
  await db.insert(oauthAuditEvents).values({
    org_id: user.org_id,
    user_id: user.id,
    client_id: `personal-token:${row.id}`,
    event: 'token_revoked',
    metadata: {
      principal_kind: 'human',
      token_id: row.id,
      surface: 'mcp-access',
    },
  });
  return c.json({ ok: true });
});
