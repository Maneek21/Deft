import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { mcpConnections, mcpToolOverrides } from '@deft/db/schema';
import { mcpClientManager } from '@deft/mcp';
import { toConnectionConfig } from '../lib/mcp-tools.js';

export const mcpConnectionRoutes = new Hono();

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const createSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'sse', 'streamable-http']),
  server_url: z.string().nullable().optional(),
  stdio_command: z.string().nullable().optional(),
  stdio_args: z.array(z.string()).nullable().optional(),
  auth_type: z.string().optional(),
  auth_config_encrypted: z.any().nullable().optional(),
  default_trust_tier: z.enum(['auto', 'quick', 'full']).optional(),
  enabled_tools: z.array(z.string()).nullable().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  transport: z.enum(['stdio', 'sse', 'streamable-http']).optional(),
  server_url: z.string().nullable().optional(),
  stdio_command: z.string().nullable().optional(),
  stdio_args: z.array(z.string()).nullable().optional(),
  auth_type: z.string().optional(),
  auth_config_encrypted: z.any().nullable().optional(),
  is_active: z.boolean().optional(),
  default_trust_tier: z.enum(['auto', 'quick', 'full']).optional(),
  enabled_tools: z.array(z.string()).nullable().optional(),
});

const toolOverrideSchema = z.object({
  trust_tier_override: z.enum(['auto', 'quick', 'full']).nullable().optional(),
  is_disabled: z.boolean().optional(),
});

// GET / — List org's MCP connections
mcpConnectionRoutes.get('/', async (c) => {
  const user = c.get('user');
  const connections = await db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.org_id, user.org_id));

  return c.json(connections);
});

// GET /:id — Get single connection with tool overrides
mcpConnectionRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const [connection] = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, user.org_id)))
    .limit(1);

  if (!connection) {
    return c.json({ error: 'Connection not found', code: 'NOT_FOUND' }, 404);
  }

  const overrides = await db
    .select()
    .from(mcpToolOverrides)
    .where(and(
      eq(mcpToolOverrides.mcp_connection_id, id),
      eq(mcpToolOverrides.org_id, user.org_id),
    ));

  return c.json({ ...connection, tool_overrides: overrides });
});

// POST / — Create connection
mcpConnectionRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }

  const data = parsed.data;
  const slug = slugify(data.name);

  // Check for duplicate slug in org
  const [existing] = await db
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.org_id, user.org_id), eq(mcpConnections.slug, slug)))
    .limit(1);

  if (existing) {
    return c.json({ error: 'A connection with this name already exists', code: 'DUPLICATE_SLUG' }, 409);
  }

  const [connection] = await db
    .insert(mcpConnections)
    .values({
      org_id: user.org_id,
      name: data.name,
      slug,
      transport: data.transport,
      server_url: data.server_url ?? null,
      stdio_command: data.stdio_command ?? null,
      stdio_args: data.stdio_args ?? null,
      auth_type: data.auth_type ?? 'none',
      auth_config_encrypted: data.auth_config_encrypted ?? null,
      default_trust_tier: data.default_trust_tier ?? 'full',
      enabled_tools: data.enabled_tools ?? null,
      created_by: user.id,
    })
    .returning();

  return c.json(connection, 201);
});

// PUT /:id — Update connection
mcpConnectionRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }

  const [existing] = await db
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, user.org_id)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Connection not found', code: 'NOT_FOUND' }, 404);
  }

  const data = parsed.data;
  const updateData: Record<string, unknown> = {};

  if (data.name !== undefined) {
    updateData.name = data.name;
    updateData.slug = slugify(data.name);
  }
  if (data.transport !== undefined) updateData.transport = data.transport;
  if (data.server_url !== undefined) updateData.server_url = data.server_url;
  if (data.stdio_command !== undefined) updateData.stdio_command = data.stdio_command;
  if (data.stdio_args !== undefined) updateData.stdio_args = data.stdio_args;
  if (data.auth_type !== undefined) updateData.auth_type = data.auth_type;
  if (data.auth_config_encrypted !== undefined) updateData.auth_config_encrypted = data.auth_config_encrypted;
  if (data.is_active !== undefined) updateData.is_active = data.is_active;
  if (data.default_trust_tier !== undefined) updateData.default_trust_tier = data.default_trust_tier;
  if (data.enabled_tools !== undefined) updateData.enabled_tools = data.enabled_tools;

  const [updated] = await db
    .update(mcpConnections)
    .set(updateData)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, user.org_id)))
    .returning();

  return c.json(updated);
});

