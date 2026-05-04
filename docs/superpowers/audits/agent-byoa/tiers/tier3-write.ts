// docs/superpowers/audits/agent-byoa/tiers/tier3-write.ts
import type { TierCtx } from './tier1-discovery.js';
import { withScratchSpace, withScratchProject } from '../lib/fixtures.js';
import { assert, assertEquals, assertIncludes } from '../../lib/assert.js';

async function approveAllPending(ctx: TierCtx, since: number): Promise<number> {
  const r = await ctx.rest.get<{ actions: Array<{ id: string; created_at: string; agent_employee_id: string }> }>(`/api/agent/actions/pending`);
  let approved = 0;
  for (const a of r.actions) {
    if (a.agent_employee_id !== ctx.agent.id) continue;
    if (new Date(a.created_at).getTime() < since) continue;
    await ctx.rest.post(`/api/agent/actions/${a.id}/approve`).catch(() => undefined);
    approved++;
  }
  return approved;
}

export async function runTier3(ctx: TierCtx) {
  const failures: string[] = []; let passed = 0;
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { failures.push(`${name}: ${e instanceof Error ? e.message : e}`); console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`); }
  };

  const slug = ctx.agent.slug;

  // Scenarios 16+17 collapsed: task_create at current trust → approve if queued → verify task exists
  await run('3.16 task_create + approval cycle', async () => {
    const proj = await withScratchProject(ctx.rest, 't3-create');
    const sinceMs = Date.now();
    try {
      const r = await ctx.mcp.toolsCall<any>('task_create', { caller_employee_slug: slug, title: 'harness create', project_id: proj.resource.id, priority: 'p1' });
      const wasQueued = r?.queued_for_approval === true || r?.status === 'pending' || r?.action_id;
      if (wasQueued) {
        const approved = await approveAllPending(ctx, sinceMs);
        assert(approved >= 1, 'at least one pending action approved');
        // wait briefly for executor
        await new Promise((res) => setTimeout(res, 2_000));
      }
      // Verify task exists
      const list = await ctx.rest.get<{ tasks: Array<{ title: string }> }>(`/api/projects/${proj.resource.id}/tasks`);
      const found = list.tasks.find((t) => t.title === 'harness create');
      assert(found, 'task with seeded title now exists in project');
    } finally { await proj.cleanup(); }
  });

  await run('3.18 task_update→done round-trip', async () => {
    const proj = await withScratchProject(ctx.rest, 't3-update');
    try {
      const t = await ctx.rest.post<{ id: string; identifier: string }>('/api/tasks', { project_id: proj.resource.id, title: 'updateme', status: 'todo' });
      const sinceMs = Date.now();
      await ctx.mcp.toolsCall<any>('task_update', { caller_employee_slug: slug, task_id: t.id, patch: { status: 'done' } });
      await approveAllPending(ctx, sinceMs);
      await new Promise((res) => setTimeout(res, 1_500));
      const after = await ctx.rest.get<{ task: { status: string } }>(`/api/tasks/${t.id}`);
      assertEquals(after.task.status, 'done', 'task status updated to done');
    } finally { await proj.cleanup(); }
  });

  await run('3.19 message_post round-trip', async () => {
    const sp = await withScratchSpace(ctx.rest, 't3-msg');
    try {
      const sinceMs = Date.now();
      const tag = `harness-msg-${Date.now()}`;
      await ctx.mcp.toolsCall<any>('message_post', { caller_employee_slug: slug, space_id: sp.resource.id, content: tag });
      await approveAllPending(ctx, sinceMs);
      await new Promise((res) => setTimeout(res, 1_500));
      const r = await ctx.rest.get<{ messages?: Array<{ content: string }> } | Array<{ content: string }>>(`/api/messages/${sp.resource.id}?limit=20`);
      const messages: Array<{ content: string }> = Array.isArray(r) ? r : (r.messages ?? []);
      assert(messages.some((m) => m.content.includes(tag)), `agent message visible in space; got ${messages.length} messages`);
    } finally { await sp.cleanup(); }
  });

  await run('3.20 memory_write creates wiki page', async () => {
    const title = `harness: t3-memory-write-${Date.now()}`;
    // memory_write MCP tool takes `body` (which it stores as `content` in wiki_pages)
    const r = await ctx.mcp.toolsCall<any>('memory_write', { caller_employee_slug: slug, title, body: 'harness body content uniqueZ', type: 'fact' });
    const slugOut: string | undefined = r?.slug ?? r?.page?.slug;
    try {
      assert(slugOut, `memory_write returned a slug, got ${JSON.stringify(r).slice(0, 200)}`);
      // wiki GET response is `{ ...page, linked_pages, backlinks, citations }` — page has `content`
      const got = await ctx.rest.get<any>(`/api/wiki/${slugOut}`);
      const content = got.content ?? got.page?.content ?? got.body ?? got.page?.body ?? '';
      assertIncludes(content, 'uniqueZ', 'wiki page contains the body content');
    } finally {
      if (slugOut) await ctx.rest.delete(`/api/wiki/${slugOut}`).catch(() => undefined);
    }
  });

  await run('3.22 space_memory round-trip', async () => {
    const sp = await withScratchSpace(ctx.rest, 't3-spmem');
    try {
      const key = `kZ${Date.now()}`;
      await ctx.mcp.toolsCall('space_memory_set', { caller_employee_slug: slug, space_id: sp.resource.id, key, value: { hello: 1 } });
      const r = await ctx.mcp.toolsCall<any>('space_memory_get', { caller_employee_slug: slug, space_id: sp.resource.id, key });
      const val = r?.value ?? r;
      assert(JSON.stringify(val).includes('"hello":1'), `space_memory_get returned ${JSON.stringify(val)}`);
    } finally { await sp.cleanup(); }
  });

  await run('3.23 request_human_approval queues row', async () => {
    const before = await ctx.rest.get<{ actions: Array<{ id: string; action: string }> }>(`/api/agent/actions/pending`);
    const beforeIds = new Set(before.actions.map((a) => a.id));
    const r = await ctx.mcp.toolsCall<any>('request_human_approval', { caller_employee_slug: slug, action: 'harness_test', summary: 'do harness thing' });
    const after = await ctx.rest.get<{ actions: Array<{ id: string; action: string }> }>(`/api/agent/actions/pending`);
    const newOne = after.actions.find((a) => !beforeIds.has(a.id) && a.action === 'harness_test');
    assert(newOne, 'request_human_approval added a new pending row');
    await ctx.rest.post(`/api/agent/actions/${newOne!.id}/reject`, { reason: 'harness cleanup' }).catch(() => undefined);
  });

  await run('3.24 approval rejection path', async () => {
    const r = await ctx.mcp.toolsCall<any>('request_human_approval', { caller_employee_slug: slug, action: 'harness_reject', summary: 'reject me' });
    const id: string | undefined = r?.action_id;
    assert(id, 'action_id returned');
    await ctx.rest.post(`/api/agent/actions/${id}/reject`, { reason: 'harness reject path' });
    // Now poll_pending_work should NOT include it (status moved off pending)
    const poll = await ctx.mcp.toolsCall<{ pending_actions: Array<{ id: string }> }>('poll_pending_work', { caller_employee_slug: slug });
    assert(!poll.pending_actions.some((a) => a.id === id), 'rejected row no longer pending');
  });

  return { passed, failed: failures.length, failures };
}
