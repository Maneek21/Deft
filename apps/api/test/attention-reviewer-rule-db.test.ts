/**
 * The review gate, its assignment rule and Attention agree on who reviews an
 * agent action: a Defty action named after a chat message is reviewed only by
 * someone who can still read that message's room; an assignment narrows the
 * reviewers only while its assignee still passes the room check; Attention
 * serves, counts and delivers approval items to exactly the users the gate
 * accepts, holds back items of users it no longer accepts, and maintenance
 * resolves those.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const ids = {
  owner: randomUUID(), admin: randomUUID(), admin2: randomUUID(), requester: randomUUID(), departed: randomUUID(),
};
const roles: Record<string, string> = {
  [ids.owner]: 'owner', [ids.admin]: 'admin', [ids.admin2]: 'admin', [ids.requester]: 'member', [ids.departed]: 'member',
};
const rooms = { anchor: randomUUID(), fallback: randomUUID(), capture: randomUUID() };
const a = {
  anchored: randomUUID(), ord: randomUUID(), strandedAssign: randomUUID(), keptAssign: randomUUID(), capture: randomUUID(),
};
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let routes: Record<string, Hono> = {};

const q = (text: string, values: unknown[] = []) => client!.query(text, values);

async function request(viewerId: string, mount: string, path: string, init?: RequestInit) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: viewerId, org_id: orgId, email: `${viewerId}@example.test`, role: roles[viewerId] } as any);
    await next();
  });
  hono.route(mount, routes[mount]!);
  return hono.request(`${mount}${path}`, init);
}

async function room(id: string, members: string[]) {
  await q("INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,'private',$4)", [id, orgId, `room-${id}`, ids.admin]);
  for (const user of members) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, user]);
  const message = randomUUID();
  await q("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'@Defty please')", [message, orgId, id, members[0]]);
  return message;
}

const leave = (space: string, user: string) => q('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [space, user]);
const join = (space: string, user: string) => q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), space, user]);

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Reviewer rule', `reviewer-rule-${orgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    await q("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)", [id, `${id}@example.test`, name]);
    await q('INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,$4,$5)', [randomUUID(), orgId, id, roles[id], id !== ids.departed]);
  }
  const anchorMessage = await room(rooms.anchor, [ids.requester]);
  const fallbackMessage = await room(rooms.fallback, [ids.departed, ids.admin, ids.admin2]);
  await room(rooms.capture, [ids.requester]);
  const insert = (id: string, user: string, params: Record<string, unknown>, messageId: string | null, source = 'mention') => q(
    `INSERT INTO agent_actions(id,org_id,user_id,action,params,approval_tier,approval_status,source,message_id)
     VALUES($1,$2,$3,'create_task',$4,'quick','pending',$5,$6)`, [id, orgId, user, JSON.stringify(params), source, messageId]);
  await insert(a.anchored, ids.requester, { title: 'ANCHORED' }, anchorMessage);
  await insert(a.ord, ids.requester, { title: 'ORD' }, null);
  // No active human requester: owners/admins in the room review; one assignment each.
  await insert(a.strandedAssign, ids.departed, { title: 'STRANDED' }, fallbackMessage);
  await insert(a.keptAssign, ids.departed, { title: 'KEPT' }, fallbackMessage);
  await insert(a.capture, ids.requester, { title: 'CAPTURE', source_user_id: ids.requester, source_space_id: rooms.capture }, null, 'defty_capture');
  for (const action of [a.strandedAssign, a.keptAssign]) {
    await q('INSERT INTO agent_action_approvers(id,org_id,action_id,user_id) VALUES($1,$2,$3,$4)', [randomUUID(), orgId, action, ids.admin2]);
  }
  routes = {
    '/api/attention': (await import('../src/routes/attention.js')).attentionRoutes,
    '/api/agent': (await import('../src/routes/agent.js')).agentRoutes,
    '/api/inbox': (await import('../src/routes/inbox.js')).inboxRoutes,
  };
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    await q('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    for (const table of ['attention_deliveries', 'attention_events', 'attention_items', 'agent_action_approvers', 'agent_actions', 'messages', 'notifications', 'spaces', 'agent_employees', 'org_members']) {
      await q(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
    }
    await q('DELETE FROM orgs WHERE id=$1', [orgId]);
    await q('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

/** Pending action ids each viewer may review, straight from the review gate. */
async function gateSet(viewer: string): Promise<string[]> {
  const { reviewableActionSql } = await import('../src/lib/agent-action-review-gate.js');
  const { db } = await import('../src/lib/db.js');
  const { agentActions } = await import('@deft/db/schema');
  const { and, eq } = await import('drizzle-orm');
  const rows = await db.select({ id: agentActions.id }).from(agentActions).where(and(
    eq(agentActions.org_id, orgId), eq(agentActions.approval_status, 'pending'),
    reviewableActionSql({ id: viewer, org_id: orgId, role: roles[viewer] }),
  ));
  return rows.map((row) => row.id).sort();
}

