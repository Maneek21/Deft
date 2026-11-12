/**
 * An employee's `wiki_update` proposal applies only to the page revision it
 * was proposed against, and only while the employee can still reach the
 * page. Proposals come from every creator (MCP wiki_update,
 * request_human_approval, Defty capture, work-intent retry) and are approved
 * through the real approve route.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/wiki-update-proposal-revision.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

import { queueDeftyKnowledgeCapture } from '../src/lib/defty-capture.js';
import { ensureDeftyEmployee } from '../src/lib/ensure-defty-membership.js';
import { requestHumanApproval } from '../src/lib/mcp-tools/cooperative.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import {
  _setWikiUpdateRevisionCheckedHookForTest,
  WIKI_TARGET_UNAVAILABLE_ERROR,
  wikiCreate,
  wikiUpdate,
  type WikiUpdateArgs,
} from '../src/lib/mcp-tools/wiki-create.js';
import { workIntentRoutes } from '../src/routes/work-intents.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
const CHANGED = 'The wiki page changed after this update was proposed, so it was not applied. Review the current page and propose the update again.';
const UNAVAILABLE = 'The wiki page this update was proposed for is no longer available to the requester, so it was not applied.';
const UNVERIFIABLE = 'This wiki proposal does not record the page revision it was made against, so it was not applied. Ask for the update again.';

let f: DurabilityFixture;
let ctx: ToolContext;
let shadowId: string;
let defty: { employeeId: string; userId: string };
const otherOrgId = randomUUID();

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('WU');
  shadowId = randomUUID();
  const employeeId = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'Wiki employee', 'agent', true, true)`,
    [shadowId, `wiki-update-employee-${shadowId}@example.test`]);
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, shadowId, 'member']);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'Wiki employee', $4, 'project_manager', 'Wiki update test', 'conservative', true, true, $5)`,
    [employeeId, f.orgId, shadowId, `wiki-employee-${employeeId.slice(0, 8)}`, f.requesterId]);
  await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), f.spaceId, shadowId]);
  ctx = { org_id: f.orgId, employee_id: employeeId, employee_slug: `wiki-employee-${employeeId.slice(0, 8)}`, trust_level: 'conservative' };
  defty = await ensureDeftyEmployee(f.orgId);
  await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), f.spaceId, defty.userId]);
  await f.client.query("INSERT INTO orgs (id, name, slug) VALUES ($1, 'Other org', $2)", [otherOrgId, `wiki-other-${otherOrgId}`]);
});

after(async () => {
  if (!f) return;
  for (const statement of [
    'DELETE FROM wiki_citations WHERE org_id = $1',
    'DELETE FROM agent_actions WHERE org_id = $1',
    'DELETE FROM work_intents WHERE org_id = $1',
  ]) await f.client.query(statement, [f.orgId]).catch(() => undefined);
  await f.client.query('DELETE FROM space_members WHERE user_id = $1', [defty.userId]).catch(() => undefined);
  await f.client.query('DELETE FROM wiki_pages WHERE org_id = $1', [otherOrgId]).catch(() => undefined);
  await f.client.query('DELETE FROM orgs WHERE id = $1', [otherOrgId]).catch(() => undefined);
  await f.teardown();
});

type PageOptions = { scope?: 'org' | 'space' | 'user'; spaceId?: string | null; userId?: string | null; orgId?: string };
async function createPage(options: PageOptions = {}) {
  const id = randomUUID();
  const slug = `wu-${id.slice(0, 8)}`;
  await f.client.query(
    `INSERT INTO wiki_pages (id, org_id, scope, space_id, user_id, type, title, slug, summary, content, version, tags, metadata)
     VALUES ($1, $2, $3, $4, $5, 'decision', $6, $7, 'Original summary', 'Original content', 1, '{"a"}', '{"k": 1}')`,
    [id, options.orgId ?? f.orgId, options.scope ?? 'org', options.spaceId ?? null, options.userId ?? null,
      `Launch checklist decision ${id.slice(0, 8)}`, slug]);
  return { id, slug };
}

async function pageState(id: string) {
  const [page] = (await f.client.query(
    `SELECT title, summary, content, version, scope, space_id, tags, metadata, confidence, origin_space_id, is_deleted,
            (SELECT count(*)::int FROM wiki_ops_log WHERE page_id = $1) AS ops
       FROM wiki_pages WHERE id = $1`, [id])).rows;
  return page;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

async function latestActionId(): Promise<string> {
  return (await f.client.query(
    "SELECT id FROM agent_actions WHERE org_id = $1 AND action = 'wiki_update' ORDER BY created_at DESC LIMIT 1", [f.orgId])).rows[0].id;
}

/** C1: the MCP wiki_update tool queues a proposal. */
async function mcpProposal(args: Omit<WikiUpdateArgs, 'caller_employee_slug'>): Promise<string> {
  const result = await wikiUpdate({ caller_employee_slug: ctx.employee_slug, ...args }, ctx);
  assert.equal(result.isError, false, textOf(result));
  assert.equal(JSON.parse(textOf(result)).status, 'queued_for_approval');
  return latestActionId();
}

