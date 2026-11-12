/**
 * An employee's `wiki_create` proposal records, when proposed, the slug its
 * page will be created at. Approval (through the real approve route) creates
 * exactly that page at that slug, or refuses for good. Run only against a
 * disposable DB: pnpm --filter @deft/api test test/wiki-create-proposal-target.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';

import { queueDeftyKnowledgeCapture } from '../src/lib/defty-capture.js';
import { ensureDeftyEmployee } from '../src/lib/ensure-defty-membership.js';
import { requestHumanApproval } from '../src/lib/mcp-tools/cooperative.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import { WIKI_CREATE_TARGET_UNAVAILABLE_ERROR, wikiCreate } from '../src/lib/mcp-tools/wiki-create.js';
import { workIntentRoutes } from '../src/routes/work-intents.js';
import { durabilityDatabaseUrl, setupDurabilityFixture, type DurabilityFixture } from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
const NOT_CREATED = 'This page could not be created as proposed. Ask for the proposal again.';
const UNVERIFIABLE = 'This wiki proposal does not record the page revision it was made against, so it was not applied. Ask for the update again.';

let f: DurabilityFixture;
let ctx: ToolContext;
let shadowId: string;
let defty: { employeeId: string; userId: string };
let hiddenSpace: string;
const otherOrgId = randomUUID();
const otherOrgSpace = randomUUID();

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('WC');
  shadowId = randomUUID();
  const employeeId = randomUUID();
  const slug = `wiki-employee-${employeeId.slice(0, 8)}`;
  await f.client.query(`INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'Wiki employee', 'agent', true, true)`,
    [shadowId, `wiki-create-employee-${shadowId}@example.test`]);
  await f.client.query("INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'member', true)", [randomUUID(), f.orgId, shadowId]);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'Wiki employee', $4, 'project_manager', 'Wiki create test', 'conservative', true, true, $5)`,
    [employeeId, f.orgId, shadowId, slug, f.requesterId]);
  ctx = { org_id: f.orgId, employee_id: employeeId, employee_slug: slug, trust_level: 'conservative' };
  defty = await ensureDeftyEmployee(f.orgId);
  for (const user of [shadowId, defty.userId]) await join(user);
  hiddenSpace = randomUUID();
  await f.client.query("INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)",
    [hiddenSpace, f.orgId, `wc-hidden-${hiddenSpace.slice(0, 8)}`, f.adminId]);
  await f.client.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Other org', $2)", [otherOrgId, `wiki-other-${otherOrgId}`]);
  await f.client.query("INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, 'Other public', 'public', $3)", [otherOrgSpace, otherOrgId, f.adminId]);
});

after(async () => {
  if (!f) return;
  for (const [statement, id] of [['DELETE FROM wiki_citations WHERE org_id = $1', f.orgId], ['DELETE FROM agent_actions WHERE org_id = $1', f.orgId],
    ['DELETE FROM work_intents WHERE org_id = $1', f.orgId], ['DELETE FROM space_members WHERE space_id = $1', f.spaceId],
    ['DELETE FROM spaces WHERE id = $1', hiddenSpace], ['DELETE FROM wiki_pages WHERE org_id = $1', otherOrgId],
    ['DELETE FROM spaces WHERE org_id = $1', otherOrgId], ['DELETE FROM orgs WHERE id = $1', otherOrgId]] as const) {
    await f.client.query(statement, [id]).catch(() => undefined);
  }
  await f.teardown();
});

const join = (userId: string) => f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), f.spaceId, userId]);
const leave = (userId: string) => f.client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [f.spaceId, userId]);
const textOf = (result: ToolResult) => result.content[0]?.text ?? '';
const uniqueTitle = (prefix = 'Created knowledge') => `${prefix} ${randomUUID().slice(0, 8)}`;
const count = async (query: string, params: unknown[]) => Number((await f.client.query(query, params)).rows[0].n);
const titled = (title: string) => count('SELECT count(*)::int AS n FROM wiki_pages WHERE org_id = $1 AND title = $2', [f.orgId, title]);
const opsCount = () => count("SELECT count(*)::int AS n FROM wiki_ops_log WHERE org_id = $1 AND operation = 'create'", [f.orgId]);

async function frozenSlug(actionId: string): Promise<string> {
  const [row] = (await f.client.query("SELECT before_state->'wiki_proposal_target'->>'slug' AS slug FROM agent_actions WHERE id = $1", [actionId])).rows;
  assert.ok(row?.slug, 'the proposal records its slug');
  return row.slug;
}

async function pagesAt(slug: string, orgId = f.orgId) {
  return (await f.client.query('SELECT id, title, content FROM wiki_pages WHERE org_id = $1 AND slug = $2', [orgId, slug])).rows;
}

async function takeSlug(slug: string, orgId = f.orgId): Promise<string> {
  const id = randomUUID();
  await f.client.query(`INSERT INTO wiki_pages (id, org_id, scope, type, title, slug, content) VALUES ($1, $2, 'org', 'fact', 'Someone else', $3, 'Other content')`,
    [id, orgId, slug]);
  return id;
}

type Proposal = { title: string; content: string; space_id?: string };
const CREATORS: Record<string, { propose: (args: Proposal) => Promise<string>; member: () => string }> = {
  mcp: { member: () => shadowId, async propose(args) {
    const result = await wikiCreate({ caller_employee_slug: ctx.employee_slug, ...args }, ctx);
    assert.equal(result.isError, false, textOf(result));
    return JSON.parse(textOf(result)).approval_id;
  } },
  request_human_approval: { member: () => shadowId, async propose(args) {
    const result = await requestHumanApproval({ action: 'wiki_create', summary: 'Create the page', params: args }, ctx);
    assert.equal(result.isError, false, textOf(result));
    return JSON.parse(textOf(result)).action_id;
  } },
  defty_capture: { member: () => defty.userId, async propose(args) {
    const messageId = await f.insertMessage(`${args.title}: ${args.content}`);
    const queued = await queueDeftyKnowledgeCapture({
      orgId: f.orgId, sourceUserId: f.requesterId, spaceId: f.spaceId, messageId, content: args.content, title: args.title,
      wikiType: 'decision', captureKind: 'decision_candidate', extraction: 'classifier', preferUpdate: false, autoApprove: false,
    });
    assert.equal(queued.queued, true, JSON.stringify(queued));
    return queued.actionId!;
  } },
};

/** An admin approves the employee's own requests; the requester approves the rest. */
async function approve(actionId: string) {
  const [row] = (await f.client.query('SELECT user_id FROM agent_actions WHERE id = $1', [actionId])).rows;
  const response = await f.as(row?.user_id === shadowId ? f.adminId : f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function assertRefused(actionId: string, error: string, title: string) {
  const ops = await opsCount();
  const answer = await approve(actionId);
  assert.notEqual(answer.status, 200, JSON.stringify(answer.body));
  const [row] = (await f.client.query('SELECT approval_status, executed_at, error FROM agent_actions WHERE id = $1', [actionId])).rows;
  assert.equal(row.approval_status, 'approved');
  assert.ok(row.executed_at, 'the refusal is terminal');
  assert.equal(row.error, error);
  await approve(actionId); // approving again does not execute it
  assert.equal(await titled(title), 0);
  assert.equal(await opsCount(), ops);
}

for (const [name, creator] of Object.entries(CREATORS)) {
  test(`${name}: approval creates exactly the proposed page, non-ASCII title included, at the recorded slug`, { skip: !canRun }, async () => {
    for (const title of [uniqueTitle(), `日本語の決定 ${randomUUID().slice(0, 8)}`]) {
      const actionId = await creator.propose({ title, content: 'Proposed content', space_id: f.spaceId });
      const slug = await frozenSlug(actionId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const answer = await approve(actionId);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      const pages = await pagesAt(slug);
      assert.equal(pages.length, 1);
      assert.equal(pages[0].title, title);
      assert.match(pages[0].content, /Proposed content/);
    }
  });

  test(`${name}: a slug taken after the proposal is refused and nothing is written`, { skip: !canRun }, async () => {
    const title = uniqueTitle();
    const actionId = await creator.propose({ title, content: 'Proposed content', space_id: f.spaceId });
    const slug = await frozenSlug(actionId);
    const other = await takeSlug(slug);
    await assertRefused(actionId, NOT_CREATED, title);
    assert.deepEqual((await pagesAt(slug)).map((page) => page.id), [other]);
  });

  test(`${name}: a requester that lost access to the target space is refused`, { skip: !canRun }, async () => {
    const title = uniqueTitle();
    const actionId = await creator.propose({ title, content: 'Proposed content', space_id: f.spaceId });
    await leave(creator.member());
    try {
      await assertRefused(actionId, NOT_CREATED, title);
    } finally {
      await join(creator.member());
    }
  });
}

test('an unreachable target space is refused when proposed, with one answer for every case', { skip: !canRun }, async () => {
  const before = await count('SELECT count(*)::int AS n FROM agent_actions WHERE org_id = $1', [f.orgId]);
  const answers = new Set<string>();
  for (const spaceId of [hiddenSpace, randomUUID(), otherOrgSpace]) {
    for (const where of [{ space_id: spaceId }, { source_space_id: spaceId }]) {
      const args = { title: uniqueTitle(), content: 'Hidden', ...where };
      for (const result of [
        await wikiCreate({ caller_employee_slug: ctx.employee_slug, ...args }, ctx),
        await wikiCreate({ caller_employee_slug: ctx.employee_slug, ...args }, { ...ctx, trust_level: 'autonomous' }),
        await requestHumanApproval({ action: 'wiki_create', summary: 'Create', params: args }, ctx),
      ]) {
        assert.equal(textOf(result), WIKI_CREATE_TARGET_UNAVAILABLE_ERROR);
        assert.equal(result.structuredContent?.code, 'WIKI_TARGET_UNAVAILABLE');
        answers.add(JSON.stringify(result));
      }
    }
  }
  assert.equal(answers.size, 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM agent_actions WHERE org_id = $1', [f.orgId]), before);
});

test('a pending create without a recorded slug is refused', { skip: !canRun }, async () => {
  const title = uniqueTitle('Legacy');
  const legacy = randomUUID();
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'mcp', 'wiki_create', $5::jsonb, 'quick', 'pending')`,
    [legacy, f.orgId, shadowId, ctx.employee_id, JSON.stringify({ caller_employee_slug: ctx.employee_slug, title, content: 'Legacy content' })]);
  await assertRefused(legacy, UNVERIFIABLE, title);
});

test('two approvals of the same proposal racing create one page', { skip: !canRun }, async () => {
  const actionId = await CREATORS.mcp!.propose({ title: uniqueTitle('Raced'), content: 'Raced content' });
  const slug = await frozenSlug(actionId);
  const answers = await Promise.all([approve(actionId), approve(actionId)]);
  const pages = await pagesAt(slug);
  assert.equal(pages.length, 1);
  for (const answer of answers.filter((a) => a.status === 200)) assert.equal(answer.body.result?.page_id, pages[0].id, JSON.stringify(answers));
});

test('a page at the same slug in another org neither blocks nor is touched by the create', { skip: !canRun }, async () => {
  const actionId = await CREATORS.mcp!.propose({ title: uniqueTitle('Cross org'), content: 'Own org content' });
  const slug = await frozenSlug(actionId);
  const foreign = await takeSlug(slug, otherOrgId);
  assert.equal((await approve(actionId)).status, 200);
  assert.equal((await pagesAt(slug)).length, 1);
  assert.deepEqual(await pagesAt(slug, otherOrgId), [{ id: foreign, title: 'Someone else', content: 'Other content' }]);
});

const retryApp = new Hono();
retryApp.use('*', async (c, next) => {
  c.set('user', { id: f.requesterId, org_id: f.orgId, email: 'requester@example.test', role: 'member' } as any);
  await next();
});
retryApp.route('/api/work-intents', workIntentRoutes);

async function retryFailedCapture(beforeRetry = async () => {}): Promise<{ status: number; body: Record<string, any>; title: string }> {
  const title = uniqueTitle('Retried');
  const actionId = await CREATORS.defty_capture!.propose({ title, content: 'Retried content' });
  const [row] = (await f.client.query("SELECT params->>'work_intent_id' AS intent FROM agent_actions WHERE id = $1", [actionId])).rows;
  await f.client.query("UPDATE agent_actions SET approval_status = 'rejected' WHERE id = $1", [actionId]);
  await f.client.query("UPDATE work_intents SET status = 'failed' WHERE id = $1", [row.intent]);
  await beforeRetry();
  const response = await retryApp.request(`/api/work-intents/${row.intent}/retry`, { method: 'POST' });
  return { status: response.status, body: await response.json() as Record<string, any>, title };
}

test('a create retry is a new proposal with its own recorded slug', { skip: !canRun }, async () => {
  const answer = await retryFailedCapture();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const slug = await frozenSlug(answer.body.action.id);
  assert.equal((await approve(answer.body.action.id)).status, 200);
  assert.deepEqual((await pagesAt(slug)).map((page) => page.title), [answer.title]);
});

test('a create retry into a space the employee can no longer reach is refused', { skip: !canRun }, async () => {
  try {
    const answer = await retryFailedCapture(async () => { await leave(defty.userId); });
    assert.equal(answer.status, 409, JSON.stringify(answer.body));
    assert.equal(answer.body.code, 'WIKI_TARGET_UNAVAILABLE');
  } finally {
    await join(defty.userId);
  }
});
