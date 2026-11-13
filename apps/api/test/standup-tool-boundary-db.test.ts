/**
 * W2-a6-Y: the daily standup is written from the prepared evidence only.
 *
 * Defty is a member of a private space and assignee of a restricted task, so
 * Defty's own reads could reach both. The standup run offers the model no
 * tools, and a tool call the model returns anyway sends the run to the
 * evidence-only fallback without being dispatched. Neither secret reaches the
 * model input or the stored standup.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, mock, test } from 'node:test';
import pg from 'pg';

type ProviderCall = { tools: string[]; serialized: string };
const providerCalls: ProviderCall[] = [];
let respond: (call: ProviderCall, index: number) => { content: any[]; stop_reason: string } = () => ({
  content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn',
});

const actualLlm = await import('../src/lib/agent-llm.js');
mock.module(new URL('../src/lib/agent-llm.ts', import.meta.url).href, { namedExports: {
  ...actualLlm,
  createAgentMessage: async (p: any) => {
    const call = { tools: p.tools.map((t: any) => t.name), serialized: JSON.stringify({ system: p.system, messages: p.messages }) };
    providerCalls.push(call);
    return { ...respond(call, providerCalls.length - 1), usage: { input_tokens: 5, output_tokens: 5 } };
  },
} });
const actualAiConfig = await import('../src/lib/org-ai-config.js');
mock.module(new URL('../src/lib/org-ai-config.ts', import.meta.url).href, { namedExports: {
  ...actualAiConfig,
  resolveReasonProvider: async () => ({ provider: 'anthropic', model: 'test-model', apiKey: 'test-key' }),
} });

const { generateDailyStandup } = await import('../src/lib/standup-automation.js');
const { ensureDeftyMembership } = await import('../src/lib/ensure-defty-membership.js');
const { closeDb } = await import('../src/lib/db.js');

after(closeDb);

type Fixture = {
  org: string; owner: string; publicSpace: string; privateSpace: string; project: string;
  publicTitle: string; secretMessage: string; secretTask: string; marker: string;
};

async function seed(c: pg.Client): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const marker = `zq${tag}`;
  const org = randomUUID(), owner = randomUUID();
  const publicSpace = randomUUID(), privateSpace = randomUUID(), project = randomUUID();
  await c.query('INSERT INTO orgs(id,name,slug) VALUES($1,$1,$1)', [org]);
  await c.query(`INSERT INTO users(id,email,name) VALUES($1,$1||'@test.local',$2)`, [owner, `Owner ${tag}`]);
  await c.query(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')`, [randomUUID(), org, owner]);
  await c.query(`INSERT INTO spaces(id,org_id,name,type,is_default,created_by) VALUES($1,$2,'general','public',true,$3)`, [publicSpace, org, owner]);
  await c.query(`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,'leadership','private',$3)`, [privateSpace, org, owner]);
  await c.query(`INSERT INTO projects(id,org_id,name,prefix) VALUES($1,$2,'Standup tools',$3)`, [project, org, `T${tag.toUpperCase()}`]);

  const defty = await ensureDeftyMembership(org);
  for (const user of [owner, defty]) {
    await c.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [randomUUID(), privateSpace, user]);
  }
  const secretMessage = `${marker} private reorg plan`;
  await c.query(
    `INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)`,
    [randomUUID(), org, privateSpace, owner, secretMessage],
  );
  const secretTask = `${marker} restricted layoff list`;
  const publicTitle = `PUBLIC-ACTIVE-${tag}`;
  await c.query(
    `INSERT INTO tasks(id,org_id,project_id,number,title,status,assignee_id,created_by,metadata)
     VALUES($1,$2,$3,1,$4,'in_progress',$5,$6,'{"visibility":"restricted"}'::jsonb)`,
    [randomUUID(), org, project, secretTask, defty, owner],
  );
  await c.query(
    `INSERT INTO tasks(id,org_id,project_id,number,title,status,assignee_id,created_by,metadata)
     VALUES($1,$2,$3,2,$4,'in_progress',$5,$5,'{}'::jsonb)`,
    [randomUUID(), org, project, publicTitle, owner],
  );
  return { org, owner, publicSpace, privateSpace, project, publicTitle, secretMessage, secretTask, marker };
}

async function cleanup(c: pg.Client, f: Fixture) {
  for (const sql of [
    'DELETE FROM agent_actions WHERE org_id=$1',
    'DELETE FROM messages WHERE org_id=$1',
    'DELETE FROM standups WHERE org_id=$1',
    'DELETE FROM automation_runs WHERE org_id=$1',
    'DELETE FROM task_activity WHERE org_id=$1',
    'DELETE FROM tasks WHERE org_id=$1',
    'DELETE FROM projects WHERE org_id=$1',
    'DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)',
    'DELETE FROM spaces WHERE org_id=$1',
    'DELETE FROM org_members WHERE org_id=$1',
    'DELETE FROM orgs WHERE id=$1',
  ]) {
    await c.query(sql, [f.org]).catch(() => undefined);
  }
  await c.query('DELETE FROM users WHERE id=$1', [f.owner]).catch(() => undefined);
}

function firstSourceId(serialized: string): string {
  const match = /source_id\\?":\\?"([^"\\]+)/.exec(serialized);
  assert.ok(match, 'the evidence carries source ids');
  return match[1]!;
}

async function published(c: pg.Client, f: Fixture, standup: { summary: string; raw_data: unknown }) {
  const rows = (await c.query('SELECT content FROM messages WHERE org_id=$1 AND space_id=$2', [f.org, f.publicSpace])).rows;
  return [standup.summary, JSON.stringify(standup.raw_data), ...rows.map((row) => String(row.content))].join('\n');
}

test('W2-a6-Y: a standup run offers no tools and a returned tool call falls back without dispatch', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  providerCalls.length = 0;
  respond = (call, index) => {
    if (index === 0) {
      return {
        content: [
          { type: 'tool_use', id: 'tu-msg', name: 'search_messages', input: { query: f.marker } },
          { type: 'tool_use', id: 'tu-task', name: 'search_tasks', input: { query: f.marker } },
        ],
        stop_reason: 'tool_use',
      };
    }
    // A model that repeats whatever its tool results contained.
    const leaked = call.serialized.includes(f.marker) ? `${f.secretMessage} ${f.secretTask}` : 'nothing';
    const sourceId = firstSourceId(providerCalls[0]!.serialized);
    return {
      content: [{ type: 'text', text: JSON.stringify({ done: [], in_progress: [{ text: leaked.slice(0, 170), source_ids: [sourceId] }], blocked: [] }) }],
      stop_reason: 'end_turn',
    };
  };
  try {
    const result = await generateDailyStandup({ orgId: f.org });
    assert.ok(result.standup, 'standup was generated');
    assert.ok(providerCalls.length >= 1);
    assert.deepEqual(providerCalls[0]!.tools, [], 'the standup run offers the model no tools');
    assert.equal(providerCalls.length, 1, 'the returned tool call is not dispatched or followed up');
    for (const call of providerCalls) {
      assert.ok(!call.serialized.includes(f.marker), 'no private message or restricted task reaches the model');
    }
    const text = await published(c, f, result.standup!);
    assert.ok(!text.includes(f.marker), 'no private message or restricted task reaches the stored standup');
    assert.ok(text.includes(f.publicTitle), 'the evidence-only fallback still reports org-visible work');
    assert.equal((result.standup!.raw_data as { generator?: string }).generator, 'fallback');
  } finally {
    await cleanup(c, f); await c.end();
  }
});

test('W2-a6-Y: a grounded standup draft without tool calls is still used', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  providerCalls.length = 0;
  respond = (call) => ({
    content: [{ type: 'text', text: JSON.stringify({ done: [], in_progress: [{ text: 'Grounded progress item', source_ids: [firstSourceId(call.serialized)] }], blocked: [] }) }],
    stop_reason: 'end_turn',
  });
  try {
    const result = await generateDailyStandup({ orgId: f.org });
    assert.ok(result.standup);
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerCalls[0]!.tools, []);
    assert.ok(!providerCalls[0]!.serialized.includes(f.marker));
    const text = await published(c, f, result.standup!);
    assert.ok(text.includes('Grounded progress item'));
    assert.equal((result.standup!.raw_data as { generator?: string }).generator, 'agent');
  } finally {
    await cleanup(c, f); await c.end();
  }
});

const ungroundedDrafts: Array<[string, (sourceId: string) => string]> = [
  ['an approval requirement the evidence does not state', (sourceId) => JSON.stringify({
    done: [], in_progress: [{ text: 'Project lead approval is required before shipping.', source_ids: [sourceId] }], blocked: [],
  })],
  ['a native link that appears only after JSON decoding', (sourceId) =>
    `{"done":[],"in_progress":[{"text":"UNGROUNDED-LINK [task](\\u002ftasks?task=invented)","source_ids":["${sourceId}"]}],"blocked":[]}`],
  ['no items', () => '{"done":[],"in_progress":[],"blocked":[]}'],
];

for (const [label, draft] of ungroundedDrafts) {
  test(`a standup draft with ${label} is not delivered`, async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    const f = await seed(c);
    providerCalls.length = 0;
    respond = (call) => ({ content: [{ type: 'text', text: draft(firstSourceId(call.serialized)) }], stop_reason: 'end_turn' });
    try {
      const result = await generateDailyStandup({ orgId: f.org });
      const text = await published(c, f, result.standup!);
      assert.ok(!/approval is required|UNGROUNDED-LINK|task=invented/.test(text), 'the ungrounded draft is not published');
      assert.ok(text.includes(f.publicTitle), 'the evidence-only fallback is published');
      assert.equal((result.standup!.raw_data as { generator?: string }).generator, 'fallback');
    } finally {
      await cleanup(c, f); await c.end();
    }
  });
}

test('a standup item that cites no evidence is dropped while cited items are delivered', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  providerCalls.length = 0;
  respond = (call) => ({
    content: [{ type: 'text', text: JSON.stringify({
      done: [{ text: 'UNCITED-CLAIM shipped everything', source_ids: [] }],
      in_progress: [{ text: 'Grounded progress item', source_ids: [firstSourceId(call.serialized)] }],
      blocked: [],
    }) }],
    stop_reason: 'end_turn',
  });
  try {
    const result = await generateDailyStandup({ orgId: f.org });
    const text = await published(c, f, result.standup!);
    assert.ok(!text.includes('UNCITED-CLAIM'), 'the uncited item is not published');
    assert.ok(text.includes('Grounded progress item'));
    assert.equal((result.standup!.raw_data as { generator?: string }).generator, 'agent');
  } finally {
    await cleanup(c, f); await c.end();
  }
});

test('a standup draft restating an approval requirement from its evidence uses the evidence-only form', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  const taskId = randomUUID();
  const title = 'Read-only rollout needs project lead approval';
  await c.query(
    `INSERT INTO tasks(id,org_id,project_id,number,title,status,assignee_id,created_by,metadata)
     VALUES($1,$2,$3,3,$4,'in_progress',$5,$5,'{}'::jsonb)`,
    [taskId, f.org, f.project, title, f.owner],
  );
  providerCalls.length = 0;
  respond = () => ({
    content: [{ type: 'text', text: JSON.stringify({ done: [], in_progress: [{ text: 'MODEL-PHRASING: project lead approval is required for the rollout.', source_ids: [`task:${taskId}`] }], blocked: [] }) }],
    stop_reason: 'end_turn',
  });
  try {
    const result = await generateDailyStandup({ orgId: f.org });
    const text = await published(c, f, result.standup!);
    assert.ok(!text.includes('MODEL-PHRASING'), 'the model phrasing is not published');
    assert.ok(text.includes(title), 'the evidence is quoted verbatim instead');
    assert.equal((result.standup!.raw_data as { generator?: string }).generator, 'fallback');
  } finally {
    await cleanup(c, f); await c.end();
  }
});
