import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db.js';
import { apiKeys } from '@deft/db/schema';
import { OrgMembershipError, requireOrgAdminOrOwner } from '../lib/org-membership.js';

export const apiKeyRoutes = new Hono();

const createKeySchema = z.object({
  name: z.string().min(1),
  agent_employee_id: z.string().nullable().optional(),
  permissions: z.array(z.string()).min(1),
  rate_limit_per_minute: z.number().int().positive().optional(),
  rate_limit_per_day: z.number().int().positive().optional(),
  expires_at: z.string().nullable().optional(),
});

const updateKeySchema = z.object({
  name: z.string().min(1).optional(),
  permissions: z.array(z.string()).min(1).optional(),
  rate_limit_per_minute: z.number().int().positive().optional(),
  rate_limit_per_day: z.number().int().positive().optional(),
  is_active: z.boolean().optional(),
  expires_at: z.string().nullable().optional(),
});

apiKeyRoutes.use('*', async (c, next) => {
  const user = c.get('user');
  try {
    await requireOrgAdminOrOwner(user.org_id, user.id);
  } catch (err) {
    if (err instanceof OrgMembershipError) {
      return c.json({ error: err.message, code: err.code }, err.status as 403);
    }
    return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
  }
  return next();
});

// GET / — List org's API keys (excluding key_hash)
apiKeyRoutes.get('/', async (c) => {
  const user = c.get('user');
  const keys = await db
    .select({
      id: apiKeys.id,
      org_id: apiKeys.org_id,
      agent_employee_id: apiKeys.agent_employee_id,
      name: apiKeys.name,
      key_prefix: apiKeys.key_prefix,
      permissions: apiKeys.permissions,
      rate_limit_per_minute: apiKeys.rate_limit_per_minute,
      rate_limit_per_day: apiKeys.rate_limit_per_day,
      last_used_at: apiKeys.last_used_at,
      request_count: apiKeys.request_count,
      is_active: apiKeys.is_active,
      expires_at: apiKeys.expires_at,
      created_by: apiKeys.created_by,
      created_at: apiKeys.created_at,
      updated_at: apiKeys.updated_at,
    })
    .from(apiKeys)
    .where(eq(apiKeys.org_id, user.org_id));

  return c.json(keys);
});

// POST / — Create a new API key
apiKeyRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = createKeySchema.parse(await c.req.json());

  // Generate raw key: deft_ + random UUID (no dashes) for compactness
  const rawKey = `deft_${crypto.randomUUID().replace(/-/g, '')}`;
  const keyPrefix = rawKey.slice(0, 12);
  const keyHash = await bcrypt.hash(rawKey, 10);

  const [key] = await db
    .insert(apiKeys)
    .values({
      org_id: user.org_id,
      agent_employee_id: body.agent_employee_id ?? null,
      name: body.name,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      permissions: body.permissions,
      rate_limit_per_minute: body.rate_limit_per_minute ?? 60,
      rate_limit_per_day: body.rate_limit_per_day ?? 10000,
      expires_at: body.expires_at ? new Date(body.expires_at) : null,
      created_by: user.id,
    })
    .returning();

  return c.json({
    ...key,
    raw_key: rawKey, // One-time display — not stored
    key_hash: undefined, // Never return hash
  }, 201);
});

// PUT /:id — Update an API key
apiKeyRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const keyId = c.req.param('id');
  const body = updateKeySchema.parse(await c.req.json());

  const [updated] = await db
    .update(apiKeys)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.permissions !== undefined ? { permissions: body.permissions } : {}),
      ...(body.rate_limit_per_minute !== undefined ? { rate_limit_per_minute: body.rate_limit_per_minute } : {}),
      ...(body.rate_limit_per_day !== undefined ? { rate_limit_per_day: body.rate_limit_per_day } : {}),
      ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
      ...(body.expires_at !== undefined ? { expires_at: body.expires_at ? new Date(body.expires_at) : null } : {}),
    })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.org_id, user.org_id)))
    .returning({
      id: apiKeys.id,
      org_id: apiKeys.org_id,
      agent_employee_id: apiKeys.agent_employee_id,
      name: apiKeys.name,
      key_prefix: apiKeys.key_prefix,
      permissions: apiKeys.permissions,
      rate_limit_per_minute: apiKeys.rate_limit_per_minute,
      rate_limit_per_day: apiKeys.rate_limit_per_day,
      last_used_at: apiKeys.last_used_at,
      request_count: apiKeys.request_count,
      is_active: apiKeys.is_active,
      expires_at: apiKeys.expires_at,
      created_by: apiKeys.created_by,
      created_at: apiKeys.created_at,
      updated_at: apiKeys.updated_at,
    });

  if (!updated) {
    return c.json({ error: 'API key not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json(updated);
});

// DELETE /:id — Delete an API key
apiKeyRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const keyId = c.req.param('id');

  const [deleted] = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.org_id, user.org_id)))
    .returning({ id: apiKeys.id });

  if (!deleted) {
    return c.json({ error: 'API key not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json({ success: true });
});
