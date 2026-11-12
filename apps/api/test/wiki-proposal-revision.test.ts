/**
 * C05: a wiki update proposal applies only to the page revision it was made
 * against. Proposals are created through the real chat proposal path
 * (persistAgentReplyWithActions) and the plan path (executeActionDirect with
 * a human checkpoint), and approved through the real approve route.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/wiki-proposal-revision.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { wikiLinks } from '@deft/db/schema';

import { persistAgentReplyWithActions } from '../src/lib/agent-action-proposals.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import { _setWikiWriteRevisionCheckedHookForTest } from '../src/lib/wiki-proposal-target.js';
import { db } from '../src/lib/db.js';
import { lockWikiPageForLinkWrite } from '../src/lib/wiki-page-link-lock.js';
import { wikiRoutes } from '../src/routes/wiki.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;
let agentUserId: string;

const CHANGED = 'The wiki page changed after this update was proposed, so it was not applied. Review the current page and propose the update again.';
const UNAVAILABLE = 'The wiki page this update was proposed for is no longer available to the requester, so it was not applied.';
const EXISTS = 'This page could not be created as proposed. Ask for the proposal again.';
const UNVERIFIABLE = 'This wiki proposal does not record the page revision it was made against, so it was not applied. Ask for the update again.';

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('WK');
  agentUserId = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'Wiki proposal agent', 'agent', true, true)`,
    [agentUserId, `wiki-proposal-agent-${agentUserId}@example.test`],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, agentUserId, 'member']);
});

after(async () => {
  if (f) await f.teardown();
});

async function createPage(options: { scope?: 'org' | 'space'; spaceId?: string; related?: string[] } = {}) {
  const id = randomUUID();
  const slug = `c05-${id.slice(0, 8)}`;
  await f.client.query(
    `INSERT INTO wiki_pages (id, org_id, scope, space_id, type, title, slug, summary, content, version)
     VALUES ($1, $2, $3, $4, 'fact', $5, $6, 'Original summary', 'Original content', 1)`,
    [id, f.orgId, options.scope ?? 'org', options.spaceId ?? null, `C05 page ${id.slice(0, 8)}`, slug],
  );
  for (const target of options.related ?? []) {
    await f.client.query('INSERT INTO wiki_links (id, org_id, source_page_id, target_page_id) VALUES ($1, $2, $3, $4)',
      [randomUUID(), f.orgId, id, target]);
  }
  return { id, slug };
}

async function pageState(id: string) {
  const [page] = (await f.client.query(
    'SELECT title, summary, type, content, version, confidence, is_deleted FROM wiki_pages WHERE id = $1', [id])).rows;
  const links = (await f.client.query(
    'SELECT target_page_id FROM wiki_links WHERE source_page_id = $1 ORDER BY target_page_id', [id])).rows
    .map((row) => row.target_page_id);
  return { ...page, links };
}

/** A wiki update proposed in chat (the action compiler's resolved params). */
async function chatProposal(params: Record<string, unknown>): Promise<string> {
  const persisted = await persistAgentReplyWithActions({
    orgId: f.orgId,
    spaceId: f.spaceId,
    userId: f.requesterId,
    agentUserId,
    content: 'I prepared a wiki update for review.',
    metadata: {},
    pendingActions: [{ action: 'wiki_write', params, approval_tier: 'quick', tool_use_id: null, source: 'action_compiler' }],
  });
  assert.equal(persisted.actions.length, 1);
  return persisted.actions[0]!.id;
}

/** A wiki update created by an approved plan step that needs its own approval. */
async function planProposal(params: Record<string, unknown>): Promise<string> {
  const result = await executeActionDirect('wiki_write', params, f.orgId, f.requesterId, null, 'quick', {
    source: 'plan',
    forceApproval: true,
  });
  assert.equal(result.requiresApproval, true);
  return result.actionId;
}