type AttentionBody = { items: Array<{ source_type: string; source_id: string }>; counts: { needs_you: { count: number } } };
async function attentionSet(viewer: string) {
  const response = await request(viewer, '/api/attention', '?lane=needs_you&limit=100');
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as AttentionBody;
  const items = body.items.filter((item) => item.source_type === 'agent_action').map((item) => item.source_id).sort();
  return { items, count: body.counts.needs_you.count };
}

const approveAs = (viewer: string, id: string, step: 'approve' | 'reject') => request(viewer, '/api/agent', `/actions/${id}/${step}`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

test('AL2b-C: a Defty action named after a message is reviewed only by someone who can still read its room', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { viewerReviewAuthority } = await import('../src/lib/agent-approval-resolver.js');
  const viewer = { id: ids.requester, org_id: orgId, role: 'member' };
  assert.equal((await gateSet(ids.requester)).includes(a.anchored), true, 'the requester in the room reviews it');
  await leave(rooms.anchor, ids.requester);
  try {
    assert.equal((await gateSet(ids.requester)).includes(a.anchored), false);
    assert.deepEqual((await viewerReviewAuthority(viewer, [a.anchored])).get(a.anchored), { viewer_can_approve: false, viewer_can_reject: false });
    for (const step of ['approve', 'reject'] as const) assert.equal((await approveAs(ids.requester, a.anchored, step)).status, 404, step);
    const inbox = JSON.stringify(await (await request(ids.requester, '/api/inbox', '?kind=pending_approval')).json());
    assert.equal(inbox.includes(a.anchored), false, 'the Inbox does not list it');
    const [row] = (await q('SELECT approval_status FROM agent_actions WHERE id=$1', [a.anchored])).rows;
    assert.equal(row.approval_status, 'pending');
  } finally {
    await join(rooms.anchor, ids.requester);
  }
});

test('AL2b-A: an assignment narrows the reviewers only while its assignee still passes the room check', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const viewer of [ids.admin, ids.admin2]) {
    for (const action of [a.strandedAssign, a.keptAssign]) {
      assert.equal((await gateSet(viewer)).includes(action), viewer === ids.admin2, 'the qualifying assignee narrows');
    }
  }
  await leave(rooms.fallback, ids.admin2);
  try {
    assert.equal((await gateSet(ids.admin)).includes(a.strandedAssign), true, 'the in-room admin reviews once the assignee lost the room');
    assert.equal((await gateSet(ids.admin2)).includes(a.strandedAssign), false);
    assert.equal((await gateSet(ids.owner)).includes(a.strandedAssign), false, 'an owner outside the room does not');
  } finally {
    await join(rooms.fallback, ids.admin2);
  }
  assert.equal((await gateSet(ids.admin)).includes(a.keptAssign), false, 'an assignee who still qualifies still narrows');
});

