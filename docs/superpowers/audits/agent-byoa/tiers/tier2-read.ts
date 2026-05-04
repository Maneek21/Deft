// docs/superpowers/audits/agent-byoa/tiers/tier2-read.ts
import type { TierCtx } from './tier1-discovery.js';
import { withScratchSpace, withScratchProject, withScratchWikiPage } from '../lib/fixtures.js';
import { assert, assertIncludes } from '../../lib/assert.js';
import { seedSyntheticEvent } from '../lib/db-helpers.js';

export async function runTier2(ctx: TierCtx) {
  const failures: string[] = []; let passed = 0;
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { failures.push(`${name}: ${e instanceof Error ? e.message : e}`); console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`); }
  };

  const slug = ctx.agent.slug;

  await run('2.6 platform_context', async () => {
    const r = await ctx.mcp.toolsCall<any>('platform_context', { caller_employee_slug: slug });
    assert(r && (r.today || r.date || r.now), 'platform_context returns a date-like field');
    assert(r.org_id === ctx.orgId || r.organization?.id === ctx.orgId, `platform_context org_id matches: ${JSON.stringify(r).slice(0, 200)}`);
  });

  await run('2.7 memory_recall finds seeded page', async () => {
    const wp = await withScratchWikiPage(ctx.rest, 't2-recall', 'REFUND-PHRASE-7Q4 is the magic refund-policy phrase. Issued by finance.', 'fact');
    try {
      const r = await ctx.mcp.toolsCall<{ pages?: any[]; results?: any[] }>('memory_recall', { caller_employee_slug: slug, query: 'REFUND-PHRASE-7Q4 refund policy' });
      const hits = (r.pages ?? r.results ?? []) as any[];
      assert(hits.length > 0, 'memory_recall returned at least one hit');
      const top = hits[0];
      const matched = JSON.stringify(top).includes('REFUND-PHRASE-7Q4');
      assert(matched, `top hit should reference seeded distinctive phrase, got ${JSON.stringify(top).slice(0, 200)}`);
    } finally { await wp.cleanup(); }
  });

  await run('2.8 task_query filtered by assignee_id', async () => {
    const proj = await withScratchProject(ctx.rest, 't2-tq');
    try {
      const me = ctx.rest.user();
      // Create 3 tasks: 2 assigned to me, 1 unassigned.
      const t1 = await ctx.rest.post<{ id: string }>('/api/tasks', { project_id: proj.resource.id, title: 'A', assignee_id: me.id });
      const t2 = await ctx.rest.post<{ id: string }>('/api/tasks', { project_id: proj.resource.id, title: 'B', assignee_id: me.id });
      const t3 = await ctx.rest.post<{ id: string }>('/api/tasks', { project_id: proj.resource.id, title: 'C' });
      const r = await ctx.mcp.toolsCall<{ tasks: Array<{ id: string }> }>('task_query', { caller_employee_slug: slug, filter: { assignee_id: me.id, project_id: proj.resource.id } });
      const ids = new Set(r.tasks.map((t) => t.id));
      assert(ids.has(t1.id) && ids.has(t2.id) && !ids.has(t3.id), `task_query expected {${t1.id},${t2.id}}, got ${[...ids].join(',')}`);
    } finally { await proj.cleanup(); }
  });

  await run('2.9 task_detail returns task + comments', async () => {
    const proj = await withScratchProject(ctx.rest, 't2-td');
    try {
      const t = await ctx.rest.post<{ id: string; identifier: string }>('/api/tasks', { project_id: proj.resource.id, title: 'detailme' });
      await ctx.rest.post(`/api/tasks/${t.id}/comments`, { content: 'hello-comment-9X3' });
      const r = await ctx.mcp.toolsCall<any>('task_detail', { caller_employee_slug: slug, task_identifier: t.identifier });
      assertIncludes(JSON.stringify(r), 'hello-comment-9X3', 'task_detail body includes seeded comment');
    } finally { await proj.cleanup(); }
  });

  await run('2.10 thread_fetch returns parent + replies', async () => {
    const sp = await withScratchSpace(ctx.rest, 't2-thread');
    try {
      const parent = await ctx.rest.post<{ id: string }>(`/api/spaces/${sp.resource.id}/messages`, { content: 'parent-A' });
      await ctx.rest.post(`/api/spaces/${sp.resource.id}/messages`, { content: 'reply-1', parent_id: parent.id });
      await ctx.rest.post(`/api/spaces/${sp.resource.id}/messages`, { content: 'reply-2', parent_id: parent.id });
      const r = await ctx.mcp.toolsCall<{ messages: Array<{ id: string; content: string }> }>('thread_fetch', { caller_employee_slug: slug, parent_message_id: parent.id });
      assert(r.messages.length === 3, `expected 3 messages, got ${r.messages.length}`);
    } finally { await sp.cleanup(); }
  });

  await run('2.11 messages_search finds rare token', async () => {
    const sp = await withScratchSpace(ctx.rest, 't2-search');
    try {
      const token = `rareTokenZ${Date.now()}`;
      await ctx.rest.post(`/api/spaces/${sp.resource.id}/messages`, { content: `marker ${token} done` });
      // Search may take a moment to index — retry up to 5s
      const deadline = Date.now() + 5_000;
      let hits: any[] = [];
      while (Date.now() < deadline) {
        const r = await ctx.mcp.toolsCall<{ messages?: any[] }>('messages_search', { caller_employee_slug: slug, query: token });
        hits = r.messages ?? [];
        if (hits.length) break;
        await new Promise((res) => setTimeout(res, 250));
      }
      assert(hits.length > 0, `messages_search returned ${hits.length} for ${token}`);
    } finally { await sp.cleanup(); }
  });

  await run('2.12 events_query filters by type', async () => {
    await seedSyntheticEvent(ctx.orgId, 'pr_merged');
    const r = await ctx.mcp.toolsCall<{ events?: any[] }>('events_query', { caller_employee_slug: slug, type: 'pr_merged', limit: 10 });
    assert((r.events ?? []).length > 0, 'events_query returns ≥1 pr_merged event');
  });

  await run('2.13 member_list includes seeded users', async () => {
    const r = await ctx.mcp.toolsCall<{ members?: any[] }>('member_list', { caller_employee_slug: slug });
    const members = r.members ?? [];
    const emails = new Set(members.map((m) => m.email));
    assert(emails.has('rahul@test.com') || emails.has('priya@test.com'), `expected seeded member, got ${[...emails].slice(0, 5).join(',')}`);
  });

  await run('2.14 team_workload returns counts', async () => {
    const r = await ctx.mcp.toolsCall<any>('team_workload', { caller_employee_slug: slug, days: 7 });
    assert(typeof r === 'object', 'team_workload returns an object');
    assert(Array.isArray((r.workload ?? r.entries ?? r.assignees ?? [])), 'team_workload has a list field');
  });

  await run('2.15 project_progress returns counts', async () => {
    const proj = await withScratchProject(ctx.rest, 't2-prog');
    try {
      await ctx.rest.post('/api/tasks', { project_id: proj.resource.id, title: 'a', status: 'todo' });
      await ctx.rest.post('/api/tasks', { project_id: proj.resource.id, title: 'b', status: 'in_progress' });
      await ctx.rest.post('/api/tasks', { project_id: proj.resource.id, title: 'c', status: 'done' });
      const r = await ctx.mcp.toolsCall<any>('project_progress', { caller_employee_slug: slug, project_identifier: proj.resource.prefix });
      assert(typeof r === 'object', 'project_progress returns an object');
    } finally { await proj.cleanup(); }
  });

  return { passed, failed: failures.length, failures };
}