async function approve(actionId: string) {
  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function actionRow(actionId: string) {
  const [row] = (await f.client.query(
    'SELECT approval_status, approved_by_user_id, executed_at, error, result FROM agent_actions WHERE id = $1', [actionId])).rows;
  return row;
}

async function receiptCount(actionId: string): Promise<number> {
  return Number((await f.client.query('SELECT count(*)::int AS n FROM action_receipts WHERE action_id = $1', [actionId])).rows[0].n);
}

async function openAttention(actionId: string): Promise<number> {
  return Number((await f.client.query(
    `SELECT count(*)::int AS n FROM attention_items
      WHERE source_type = 'agent_action' AND source_id = $1 AND state IN ('open_unseen', 'open_seen', 'acknowledged')`,
    [actionId])).rows[0].n);
}

/** The refusal is final: decided, failed with `error`, bookkeeping complete, and a retry changes nothing. */
async function assertRefused(actionId: string, error: string, pageId: string, before: unknown) {
  const first = await approve(actionId);
  assert.equal(first.body.error, error, JSON.stringify(first.body));
  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.approved_by_user_id, f.requesterId);
  assert.ok(row.executed_at, 'the refusal is terminal');
  assert.equal(row.error, error);
  assert.deepEqual(await pageState(pageId), before);
  assert.equal(await receiptCount(actionId), 1);
  assert.equal(await openAttention(actionId), 0);

  const again = await approve(actionId);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.status, 'failed');
  assert.equal(again.body.error, error);
  assert.equal((await actionRow(actionId)).approval_status, 'approved');
  assert.deepEqual(await pageState(pageId), before);
  assert.equal(await receiptCount(actionId), 1);
}

function updateParams(page: { slug: string }, extra: Record<string, unknown> = {}) {
  return {
    slug: page.slug,
    title: 'Proposed title',
    summary: 'Proposed summary',
    type: 'procedure',
    content: 'Proposed content',
    wiki_write_mode: 'update',
    ...extra,
  };
}

test('C05-a: an unchanged page receives the approved update once', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = await chatProposal(updateParams(page));
  const first = await approve(actionId);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const state = await pageState(page.id);
  assert.equal(state.title, 'Proposed title');
  assert.equal(state.summary, 'Proposed summary');
  assert.equal(state.type, 'procedure');
  assert.equal(state.content, 'Proposed content');
  assert.equal(state.version, 2);
  assert.equal(await receiptCount(actionId), 1);
  await approve(actionId);
  assert.deepEqual(await pageState(page.id), state);
  assert.equal(await receiptCount(actionId), 1);
});

const FIELD_EDITS: Record<string, (pageId: string, other: string) => Promise<void>> = {
  content: async (id) => { await f.client.query("UPDATE wiki_pages SET content = 'Edited by a person', version = version + 1 WHERE id = $1", [id]); },
  title: async (id) => { await f.client.query("UPDATE wiki_pages SET title = 'Edited title' WHERE id = $1", [id]); },
  summary: async (id) => { await f.client.query("UPDATE wiki_pages SET summary = 'Edited summary' WHERE id = $1", [id]); },
  type: async (id) => { await f.client.query("UPDATE wiki_pages SET type = 'decision' WHERE id = $1", [id]); },
  related_links: async (id, other) => {
    await f.client.query('INSERT INTO wiki_links (id, org_id, source_page_id, target_page_id) VALUES ($1, $2, $3, $4)',
      [randomUUID(), f.orgId, id, other]);
  },
};

for (const [field, edit] of Object.entries(FIELD_EDITS)) {
  test(`C05-b: an edit to the ${field} between proposal and approval refuses the update`, { skip: !canRun }, async () => {
    const other = await createPage();
    const page = await createPage();
    const actionId = await chatProposal(updateParams(page, { related_slugs: [other.slug] }));
    await edit(page.id, other.id);
    const before = await pageState(page.id);
    await assertRefused(actionId, CHANGED, page.id, before);
  });
}

test('C05-c: a housekeeping change to a field the update does not write still lets it apply', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = await chatProposal(updateParams(page));
  // Wiki lint adjusts confidence, which moves updated_at but no written field.
  await f.client.query("UPDATE wiki_pages SET confidence = 0.42, updated_at = now() + interval '1 minute' WHERE id = $1", [page.id]);
  const response = await approve(actionId);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await pageState(page.id)).content, 'Proposed content');
});

