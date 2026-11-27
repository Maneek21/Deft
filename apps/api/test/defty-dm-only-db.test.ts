/**
 * FIX158 option C (the stop-gap switch): Defty reads with the asker's access,
 * so it answers only in a 1:1 DM with the asker. In any conversation other
 * people can read (a room, a thread in a room, a group DM, a DM between two
 * people) it runs nothing and replies once: "ask me in a direct message".
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { DEFTY_SHARED_CONVERSATION_REPLY, handleAgentReply } from '../src/workers/handlers/agent-reply.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const run = randomUUID().replace(/-/g, '').slice(0, 8);
const org = randomUUID();
const owner = randomUUID(), mia = randomUUID(), gus = randomUUID(), left = randomUUID();
const publicRoom = randomUUID(), privateRoom = randomUUID(), groupDm = randomUUID(), humanDm = randomUUID();
const deftyDm = randomUUID(), soloRoom = randomUUID(), formerDm = randomUUID();
let client: pg.Client | undefined;
let unavailable: string | undefined;
let ready = false;
let deftyUser = '';
// The test runner turns answers in shared conversations back on for the other
// reply suites; this one tests the stop-gap itself.
const savedSwitch = process.env.DEFT_DEFTY_SHARED_ANSWERS;

async function q(text: string, values: unknown[] = []) {
  return client!.query(text, values);
}

async function room(id: string, type: string, members: string[]) {
  await q('INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, $4, $5)', [id, org, `${type}-${id.slice(0, 6)}`, type, owner]);
  for (const userId of members) await q('INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)', [id, userId]);
}

before(async () => {
  delete process.env.DEFT_DEFTY_SHARED_ANSWERS;
  if (!url) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await q('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [org, 'DM-only Org', `dm-only-${run}`]);
  for (const [id, role, active] of [[owner, 'owner', true], [mia, 'member', true], [gus, 'guest', true], [left, 'member', false]] as const) {
    await q(`INSERT INTO users (id, email, name, kind, is_agent) VALUES ($1, $2, $3, 'human', false)`, [id, `${role}-${id.slice(0, 6)}-${run}@dmonly.test`, `${role} ${run}`]);
    await q('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)', [org, id, role, active]);
  }
  deftyUser = await ensureDeftyMembership(org);
  await room(publicRoom, 'public', [owner, mia, gus, deftyUser]);
  await room(privateRoom, 'private', [owner, mia, deftyUser]);
  await room(groupDm, 'group_dm', [owner, mia, deftyUser]);
  await room(humanDm, 'dm', [owner, mia, deftyUser]);
  await room(deftyDm, 'dm', [owner, deftyUser]);
  await room(soloRoom, 'private', [owner, deftyUser]);
  // A DM with someone who has since left the workspace: only the asker reads it now.
  await room(formerDm, 'dm', [owner, left, deftyUser]);
  ready = true;
});

after(async () => {
  if (savedSwitch === undefined) delete process.env.DEFT_DEFTY_SHARED_ANSWERS;
  else process.env.DEFT_DEFTY_SHARED_ANSWERS = savedSwitch;
  if (ready && client) {
    await q('DELETE FROM job_queue WHERE org_id = $1', [org]).catch(() => {});
    await q('DELETE FROM agent_actions WHERE org_id = $1', [org]);
    await q('DELETE FROM messages WHERE org_id = $1', [org]);
    await q('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)', [org]);
    await q('DELETE FROM spaces WHERE org_id = $1', [org]);
    await q('DELETE FROM org_members WHERE org_id = $1', [org]);
    await q('DELETE FROM orgs WHERE id = $1', [org]);
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[owner, mia, gus, left]]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

const answer = (text: string) => ({ text, pendingActions: [], executedActions: [], citations: [], assistantBlocks: [], model: 'stub', tokensIn: 0, tokensOut: 0 });

async function ask(spaceId: string, content: string, extra: { parentId?: string; followed?: boolean } = {}) {
  const triggerId = randomUUID();
  await q('INSERT INTO messages (id, org_id, space_id, user_id, content, parent_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [triggerId, org, spaceId, owner, content, extra.parentId ?? null]);
  let runs = 0, compiles = 0;
  const runQuery = (async () => { runs += 1; return answer('The secret answer'); }) as any;
  const compileDraft = (async () => { compiles += 1; throw new Error('not expected'); }) as any;
  const job = { id: randomUUID(), name: 'agent-reply', attempts: 1, data: {
    orgId: org, spaceId, messageId: triggerId, userId: owner, orgName: 'DM-only Org', content,
    ...(extra.parentId ? { parentId: extra.parentId } : {}), ...(extra.followed ? { followed: true } : {}),
  } };
  await handleAgentReply(job as any, { io: null, runQuery, compileDraft } as any);
  const replies = (await q(`SELECT id, content, parent_id FROM messages WHERE org_id = $1 AND space_id = $2 AND user_id = $3
      AND metadata->>'reply_to_message_id' = $4`, [org, spaceId, deftyUser, triggerId])).rows;
  return { triggerId, runs, compiles, replies, job, runQuery };
}

describe('FIX158 C: Defty answers only in a 1:1 DM', { skip: !url }, () => {
  test('rooms, group DMs and DMs with another person get one fixed reply, and nothing runs', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    for (const [label, spaceId] of [['public room', publicRoom], ['private room', privateRoom], ['group DM', groupDm], ['DM with a person', humanDm]] as const) {
      const { triggerId, runs, compiles, replies } = await ask(spaceId, '@Defty summarize Launch pilot and mark LP-1 done');
      assert.equal(runs, 0, `${label}: Defty runs no reads`);
      assert.equal(compiles, 0, `${label}: Defty drafts no actions`);
      assert.equal(replies.length, 1, `${label}: one reply`);
      assert.equal(replies[0].content, DEFTY_SHARED_CONVERSATION_REPLY, `${label}: the fixed reply`);
      assert.match(replies[0].content, /direct message/i);
      if (spaceId === publicRoom || spaceId === privateRoom) assert.equal(replies[0].parent_id, triggerId, `${label}: threaded off the question`);
    }
    const pending = (await q('SELECT count(*)::int AS n FROM agent_actions WHERE org_id = $1', [org])).rows[0].n;
    assert.equal(pending, 0, 'no approval card is drafted in a shared conversation');
  });

  test('a thread in a room gets the fixed reply in the thread', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const rootId = randomUUID();
    await q('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)', [rootId, org, publicRoom, mia, 'How is it going?']);
    const { runs, replies } = await ask(publicRoom, '@Defty what is open?', { parentId: rootId });
    assert.equal(runs, 0);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].parent_id, rootId);
    assert.equal(replies[0].content, DEFTY_SHARED_CONVERSATION_REPLY);
  });

  test('a followed thread turn in a shared conversation stays silent', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const { runs, replies } = await ask(publicRoom, 'thanks all', { followed: true });
    assert.equal(runs, 0);
    assert.equal(replies.length, 0, 'no "ask me in a DM" on every followed message');
  });

  test('a redelivered job posts the fixed reply once', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const first = await ask(groupDm, '@Defty status?');
    await handleAgentReply(first.job as any, { io: null, runQuery: first.runQuery } as any);
    const replies = (await q(`SELECT id FROM messages WHERE org_id = $1 AND space_id = $2 AND user_id = $3 AND metadata->>'reply_to_message_id' = $4`,
      [org, groupDm, deftyUser, first.triggerId])).rows;
    assert.equal(replies.length, 1);
  });

  test('DEFT_DEFTY_SHARED_ANSWERS=on restores answers in shared conversations', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    process.env.DEFT_DEFTY_SHARED_ANSWERS = 'on';
    try {
      const { runs, replies } = await ask(privateRoom, '@Defty what is open?');
      assert.equal(runs, 1);
      assert.equal(replies[0]?.content, 'The secret answer');
    } finally {
      delete process.env.DEFT_DEFTY_SHARED_ANSWERS;
    }
  });

  test('a 1:1 DM with Defty answers as today, and so does a room only the asker reads', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    for (const spaceId of [deftyDm, soloRoom, formerDm]) {
      const { runs, replies } = await ask(spaceId, '@Defty what is in Launch pilot?');
      assert.equal(runs, 1, 'Defty runs');
      assert.equal(replies.length, 1);
      assert.equal(replies[0].content, 'The secret answer');
    }
  });
});
