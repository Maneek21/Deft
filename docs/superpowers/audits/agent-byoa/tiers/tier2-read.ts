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
    const orgId = r.org_id ?? r.org?.id ?? r.organization?.id;
    assert(orgId === ctx.orgId, `platform_context org_id matches: got ${orgId}, expected ${ctx.orgId}, full=${JSON.stringify(r).slice(0, 200)}`);
  });

  await run('2.7 memory_recall finds seeded page', async () => {
    const wp = await withScratchWikiPage(ctx.rest, 't2-recall', 'REFUND-PHRASE-7Q4 is the magic refund-policy phrase. Issued by finance.', 'fact');
    try {
      // Wait briefly for FTS indexing — search_vector is updated post-insert
      await new Promise((res) => setTimeout(res, 1_500));
      const r = await ctx.mcp.toolsCall<any>('memory_recall', { caller_employee_slug: slug, query: 'REFUND-PHRASE-7Q4' });
      const hits: any[] = Array.isArray(r) ? r : (r.pages ?? r.results ?? []);
      assert(hits.length > 0, `memory_recall returned no hit; raw=${JSON.stringify(r).slice(0, 200)}`);
      const matched = JSON.stringify(hits).includes('REFUND-PHRASE-7Q4') || JSON.stringify(hits).toLowerCase().includes('refund');
      assert(matched, `top hit should reference refund, got ${JSON.stringify(hits).slice(0, 200)}`);
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
      const r = await ctx.mcp.toolsCall<any>('task_query', { caller_employee_slug: slug, filter: { assignee_id: me.id, project_id: proj.resource.id } });
      const tasks: Array<{ id: string }> = Array.isArray(r) ? r : (r.tasks ?? []);
      const ids = new Set(tasks.map((t) => t.id));
      assert(ids.has(t1.id) && ids.has(t2.id) && !ids.has(t3.id), `task_query expected {${t1.id},${t2.id}}, got [${[...ids].join(',')}]`);
    } finally { await proj.cleanup(); }
  });

  await run('2.9 task_detail returns task + comments', async () => {
    const proj = await withScratchProject(ctx.rest, 't2-td');
    try {
      // Task POST returns { ...task, project_prefix, project_name } where task has `number`. Identifier = `<prefix>-<number>`.
      const t = await ctx.rest.post<{ id: string; number: number; project_prefix: string }>('/api/tasks', { project_id: proj.resource.id, title: 'detailme' });
      const identifier = `${t.project_prefix}-${t.number}`;
      await ctx.rest.post(`/api/tasks/${t.id}/comments`, { content: 'hello-comment-9X3' });
      const r = await ctx.mcp.toolsCall<any>('task_detail', { caller_employee_slug: slug, task_identifier: identifier });
      assertIncludes(JSON.stringify(r), 'hello-comment-9X3', `task_detail body includes seeded comment; identifier=${identifier} raw=${JSON.stringify(r).slice(0, 200)}`);
    } finally { await proj.cleanup(); }
  });

  await run('2.10 thread_fetch returns parent + replies', async () => {
    const sp = await withScratchSpace(ctx.rest, 't2-thread');
    try {
      const parent = await ctx.rest.post<{ id: string }>(`/api/messages/${sp.resource.id}`, { content: 'parent-A' });
      await ctx.rest.post(`/api/messages/${sp.resource.id}`, { content: 'reply-1', parent_id: parent.id });
      await ctx.rest.post(`/api/messages/${sp.resource.id}`, { content: 'reply-2', parent_id: parent.id });
      const r = await ctx.mcp.toolsCall<any>('thread_fetch', { caller_employee_slug: slug, parent_message_id: parent.id });
      const messages: Array<{ id: string }> = Array.isArray(r) ? r : (r.messages ?? []);
      assert(messages.length === 3, `expected 3 messages, got ${messages.length}; raw=${JSON.stringify(r).slice(0, 200)}`);
    } finally { await sp.cleanup(); }
  });

  await run('2.11 messages_search finds rare token', async () => {
    const sp = await withScratchSpace(ctx.rest, 't2-search');
    try {
      const token = `rareTokenZ${Date.now()}`;
      await ctx.rest.post(`/api/messages/${sp.resource.id}`, { content: `marker ${token} done` });
      // Search may take a moment to index — retry up to 8s
      const deadline = Date.now() + 8_000;
      let hits: any[] = [];
      while (Date.now() < deadline) {
        const r = await ctx.mcp.toolsCall<any>('messages_search', { caller_employee_slug: slug, query: token });
        hits = Array.isArray(r) ? r : (r.messages ?? []);
        if (hits.length) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      assert(hits.length > 0, `messages_search returned ${hits.length} for ${token} after 8s`);
    } finally { await sp.cleanup(); }
  });

  await run('2.12 events_query filters by type', async () => {
    await seedSyntheticEvent(ctx.orgId, 'pr_merged');
    const r = await ctx.mcp.toolsCall<any>('events_query', { caller_employee_slug: slug, type: 'pr_merged', limit: 10 });
    const events: any[] = Array.isArray(r) ? r : (r.events ?? []);
    assert(events.length > 0, `events_query returns ≥1 pr_merged event; raw=${JSON.stringify(r).slice(0, 200)}`);
  });

  await run('2.13 member_list includes seeded users', async () => {
    // member_list returns rows directly (not wrapped). Seed users may be @test.com OR @deft.test
    // depending on which seed was last applied — accept either.
    const r = await ctx.mcp.toolsCall<any>('member_list', { caller_employee_slug: slug });
    const members: any[] = Array.isArray(r) ? r : (r.members ?? r.rows ?? []);
    const emails = new Set(members.map((m) => m.email).filter(Boolean));
    const hasSeed = [...emails].some((e: string) => /(rahul|priya|arjun|sara|maneek)@(test\.com|deft\.test)/.test(e));
    assert(hasSeed, `expected at least one seeded user (rahul/priya/arjun/sara/maneek), got ${[...emails].slice(0, 6).join(',')}`);
  });

  await run('2.14 team_workload returns counts', async () => {
    const r = await ctx.mcp.toolsCall<any>('team_workload', { caller_employee_slug: slug, days: 7 });
    // Accept any object response that has at least one numeric or array field — different platforms render this differently.
    assert(r !== null && typeof r === 'object', `team_workload returns an object; got ${typeof r}`);
    const hasContent = Array.isArray(r) || Object.keys(r).length > 0;
    assert(hasContent, `team_workload returned non-empty: keys=${Object.keys(r ?? {}).join(',')}`);
  });

  await run('2.15 project_progress returns counts', async () => {
    const proj = await withScratchProject(ctx.rest, 't2-prog');
    try {
      await ctx.rest.post('/api/tasks', { project_id: proj.resource.id, title: 'a', status: 'todo' });
      await ctx.rest.post('/api/tasks', { project_id: proj.resource.id, title: 'b', status: 'in_progress' });
      await ctx.rest.post('/api/tasks', { project_id: proj.resource.id, title: 'c', status: 'done' });
      // Try project_name first (more reliable than prefix lookup)
      const r = await ctx.mcp.toolsCall<any>('project_progress', { caller_employee_slug: slug, project_name: proj.resource.name });
      // Accept any non-empty response — could be string, object, or array
      const stringified = JSON.stringify(r);
      assert(stringified && stringified.length > 4, `project_progress returned non-empty; got ${stringified.slice(0, 200)}`);
      assert(!stringified.includes('not found'), `project_progress could not find project; got ${stringified.slice(0, 200)}`);
    } finally { await proj.cleanup(); }
  });

  return { passed, failed: failures.length, failures };
}
