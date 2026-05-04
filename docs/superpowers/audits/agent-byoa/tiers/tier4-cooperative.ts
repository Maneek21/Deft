// docs/superpowers/audits/agent-byoa/tiers/tier4-cooperative.ts
import type { TierCtx } from './tier1-discovery.js';
import { db, schema } from '../../lib/db.js';
import { eq, desc } from 'drizzle-orm';
import { assert, assertIncludes } from '../../lib/assert.js';
import { getEmployeeRow } from '../lib/db-helpers.js';

export async function runTier4(ctx: TierCtx) {
  const failures: string[] = []; let passed = 0;
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { failures.push(`${name}: ${e instanceof Error ? e.message : e}`); console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`); }
  };

  const slug = ctx.agent.slug;

  await run('4.25 record_decision writes to log', async () => {
    const sentinel = `decision-uniqueZ-${Date.now()}`;
    await ctx.mcp.toolsCall('record_decision', { caller_employee_slug: slug, summary: sentinel, metadata: { rationale: 'harness' } });
    const rows = await db.select().from(schema.agentCooperativeLog)
      .where(eq(schema.agentCooperativeLog.employee_id, ctx.agent.id))
      .orderBy(desc(schema.agentCooperativeLog.created_at)).limit(5);
    assert(rows.some((r) => r.summary === sentinel && r.kind === 'decision'), 'record_decision row found');
  });

  await run('4.26 ping_alive bumps last_heartbeat_at', async () => {
    const before = await getEmployeeRow(ctx.agent.id);
    await ctx.mcp.toolsCall('ping_alive', { caller_employee_slug: slug });
    const after = await getEmployeeRow(ctx.agent.id);
    const beforeMs = before?.last_heartbeat_at ? new Date(before.last_heartbeat_at).getTime() : 0;
    const afterMs = after?.last_heartbeat_at ? new Date(after.last_heartbeat_at).getTime() : 0;
    assert(afterMs > beforeMs, `last_heartbeat_at advanced (${beforeMs} → ${afterMs})`);
  });

  await run('4.27 delegation_self_report writes log', async () => {
    const sentinel = `delegate-${Date.now()}`;
    await ctx.mcp.toolsCall('delegation_self_report', { caller_employee_slug: slug, target_employee_slug: 'nonexistent', reason: sentinel });
    // Surface check: query activity timeline endpoint OR drop directly to log
    const rows = await db.select().from(schema.agentCooperativeLog)
      .where(eq(schema.agentCooperativeLog.employee_id, ctx.agent.id))
      .orderBy(desc(schema.agentCooperativeLog.created_at)).limit(5);
    // delegation_self_report may map to a different table — if so, swap accordingly
    const found = rows.some((r) => JSON.stringify(r).includes(sentinel));
    assert(found, `delegation_self_report sentinel ${sentinel} appears somewhere in agent log`);
  });

  return { passed, failed: failures.length, failures };
}
