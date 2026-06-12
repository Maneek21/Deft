import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { mcpTokens } from '@deft/db/schema';
import { issuePersonalMcpToken } from '../lib/mcp-token.js';

export const mcpAccessRoutes = new Hono();

const ALLOWED_SCOPES = [
  'read:workspace',
  'read:wiki',
  'read:tasks',
  'read:messages',
  'read:calendar',
  'write:tasks',
  'write:messages',
  'write:wiki',
] as const;

const createTokenSchema = z.object({
  name: z.string().min(1).max(120).default('Personal AI client'),
  scopes: z.array(z.enum(ALLOWED_SCOPES)).min(1).max(ALLOWED_SCOPES.length),
});

function endpointUrl(): string {
  const base = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.API_PORT || '3001'}`;
  return `${base.replace(/\/$/, '')}/api/mcp/v1`;
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

  return c.json({ tokens: rows, mcp_endpoint_url: endpointUrl(), allowed_scopes: ALLOWED_SCOPES });
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
  return c.json({ ok: true });
});
