/**
 * FIX158: Defty reads with the asker's access, but answers to an audience:
 * everyone who can read the conversation. Found live on release 157: in a
 * public room the owner asked Defty about a project and its threaded reply
 * named a restricted task; a member and a guest read that reply, and both get
 * 404 on the task itself.
 *
 * In a conversation others can read (a room, a thread in a room, a group DM,
 * a DM between two people) Defty uses only records every reader can see, and
 * says when it left something out. A 1:1 DM with Defty behaves as before.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { closeDb } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { runAgentQuery } from '../src/lib/agent-runner.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { handleAgentReply } from '../src/workers/handlers/agent-reply.js';
import { messageRoutes } from '../src/routes/messages.js';
import { taskRoutes } from '../src/routes/tasks.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const run = randomUUID().replace(/-/g, '').slice(0, 8);
const org = randomUUID();
const owner = randomUUID(), mia = randomUUID(), gus = randomUUID(), agentUser = randomUUID(), employee = randomUUID();
const project = randomUUID(), otherProject = randomUUID();
const prefix = `LQ${run.slice(0, 3).toUpperCase()}`;
const openTitle = `Open roadmap zq${run}`;
const restrictedTitle = `Salary bands zq${run}`;
const restrictedKey = `${prefix}-2`;
const openTask = randomUUID(), restrictedTask = randomUUID();
const publicRoom = randomUUID(), privateRoom = randomUUID(), groupDm = randomUUID(), deftyDm = randomUUID();
const humanDm = randomUUID(), agentRoom = randomUUID(), secretRoom = randomUUID();
const secretMessage = `zqsecretmsg${run}`;
const privateNote = randomUUID();
const noteCanary = `zqnote${run}`;
const wikiCanary = `zqwiki${run}`;
/** The fixed line Defty adds when it held something back. */
const LEFT_OUT = 'Some items were left out because not everyone here can see them.';

let client: pg.Client | undefined;
let unavailable: string | undefined;
let ready = false;
let deftyUser = '';

const people: Array<[string, string, 'owner' | 'member' | 'guest']> = [
  [owner, 'Olu Owner', 'owner'],
  [mia, 'Mia Member', 'member'],
  [gus, 'Gus Guest', 'guest'],
];

async function q(text: string, values: unknown[] = []) {
  return client!.query(text, values);
}

async function room(id: string, type: string, name: string, members: string[]) {
  await q('INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, $4, $5)', [id, org, name, type, owner]);
  for (const userId of members) {
    await q('INSERT INTO space_members (id, space_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)', [id, userId]);
  }
}