/** C5: request_human_approval queues a proposal. */
async function requestedProposal(args: Omit<WikiUpdateArgs, 'caller_employee_slug'>): Promise<string> {
  const result = await requestHumanApproval({ action: 'wiki_update', summary: 'Update the page', params: args }, ctx);
  assert.equal(result.isError, false, textOf(result));
  return JSON.parse(textOf(result)).action_id;
}

const CREATORS = { mcp: mcpProposal, request_human_approval: requestedProposal };

/** An admin approves the employee's own requests; the requester approves the rest. */
async function approve(actionId: string) {
  const [row] = (await f.client.query('SELECT user_id FROM agent_actions WHERE id = $1', [actionId])).rows;
  const approver = row?.user_id === shadowId ? f.adminId : f.requesterId;
  const response = await f.as(approver, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function assertRefused(actionId: string, error: string, pageId: string) {
  const before = await pageState(pageId);
  const answer = await approve(actionId);
  assert.notEqual(answer.status, 200, JSON.stringify(answer.body));
  const [row] = (await f.client.query('SELECT approval_status, executed_at, error FROM agent_actions WHERE id = $1', [actionId])).rows;
  assert.equal(row.approval_status, 'approved');
  assert.ok(row.executed_at, 'the refusal is terminal');
  assert.equal(row.error, error);
  assert.deepEqual(await pageState(pageId), before);
}

const patch = { content: 'Proposed content', summary: 'Proposed summary' };

for (const [name, propose] of Object.entries(CREATORS)) {
  test(`${name}: an unchanged page receives the approved update`, { skip: !canRun }, async () => {
    const page = await createPage();
    const actionId = await propose({ page_id: page.id, patch });
    const answer = await approve(actionId);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const state = await pageState(page.id);
    assert.equal(state.content, 'Proposed content');
    assert.equal(state.version, 2);
  });

  test(`${name}: a page edited after the proposal is refused and left untouched`, { skip: !canRun }, async () => {
    const page = await createPage();
    const actionId = await propose({ slug: page.slug, patch });
    await f.client.query("UPDATE wiki_pages SET content = 'Edited by a person' WHERE id = $1", [page.id]);
    await assertRefused(actionId, CHANGED, page.id);
  });

  test(`${name}: a requester that lost access to the page is refused`, { skip: !canRun }, async () => {
    const page = await createPage({ scope: 'space', spaceId: f.spaceId });
    const actionId = await propose({ page_id: page.id, patch });
    await f.client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [f.spaceId, shadowId]);
    try {
      await assertRefused(actionId, UNAVAILABLE, page.id);
    } finally {
      await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), f.spaceId, shadowId]);
    }
  });
}

const FIELD_EDITS: Array<[string, Partial<WikiUpdateArgs['patch']>, (spaceId: string) => string]> = [
  ['title', { title: 'New title' }, () => "title = 'Edited title'"],
  ['summary cleared', { summary: null }, () => "summary = 'Edited summary'"],
  ['tags', { tags: ['b'] }, () => "tags = '{z}'"],
  ['metadata', { metadata: { k: 2 } }, () => "metadata = '{\"k\": 3}'"],
  ['scope', { scope: 'space' }, () => "scope = 'space'"],
  ['space the source is derived from', { content: 'Proposed content' }, (spaceId) => `space_id = '${spaceId}'`],
];

for (const [field, fieldPatch, edit] of FIELD_EDITS) {
  test(`an edit to the ${field} after the proposal refuses it`, { skip: !canRun }, async () => {
    const page = await createPage();
    const actionId = await mcpProposal({ page_id: page.id, patch: fieldPatch as WikiUpdateArgs['patch'] });
    await f.client.query(`UPDATE wiki_pages SET ${edit(f.spaceId)} WHERE id = $1`, [page.id]);
    await assertRefused(actionId, CHANGED, page.id);
  });
}

test('a change to a column the update neither writes nor derives from still lets it apply', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = await mcpProposal({ page_id: page.id, patch });
  await f.client.query('UPDATE wiki_pages SET confidence = 0.42 WHERE id = $1', [page.id]);
  assert.equal((await approve(actionId)).status, 200);
  assert.equal((await pageState(page.id)).content, 'Proposed content');
});

