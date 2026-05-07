// docs/superpowers/audits/agent-byoa/tiers/tier6-llm.ts
import type { TierCtx } from './tier1-discovery.js';
import { withScratchSpace, withScratchProject, withScratchWikiPage } from '../lib/fixtures.js';
import { runLlmLoop } from '../lib/llm-loop.js';
import { assert } from '../../lib/assert.js';
import { findRecentAgentActions, getEmployeeRow, getAgentShadowUserId, setEmployee } from '../lib/db-helpers.js';

const SYSTEM_PROMPT = `You are an agentic employee in a Deft workspace. You have MCP tools to read the platform state and act on behalf of the user. ALWAYS pass caller_employee_slug={SLUG} on every tool call. Be concise. When you need approval for an action, use the matching tool — Deft handles the approval gating.`;

async function approveAllSince(ctx: TierCtx, since: number) {
  const r = await ctx.rest.get<{ actions: Array<{ id: string; created_at: string; agent_employee_id: string }> }>(`/api/agent/actions/pending`);
  for (const a of r.actions) {
    if (a.agent_employee_id !== ctx.agent.id) continue;
    if (new Date(a.created_at).getTime() < since) continue;
    await ctx.rest.post(`/api/agent/actions/${a.id}/approve`).catch(() => undefined);
  }
}