before(async () => {
  if (!url) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await q('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [org, 'Audience Org', `audience-${run}`]);
  for (const [id, name, role] of people) {
    await q(`INSERT INTO users (id, email, name, kind, is_agent) VALUES ($1, $2, $3, 'human', false)`, [id, `${role}-${run}@audience.test`, name]);
    await q('INSERT INTO org_members (id, org_id, user_id, role) VALUES (gen_random_uuid()::text, $1, $2, $3)', [org, id, role]);
  }
  // A BYOA agent employee; the agent test limits it to the other project.
  await q(`INSERT INTO users (id, email, name, kind, is_agent) VALUES ($1, $2, 'Ada Agent', 'agent', true)`, [agentUser, `agent-${run}@audience.test`]);
  await q(`INSERT INTO org_members (id, org_id, user_id, role) VALUES (gen_random_uuid()::text, $1, $2, 'member')`, [org, agentUser]);
  await q(`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, max_daily_actions,
      daily_action_count, created_by, is_active, is_deleted, project_ids)
    VALUES ($1, $2, $3, 'Ada Agent', $4, 'custom', 'test', 'standard', 50, 0, $5, true, false, $6::text[])`,
  [employee, org, agentUser, `ada-${run}`, owner, []]);
  deftyUser = await ensureDeftyMembership(org);

  await room(publicRoom, 'public', `open-${run}`, [owner, mia, gus, deftyUser]);
  await room(privateRoom, 'private', `closed-${run}`, [owner, mia, deftyUser]);
  await room(groupDm, 'group_dm', `group-${run}`, [owner, mia, deftyUser]);
  await room(deftyDm, 'dm', `defty-dm-${run}`, [owner, deftyUser]);
  await room(humanDm, 'dm', `human-dm-${run}`, [owner, mia, deftyUser]);
  await room(agentRoom, 'private', `agents-${run}`, [owner, agentUser, deftyUser]);
  await room(secretRoom, 'private', `secret-${run}`, [owner, mia]);

  await q(`INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, $3, $4, null, 10), ($5, $2, $6, $7, null, 10)`,
    [project, org, `Launch pilot ${run}`, prefix, otherProject, `Other ${run}`, `LR${run.slice(0, 3).toUpperCase()}`]);
  // The project is linked to the public room, so the guest there sees its open tasks.
  await q('INSERT INTO project_spaces (id, project_id, space_id) VALUES (gen_random_uuid()::text, $1, $2)', [project, publicRoom]);
  const restricted = JSON.stringify({ visibility: 'restricted', visible_user_ids: [] });
  await q(`INSERT INTO tasks (id, org_id, project_id, number, title, description, created_by, assignee_id, metadata, status, priority)
    VALUES ($1, $2, $3, 1, $4, 'open work', $5, $6, null, 'todo', 'p2'),
           ($7, $2, $3, 2, $8, 'pay review', $5, null, $9::jsonb, 'todo', 'p1')`,
  [openTask, org, project, openTitle, owner, mia, restrictedTask, restrictedTitle, restricted]);

  await q(`INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`,
    [org, secretRoom, owner, `The ${secretMessage} plan zq${run}`]);
  await q(`INSERT INTO notes (id, org_id, user_id, title, content, visibility) VALUES ($1, $2, $3, $4, $5, 'private')`,
    [privateNote, org, owner, `Owner note zq${run}`, noteCanary]);
  await q(`INSERT INTO wiki_pages (id, org_id, scope, user_id, type, title, slug, content)
    VALUES (gen_random_uuid()::text, $1, 'user', $2, 'concept', $3, $4, $5)`,
  [org, owner, `Owner wiki zq${run}`, `owner-wiki-${run}`, `The owner's plan is ${wikiCanary}.`]);
  ready = true;
});

after(async () => {
  if (ready && client) {
    await q('DELETE FROM job_queue WHERE org_id = $1', [org]).catch(() => {});
    await q('DELETE FROM agent_actions WHERE org_id = $1', [org]);
    await q('DELETE FROM messages WHERE org_id = $1', [org]);
    await q('DELETE FROM wiki_pages WHERE org_id = $1', [org]);
    await q('DELETE FROM notes WHERE org_id = $1', [org]);
    await q('DELETE FROM tasks WHERE org_id = $1', [org]);
    await q('DELETE FROM project_spaces WHERE project_id IN (SELECT id FROM projects WHERE org_id = $1)', [org]);
    await q('DELETE FROM projects WHERE org_id = $1', [org]);
    await q('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)', [org]);
    await q('DELETE FROM spaces WHERE org_id = $1', [org]);
    await q('DELETE FROM agent_employees WHERE org_id = $1', [org]);
    await q('DELETE FROM org_members WHERE org_id = $1', [org]);
    await q('DELETE FROM orgs WHERE id = $1', [org]);
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[owner, mia, gus, agentUser]]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

const text = (value: unknown) => JSON.stringify(value) ?? '';
const leaksRestricted = (value: string) => value.includes(restrictedTitle) || value.includes(restrictedKey) || value.includes(restrictedTask);

function readerApp(viewer: string) {
  const role = people.find(([id]) => id === viewer)![2];
  const hono = new Hono();
  hono.use('*', async (ctx, next) => {
    // A guest's session claims 'member': only org_members makes them a guest.
    ctx.set('user', { id: viewer, org_id: org, email: `${role}-${run}@audience.test`, sid: 's', role: role === 'guest' ? 'member' : role } as never);
    await next();
  });
  hono.route('/api/messages', messageRoutes);
  hono.route('/api/tasks', taskRoutes);
  return hono;
}

/** What `viewer` reads in the thread under `rootId`, through the API. */
async function threadAs(viewer: string, rootId: string): Promise<{ status: number; body: string }> {
  const res = await readerApp(viewer).request(`/api/messages/${rootId}/thread`);
  return { status: res.status, body: await res.text() };
}

/**
 * Runs Defty's reply for `content` in `spaceId` with a provider stand-in that
 * calls `toolName` once and then repeats every tool result word for word, as a
 * model summarising its reads would. Returns every provider request body.
 */
async function deftyReply(t: any, input: { spaceId: string; content: string; toolName: string; toolInput: Record<string, unknown>; parentId?: string }) {
  const triggerId = randomUUID();
  await q('INSERT INTO messages (id, org_id, space_id, user_id, content, parent_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [triggerId, org, input.spaceId, owner, input.content, input.parentId ?? null]);
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_URL'] as const;
  const savedEnv = Object.fromEntries(keys.map((key) => [key, env[key]]));
  const savedProcess = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const configured = { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'test', OPENROUTER_API_KEY: '', OLLAMA_URL: '' };
  Object.assign(env, configured); Object.assign(process.env, configured);
  const bodies: string[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (address: unknown, init?: RequestInit) => {
    if (String(address).includes('/embeddings')) return Response.json({ data: [{ embedding: Array(1536).fill(0) }] });
    const body = typeof init?.body === 'string' ? init.body : '';
    bodies.push(body);
    let parsed: any = {};
    try { parsed = JSON.parse(body); } catch { parsed = {}; }
    const items: any[] = Array.isArray(parsed.input) ? parsed.input : [];
    const outputs = items.filter((item) => item?.type === 'function_call_output').map((item) => String(item.output));
    const offersTool = Array.isArray(parsed.tools) && parsed.tools.some((tool: any) => tool?.name === input.toolName);
    const reply = (words: string) => Response.json({ status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: words }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    if (outputs.length > 0) return reply(`Here is what I found: ${outputs.join('\n')}`);
    if (offersTool) {
      return Response.json({ status: 'completed', output: [{ type: 'function_call', name: input.toolName, call_id: `call-${randomUUID()}`,
        arguments: JSON.stringify(input.toolInput) }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    return reply('ok');
  });
  try {
    const runQuery = ((params: Parameters<typeof runAgentQuery>[0]) => runAgentQuery({ ...params, skipVerification: true, maxIterations: 2 })) as any;
    await handleAgentReply({ id: randomUUID(), name: 'agent-reply', attempts: 1, data: {
      orgId: org, spaceId: input.spaceId, messageId: triggerId, userId: owner, orgName: 'Audience Org', content: input.content,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    } } as any, { io: null, runQuery } as any);
  } finally {
    fetchMock.mock.restore();
    Object.assign(env, savedEnv);
    for (const key of keys) {
      if (savedProcess[key] === undefined) delete process.env[key];
      else process.env[key] = savedProcess[key];
    }
  }
  const replies = (await q(`SELECT id, content, parent_id FROM messages WHERE org_id = $1 AND space_id = $2 AND user_id = $3
      AND created_at >= (SELECT created_at FROM messages WHERE id = $4) ORDER BY created_at`, [org, input.spaceId, deftyUser, triggerId])).rows;
  return { triggerId, bodies, replies };
}

const tool = (name: string, params: Record<string, unknown>, conversationId?: string) =>
  executeToolCall(name, params, org, owner, conversationId);

describe('FIX158 Defty answers to its audience', { skip: !url }, () => {
  test('public room: the reply a member and a guest read names no restricted task, and says something was left out', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    // Someone named the restricted task in the room earlier: the room context must not resolve it either.
    await q('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES (gen_random_uuid()::text, $1, $2, $3, $4)',
      [org, publicRoom, owner, `Reminder: ${restrictedKey} is due Friday`]);
    const { triggerId, bodies, replies } = await deftyReply(t, {
      spaceId: publicRoom, content: `@Defty summarize Launch pilot ${run}`,
      toolName: 'search_tasks', toolInput: { project_name: `Launch pilot ${run}` },
    });
    assert.equal(replies.length, 1, 'Defty replied once');
    assert.equal(replies[0].parent_id, triggerId, 'in a room the reply is threaded off the question');
    for (const viewer of [mia, gus]) {
      const who = viewer === mia ? 'member' : 'guest';
      const task = await readerApp(viewer).request(`/api/tasks/${restrictedTask}`);
      assert.equal(task.status, 404, `the ${who} cannot open the restricted task itself`);
      const read = await threadAs(viewer, triggerId);
      assert.equal(read.status, 200, `the ${who} can read the thread`);
      assert.ok(!leaksRestricted(read.body), `the ${who} must not read the restricted task through Defty's reply`);
      assert.ok(read.body.includes(openTitle), 'tasks everyone here can see are still answered');
      assert.ok(read.body.includes(LEFT_OUT), 'the reply says something was left out');
    }
    assert.ok(!bodies.some((body) => body.includes(restrictedTitle)), 'the model is never shown the restricted task in a shared room');
  });

  test('thread in a room: a threaded question is answered to the room\'s readers', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const rootId = randomUUID();
    await q('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
      [rootId, org, publicRoom, mia, 'How is the pilot going?']);
    const { bodies, replies } = await deftyReply(t, {
      spaceId: publicRoom, parentId: rootId, content: `@Defty what is open in Launch pilot ${run}?`,
      toolName: 'search_tasks', toolInput: { query: `zq${run}` },
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].parent_id, rootId, 'the reply stays in the thread');
    assert.ok(!bodies.some((body) => body.includes(restrictedTitle)));
    const read = await threadAs(gus, rootId);
    assert.equal(read.status, 200);
    assert.ok(!leaksRestricted(read.body), 'the guest must not read the restricted task in the thread');
    assert.ok(read.body.includes(openTitle));
  });

  test('private room, group DM and a DM between two people are shared: the restricted task is held back', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    for (const [label, conversation] of [['private room', privateRoom], ['group DM', groupDm], ['DM with a person', humanDm]] as const) {
      const search = await tool('search_tasks', { query: `zq${run}` }, conversation);
      assert.ok(!leaksRestricted(text(search)), `${label}: search_tasks must not return the restricted task`);
      assert.ok(text(search).includes(openTitle), `${label}: an open task is still found`);
      const detail = await tool('get_task_detail', { task_identifier: restrictedKey }, conversation);
      assert.ok(!text(detail).includes(restrictedTitle), `${label}: get_task_detail must not name the restricted task`);
      const progress = await tool('get_project_progress', { project_name: `Launch pilot ${run}` }, conversation);
      assert.ok(!leaksRestricted(text(progress)), `${label}: project progress must not name the restricted task`);
      assert.equal((progress.result as any)?.total_tasks ?? (progress.result as any)?.total, 1, `${label}: counts include only what everyone can see`);
    }
  });

  test('a 1:1 DM with Defty behaves exactly as today: the asker sees their restricted task', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const search = await tool('search_tasks', { query: `zq${run}` }, deftyDm);
    assert.ok(text(search).includes(restrictedTitle), 'the asker alone reads their own restricted task');
    const detail = await tool('get_task_detail', { task_identifier: restrictedKey }, deftyDm);
    assert.ok(text(detail).includes(restrictedTitle));
    const workload = await tool('get_team_workload', {}, deftyDm);
    assert.ok(!text(workload).includes('SHARED_CONVERSATION'), 'no tool is refused in a private DM');
    const { replies } = await deftyReply(t, {
      spaceId: deftyDm, content: `@Defty what is in Launch pilot ${run}?`, toolName: 'search_tasks', toolInput: { query: `zq${run}` },
    });
    assert.equal(replies.length, 1);
    assert.ok(replies[0].content.includes(restrictedTitle), 'the DM answer still names the asker\'s restricted task');
    assert.ok(!replies[0].content.includes(LEFT_OUT), 'nothing is left out in a private DM');
  });

  test('an agent member counts as a reader, with its own project scope', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const unscoped = await tool('search_tasks', { query: `zq${run}` }, agentRoom);
    assert.ok(!leaksRestricted(text(unscoped)), 'the restricted task is held back from the agent');
    assert.ok(text(unscoped).includes(openTitle), 'an agent with no project limit sees the open task');
    // Limited to the other project, the agent cannot see even the open task.
    await q('UPDATE agent_employees SET project_ids = $2::text[] WHERE id = $1', [employee, [otherProject]]);
    try {
      const scoped = await tool('search_tasks', { query: `zq${run}` }, agentRoom);
      assert.ok(!text(scoped).includes(openTitle), 'a task outside the agent\'s project scope is held back');
      // An agent reads any active public room through its MCP tools, so it is a reader there too.
      const publicScoped = await tool('search_tasks', { query: `zq${run}` }, publicRoom);
      assert.ok(!text(publicScoped).includes(openTitle), 'the agent is a reader of a public room it has not joined');
      // A paused employee reads nothing now: its agent is not a reader, and
      // with only the asker reading, the room answers as a private DM does.
      await q('UPDATE agent_employees SET is_active = false WHERE id = $1', [employee]);
      const paused = await tool('search_tasks', { query: `zq${run}` }, publicRoom);
      assert.ok(text(paused).includes(openTitle), 'a paused agent is not a reader of the public room');
      assert.ok(!leaksRestricted(text(paused)), 'the public room is still shared: the restricted task stays held back');
      const alone = await tool('search_tasks', { query: `zq${run}` }, agentRoom);
      assert.ok(text(alone).includes(restrictedTitle), 'with the agent paused, the asker is the only reader');
    } finally {
      await q('UPDATE agent_employees SET project_ids = $2::text[], is_active = true WHERE id = $1', [employee, []]);
    }
  });

  test('messages, notes and wiki: only what every reader can open', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    const messages = await tool('search_messages', { query: secretMessage }, publicRoom);
    assert.ok(!text(messages).includes(secretMessage), 'a message from a room not everyone here can read is held back');
    const dmMessages = await tool('search_messages', { query: secretMessage }, deftyDm);
    assert.ok(text(dmMessages).includes(secretMessage), 'in the asker\'s own DM it is found');
    const notes = await tool('search_notes', { query: noteCanary }, publicRoom);
    assert.ok(!text(notes).includes(noteCanary), 'the asker\'s private note is held back');
    const note = await tool('read_note', { note_id: privateNote }, publicRoom);
    assert.ok(!text(note).includes(noteCanary));
    const wiki = await tool('wiki_search', { query: wikiCanary }, publicRoom);
    assert.ok(!text(wiki).includes(wikiCanary), 'the asker\'s own wiki page is held back');
    const dmNote = await tool('read_note', { note_id: privateNote }, deftyDm);
    assert.ok(text(dmNote).includes(noteCanary), 'in the asker\'s own DM the note is read');
  });

  test('every other read tool is refused in a shared conversation with "ask me in a DM"', async (t) => {
    if (!ready) { t.skip(unavailable); return; }
    for (const name of ['get_team_workload', 'get_user_activity', 'recall', 'check_calendar', 'search_decisions', 'module_list']) {
      const refused = await tool(name, {}, publicRoom);
      assert.equal((refused.result as any)?.code, 'SHARED_CONVERSATION_READ_UNAVAILABLE', `${name} is refused in a shared room`);
      assert.match(String((refused.result as any)?.error), /direct message/i);
    }
  });
});
