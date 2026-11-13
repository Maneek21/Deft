/**
 * Approving a wiki proposal that can no longer be applied as proposed returns
 * a failed result with the reason and its code (HTTP 200), the same answer on
 * the first approve and on every replay. The page is never written and the
 * action is terminal. Any other execution error keeps its error response.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/wiki-proposal-refusal-result.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { persistAgentReplyWithActions } from '../src/lib/agent-action-proposals.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import { _setWikiUpdateRevisionCheckedHookForTest, wikiCreate, wikiUpdate } from '../src/lib/mcp-tools/wiki-create.js';
import { _setWikiWriteRevisionCheckedHookForTest } from '../src/lib/wiki-proposal-target.js';
import { durabilityDatabaseUrl, setupDurabilityFixture, type DurabilityFixture } from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
const CHANGED = 'The wiki page changed after this update was proposed, so it was not applied. Review the current page and propose the update again.';
const UNAVAILABLE = 'The wiki page this update was proposed for is no longer available to the requester, so it was not applied.';
const NOT_CREATED = 'This page could not be created as proposed. Ask for the proposal again.';
const UNVERIFIABLE = 'This wiki proposal does not record the page revision it was made against, so it was not applied. Ask for the update again.';

let f: DurabilityFixture;
let ctx: ToolContext;
let agentUserId: string;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('WR');
  const shadowId = randomUUID();
  const employeeId = randomUUID();
  const slug = `wiki-refusal-${employeeId.slice(0, 8)}`;
  await f.client.query(`INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'Wiki employee', 'agent', true, true)`,
    [shadowId, `wiki-refusal-${shadowId}@example.test`]);
  await f.client.query("INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'member', true)", [randomUUID(), f.orgId, shadowId]);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'Wiki employee', $4, 'project_manager', 'Wiki refusal test', 'conservative', true, true, $5)`,
    [employeeId, f.orgId, shadowId, slug, f.requesterId]);
  await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), f.spaceId, shadowId]);
  ctx = { org_id: f.orgId, employee_id: employeeId, employee_slug: slug, trust_level: 'conservative' };
  agentUserId = randomUUID();
  await f.client.query(`INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'Wiki agent', 'agent', true, true)`,
    [agentUserId, `wiki-refusal-agent-${agentUserId}@example.test`]);
  await f.client.query("INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'member', true)", [randomUUID(), f.orgId, agentUserId]);
});

after(async () => {
  if (!f) return;
  for (const statement of ['DELETE FROM wiki_citations WHERE org_id = $1', 'DELETE FROM agent_actions WHERE org_id = $1',
    'DELETE FROM work_intents WHERE org_id = $1']) await f.client.query(statement, [f.orgId]).catch(() => undefined);
  await f.teardown();
});

const textOf = (result: ToolResult) => result.content[0]?.text ?? '';

async function createPage() {
  const id = randomUUID();
  const slug = `wr-${id.slice(0, 8)}`;
  await f.client.query(
    `INSERT INTO wiki_pages (id, org_id, scope, type, title, slug, summary, content, version)
     VALUES ($1, $2, 'org', 'fact', $3, $4, 'Original summary', 'Original content', 1)`,
    [id, f.orgId, `Refusal page ${id.slice(0, 8)}`, slug]);
  return { id, slug };
}

async function pageState(id: string) {
  return (await f.client.query('SELECT title, summary, content, version, is_deleted FROM wiki_pages WHERE id = $1', [id])).rows[0];
}

async function approve(actionId: string) {
  let answer = { status: 404, body: {} as Record<string, unknown> };
  for (const reviewer of [f.requesterId, f.adminId]) {
    const response = await f.as(reviewer, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
    answer = { status: response.status, body: await response.json() as Record<string, unknown> };
    if (response.status !== 404) break;
  }
  return answer;
}

async function mcpUpdate(page: { id: string }): Promise<string> {
  const result = await wikiUpdate({ caller_employee_slug: ctx.employee_slug, page_id: page.id, patch: { content: 'Proposed content' } }, ctx);
  assert.equal(result.isError, false, textOf(result));
  return (await f.client.query(
    "SELECT id FROM agent_actions WHERE org_id = $1 AND action = 'wiki_update' ORDER BY created_at DESC LIMIT 1", [f.orgId])).rows[0].id;
}

async function mcpCreate(title: string): Promise<string> {
  const result = await wikiCreate({ caller_employee_slug: ctx.employee_slug, title, content: 'Proposed content' }, ctx);
  assert.equal(result.isError, false, textOf(result));
  return JSON.parse(textOf(result)).approval_id;
}

async function chatWrite(params: Record<string, unknown>): Promise<string> {
  const persisted = await persistAgentReplyWithActions({
    orgId: f.orgId, spaceId: f.spaceId, userId: f.requesterId, agentUserId,
    content: 'I prepared a wiki change for review.', metadata: {},
    pendingActions: [{ action: 'wiki_write', params, approval_tier: 'quick', tool_use_id: null, source: 'action_compiler' }],
  });
  return persisted.actions[0]!.id;
}

const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const writeUpdate = (page: { slug: string }) => ({ slug: page.slug, content: 'Proposed content', wiki_write_mode: 'update' });

/** First approve and replay both answer 200 with the same failed result; nothing is written; the row is terminal. */
async function assertFailedResult(actionId: string, error: string, code: string, pageId: string) {
  const before = await pageState(pageId);
  const first = await approve(actionId);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { status: 'failed', message: 'approved, but it did not complete', error, code });
  const [row] = (await f.client.query('SELECT approval_status, executed_at, error FROM agent_actions WHERE id = $1', [actionId])).rows;
  assert.equal(row.approval_status, 'approved');
  assert.ok(row.executed_at, 'the refusal is terminal');
  assert.equal(row.error, error);
  const replay = await approve(actionId);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, first.body);
  assert.deepEqual(await pageState(pageId), before);
}

