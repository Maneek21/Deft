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
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Reply delivery fence', `reply-fence-${orgId}`]);
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
  return { id: randomUUID(), name: 'agent-reply', attempts: 1, data: { orgId, spaceId, messageId, userId: ownerId, orgName: 'Reply delivery fence', content }, ...extra };
}
async function deftyReplies(spaceId: string) {
  return (await client!.query('SELECT id, content, metadata FROM messages WHERE space_id=$1 AND user_id NOT IN ($2,$3) ORDER BY created_at', [spaceId, ownerId, peerId])).rows;
}

test('A09: the job signal aborts the reasoning call and nothing is published', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const content = '@Defty long question';
  const triggerId = await message(spaceId, content);
  const controller = new AbortController();
  let sawAbort = false;
  const runQuery = (async (input: any) => {
    setTimeout(() => controller.abort(new Error('lost its job lease')), 20);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      input.abortSignal?.addEventListener('abort', () => { sawAbort = true; clearTimeout(timer); resolve(); }, { once: true });
    });
    return result('Late answer from a cancelled delivery');
  }) as any;
  await handleAgentReply(job(spaceId, triggerId, content, { signal: controller.signal }), { io: null, runQuery } as any)
    .catch(() => undefined);
  assert.equal(sawAbort, true, 'the reasoning call must observe the job signal');
  assert.equal((await deftyReplies(spaceId)).length, 0, 'a cancelled delivery must not publish');
});

test('A09: a delivery whose queue lease is no longer current does not publish', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const content = '@Defty anything new?';
  const triggerId = await message(spaceId, content);
  const jobId = randomUUID();
  // The queue row was reclaimed by another worker: a different lock token owns it.
  await client!.query(
    `INSERT INTO job_queue(id,org_id,queue,name,data,status,attempts,lock_token,lock_expires_at)
     VALUES($1,$2,'agent-jobs','agent-reply','{}'::jsonb,'running',2,$3,now() + interval '1 minute')`,
    [jobId, orgId, 'new-owner-token'],
  );
  await handleAgentReply({ ...job(spaceId, triggerId, content), id: jobId, lockToken: 'stale-owner-token' } as any,
    { io: null, runQuery: (async () => result('Stale answer')) as any } as any).catch(() => undefined);
  assert.equal((await deftyReplies(spaceId)).length, 0);
});

test('A09: a delivery that still owns its lease publishes normally', { skip: !url }, async (t) => {
  if (!ready) { t.skip(unavailable); return; }
  const spaceId = await space();
  const content = '@Defty hello';
  const triggerId = await message(spaceId, content);
  const jobId = randomUUID();
  await client!.query(
    `INSERT INTO job_queue(id,org_id,queue,name,data,status,attempts,lock_token,lock_expires_at)
     VALUES($1,$2,'agent-jobs','agent-reply','{}'::jsonb,'running',1,$3,now() + interval '1 minute')`,
    [jobId, orgId, 'owner-token'],
  );
  await handleAgentReply({ ...job(spaceId, triggerId, content), id: jobId, lockToken: 'owner-token', signal: new AbortController().signal } as any,
    { io: null, runQuery: (async () => result('Hello!')) as any } as any);
  assert.deepEqual((await deftyReplies(spaceId)).map((row) => row.content), ['Hello!']);
});