test('C05-d: a requester who lost access to the page between proposal and approval is refused', { skip: !canRun }, async () => {
  const page = await createPage({ scope: 'space', spaceId: f.spaceId });
  const actionId = await chatProposal(updateParams(page));
  await f.client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [f.spaceId, f.requesterId]);
  try {
    const before = await pageState(page.id);
    const first = await approve(actionId);
    assert.notEqual(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(await pageState(page.id), before);
    const row = await actionRow(actionId);
    assert.equal(row.approval_status, 'approved');
    assert.ok(row.executed_at, 'the refusal is terminal');
    assert.ok(row.error === UNAVAILABLE || /not found/.test(row.error), row.error);
    assert.equal(await receiptCount(actionId), 1);
  } finally {
    await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), f.spaceId, f.requesterId]);
  }
});

test('C05-e: a page id supplied in params never selects the page that is written', { skip: !canRun }, async () => {
  const hiddenSpaceId = randomUUID();
  await f.client.query("INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)",
    [hiddenSpaceId, f.orgId, `c05-hidden-${hiddenSpaceId.slice(0, 8)}`, f.adminId]);
  await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), hiddenSpaceId, f.adminId]);
  const hidden = await createPage({ scope: 'space', spaceId: hiddenSpaceId });
  const visible = await createPage();
  const hiddenBefore = await pageState(hidden.id);
  const supplied = {
    resolved_wiki_page_id: hidden.id,
    page_id: hidden.id,
    wiki_proposal_target: { v: 1, mode: 'update', slug: visible.slug, page_id: hidden.id, revision: 'sha256:0' },
  };

  const chatId = await chatProposal(updateParams(visible, supplied));
  const planId = await planProposal(updateParams(visible, { ...supplied, content: 'Plan content' }));
  const chat = await approve(chatId);
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  assert.equal((await pageState(visible.id)).content, 'Proposed content');
  assert.deepEqual(await pageState(hidden.id), hiddenBefore);
  // The plan proposal was frozen against the page before the chat update.
  const plan = await approve(planId);
  assert.equal(plan.body.error, CHANGED, JSON.stringify(plan.body));
  assert.deepEqual(await pageState(hidden.id), hiddenBefore);

  // A slug the requester cannot see is not found, whatever params say.
  const direct = await chatProposal(updateParams(hidden, supplied));
  const answer = await approve(direct);
  assert.notEqual(answer.status, 200, JSON.stringify(answer.body));
  assert.ok((await actionRow(direct)).executed_at, 'the refusal is terminal');
  assert.deepEqual(await pageState(hidden.id), hiddenBefore);
});

test('C05-f: plan-created proposals apply when the page is unchanged and are refused when it changed', { skip: !canRun }, async () => {
  const page = await createPage();
  const applies = await planProposal(updateParams(page));
  const applied = await approve(applies);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal((await pageState(page.id)).content, 'Proposed content');

  const stale = await planProposal(updateParams(page, { content: 'Second plan content' }));
  await FIELD_EDITS.content!(page.id, page.id);
  await assertRefused(stale, CHANGED, page.id, await pageState(page.id));
});

test('C05-g: a new page whose name is no longer free is refused', { skip: !canRun }, async () => {
  const title = `C05 new page ${randomUUID().slice(0, 8)}`;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const actionId = await chatProposal({ title, content: 'New page content', type: 'fact', wiki_write_mode: 'create' });
  const takenId = randomUUID();
  await f.client.query(
    `INSERT INTO wiki_pages (id, org_id, scope, type, title, slug, content, version)
     VALUES ($1, $2, 'org', 'fact', $3, $4, 'Written by a person', 1)`,
    [takenId, f.orgId, title, slug],
  );
  await assertRefused(actionId, EXISTS, takenId, await pageState(takenId));
  const pages = Number((await f.client.query('SELECT count(*)::int AS n FROM wiki_pages WHERE org_id = $1 AND slug = $2', [f.orgId, slug])).rows[0].n);
  assert.equal(pages, 1);

  const freeTitle = `C05 free page ${randomUUID().slice(0, 8)}`;
  const created = await chatProposal({ title: freeTitle, content: 'Created content', type: 'fact', wiki_write_mode: 'create' });
  const response = await approve(created);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((await actionRow(created)).result.action, 'created');
});