// DELETE /:id — Delete connection
mcpConnectionRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const [existing] = await db
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, user.org_id)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Connection not found', code: 'NOT_FOUND' }, 404);
  }

  // Disconnect from the MCP client pool
  try {
    await mcpClientManager.disconnect(id);
  } catch {
    // Ignore disconnect errors — connection may not be active
  }

  // Cascade delete handles tool_overrides via FK
  await db
    .delete(mcpConnections)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, user.org_id)));

  return c.json({ success: true });
});

// POST /:id/test — Test connection
mcpConnectionRoutes.post('/:id/test', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const [connection] = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, user.org_id)))
    .limit(1);

  if (!connection) {
    return c.json({ error: 'Connection not found', code: 'NOT_FOUND' }, 404);
  }

  const config = toConnectionConfig(connection);

  try {
    const tools = await mcpClientManager.testConnection(config);

    await db
      .update(mcpConnections)
      .set({
        last_connected_at: new Date(),
        connection_error: null,
        tools_cache: tools as any,
        tools_cached_at: new Date(),
      })
      .where(eq(mcpConnections.id, id));

    return c.json({ success: true, tools_count: tools.length, tools });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    await db
      .update(mcpConnections)
      .set({ connection_error: errorMessage })
      .where(eq(mcpConnections.id, id));

    return c.json({ success: false, error: errorMessage }, 502);
  }
});

// POST /:id/refresh-tools — Re-discover tools
mcpConnectionRoutes.post('/:id/refresh-tools', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const [connection] = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, user.org_id)))
    .limit(1);

  if (!connection) {
    return c.json({ error: 'Connection not found', code: 'NOT_FOUND' }, 404);
  }

  const config = toConnectionConfig(connection);

  // Load overrides for this connection
  const overrideRows = await db
    .select()
    .from(mcpToolOverrides)
    .where(and(
      eq(mcpToolOverrides.mcp_connection_id, id),
      eq(mcpToolOverrides.org_id, user.org_id),
    ));

  const overrides = overrideRows.map((row) => ({
    toolName: row.tool_name,
    approvalTier: row.trust_tier_override
      ? (row.trust_tier_override === 'auto' ? 'auto-execute' as const : row.trust_tier_override === 'quick' ? 'quick-approve' as const : 'full-review' as const)
      : undefined,
    disabled: row.is_disabled,
  }));

  try {
    const tools = await mcpClientManager.discoverTools(config, overrides);

    await db
      .update(mcpConnections)
      .set({
        tools_cache: tools as any,
        tools_cached_at: new Date(),
        last_connected_at: new Date(),
        connection_error: null,
      })
      .where(eq(mcpConnections.id, id));

    return c.json({ success: true, tools_count: tools.length, tools });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    await db
      .update(mcpConnections)
      .set({ connection_error: errorMessage })
      .where(eq(mcpConnections.id, id));

    return c.json({ success: false, error: errorMessage }, 502);
  }
});

// PUT /:id/tools/:toolName — Create or update tool override
mcpConnectionRoutes.put('/:id/tools/:toolName', async (c) => {
  const user = c.get('user');
  const connectionId = c.req.param('id');
  const toolName = c.req.param('toolName');
  const body = await c.req.json();
  const parsed = toolOverrideSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }

  // Verify connection belongs to org
  const [connection] = await db
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.org_id, user.org_id)))
    .limit(1);

  if (!connection) {
    return c.json({ error: 'Connection not found', code: 'NOT_FOUND' }, 404);
  }

  const data = parsed.data;

  // Upsert: check if override exists
  const [existing] = await db
    .select({ id: mcpToolOverrides.id })
    .from(mcpToolOverrides)
    .where(and(
      eq(mcpToolOverrides.mcp_connection_id, connectionId),
      eq(mcpToolOverrides.tool_name, toolName),
    ))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(mcpToolOverrides)
      .set({
        trust_tier_override: data.trust_tier_override ?? null,
        is_disabled: data.is_disabled ?? false,
      })
      .where(eq(mcpToolOverrides.id, existing.id))
      .returning();

    return c.json(updated);
  } else {
    const [created] = await db
      .insert(mcpToolOverrides)
      .values({
        org_id: user.org_id,
        mcp_connection_id: connectionId,
        tool_name: toolName,
        trust_tier_override: data.trust_tier_override ?? null,
        is_disabled: data.is_disabled ?? false,
      })
      .returning();

    return c.json(created, 201);
  }
});
