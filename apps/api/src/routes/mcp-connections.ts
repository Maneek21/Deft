import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { mcpConnections, mcpToolOverrides } from '@deft/db/schema';
import { mcpClientManager } from '@deft/mcp';
import { canonicalMcpToolName, toConnectionConfig } from '../lib/mcp-tools.js';
import {
  mcpAuthTypeSchema,
  mcpCredentialInputSchema,
  redactMcpConnection,
  storeMcpCredential,
} from '../lib/mcp-connection-auth.js';
import { validateMcpConnectionTarget } from '../lib/mcp-connection-validation.js';

export const mcpConnectionRoutes = new Hono();

// Connector configuration can create outbound network clients and, in
// self-hosted mode, spawn explicitly configured stdio commands. Treat the
// whole surface as an administrative control plane rather than ordinary
// workspace data.
mcpConnectionRoutes.use('*', async (c, next) => {
  const role = c.get('user').role;
  if (role !== 'owner' && role !== 'admin') {
    return c.json({ error: 'Only owners or admins can manage MCP connections', code: 'FORBIDDEN' }, 403);
  }
  return next();
});

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const createSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'sse', 'streamable-http']).default('streamable-http'),
  server_url: z.string().nullable().optional(),
  stdio_command: z.string().nullable().optional(),
  stdio_args: z.array(z.string()).nullable().optional(),
  auth_type: mcpAuthTypeSchema.default('none'),
  credential: mcpCredentialInputSchema.optional(),
  default_trust_tier: z.enum(['auto', 'quick', 'full']).optional(),
  enabled_tools: z.array(z.string()).nullable().optional(),
}).strict();

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  transport: z.enum(['stdio', 'sse', 'streamable-http']).optional(),
  server_url: z.string().nullable().optional(),
  stdio_command: z.string().nullable().optional(),
  stdio_args: z.array(z.string()).nullable().optional(),
  auth_type: mcpAuthTypeSchema.optional(),
  credential: mcpCredentialInputSchema.optional(),
  is_active: z.boolean().optional(),
  default_trust_tier: z.enum(['auto', 'quick', 'full']).optional(),
  enabled_tools: z.array(z.string()).nullable().optional(),
}).strict();

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

  return c.json(connections.map((connection) => redactMcpConnection(connection)));
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

  return c.json({ ...redactMcpConnection(connection), tool_overrides: overrides });
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

  if (data.auth_type === 'api_key' && !data.credential) {
    return c.json({ error: 'API key authentication requires a credential', code: 'VALIDATION_ERROR' }, 400);
  }
  if (data.auth_type === 'none' && data.credential) {
    return c.json({ error: 'A credential cannot be supplied when authentication is disabled', code: 'VALIDATION_ERROR' }, 400);
  }
  const targetError = validateMcpConnectionTarget({
    transport: data.transport,
    serverUrl: data.server_url,
    stdioCommand: data.stdio_command,
    stdioArgs: data.stdio_args,
  });
  if (targetError) {
    return c.json({ error: targetError, code: 'VALIDATION_ERROR' }, 400);
  }

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
      auth_type: data.auth_type,
      auth_config_encrypted: data.credential ? storeMcpCredential(data.credential) : null,
      default_trust_tier: data.default_trust_tier ?? 'full',
      enabled_tools: data.enabled_tools ?? null,
      created_by: user.id,
    })
    .returning();

  if (!connection) {
    return c.json({ error: 'Failed to create connection', code: 'CREATE_FAILED' }, 500);
  }
  return c.json(redactMcpConnection(connection), 201);
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
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, user.org_id)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Connection not found', code: 'NOT_FOUND' }, 404);
  }

  const data = parsed.data;
  const nextAuthType = data.auth_type ?? existing.auth_type;

  if (data.credential && nextAuthType !== 'api_key') {
    return c.json({ error: 'A credential requires API key authentication', code: 'VALIDATION_ERROR' }, 400);
  }
  if (
    nextAuthType === 'api_key'
    && !data.credential
    && (existing.auth_config_encrypted === null || existing.auth_config_encrypted === undefined)
  ) {
    return c.json({ error: 'API key authentication requires a credential', code: 'VALIDATION_ERROR' }, 400);
  }
  const targetError = validateMcpConnectionTarget({
    transport: data.transport ?? existing.transport,
    serverUrl: data.server_url !== undefined ? data.server_url : existing.server_url,
    stdioCommand: data.stdio_command !== undefined ? data.stdio_command : existing.stdio_command,
    stdioArgs: data.stdio_args !== undefined
      ? data.stdio_args
      : (existing.stdio_args as string[] | null),
  });
  if (targetError) {
    return c.json({ error: targetError, code: 'VALIDATION_ERROR' }, 400);
  }

  const updateData: Record<string, unknown> = {};

  if (data.name !== undefined) {
    updateData.name = data.name;
  }
  if (data.transport !== undefined) updateData.transport = data.transport;
  if (data.server_url !== undefined) updateData.server_url = data.server_url;
  if (data.stdio_command !== undefined) updateData.stdio_command = data.stdio_command;
  if (data.stdio_args !== undefined) updateData.stdio_args = data.stdio_args;
  if (data.auth_type !== undefined) updateData.auth_type = data.auth_type;
  if (data.auth_type === 'none') updateData.auth_config_encrypted = null;
  if (data.credential !== undefined) {
    updateData.auth_config_encrypted = storeMcpCredential(data.credential);
    // Unsupported legacy OAuth rows are disabled by the startup migration.
    // Supplying a supported credential is the explicit recovery action.
    updateData.is_active = true;
    updateData.connection_error = null;
  }
  if (data.is_active !== undefined) updateData.is_active = data.is_active;
  if (data.default_trust_tier !== undefined) updateData.default_trust_tier = data.default_trust_tier;
  if (data.enabled_tools !== undefined) updateData.enabled_tools = data.enabled_tools;

  const [updated] = await db
    .update(mcpConnections)
    .set(updateData)
    .where(and(eq(mcpConnections.id, id), eq(mcpConnections.org_id, user.org_id)))
    .returning();

  if (!updated) {
    return c.json({ error: 'Failed to update connection', code: 'UPDATE_FAILED' }, 500);
  }

  // Ensure future requests do not reuse a client holding stale URL/auth data.
  await mcpClientManager.disconnect(id);

  return c.json(redactMcpConnection(updated));
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

  try {
    const config = toConnectionConfig(connection);
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
    const config = toConnectionConfig(connection);
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
  const requestedToolName = c.req.param('toolName');
  const body = await c.req.json();
  const parsed = toolOverrideSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
  }

  // Verify connection belongs to org
  const [connection] = await db
    .select({ id: mcpConnections.id, slug: mcpConnections.slug })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.org_id, user.org_id)))
    .limit(1);

  if (!connection) {
    return c.json({ error: 'Connection not found', code: 'NOT_FOUND' }, 404);
  }

  const toolName = canonicalMcpToolName(requestedToolName);
  if (!toolName || (requestedToolName.startsWith('mcp__') && toolName === requestedToolName)) {
    return c.json({ error: 'Invalid tool name', code: 'VALIDATION_ERROR' }, 400);
  }

  const data = parsed.data;

  // Read all rows so historical legacy-prefixed duplicates can be collapsed
  // to the stable connection-local name in one transaction.
  const overrideRows = await db
    .select({ id: mcpToolOverrides.id, tool_name: mcpToolOverrides.tool_name })
    .from(mcpToolOverrides)
    .where(and(
      eq(mcpToolOverrides.org_id, user.org_id),
      eq(mcpToolOverrides.mcp_connection_id, connectionId),
    ));
  const matchingRows = overrideRows.filter((row) => canonicalMcpToolName(row.tool_name) === toolName);

  if (matchingRows.length > 0) {
    const primary = matchingRows.find((row) => row.tool_name === toolName) ?? matchingRows[0]!;
    const duplicateIds = matchingRows.filter((row) => row.id !== primary.id).map((row) => row.id);
    const updated = await db.transaction(async (tx) => {
      if (duplicateIds.length > 0) {
        await tx.delete(mcpToolOverrides).where(inArray(mcpToolOverrides.id, duplicateIds));
      }
      const [row] = await tx
        .update(mcpToolOverrides)
        .set({
          tool_name: toolName,
          trust_tier_override: data.trust_tier_override ?? null,
          is_disabled: data.is_disabled ?? false,
        })
        .where(eq(mcpToolOverrides.id, primary.id))
        .returning();
      return row;
    });

    await mcpClientManager.disconnect(connectionId);
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

    await mcpClientManager.disconnect(connectionId);
    return c.json(created, 201);
  }
});
