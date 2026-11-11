/**
 * Lane W2-a2 — C05: approving a wiki update proposal that went stale (the
 * page changed after the proposal) does not overwrite the newer edit. The
 * action is recorded as failed with a clear message.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-durability-c05.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { WIKI_PROPOSAL_STALE_ERROR } from '../src/lib/wiki-proposal-freshness.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('WK');
});

after(async () => {
  if (f) await f.teardown();
});

async function insertPage(slug: string, content: string, updatedAt: Date): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO wiki_pages (id, org_id, scope, type, title, slug, content, version, created_at, updated_at)
     VALUES ($1, $2, 'org', 'fact', $3, $4, $5, 1, $6, $6)`,
    [id, f.orgId, `Page ${slug}`, slug, content, updatedAt.toISOString()],
  );
  return id;
}

async function proposal(pageId: string, slug: string, content: string, createdAt: Date) {
  return f.insertAction({
    action: 'wiki_write',
    params: {
      slug, title: `Page ${slug}`, content, type: 'fact',
      wiki_write_mode: 'update', resolved_wiki_page_id: pageId,
    },
    status: 'pending',
    executed: false,
    createdAt,
  });
}

async function pageContent(pageId: string): Promise<string> {
  const rows = await f.client.query('SELECT content FROM wiki_pages WHERE id = $1', [pageId]);
  return rows.rows[0].content as string;
}

test('C05: a wiki update proposal is refused when the page changed after the proposal', { skip: !canRun }, async () => {
  const slug = `c05-stale-${randomUUID().slice(0, 8)}`;
  const pageId = await insertPage(slug, 'original', new Date(Date.now() - 10 * 60_000));
  const actionId = await proposal(pageId, slug, 'original + proposed append', new Date(Date.now() - 5 * 60_000));
  // A human edit lands between the proposal and its approval.
  await f.client.query("UPDATE wiki_pages SET content = 'human edit', updated_at = $2 WHERE id = $1", [pageId, new Date().toISOString()]);

  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.notEqual(response.status, 200, await response.clone().text());
  const body = await response.json() as { error: string };
  assert.equal(body.error, WIKI_PROPOSAL_STALE_ERROR);
  assert.equal(await pageContent(pageId), 'human edit');

  const row = await f.client.query('SELECT approval_status, error, executed_at FROM agent_actions WHERE id = $1', [actionId]);
  assert.equal(row.rows[0].approval_status, 'approved', 'the stale proposal is closed, not reopened for a retry');
  assert.equal(row.rows[0].error, WIKI_PROPOSAL_STALE_ERROR);
  assert.notEqual(row.rows[0].executed_at, null);
});

test('C05: the executor updates the page frozen at proposal time, not whichever page holds the slug', { skip: !canRun }, async () => {
  const slug = `c05-frozen-${randomUUID().slice(0, 8)}`;
  const frozenId = await insertPage(`${slug}-old`, 'frozen page', new Date(Date.now() - 10 * 60_000));
  const otherId = await insertPage(slug, 'other page', new Date(Date.now() - 10 * 60_000));
  const actionId = await proposal(frozenId, slug, 'frozen page updated', new Date(Date.now() - 5 * 60_000));

  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await pageContent(otherId), 'other page');
  assert.equal(await pageContent(frozenId), 'frozen page updated');
});

test('C05: an unchanged page accepts the approved update', { skip: !canRun }, async () => {
  const slug = `c05-fresh-${randomUUID().slice(0, 8)}`;
  const pageId = await insertPage(slug, 'original', new Date(Date.now() - 10 * 60_000));
  const actionId = await proposal(pageId, slug, 'original + append', new Date(Date.now() - 5 * 60_000));
  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await pageContent(pageId), 'original + append');
});