const takeSlug = async (slug: string) => {
  const id = randomUUID();
  await f.client.query(`INSERT INTO wiki_pages (id, org_id, scope, type, title, slug, content) VALUES ($1, $2, 'org', 'fact', 'Someone else', $3, 'Other content')`,
    [id, f.orgId, slug]);
  return id;
};

test('wiki_update: a page edited after the proposal', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = await mcpUpdate(page);
  await f.client.query("UPDATE wiki_pages SET content = 'Edited by a person' WHERE id = $1", [page.id]);
  await assertFailedResult(actionId, CHANGED, 'WIKI_PAGE_CHANGED', page.id);
});

test('wiki_update: a page deleted after the proposal', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = await mcpUpdate(page);
  await f.client.query('UPDATE wiki_pages SET is_deleted = true WHERE id = $1', [page.id]);
  await assertFailedResult(actionId, UNAVAILABLE, 'WIKI_PAGE_UNAVAILABLE', page.id);
});

test('wiki_update: a proposal without a recorded target', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = await mcpUpdate(page);
  await f.client.query('UPDATE agent_actions SET before_state = NULL WHERE id = $1', [actionId]);
  await assertFailedResult(actionId, UNVERIFIABLE, 'WIKI_PROPOSAL_UNVERIFIABLE', page.id);
});

test('wiki_create: a slug taken after the proposal', { skip: !canRun }, async () => {
  const title = `Refusal create ${randomUUID().slice(0, 8)}`;
  const actionId = await mcpCreate(title);
  const [row] = (await f.client.query("SELECT before_state->'wiki_proposal_target'->>'slug' AS slug FROM agent_actions WHERE id = $1", [actionId])).rows;
  const takenId = await takeSlug(row.slug);
  await assertFailedResult(actionId, NOT_CREATED, 'WIKI_PAGE_NOT_CREATED', takenId);
});

test('wiki_write: a page edited after the proposal', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = await chatWrite(writeUpdate(page));
  await f.client.query("UPDATE wiki_pages SET content = 'Edited by a person' WHERE id = $1", [page.id]);
  await assertFailedResult(actionId, CHANGED, 'WIKI_PAGE_CHANGED', page.id);
});

test('wiki_write: a page deleted after the proposal', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = await chatWrite(writeUpdate(page));
  await f.client.query('UPDATE wiki_pages SET is_deleted = true WHERE id = $1', [page.id]);
  await assertFailedResult(actionId, UNAVAILABLE, 'WIKI_PAGE_UNAVAILABLE', page.id);
});

test('wiki_write: a new page whose slug was taken after the proposal', { skip: !canRun }, async () => {
  const title = `Refusal write ${randomUUID().slice(0, 8)}`;
  const actionId = await chatWrite({ title, content: 'Proposed content', type: 'fact', wiki_write_mode: 'create' });
  const takenId = await takeSlug(slugOf(title));
  await assertFailedResult(actionId, NOT_CREATED, 'WIKI_PAGE_NOT_CREATED', takenId);
});

test('wiki_write: a proposal without a recorded target', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = await chatWrite(writeUpdate(page));
  await f.client.query('UPDATE agent_actions SET before_state = NULL WHERE id = $1', [actionId]);
  await assertFailedResult(actionId, UNVERIFIABLE, 'WIKI_PROPOSAL_UNVERIFIABLE', page.id);
});

test('an unexpected execution error keeps its error response', { skip: !canRun }, async () => {
  const updatePage = await createPage();
  const updateAction = await mcpUpdate(updatePage);
  _setWikiUpdateRevisionCheckedHookForTest(async () => { throw new Error('simulated failure'); });
  try {
    const answer = await approve(updateAction);
    assert.equal(answer.status, 500, JSON.stringify(answer.body));
    assert.equal(answer.body.code, 'EXECUTE_FAILED');
  } finally {
    _setWikiUpdateRevisionCheckedHookForTest(null);
  }

  const writePage = await createPage();
  const writeAction = await chatWrite(writeUpdate(writePage));
  _setWikiWriteRevisionCheckedHookForTest(async () => { throw new Error('simulated failure'); });
  try {
    const answer = await approve(writeAction);
    assert.equal(answer.status, 500, JSON.stringify(answer.body));
    assert.equal(answer.body.code, 'EXECUTE_FAILED');
  } finally {
    _setWikiWriteRevisionCheckedHookForTest(null);
  }
  assert.equal((await pageState(updatePage.id)).content, 'Original content');
  assert.equal((await pageState(writePage.id)).content, 'Original content');
});