test('AL2b-B: Attention list, count and delivery checks match the review gate', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // Items as raised under an earlier rule, for users the gate does not accept.
  for (const user of [ids.owner, ids.admin]) {
    await q(`INSERT INTO attention_items(id,org_id,user_id,lane,kind,dedupe_key,source_type,source_id,source_event_id,title,state,last_event_at)
      VALUES($1,$2,$3,'needs_you','approval',$4,'agent_action',$5,$6,'Review create task','open_unseen',now())`,
    [randomUUID(), orgId, user, `approval:${a.ord}`, a.ord, `approval-requested:${a.ord}`]);
  }
  await leave(rooms.capture, ids.requester);
  try {
    for (const viewer of [ids.requester, ids.owner, ids.admin, ids.admin2]) {
      const expected = await gateSet(viewer);
      const got = await attentionSet(viewer);
      assert.deepEqual(got.items, expected, `${roles[viewer]} ${viewer.slice(0, 4)} list`);
      assert.equal(got.count, expected.length, `${roles[viewer]} count`);
    }
    assert.equal((await gateSet(ids.requester)).includes(a.capture), false, 'a requester who lost the capture room');

    const { attentionItemStillVisible, filterVisibleAttentionItems, transitionAttentionItem, resolveApprovalItemsWithoutReviewer } = await import('../src/lib/attention.js');
    const [stale] = (await q('SELECT * FROM attention_items WHERE org_id=$1 AND user_id=$2 AND source_id=$3', [orgId, ids.owner, a.ord])).rows;
    assert.deepEqual(await filterVisibleAttentionItems(ids.owner, [stale]), [], 'delivery holds the item back');
    assert.equal(await attentionItemStillVisible(stale), false, 'the check before send refuses it');
    const held = (await q('SELECT state FROM attention_items WHERE id=$1', [stale.id])).rows[0];
    assert.equal(held.state, 'open_unseen', 'holding back does not close the item');
    assert.equal(await transitionAttentionItem({ orgId, userId: ids.owner, itemId: stale.id, state: 'open_seen', viewerId: ids.owner }), null,
      'a user change to an item they cannot open does not apply');
    const [own] = (await q('SELECT * FROM attention_items WHERE org_id=$1 AND user_id=$2 AND source_id=$3', [orgId, ids.requester, a.ord])).rows;
    assert.equal(await attentionItemStillVisible(own), true);

    await resolveApprovalItemsWithoutReviewer();
    const states = (await q(`SELECT user_id, state, resolution FROM attention_items WHERE org_id=$1 AND source_id=$2`, [orgId, a.ord])).rows;
    for (const row of states) {
      assert.equal(row.state === 'resolved', row.user_id !== ids.requester, `maintenance for ${roles[row.user_id]}`);
    }
  } finally {
    await join(rooms.capture, ids.requester);
  }
});

test('AL2b-D: an approval item closed for lost access opens again when the access returns; a dismissed one does not', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { resolveApprovalItemsWithoutReviewer, transitionAttentionItem } = await import('../src/lib/attention.js');
  assert.equal((await attentionSet(ids.requester)).items.includes(a.anchored), true);
  const [dismissed] = (await q('SELECT id FROM attention_items WHERE org_id=$1 AND user_id=$2 AND source_id=$3', [orgId, ids.requester, a.ord])).rows;
  await transitionAttentionItem({ orgId, userId: ids.requester, itemId: dismissed.id, state: 'resolved', resolution: 'dismissed' });
  await leave(rooms.anchor, ids.requester);
  try {
    await resolveApprovalItemsWithoutReviewer();
    const [closed] = (await q('SELECT state, resolution FROM attention_items WHERE org_id=$1 AND user_id=$2 AND source_id=$3', [orgId, ids.requester, a.anchored])).rows;
    assert.deepEqual(closed, { state: 'resolved', resolution: 'source_access_removed' });
  } finally {
    await join(rooms.anchor, ids.requester);
  }
  const back = await attentionSet(ids.requester);
  assert.equal(back.items.includes(a.anchored), true, 'the pending approval is back in needs-you');
  assert.equal(back.items.includes(a.ord), false, 'a dismissed item stays closed');
});
