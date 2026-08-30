/**
 * One-shot installer for the Tier-1 MCP bundle on Alex PM's org.
 *
 * For each entry in BUNDLE:
 *   1. Upsert an mcp_connections row (keyed by org_id + slug)
 *   2. Request tool discovery through Capability Service's cached MCP mode
 *      — this runs the updated classifier and picks tiers
 *   3. Persist the discovered tools into tools_cache
 *   4. Attach the connection id to Alex PM's mcp_connection_ids
 *
 * Secrets are injected via env vars. Never hardcode API keys here.
 *
 * Run:
 *   TAVILY_MCP_URL="https://mcp.tavily.com/mcp/?tavilyApiKey=..." \
 *     pnpm --filter @deft/api exec tsx src/scripts/install-tier1-mcp-bundle.ts
 */
import { db } from '../lib/db.js';
import { mcpConnections, agentEmployees, orgMembers } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { capabilityService } from '../lib/capability-service.js';

const EMPLOYEE_ID = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633'; // Alex PM

type BundleEntry = {
  slug: string;
  name: string;
  transport: 'stdio' | 'streamable-http';
  stdio_command?: string;
  stdio_args?: string[];
  server_url?: string;
  required: boolean;
};

const TAVILY_URL = process.env.TAVILY_MCP_URL || '';

const BUNDLE: BundleEntry[] = [
  {
    // yokingma/time-mcp — Node-native, no Python deps. Exposes current_time,
    // relative_time, convert_time, days_in_month, get_week_year, get_timestamp.
    slug: 'time',
    name: 'Time',
    transport: 'stdio',
    stdio_command: 'npx',
    stdio_args: ['-y', 'time-mcp'],
    required: true,
  },
  {
    // fetch-mcp — generic HTTP/GraphQL/WebSocket client, Node-native.
    slug: 'fetch',
    name: 'Fetch',
    transport: 'stdio',
    stdio_command: 'npx',
    stdio_args: ['-y', 'fetch-mcp'],
    required: true,
  },
  {
    slug: 'tavily-search',
    name: 'Tavily Search',
    transport: 'streamable-http',
    server_url: TAVILY_URL,
    required: false, // skipped if TAVILY_MCP_URL not set
  },
  {
    slug: 'sequential-thinking',
    name: 'Sequential Thinking',
    transport: 'stdio',
    stdio_command: 'npx',
    stdio_args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    required: true,
  },
  {
    slug: 'context7',
    name: 'Context7 Docs',
    transport: 'stdio',
    stdio_command: 'npx',
    stdio_args: ['-y', '@upstash/context7-mcp@latest'],
    required: true,
  },
];

async function main() {
  const [emp] = await db
    .select()
    .from(agentEmployees)
    .where(eq(agentEmployees.id, EMPLOYEE_ID))
    .limit(1);
  if (!emp) {
    console.error(`Employee ${EMPLOYEE_ID} not found`);
    process.exit(1);
  }
  const orgId = emp.org_id;
  console.log(`Installing Tier-1 bundle for ${emp.name} (org ${orgId})\n`);

  const [creator] = await db
    .select({ id: orgMembers.user_id })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true)))
    .limit(1);
  if (!creator) {
    console.error(`No active members found in org ${orgId}`);
    process.exit(1);
  }

  const attachedIds = new Set<string>(emp.mcp_connection_ids ?? []);
  const classificationTable: { slug: string; tool: string; tier: string; isWrite: boolean }[] = [];

  for (const entry of BUNDLE) {
    console.log(`── ${entry.name} (${entry.slug}) ──`);

    if (entry.transport === 'streamable-http' && !entry.server_url) {
      if (entry.required) {
        console.error(`  Missing server_url for required entry ${entry.slug}`);
        process.exit(1);
      }
      console.log(`  skipped: env var not set`);
      continue;
    }

    const existingRows = await db
      .select()
      .from(mcpConnections)
      .where(and(eq(mcpConnections.org_id, orgId), eq(mcpConnections.slug, entry.slug)))
      .limit(1);

    let connectionId: string;
    if (existingRows.length > 0) {
      connectionId = existingRows[0]!.id;
      await db
        .update(mcpConnections)
        .set({
          name: entry.name,
          transport: entry.transport,
          server_url: entry.server_url ?? null,
          stdio_command: entry.stdio_command ?? null,
          stdio_args: (entry.stdio_args ?? null) as any,
          auth_type: 'none',
          is_active: true,
          tools_cache: null,
          tools_cached_at: null,
          default_trust_tier: 'auto',
        })
        .where(eq(mcpConnections.id, connectionId));
      console.log(`  updated existing connection ${connectionId}`);
    } else {
      const [inserted] = await db
        .insert(mcpConnections)
        .values({
          org_id: orgId,
          name: entry.name,
          slug: entry.slug,
          transport: entry.transport,
          server_url: entry.server_url ?? null,
          stdio_command: entry.stdio_command ?? null,
          stdio_args: (entry.stdio_args ?? null) as any,
          auth_type: 'none',
          is_active: true,
          default_trust_tier: 'auto',
          created_by: creator.id,
        })
        .returning();
      connectionId = inserted!.id;
      console.log(`  inserted new connection ${connectionId}`);
    }

    const [connRow] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId))
      .limit(1);
    try {
      const { tools } = await capabilityService.discover({
        provider_kind: 'mcp',
        mode: 'cached',
        org_id: connRow!.org_id,
        provider_instance_id: connRow!.id,
        overrides: [],
      });
      console.log(`  discovered ${tools.length} tools:`);
      for (const t of tools) {
        console.log(
          `    ${t.originalName.padEnd(30)} tier=${t.approvalTier.padEnd(14)} isWrite=${t.isWrite}`
        );
        classificationTable.push({
          slug: entry.slug,
          tool: t.originalName,
          tier: t.approvalTier,
          isWrite: t.isWrite,
        });
      }
      await db
        .update(mcpConnections)
        .set({
          tools_cache: tools as any,
          tools_cached_at: new Date(),
          last_connected_at: new Date(),
          connection_error: null,
        })
        .where(eq(mcpConnections.id, connectionId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED to discover tools: ${msg}`);
      await db
        .update(mcpConnections)
        .set({ connection_error: msg, tools_cache: null })
        .where(eq(mcpConnections.id, connectionId));
      if (entry.required) {
        console.error(`  (required entry — continuing anyway, fix this before using Alex)`);
      }
    }

    attachedIds.add(connectionId);
  }

  const finalIds = Array.from(attachedIds);
  await db
    .update(agentEmployees)
    .set({ mcp_connection_ids: finalIds })
    .where(eq(agentEmployees.id, EMPLOYEE_ID));
  console.log(`\nAttached ${finalIds.length} connections to ${emp.name}`);
  console.log(`mcp_connection_ids = ${JSON.stringify(finalIds, null, 2)}`);

  const byTier: Record<string, typeof classificationTable> = { 'auto-execute': [], 'quick-approve': [], 'full-review': [] };
  for (const c of classificationTable) {
    byTier[c.tier]?.push(c);
  }
  console.log(`\n=== Classification Summary ===`);
  for (const tier of ['auto-execute', 'quick-approve', 'full-review'] as const) {
    console.log(`\n${tier}: ${byTier[tier]?.length ?? 0} tools`);
    for (const c of byTier[tier] ?? []) {
      console.log(`  ${c.slug}/${c.tool}`);
    }
  }

  console.log(`\nDone. Restart the API so in-memory tool caches refresh.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
