/**
 * A wiki proposal that cites a chat message is accepted only when the cited
 * message is one the write itself can use: from the page's own room. A call
 * citing a message from another room is refused before anything is queued or
 * written, with one code telling the agent to cite a message from the page's
 * room or omit the citation. A call without a citation is unchanged.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/wiki-citation-room-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;
let shadow: string;
let employee: string;
let roomA: string;
let roomB: string;
let pageB: string;
let movedPage: string; // now in room B, sources from room A
const SLUG = 'r4c-e';

const text = (result: ToolResult) => result.content[0]?.text ?? '';
const ctx = (trust: string) => ({ org_id: f.orgId, employee_id: employee, employee_slug: SLUG, trust_level: trust }) as ToolContext;
const count = async (table: string) =>
  Number((await f.client.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [f.orgId])).rows[0].n);

async function addRoom(): Promise<string> {
  const id = randomUUID();
  await f.client.query("INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)",
    [id, f.orgId, `r4c-${id.slice(0, 8)}`, f.requesterId]);
  for (const user of [f.requesterId, f.adminId, shadow]) {
    await f.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), id, user]);
  }
  return id;
}

async function messageIn(spaceId: string): Promise<string> {
  const id = randomUUID();
  await f.client.query('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [id, f.orgId, spaceId, f.requesterId, `please record ${id.slice(0, 6)}`]);
  return id;
}

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('R4C');
  shadow = randomUUID();
  employee = randomUUID();
  await f.client.query(`INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, 'R4c agent', 'agent', true, true)`,
    [shadow, `r4c-${shadow}@example.test`]);
  await f.client.query("INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'member', true)",
    [randomUUID(), f.orgId, shadow]);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'R4c employee', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`,
    [employee, f.orgId, shadow, SLUG, f.adminId]);
  roomA = await addRoom();
  roomB = await addRoom();
  pageB = randomUUID();
  await f.client.query(
    `INSERT INTO wiki_pages (id, org_id, scope, type, title, slug, content, space_id, origin_space_id)
     VALUES ($1, $2, 'space', 'fact', 'R4c page', $3, 'Room B fact', $4, $4)`,
    [pageB, f.orgId, `r4c-page-${pageB.slice(0, 8)}`, roomB]);
  movedPage = randomUUID();
  await f.client.query(
    `INSERT INTO wiki_pages (id, org_id, scope, type, title, slug, content, space_id, origin_space_id)
     VALUES ($1, $2, 'space', 'fact', 'R4c moved', $3, 'Moved fact', $4, $5)`,
    [movedPage, f.orgId, `r4c-moved-${movedPage.slice(0, 8)}`, roomB, roomA]);
});

after(async () => {
  if (!f) return;
  await f.client.query('DELETE FROM space_members WHERE space_id = ANY($1::text[])', [[roomA, roomB]]).catch(() => undefined);
  await f.teardown();
});

test('a wiki proposal citing a message from another room is refused before anything is queued or written', { skip: !canRun, timeout: 300_000 }, async () => {
  const { wikiCreate, wikiUpdate } = await import('../src/lib/mcp-tools/wiki-create.js');
  const { requestHumanApproval } = await import('../src/lib/mcp-tools/cooperative.js');
  const fromA = await messageIn(roomA);
  const fromB = await messageIn(roomB);
  const before = [await count('agent_actions'), await count('wiki_pages')];
  // A page's sources come from the room it came from, not the room it is in now.
  const moved = await wikiUpdate({
    caller_employee_slug: SLUG, page_id: movedPage, patch: { content: 'x' }, source_message_id: fromB,
  } as any, ctx('conservative'));
  assert.equal(JSON.parse(text(moved)).code, 'WIKI_SOURCE_MESSAGE_ROOM', text(moved));
  for (const [action, params] of [
    ['wiki_create', { title: `R4c ask ${randomUUID().slice(0, 6)}`, content: 'x', scope: 'space', space_id: roomB, source_message_id: fromA }],
    ['wiki_update', { page_id: pageB, patch: { content: 'x' }, source_message_id: fromA }],
  ] as const) {
    const asked = await requestHumanApproval({ action, summary: 'Record it', params } as any, ctx('conservative'));
    assert.equal(JSON.parse(text(asked)).code, 'WIKI_SOURCE_MESSAGE_ROOM', `request_human_approval ${action}: ${text(asked)}`);
  }
  for (const trust of ['conservative', 'autonomous']) {
    const created = await wikiCreate({
      caller_employee_slug: SLUG, title: `R4c create ${randomUUID().slice(0, 6)}`, content: 'x', scope: 'space', space_id: roomB,
      source_message_id: fromA,
    } as any, ctx(trust));
    const updated = await wikiUpdate({
      caller_employee_slug: SLUG, page_id: pageB, patch: { content: `R4c update ${randomUUID()}` }, source_message_id: fromA,
    } as any, ctx(trust));
    for (const [label, result] of [['create', created], ['update', updated]] as const) {
      assert.equal(result.isError, true, `${trust} ${label}: ${text(result)}`);
      assert.equal(JSON.parse(text(result)).code, 'WIKI_SOURCE_MESSAGE_ROOM', `${trust} ${label}`);
    }
  }
  assert.deepEqual([await count('agent_actions'), await count('wiki_pages')], before, 'nothing queued or written');
  assert.equal((await f.client.query('SELECT content FROM wiki_pages WHERE id = $1', [pageB])).rows[0].content, 'Room B fact');
});

test('a wiki proposal citing a message from the page\'s room, or citing none, still queues', { skip: !canRun, timeout: 300_000 }, async () => {
  const { wikiCreate, wikiUpdate } = await import('../src/lib/mcp-tools/wiki-create.js');
  const fromB = await messageIn(roomB);
  for (const cite of [{ source_message_id: fromB }, {}]) {
    const created = await wikiCreate({
      caller_employee_slug: SLUG, title: `R4c ok ${randomUUID().slice(0, 6)}`, content: 'x', scope: 'space', space_id: roomB, ...cite,
    } as any, ctx('conservative'));
    const updated = await wikiUpdate({
      caller_employee_slug: SLUG, page_id: pageB, patch: { content: `R4c ok ${randomUUID()}` }, ...cite,
    } as any, ctx('conservative'));
    for (const result of [created, updated]) {
      assert.notEqual(result.isError, true, text(result));
      assert.equal(JSON.parse(text(result)).status, 'queued_for_approval');
    }
  }
  // A page moved to room B still takes its sources from room A.
  const moved = await wikiUpdate({
    caller_employee_slug: SLUG, page_id: movedPage, patch: { content: 'Moved again' }, source_message_id: await messageIn(roomA),
  } as any, ctx('conservative'));
  assert.equal(JSON.parse(text(moved)).status, 'queued_for_approval', text(moved));
  // An accepted cited proposal executes when approved.
  const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
  const approved = await approveAction(JSON.parse(text(moved)).approval_id, f.adminId);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  assert.equal((await f.client.query('SELECT content FROM wiki_pages WHERE id = $1', [movedPage])).rows[0].content, 'Moved again');
  // An empty source room is no room, as when the write runs.
  const emptyRoom = await wikiUpdate({
    caller_employee_slug: SLUG, page_id: pageB, patch: { content: 'x' }, source_space_id: '', source_message_id: await messageIn(roomA),
  } as any, ctx('conservative'));
  assert.equal(JSON.parse(text(emptyRoom)).status, 'queued_for_approval', text(emptyRoom));
  // A citation of a message from another room is still fine when the page has no room.
  const fromA = await messageIn(roomA);
  const orgPage = await wikiCreate({
    caller_employee_slug: SLUG, title: `R4c org ${randomUUID().slice(0, 6)}`, content: 'x', source_message_id: fromA,
  } as any, ctx('conservative'));
  assert.equal(JSON.parse(text(orgPage)).status, 'queued_for_approval', text(orgPage));
});