test('C05-h: a pending wiki update without a recorded revision is refused, not resolved by slug', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = randomUUID();
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, 'mention', 'wiki_write', $4::jsonb, 'quick', 'pending')`,
    [actionId, f.orgId, f.requesterId, JSON.stringify(updateParams(page))],
  );
  await assertRefused(actionId, UNVERIFIABLE, page.id, await pageState(page.id));
});

test('C05-k: an approved update whose write transaction throws is reopened, not left claimed', { skip: !canRun }, async () => {
  const page = await createPage();
  const actionId = await chatProposal(updateParams(page));
  const before = await pageState(page.id);
  _setWikiWriteRevisionCheckedHookForTest(async () => { throw new Error('simulated lock timeout'); });
  try {
    await approve(actionId);
  } finally {
    _setWikiWriteRevisionCheckedHookForTest(null);
  }
  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'pending', JSON.stringify(row));
  assert.equal(row.executed_at, null);
  assert.deepEqual(await pageState(page.id), before);

  const retried = await approve(actionId);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal((await pageState(page.id)).title, 'Proposed title');
});

test('C05-i: a person changing the links while an approved update runs is not overwritten', { skip: !canRun, timeout: 600_000 }, async () => {
  const first = await createPage();
  const second = await createPage();
  const page = await createPage({ related: [first.id] });
  // The page already has its history snapshot, so the person's request writes
  // nothing else to the page before it replaces the links.
  await f.client.query(
    "INSERT INTO wiki_page_versions (id, page_id, version, title, content, summary) SELECT gen_random_uuid()::text, id, version, title, content, summary FROM wiki_pages WHERE id = $1",
    [page.id],
  );
  const actionId = await chatProposal({ slug: page.slug, related_slugs: [first.slug], wiki_write_mode: 'update' });
  const wikiApp = new Hono();
  wikiApp.use('*', async (c, next) => {
    c.set('user', { id: f.requesterId, org_id: f.orgId, email: 'requester@example.test', role: 'member' } as any);
    await next();
  });
  wikiApp.route('/api/wiki', wikiRoutes);

  let personEdit: Promise<Response> | null = null;
  let personDone = false;
  // Once the update has checked the revision, the person replaces the links.
  // The update continues only when that request has finished or is waiting
  // for the page, so the two writes interleave the same way on every run.
  _setWikiWriteRevisionCheckedHookForTest(async (tx) => {
    const writer = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    const writerPid = Number((writer as unknown as { rows: Array<{ pid: number }> }).rows[0]!.pid);
    personEdit = Promise.resolve(wikiApp.request(`/api/wiki/${page.slug}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ related_slugs: [second.slug] }),
    }));
    void personEdit.finally(() => { personDone = true; });
    for (;;) {
      if (personDone) return;
      // The person's request is blocked by this write's backend, not by anything else.
      const waiting = await f.client.query(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [writerPid]);
      if (waiting.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  try {
    const approved = await approve(actionId);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const edited = await personEdit!;
    assert.equal(edited.status, 200, await edited.clone().text());
  } finally {
    _setWikiWriteRevisionCheckedHookForTest(null);
  }
  // The later write is the person's, and it stands.
  assert.deepEqual((await pageState(page.id)).links, [second.id]);
});

test('C05-j: two pages linking to each other at the same time both commit', { skip: !canRun, timeout: 600_000 }, async () => {
  const left = await createPage();
  const right = await createPage();
  // Each writer holds its own page lock before either inserts its link, so
  // the two link inserts each check the page the other one holds.
  let lockedCount = 0;
  let release!: () => void;
  const bothLocked = new Promise<void>((resolve) => { release = resolve; });
  const write = (source: string, target: string) => db.transaction(async (tx) => {
    assert.equal(await lockWikiPageForLinkWrite(tx, f.orgId, source), true);
    lockedCount += 1;
    if (lockedCount === 2) release();
    await bothLocked;
    await tx.insert(wikiLinks).values({ org_id: f.orgId, source_page_id: source, target_page_id: target }).onConflictDoNothing();
  });
  const results = await Promise.allSettled([write(left.id, right.id), write(right.id, left.id)]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled'], JSON.stringify(results.map((result) => result.status === 'rejected' ? String(result.reason) : 'ok')));
  assert.deepEqual((await pageState(left.id)).links, [right.id]);
  assert.deepEqual((await pageState(right.id)).links, [left.id]);
});
