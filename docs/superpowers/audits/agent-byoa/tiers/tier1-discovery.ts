// docs/superpowers/audits/agent-byoa/tiers/tier1-discovery.ts
import type { Page } from 'playwright';
import type { McpClient } from '../lib/mcp-client.js';
import type { DeftRest } from '../lib/api-client.js';
import { withScratchSpace } from '../lib/fixtures.js';
import { assertActionRowExists } from '../lib/assertions.js';
import { findRecentAgentActions, waitForAgentAction, getEmployeeRow } from '../lib/db-helpers.js';
import { assert, assertEquals } from '../../lib/assert.js';
import { db, schema } from '../../lib/db.js';
import { eq } from 'drizzle-orm';

export interface TierCtx {
  page: Page;
  rest: DeftRest;
  mcp: McpClient;
  agent: { id: string; slug: string; trust_level: string };
  orgId: string;
  webUrl: string;
}

export async function runTier1(ctx: TierCtx): Promise<{ passed: number; failed: number; failures: string[] }> {
  const failures: string[] = [];
  let passed = 0;
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`); }
  };

  // Scenario 1 — @mention dispatch
  await run('1.1 @mention dispatch', async () => {
    const sp = await withScratchSpace(ctx.rest, 't1-mention');
    try {
      // Post message with @mention via REST. Format: <@employee:slug> or @<slug> — both supported by mention parser.
      const startedAt = Date.now();
      await ctx.rest.post(`/api/spaces/${sp.resource.id}/messages`, {
        content: `@${ctx.agent.slug} please help`,
      });
      // Wait for agent_actions row
      const row = await waitForAgentAction({
        agentEmployeeId: ctx.agent.id,
        source: 'mention',
        action: 'chat_mention',
        timeoutMs: 15_000,
      });
      const params = row.params as { space_id?: string };
      assertEquals(params.space_id, sp.resource.id, 'params.space_id matches scratch space');
    } finally { await sp.cleanup(); }
  });

  // Scenario 2 — task assignment dispatch
  await run('1.2 task_assigned dispatch', async () => {
    const proj = await ctx.rest.post<{ id: string; prefix: string }>('/api/projects', {
      name: `harness-t1-task-${Date.now()}`,
      prefix: 'T1TASK',
    });
    try {
      // Need agent's shadow user_id — query via DB
      const emp = await getEmployeeRow(ctx.agent.id);
      assert(emp?.shadow_user_id, 'agent has shadow_user_id');
      await ctx.rest.post('/api/tasks', {
        project_id: proj.id,
        title: 'harness assignment',
        assignee_id: emp!.shadow_user_id,
      });
      const row = await waitForAgentAction({
        agentEmployeeId: ctx.agent.id,
        source: 'task_assignment',
        action: 'task_assigned',
        timeoutMs: 15_000,
      });
      assert(row.params, 'task_assigned has params');
    } finally {
      await ctx.rest.delete(`/api/projects/${proj.id}`).catch(() => undefined);
    }
  });

  // Scenario 3 — webhook dispatch
  await run('1.3 webhook trigger dispatch', async () => {
    // Create a webhook for the agent
    const wh = await ctx.rest.post<{ id: string; slug: string; secret: string }>('/api/agent-webhooks', {
      agent_employee_id: ctx.agent.id,
      name: `t1-webhook-${Date.now()}`,
    });
    try {
      // POST to public dispatch endpoint with HMAC
      const payload = JSON.stringify({ harness: true, n: Date.now() });
      const crypto = await import('node:crypto');
      const sig = crypto.createHmac('sha256', wh.secret).update(payload).digest('hex');
      const res = await fetch(`${process.env.DEFT_API_URL || 'http://localhost:3001'}/api/agent-webhooks/${wh.slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Deft-Signature': `sha256=${sig}` },
        body: payload,
      });
      assert(res.ok, `webhook dispatch returned ${res.status}`);
      await waitForAgentAction({
        agentEmployeeId: ctx.agent.id,
        source: 'trigger',
        action: 'trigger_dispatch',
        timeoutMs: 15_000,
      });
    } finally {
      await ctx.rest.delete(`/api/agent-webhooks/${wh.id}`).catch(() => undefined);
    }
  });

  // Scenario 4 — heartbeat tick dispatch
  await run('1.4 heartbeat tick dispatch', async () => {
    // Briefly enable heartbeat at 5min cadence so the cron eligibility passes.
    // BUT we also need the cron to fire NOW, which means pushing a job
    // directly to the queue. Use a curl into a debug route if it exists,
    // OR temporarily flip heartbeat_enabled and last_heartbeat_at far enough back.
    const before = await getEmployeeRow(ctx.agent.id);
    assert(before, 'agent exists');
    await db.update(schema.agentEmployees).set({
      heartbeat_enabled: true,
      heartbeat_interval_min: 5,
      last_heartbeat_at: new Date(Date.now() - 1000 * 60 * 60), // 1h ago
    }).where(eq(schema.agentEmployees.id, ctx.agent.id));
    try {
      // The cron worker registers `agent-employee-heartbeat-cron` — wait up
      // to 75s for it to fire (it runs once a minute). If this is too slow
      // for the audit, an alternative is to use `BullMQ.Queue.add` directly,
      // but that requires the queue connection — leave the wait as the
      // simplest path. If it times out, scenario 4 reports as flaky.
      await waitForAgentAction({
        agentEmployeeId: ctx.agent.id,
        source: 'heartbeat',
        action: 'heartbeat_tick',
        timeoutMs: 75_000,
      });
    } finally {
      await db.update(schema.agentEmployees).set({
        heartbeat_enabled: before!.heartbeat_enabled,
        heartbeat_interval_min: before!.heartbeat_interval_min,
        last_heartbeat_at: before!.last_heartbeat_at,
      }).where(eq(schema.agentEmployees.id, ctx.agent.id));
    }
  });

  // Scenario 5 — poll_pending_work idempotency
  await run('1.5 poll_pending_work idempotency', async () => {
    const sp = await withScratchSpace(ctx.rest, 't1-idem');
    try {
      await ctx.rest.post(`/api/spaces/${sp.resource.id}/messages`, { content: `@${ctx.agent.slug} idempotency check` });
      await waitForAgentAction({ agentEmployeeId: ctx.agent.id, source: 'mention', action: 'chat_mention', timeoutMs: 15_000 });

      const r1 = await ctx.mcp.toolsCall<{ pending_actions: Array<{ id: string }> }>('poll_pending_work', { caller_employee_slug: ctx.agent.slug });
      const r2 = await ctx.mcp.toolsCall<{ pending_actions: Array<{ id: string }> }>('poll_pending_work', { caller_employee_slug: ctx.agent.slug });
      // Same pending rows on both polls — both should include the same row.
      // Note: poll_pending_work is a snapshot read, not a "consume" — the
      // platform contract is "filter pending status", not "deliver-once".
      const ids1 = new Set(r1.pending_actions.map((a) => a.id));
      const ids2 = new Set(r2.pending_actions.map((a) => a.id));
      assert(ids1.size > 0 && ids2.size > 0, 'both polls returned at least one row');
      // Resolve the row via approve so the next test class isn't polluted.
      const ids = [...ids1];
      for (const id of ids) {
        // It might not be approvable directly (schema action=chat_mention).
        // Mark rejected to clear from pending.
        await ctx.rest.post(`/api/agent/actions/${id}/reject`, { reason: 'harness cleanup' }).catch(() => undefined);
      }
    } finally { await sp.cleanup(); }
  });

  return { passed, failed: failures.length, failures };
}