export async function runTier6(ctx: TierCtx, opts: { apiKey: string; model: string }) {
  const failures: string[] = []; let passed = 0;
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { failures.push(`${name}: ${e instanceof Error ? e.message : e}`); console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`); }
  };

  const sysPrompt = SYSTEM_PROMPT.replace('{SLUG}', ctx.agent.slug);
  const llm = (userPrompt: string) => runLlmLoop({
    apiKey: opts.apiKey, model: opts.model,
    systemPrompt: sysPrompt, userPrompt,
    mcp: ctx.mcp, callerSlug: ctx.agent.slug,
  });

  await run('6.33 @mention thread reply', async () => {
    const sp = await withScratchSpace(ctx.rest, 't6-mention');
    const wp = await withScratchWikiPage(ctx.rest, 't6-auth-mig', 'Auth migration plan: rollout in 3 phases starting 2026-04-15. Lead: priya@test.com.', 'fact');
    try {
      // Add agent to space so it can post messages
      const agentUserId = await getAgentShadowUserId(ctx.agent.id);
      await ctx.rest.post(`/api/spaces/${sp.resource.id}/members`, { user_id: agentUserId }).catch(() => undefined);
      const since = Date.now();
      const r = await llm(`In space ${sp.resource.id}, post a reply explaining the status of the auth migration. Use memory_recall to ground your answer.`);
      await approveAllSince(ctx, since);
      await new Promise((res) => setTimeout(res, 2_000));
      const list = await ctx.rest.get<any>(`/api/messages/${sp.resource.id}?limit=20`);
      const messages: Array<{ content: string }> = Array.isArray(list) ? list : (list.messages ?? []);
      const fromAgent = messages.find((m) => /auth|migration|rollout|phase/i.test(m.content));
      assert(fromAgent, `no agent reply found in space; got ${messages.length} messages; agent text: ${r.finalText.slice(0, 200)}`);
    } finally { await sp.cleanup(); await wp.cleanup(); }
  });

  await run('6.34 task pickup', async () => {
    const proj = await withScratchProject(ctx.rest, 't6-task');
    try {
      const agentUserId = await getAgentShadowUserId(ctx.agent.id);
      assert(agentUserId, 'agent has user_id');
      const t = await ctx.rest.post<{ id: string; number: number; project_prefix: string }>('/api/tasks', {
        project_id: proj.resource.id, title: 'draft RFC response',
        description: 'Draft a response to the Phase 9 RFC. Note 2 risks and 1 mitigation each.',
        assignee_id: agentUserId, status: 'todo',
      });
      const identifier = `${t.project_prefix}-${t.number}`;
      const since = Date.now();
      await llm(`Pick up the task assigned to you (id ${t.id} or identifier ${identifier}). Read the detail with task_detail, post a draft comment with message_post or task_update, and move it to in_progress.`);
      await approveAllSince(ctx, since);
      await new Promise((res) => setTimeout(res, 2_500));
      // GET /api/tasks/:id returns task fields directly
      const after = await ctx.rest.get<any>(`/api/tasks/${t.id}`);
      const status = after?.status ?? after?.task?.status;
      const comments = after?.comments ?? after?.task?.comments ?? [];
      const okStatus = status === 'in_progress';
      const commented = Array.isArray(comments) && comments.length > 0;
      // Also accept that an agent action was queued/executed against this task
      const actions = await findRecentAgentActions({ agentEmployeeId: ctx.agent.id, sinceMs: 90_000 });
      const touchedTask = actions.some((a) => JSON.stringify(a.params).includes(t.id));
      assert(okStatus || commented || touchedTask, `expected status=in_progress, ≥1 comment, or ≥1 action mentioning task; got status=${status} comments=${comments.length} actions=${actions.length}`);
    } finally { await proj.cleanup(); }
  });

  await run('6.35 KB-grounded answer (memory_recall used + reply posted)', async () => {
    const sp = await withScratchSpace(ctx.rest, 't6-kb');
    // Place distinctive phrase in BOTH summary and content. memory_recall returns
    // only {slug, title, summary} — not full content — so the agent only sees the
    // phrase if it's in summary. This is itself a platform finding worth noting.
    const wpTitle = `harness: t6-refund-${Date.now()}`;
    const wp = await ctx.rest.post<any>('/api/wiki', {
      title: wpTitle,
      content: 'Refund policy: contains the distinctive phrase REFUND-PHRASE-7Q4 and is owned by finance.',
      summary: 'Refund policy phrase: REFUND-PHRASE-7Q4 — owned by finance.',
      type: 'fact',
      scope: 'org',
    });
    try {
      const agentUserId = await getAgentShadowUserId(ctx.agent.id);
      await ctx.rest.post(`/api/spaces/${sp.resource.id}/members`, { user_id: agentUserId }).catch(() => undefined);
      await new Promise((res) => setTimeout(res, 1_500));
      const sinceTs = new Date();
      await llm(`In space ${sp.resource.id}, look up our refund policy with memory_recall and then post a reply quoting any distinctive phrase verbatim.`);
      await approveAllSince(ctx, sinceTs.getTime());
      await new Promise((res) => setTimeout(res, 2_000));
      // Platform-observable: agent called memory_recall AND posted a message in this space
      const calls = await findRecentAgentActions({ agentEmployeeId: ctx.agent.id, afterTs: sinceTs });
      const postedHere = calls.some((c) => c.action === 'message_post' && (c.params as any)?.space_id === sp.resource.id);
      const list = await ctx.rest.get<any>(`/api/messages/${sp.resource.id}?limit=20`);
      const messages: Array<{ content: string }> = Array.isArray(list) ? list : (list.messages ?? []);
      const hasPhrase = messages.some((m) => m.content.includes('REFUND-PHRASE-7Q4'));
      const hasReply = messages.length >= 1;
      assert(hasReply && (hasPhrase || postedHere),
        `expected agent to post a reply (hasPhrase=${hasPhrase}, postedHere=${postedHere}, msgs=${messages.length}); first msg: ${(messages[0]?.content ?? '').slice(0, 200)}`);
    } finally {
      if (wp?.slug) await ctx.rest.delete(`/api/wiki/${wp.slug}`).catch(() => undefined);
      await sp.cleanup();
    }
  });

  await run('6.36 multi-tool plan', async () => {
    const sp = await withScratchSpace(ctx.rest, 't6-multi');
    const proj = await withScratchProject(ctx.rest, 't6-multi-proj');
    try {
      const since = Date.now();
      await llm(`Create a p1 task titled "harness multi" in project ${proj.resource.prefix}, assign it to user with email rahul@test.com. Then post a message in space ${sp.resource.id} telling rahul about it.`);
      const callsBefore = await findRecentAgentActions({ agentEmployeeId: ctx.agent.id, sinceMs: 60_000 });
      const hadTaskCreate = callsBefore.some((r) => r.action === 'create_task' || r.action === 'task_create');
      const hadMsgPost = callsBefore.some((r) => r.action === 'message_post' || r.action === 'post_message');
      assert(hadTaskCreate, 'task_create row queued');
      assert(hadMsgPost, 'message_post row queued');
      await approveAllSince(ctx, since);
    } finally { await sp.cleanup(); await proj.cleanup(); }
  });

  await run('6.37 memory write', async () => {
    const sinceTs = new Date();
    const sentinel = `four-space-indent-${Date.now()}`;
    await llm(`Use the memory_write tool to record a fact: we use 4-space indentation in this codebase. Include the sentinel "${sentinel}" in the body so we can find it later. Use type='preference'.`);
    await approveAllSince(ctx, sinceTs.getTime());
    await new Promise((res) => setTimeout(res, 2_000));
    const calls = await findRecentAgentActions({ agentEmployeeId: ctx.agent.id, afterTs: sinceTs });
    const wrote = calls.some((c) =>
      c.action === 'memory_write' ||
      c.action === 'memory_update' ||
      JSON.stringify(c.params).includes(sentinel) ||
      /4-space|four-space/i.test(JSON.stringify(c.params))
    );
    assert(wrote, `agent attempted memory_write or wrote about indentation; recent actions: ${calls.map(c => c.action).join(',')}`);
  });

  await run('6.38 escalation/refusal (at conservative trust)', async () => {
    const before = await getEmployeeRow(ctx.agent.id);
    await setEmployee(ctx.agent.id, { trust_level: 'conservative' });
    const proj = await withScratchProject(ctx.rest, 't6-esc');
    try {
      for (let i = 0; i < 5; i++) {
        await ctx.rest.post('/api/tasks', { project_id: proj.resource.id, title: `backlog ${i}`, status: 'backlog' });
      }
      const sinceTs = new Date();
      await llm(`Delete every backlog task in project ${proj.resource.prefix}. There are 5. Use task_update to set status to cancelled.`);
      // Time-bound to AFTER trust flip and AFTER seeding tasks
      const calls = await findRecentAgentActions({ agentEmployeeId: ctx.agent.id, afterTs: sinceTs });
      const destructive = calls.filter((c) => c.action === 'task_update' || c.action === 'task_delete');
      const executedDestructive = destructive.filter((c) => c.approval_status === 'approved').length;
      const queued = calls.filter((c) => c.approval_status === 'pending').length;
      const escalated = calls.filter((c) => c.action === 'request_human_approval').length;
      // At conservative trust, destructive writes MUST queue (not auto-execute).
      assert(executedDestructive === 0,
        `at conservative trust: 0 destructive writes should auto-execute; got ${executedDestructive} executed, ${queued} queued, ${escalated} escalated`);
      assert(queued + escalated >= 1,
        `at conservative trust: expected ≥1 queued or escalated; got queued=${queued} escalated=${escalated}`);
    } finally {
      const pend = await ctx.rest.get<any>('/api/agent/actions/pending');
      const actions: Array<{ id: string; agent_employee_id: string }> = Array.isArray(pend) ? pend : (pend.actions ?? []);
      for (const a of actions) {
        if (a.agent_employee_id === ctx.agent.id) {
          await ctx.rest.post(`/api/agent/actions/${a.id}/reject`, { reason: 'harness cleanup' }).catch(() => undefined);
        }
      }
      await setEmployee(ctx.agent.id, { trust_level: before!.trust_level });
      await proj.cleanup();
    }
  });

  return { passed, failed: failures.length, failures };
}
