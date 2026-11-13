/**
 * Items W2a3-3a..3d: reply-pipeline follow-ups.
 * 3a  note proposals bind a space note's visibility space to the note's org,
 *     and a space note may target an archived space the requester belongs to.
 * 3b  send_message refuses an ambiguous @alias before creating a DM space.
 * 3c  GET /api/messages/:spaceId returns a cursor that pages to older rows.
 * 3d  a reply job that fails for good posts one plain failure reply.
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
const otherOrgId = randomUUID();
const ids = { human: randomUUID(), peer: randomUUID(), twinA: randomUUID(), twinB: randomUUID() };
const spaceId = randomUUID();
const archivedSpaceId = randomUUID();
const otherOrgSpaceId = randomUUID();
const crossOrgNoteId = randomUUID();
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  for (const [id, name] of [[orgId, 'Followups'], [otherOrgId, 'Followups other']]) {
    await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [id, name, `followups-${id}`]);
  }
  for (const [key, id] of Object.entries(ids)) {
    const agent = key.startsWith('twin');
    await client.query('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,$4,$5)', [id, `${id}@example.test`, agent ? 'Twin' : key, agent ? 'agent' : 'human', agent]);
    await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,\'member\')', [randomUUID(), orgId, id]);
    if (agent) {
      await client.query(`INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,expertise_description,trust_level,is_active,is_byoa,runtime_kind,wake_mode,certification_status,created_by)
        VALUES($1,$2,$3,'Twin',$4,'custom','Test.','Test.','conservative',true,true,'custom_mcp','manual','token_issued',$5)`, [randomUUID(), orgId, id, `twin-${id.slice(0, 8)}`, ids.human]);
    }
  }
  await client.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,\'member\')', [randomUUID(), otherOrgId, ids.human]);
  await client.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,\'room\',\'public\',$3)', [spaceId, orgId, ids.human]);
  await client.query('INSERT INTO spaces(id,org_id,name,type,created_by,is_archived) VALUES($1,$2,\'old-room\',\'public\',$3,true)', [archivedSpaceId, orgId, ids.human]);
  await client.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,\'elsewhere\',\'private\',$3)', [otherOrgSpaceId, otherOrgId, ids.human]);
  for (const space of [spaceId, archivedSpaceId, otherOrgSpaceId]) {
    await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), space, ids.human]);
  }
  await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, ids.peer]);
  // A legacy note of this org whose visibility space belongs to another org.
  await client.query(`INSERT INTO notes(id,org_id,user_id,title,content,visibility,visibility_space_id)
    VALUES($1,$2,$3,'Peer note','Body','space',$4)`, [crossOrgNoteId, orgId, ids.peer, otherOrgSpaceId]);
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    for (const org of [orgId, otherOrgId]) {
      await client.query('DELETE FROM job_queue WHERE org_id=$1', [org]);
      await client.query('DELETE FROM notes WHERE org_id=$1', [org]);
      await client.query('DELETE FROM messages WHERE org_id=$1', [org]);
      await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [org]);
      await client.query('DELETE FROM spaces WHERE org_id=$1', [org]);
      await client.query('DELETE FROM agent_employees WHERE org_id=$1', [org]);
      await client.query('DELETE FROM org_members WHERE org_id=$1', [org]);
      await client.query('DELETE FROM orgs WHERE id=$1', [org]);
    }
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

test('W2a3-3a: a note promotion proposal requires the visibility space to be in the note\'s org', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { resolvePendingActionTargets } = await import('../src/workers/handlers/agent-reply.js');
  const resolved = await resolvePendingActionTargets(orgId, ids.human, spaceId, [{ action: 'note_to_wiki', params: { note_id: crossOrgNoteId } }]);
  assert.equal(resolved.actions.length, 0);
  assert.match(resolved.warnings.join(' '), /could not find that note/);
});

test('W2a3-3a: a space note proposal may target an archived space the requester belongs to', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { resolvePendingActionTargets } = await import('../src/workers/handlers/agent-reply.js');
  const resolved = await resolvePendingActionTargets(orgId, ids.human, spaceId, [{ action: 'create_note', params: { title: 'Kept', content: 'x', visibility: 'space', visibility_space_id: archivedSpaceId } }]);
  assert.equal(resolved.actions.length, 1, resolved.warnings.join(' '));
  const foreign = await resolvePendingActionTargets(orgId, ids.human, spaceId, [{ action: 'create_note', params: { title: 'No', content: 'x', visibility: 'space', visibility_space_id: otherOrgSpaceId } }]);
  assert.equal(foreign.actions.length, 0);
});

test('W2a3-3b: send_message keeps an ambiguous alias as plain text', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { humanSendMessage } = await import('../src/lib/mcp-tools/human.js');
  const result = await humanSendMessage({ target: { user_id: ids.peer }, content: '@twin can you take this', idempotency_key: randomUUID() } as any,
    { org_id: orgId, user_id: ids.human, role: 'member', scopes: ['read:workspace', 'read:messages', 'write:messages'] });
  assert.equal(Boolean(result.isError), false, String((result as any).content?.[0]?.text));
  assert.equal(JSON.parse(String((result as any).content[0].text)).content, '@twin can you take this');
});

test('W2a3-3c: following next_cursor pages to older top-level messages without overlap', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const pageSpace = randomUUID();
  await client!.query('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,\'pages\',\'public\',$3)', [pageSpace, orgId, ids.human]);
  await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), pageSpace, ids.human]);
  for (let i = 1; i <= 5; i += 1) {
    await client!.query(`INSERT INTO messages(id,org_id,space_id,user_id,content,created_at) VALUES($1,$2,$3,$4,$5, now() - ($6 || ' minutes')::interval)`,
      [randomUUID(), orgId, pageSpace, ids.human, `m${i}`, String(10 - i)]);
  }
  const { messageRoutes } = await import('../src/routes/messages.js');
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('user', { id: ids.human, org_id: orgId, role: 'member' } as any); await next(); });
  app.route('/api/messages', messageRoutes);
  const page = async (cursor?: string) => (await app.request(`/api/messages/${pageSpace}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json() as Promise<{ messages: Array<{ content: string }>; next_cursor: string | null }>;
  const first = await page();
  assert.deepEqual(first.messages.map((m) => m.content), ['m4', 'm5']);
  const second = await page(first.next_cursor!);
  assert.deepEqual(second.messages.map((m) => m.content), ['m2', 'm3']);
  const third = await page(second.next_cursor!);
  assert.deepEqual(third.messages.map((m) => m.content), ['m1']);
  assert.equal(third.next_cursor, null);
});

test('W2a3-3d: a reply job that fails for good posts one failure reply, never a second reply', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { failJob } = await import('../src/lib/queues.js');
  const trigger = randomUUID();
  await client!.query('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,\'@Defty summarize\')', [trigger, orgId, spaceId, ids.human]);
  const exhausted = async () => {
    const jobId = randomUUID();
    const token = randomUUID();
    await client!.query(`INSERT INTO job_queue(id,org_id,queue,name,data,status,attempts,max_attempts,lock_token,lock_expires_at,started_at)
      VALUES($1,$2,'agent-jobs','agent-reply',$3,'running',3,3,$4,now() + interval '1 minute',now())`,
      [jobId, orgId, JSON.stringify({ orgId, spaceId, messageId: trigger, userId: ids.human, orgName: 'Followups', content: '@Defty summarize' }), token]);
    assert.equal(await failJob(jobId, token, 'provider unavailable'), true);
  };
  await exhausted();
  const replies = async () => (await client!.query(`SELECT content, metadata FROM messages WHERE org_id=$1 AND metadata->>'reply_to_message_id'=$2`, [orgId, trigger])).rows;
  const first = await replies();
  assert.equal(first.length, 1);
  assert.match(first[0].content, /could not finish/i);
  await exhausted();
  assert.equal((await replies()).length, 1, 'the reply guard allows one reply per trigger');
});
