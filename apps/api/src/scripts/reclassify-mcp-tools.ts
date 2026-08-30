/**
 * One-shot: clear mcp_connections.tools_cache on every active connection and
 * re-discover tools via the MCPClientManager. Prints each tool's new
 * approvalTier so you can confirm the new classification is correct.
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/reclassify-mcp-tools.ts
 */
import { db } from '../lib/db.js';
import { mcpConnections } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { capabilityService } from '../lib/capability-service.js';

async function main() {
  const active = await db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.is_active, true));

  if (active.length === 0) {
    console.log('No active MCP connections found.');
    process.exit(0);
  }

  for (const conn of active) {
    console.log(`\n-- ${conn.name} (${conn.slug}) [${conn.id}] --`);

    // 1. Clear the stale DB cache.
    await db
      .update(mcpConnections)
      .set({ tools_cache: null, tools_cached_at: null })
      .where(eq(mcpConnections.id, conn.id));

    // 2. Re-run discovery with the manager's existing cache semantics.
    try {
      const { tools } = await capabilityService.discover({
        provider_kind: 'mcp',
        mode: 'cached',
        org_id: conn.org_id,
        provider_instance_id: conn.id,
        overrides: [],
      });
      console.log(`  Discovered ${tools.length} tools:`);
      for (const t of tools) {
        console.log(
          `    ${t.originalName.padEnd(30)} tier=${t.approvalTier.padEnd(14)} isWrite=${t.isWrite}`
        );
      }

      // 3. Persist re-classified list back.
      await db
        .update(mcpConnections)
        .set({ tools_cache: tools as any, tools_cached_at: new Date() })
        .where(eq(mcpConnections.id, conn.id));
    } catch (err) {
      console.error(
        `  Failed to re-discover: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  console.log('\nDone. Restart the API so existing in-memory caches also get the new tiers.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