test('a deleted page and a pending update without a recorded target are refused', { skip: !canRun }, async () => {
  const deleted = await createPage();
  const deletedAction = await mcpProposal({ page_id: deleted.id, patch });
  await f.client.query('UPDATE wiki_pages SET is_deleted = true WHERE id = $1', [deleted.id]);
  await assertRefused(deletedAction, UNAVAILABLE, deleted.id);

  const page = await createPage();
  const legacy = randomUUID();
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'mcp', 'wiki_update', $5::jsonb, 'quick', 'pending')`,
    [legacy, f.orgId, shadowId, ctx.employee_id, JSON.stringify({ caller_employee_slug: ctx.employee_slug, page_id: page.id, patch })]);
  await assertRefused(legacy, UNVERIFIABLE, page.id);
});

test('an unreachable page is refused at proposal time with one answer for every case', { skip: !canRun }, async () => {
  const hiddenSpace = randomUUID();
  await f.client.query("INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)",
    [hiddenSpace, f.orgId, `wu-hidden-${hiddenSpace.slice(0, 8)}`, f.adminId]);
  const deleted = await createPage();
  await f.client.query('UPDATE wiki_pages SET is_deleted = true WHERE id = $1', [deleted.id]);
  const left = await createPage();
  const right = await createPage();
  const cases: Record<string, { page_id?: string; slug?: string }> = {
    missing: { page_id: randomUUID() },
    deleted: { page_id: deleted.id },
    other_org: { page_id: (await createPage({ orgId: otherOrgId })).id },
    other_org_slug: { slug: (await createPage({ orgId: otherOrgId })).slug },
    space_not_joined: { page_id: (await createPage({ scope: 'space', spaceId: hiddenSpace })).id },
    user_page_of_another: { page_id: (await createPage({ scope: 'user', userId: f.requesterId })).id },
    id_slug_mismatch: { page_id: left.id, slug: right.slug },
  };
  const before = Number((await f.client.query('SELECT count(*)::int AS n FROM agent_actions WHERE org_id = $1', [f.orgId])).rows[0].n);
  const answers = new Set<string>();
  for (const [name, ref] of Object.entries(cases)) {
    // A stale expected version must not reveal that the page exists.
    const args = { caller_employee_slug: ctx.employee_slug, ...ref, expected_version: 99, patch };
    for (const result of [
      await wikiUpdate(args, ctx),
      await wikiUpdate(args, { ...ctx, trust_level: 'standard' }),
      await requestHumanApproval({ action: 'wiki_update', summary: 'Update', params: args }, ctx),
    ]) {
      assert.equal(result.isError, true, name);
      assert.equal(textOf(result), WIKI_TARGET_UNAVAILABLE_ERROR, name);
      assert.equal(result.structuredContent?.code, 'WIKI_TARGET_UNAVAILABLE', name);
      answers.add(JSON.stringify(result));
    }
  }
  assert.equal(answers.size, 1);
  assert.equal(Number((await f.client.query('SELECT count(*)::int AS n FROM agent_actions WHERE org_id = $1', [f.orgId])).rows[0].n), before);
  for (const page of [left, right]) assert.equal((await pageState(page.id)).version, 1);

  // Control: a reachable page in the employee's own org is proposed, and a
  // stale expected version on it is reported as such.
  assert.ok(await mcpProposal({ page_id: left.id, patch }));
  const stale = await wikiUpdate({ caller_employee_slug: ctx.employee_slug, page_id: left.id, expected_version: 99, patch }, { ...ctx, trust_level: 'standard' });
  assert.match(textOf(stale), /changed since this update was drafted/);
});

test('a membership removal during an approved update waits until the update commits', { skip: !canRun, timeout: 120_000 }, async () => {
  const page = await createPage({ scope: 'space', spaceId: f.spaceId });
  const actionId = await mcpProposal({ page_id: page.id, patch });
  let removal: Promise<unknown> | null = null;
  _setWikiUpdateRevisionCheckedHookForTest(async (tx) => {
    const writer = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    const writerPid = Number((writer as unknown as { rows: Array<{ pid: number }> }).rows[0]!.pid);
    const { default: pg } = await import('pg');
    const other = new pg.Client({ connectionString: durabilityDatabaseUrl });
    await other.connect();
    removal = other.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [f.spaceId, shadowId])
      .finally(() => other.end());
    for (;;) {
      const waiting = await f.client.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [writerPid]);
      if (waiting.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  try {
    const answer = await approve(actionId);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    await removal;
  } finally {
    _setWikiUpdateRevisionCheckedHookForTest(null);
    await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), f.spaceId, shadowId]);
  }
  assert.equal((await pageState(page.id)).content, 'Proposed content');
});

const retryApp = new Hono();
retryApp.use('*', async (c, next) => {
  c.set('user', { id: f.requesterId, org_id: f.orgId, email: 'requester@example.test', role: 'member' } as any);
  await next();
});
retryApp.route('/api/work-intents', workIntentRoutes);

async function captureProposal(page: { id: string; slug: string }): Promise<{ actionId: string; intentId: string }> {
  const messageId = await f.insertMessage(`Launch checklist decision ${page.id.slice(0, 8)}: keep Friday`);
  const queued = await queueDeftyKnowledgeCapture({
    orgId: f.orgId, sourceUserId: f.requesterId, spaceId: f.spaceId, messageId,
    content: 'The launch checklist decision now keeps the Friday review.', title: `Launch checklist decision ${page.id.slice(0, 8)}`,
    wikiType: 'decision', captureKind: 'decision_candidate', extraction: 'classifier', preferUpdate: true, autoApprove: false,
  });
  assert.equal(queued.queued, true, JSON.stringify(queued));
  const [row] = (await f.client.query("SELECT params->>'work_intent_id' AS intent FROM agent_actions WHERE id = $1", [queued.actionId])).rows;
  return { actionId: queued.actionId!, intentId: row.intent };
}

async function retry(intentId: string) {
  const response = await retryApp.request(`/api/work-intents/${intentId}/retry`, { method: 'POST' });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test('Defty capture and its retry apply to the captured revision only', { skip: !canRun }, async () => {
  const applied = await createPage({ scope: 'space', spaceId: f.spaceId });
  const first = await captureProposal(applied);
  assert.equal((await approve(first.actionId)).status, 200);
  assert.match((await pageState(applied.id)).content, /Friday review/);

  const page = await createPage({ scope: 'space', spaceId: f.spaceId });
  const capture = await captureProposal(page);
  await f.client.query("UPDATE wiki_pages SET content = 'Edited by a person', version = 2 WHERE id = $1", [page.id]);
  await assertRefused(capture.actionId, CHANGED, page.id);
  // The retry repeats the original proposal, so it is refused the same way.
  const retried = await retry(capture.intentId);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  await assertRefused(retried.body.action.id, CHANGED, page.id);

  // A retry of an unchanged page applies.
  const fresh = await createPage({ scope: 'space', spaceId: f.spaceId });
  const later = await captureProposal(fresh);
  await f.client.query("UPDATE agent_actions SET approval_status = 'rejected' WHERE id = $1", [later.actionId]);
  await f.client.query("UPDATE work_intents SET status = 'failed' WHERE id = $1", [later.intentId]);
  const again = await retry(later.intentId);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal((await approve(again.body.action.id)).status, 200);
  assert.match((await pageState(fresh.id)).content, /Friday review/);
});

test('a retry without a trusted original proposal is refused', { skip: !canRun }, async () => {
  const page = await createPage({ scope: 'space', spaceId: f.spaceId });
  const capture = await captureProposal(page);
  // A legacy capture: its proposal records no target.
  await f.client.query("UPDATE agent_actions SET before_state = NULL, approval_status = 'rejected' WHERE id = $1", [capture.actionId]);
  await f.client.query("UPDATE work_intents SET status = 'failed' WHERE id = $1", [capture.intentId]);
  // An employee proposal naming the intent is not its original proposal.
  const [intent] = (await f.client.query('SELECT proposed_params FROM work_intents WHERE id = $1', [capture.intentId])).rows;
  await requestedProposal({ ...intent.proposed_params, work_intent_id: capture.intentId });
  const answer = await retry(capture.intentId);
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.equal(answer.body.code, 'RETRY_UNAVAILABLE');
});

test('a wiki_create proposal is queued and applied as before', { skip: !canRun }, async () => {
  const title = `Wu created ${randomUUID().slice(0, 8)}`;
  const result = await wikiCreate({ caller_employee_slug: ctx.employee_slug, title, content: 'Created content' }, ctx);
  const actionId = JSON.parse(textOf(result)).approval_id;
  const [row] = (await f.client.query('SELECT before_state FROM agent_actions WHERE id = $1', [actionId])).rows;
  assert.equal(row.before_state, null);
  assert.equal((await approve(actionId)).status, 200);
  assert.equal(Number((await f.client.query('SELECT count(*)::int AS n FROM wiki_pages WHERE org_id = $1 AND title = $2', [f.orgId, title])).rows[0].n), 1);
});

test('a retry for a page the employee can no longer reach is refused', { skip: !canRun }, async () => {
  const page = await createPage({ scope: 'space', spaceId: f.spaceId });
  const capture = await captureProposal(page);
  await f.client.query('UPDATE wiki_pages SET is_deleted = true WHERE id = $1', [page.id]);
  await assertRefused(capture.actionId, UNAVAILABLE, page.id);
  const answer = await retry(capture.intentId);
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.equal(answer.body.code, 'WIKI_TARGET_UNAVAILABLE');
  assert.equal(answer.body.error, WIKI_TARGET_UNAVAILABLE_ERROR);
});
