import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { handleAgentReply } from '../src/workers/handlers/agent-reply.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID(), ownerId = randomUUID(), peerId = randomUUID();
let client: pg.Client | undefined;
let unavailable: string | undefined;
let ready = false;
const result = (text: string) => ({ text, pendingActions: [], executedActions: [], citations: [], assistantBlocks: [], model: 'stub', tokensIn: 0, tokensOut: 0 });

before(async () => {
  if (!url) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Reply lifecycle', `reply-lifecycle-${orgId}`]);
  for (const [id, name] of [[ownerId, 'Priya Shah'], [peerId, 'Rahul Mehta']]) {
    await client.query('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,\'human\',false)', [id, `${id}@example.test`, name]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,\'owner\')', [randomUUID(), orgId, id]);
  }
  ready = true;
});

after(async () => {
  if (ready && client) {
    await client.query('DELETE FROM job_queue WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_actions WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM agent_employees WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[ownerId, peerId]]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

async function space() {
  const id = randomUUID();
  await client!.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,\'public\',$4)', [id, orgId, `room-${id}`, ownerId]);
  for (const userId of [ownerId, peerId]) await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, userId]);
  return id;
}
async function message(spaceId: string, content: string) {
  const id = randomUUID();
  await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)', [id, orgId, spaceId, ownerId, content]);
  return id;
}
function job(spaceId: string, messageId: string, content: string, extra: Record<string, unknown> = {}) {
  return { id: randomUUID(), name: 'agent-reply', attempts: 1, data: { orgId, spaceId, messageId, userId: ownerId, orgName: 'Reply lifecycle', content }, ...extra };
}
async function deftyReplies(spaceId: string) {
  return (await client!.query('SELECT id, content, metadata FROM messages WHERE space_id=$1 AND user_id NOT IN ($2,$3) ORDER BY created_at', [spaceId, ownerId, peerId])).rows;
}

test('A05: a failure after the reply commits does not post a second reply on retry', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const content = '@Defty what changed today?';
  const triggerId = await message(spaceId, content);
  const failingIo = { to() { return { emit(event: string) { if (event === 'message:new') throw new Error('socket adapter down'); } }; } };
  let calls = 0;
  const runQuery = (async () => { calls += 1; return result(`Answer ${calls}`); }) as any;
  // First delivery: the reply commits, then the broadcast throws.
  await handleAgentReply(job(spaceId, triggerId, content), { io: failingIo, runQuery } as any).catch(() => undefined);
  // The queue retries the same trigger.
  await handleAgentReply(job(spaceId, triggerId, content), { io: null, runQuery } as any);
  const replies = await deftyReplies(spaceId);
  assert.equal(replies.length, 1, 'one trigger must produce one Defty reply');
  assert.equal(replies[0].metadata.reply_to_message_id, triggerId);
});

test('A05: a post-commit broadcast failure does not fail the job', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const content = '@Defty status?';
  const triggerId = await message(spaceId, content);
  const failingIo = { to() { return { emit(event: string) { if (event === 'message:new') throw new Error('socket adapter down'); } }; } };
  await handleAgentReply(job(spaceId, triggerId, content), { io: failingIo, runQuery: (async () => result('All good.')) as any } as any);
  assert.equal((await deftyReplies(spaceId)).length, 1);
});

test('A05: two concurrent deliveries of one trigger post exactly one reply', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const content = '@Defty summarize';
  const triggerId = await message(spaceId, content);
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const runQuery = (async () => {
    arrived += 1;
    if (arrived === 2) release();
    await barrier;
    return result(`Summary from run ${arrived}`);
  }) as any;
  await Promise.all([
    handleAgentReply(job(spaceId, triggerId, content), { io: null, runQuery } as any),
    handleAgentReply(job(spaceId, triggerId, content), { io: null, runQuery } as any),
  ]);
  assert.equal(arrived, 2, 'both deliveries reached generation');
  assert.equal((await deftyReplies(spaceId)).length, 1);
});

