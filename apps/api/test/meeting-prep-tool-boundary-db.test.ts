/**
 * Meeting prep is written from the prepared, recipient-filtered evidence only.
 *
 * The run offers the model no tools, and a tool call the model returns anyway
 * sends the run to the evidence-only fallback without dispatching anything: no
 * read or write runs on the recipient's behalf. A private space and restricted
 * tasks the recipient cannot read stay out of the model input and the
 * delivered brief, the brief reaches only the recipient, and a grounded draft
 * with no tool calls is still used.
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

const emitted: Array<{ orgId: string; userId: string; event: string; data: string }> = [];
const actualSocket = await import('../src/socket.js');
mock.module(new URL('../src/socket.ts', import.meta.url).href, { namedExports: {
  ...actualSocket,
  emitToUser: (orgId: string, userId: string, event: string, data: unknown) => {
    emitted.push({ orgId, userId, event, data: JSON.stringify(data) });
  },
} });

const { generateMeetingPrep } = await import('../src/lib/meeting-prep-automation.js');
const { closeDb } = await import('../src/lib/db.js');

after(closeDb);

type Fixture = {
  org: string; otherOrg: string; recipient: string; users: string[]; event: string;
  attendeeTask: string; keywordTask: string; publicNote: string; readableNote: string; marker: string;
};

async function seed(c: pg.Client): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const marker = `zq${tag}`;
  const org = randomUUID(), recipient = randomUUID(), attendee = randomUUID(), other = randomUUID();
  const publicSpace = randomUUID(), privateSpace = randomUUID(), sharedSpace = randomUUID();
  const project = randomUUID(), event = randomUUID();
  const attendeeEmail = `attendee-${tag}@test.local`;
  await c.query('INSERT INTO orgs(id,name,slug) VALUES($1,$1,$1)', [org]);
  await c.query(`INSERT INTO users(id,email,name) VALUES($1,$1||'@test.local',$2)`, [recipient, `Recipient ${tag}`]);
  await c.query(`INSERT INTO users(id,email,name) VALUES($1,$2,$3)`, [attendee, attendeeEmail, `Attendee ${tag}`]);
  await c.query(`INSERT INTO users(id,email,name) VALUES($1,$1||'@test.local',$2)`, [other, `Other ${tag}`]);
  for (const [user, role] of [[recipient, 'admin'], [attendee, 'member'], [other, 'member']]) {
    await c.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), org, user, role]);
  }
  await c.query(`INSERT INTO spaces(id,org_id,name,type,is_default,created_by) VALUES($1,$2,'general','public',true,$3)`, [publicSpace, org, recipient]);
  await c.query(`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,'attendee-private','private',$3)`, [privateSpace, org, attendee]);
  await c.query(`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,'pair-private','private',$3)`, [sharedSpace, org, recipient]);
  for (const [space, user] of [[publicSpace, recipient], [publicSpace, attendee], [privateSpace, attendee], [sharedSpace, recipient], [sharedSpace, attendee]]) {
    await c.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), space, user]);
  }
  await c.query(`INSERT INTO projects(id,org_id,name,prefix) VALUES($1,$2,'Meeting prep tools',$3)`, [project, org, `M${tag.toUpperCase()}`]);

  const publicNote = `PUBLIC-NOTE-${tag}`, readableNote = `READABLE-NOTE-${tag}`;
  for (const [space, content] of [[publicSpace, publicNote], [sharedSpace, readableNote], [privateSpace, `${marker} private reorg plan`]]) {
    await c.query('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)', [randomUUID(), org, space, attendee, content]);
  }
  // Attendee-assigned tasks, and tasks reached only through the title keyword.
  const attendeeTask = `PUBLIC-TASK-${tag}`, keywordTask = `ROADMAP-VISIBLE-${tag}`;
  const taskRows: Array<[number, string, string, string]> = [
    [1, `${marker} restricted layoff list`, attendee, '{"visibility":"restricted"}'],
    [2, attendeeTask, attendee, '{}'],
    [3, `${marker} roadmap acquisition`, other, '{"visibility":"restricted"}'],
    [4, keywordTask, other, '{}'],
  ];
  for (const [number, title, owner, metadata] of taskRows) {
    await c.query(
      `INSERT INTO tasks(id,org_id,project_id,number,title,status,assignee_id,created_by,metadata)
       VALUES($1,$2,$3,$4,$5,'in_progress',$6,$6,$7::jsonb)`,
      [randomUUID(), org, project, number, title, owner, metadata],
    );
  }
  await c.query(
    `INSERT INTO events(id,org_id,user_id,source,event_type,external_id,title,timestamp,metadata)
     VALUES($1,$2,$3,'ics','calendar_event',$4,'Roadmap sync',$5,$6::jsonb)`,
    [event, org, recipient, `mprep-${event}`, new Date(Date.now() + 20 * 60_000), JSON.stringify({ attendees: [{ email: attendeeEmail }] })],
  );
  // Another workspace both people belong to, with matching open work.
  const otherOrg = randomUUID(), otherProject = randomUUID(), otherSpace = randomUUID();
  await c.query('INSERT INTO orgs(id,name,slug) VALUES($1,$1,$1)', [otherOrg]);
  for (const user of [recipient, attendee]) {
    await c.query(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')`, [randomUUID(), otherOrg, user]);
  }
  await c.query(`INSERT INTO spaces(id,org_id,name,type,is_default,created_by) VALUES($1,$2,'general','public',true,$3)`, [otherSpace, otherOrg, recipient]);
  for (const user of [recipient, attendee]) {
    await c.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), otherSpace, user]);
  }
  await c.query('INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)', [randomUUID(), otherOrg, otherSpace, attendee, `${marker} other workspace note`]);
  await c.query(`INSERT INTO projects(id,org_id,name,prefix) VALUES($1,$2,'Other workspace',$3)`, [otherProject, otherOrg, `O${tag.toUpperCase()}`]);
  await c.query(
    `INSERT INTO tasks(id,org_id,project_id,number,title,status,assignee_id,created_by,metadata)
     VALUES($1,$2,$3,1,$4,'in_progress',$5,$5,'{}'::jsonb)`,
    [randomUUID(), otherOrg, otherProject, `${marker} roadmap other workspace`, attendee],
  );
  return { org, otherOrg, recipient, users: [recipient, attendee, other], event, attendeeTask, keywordTask, publicNote, readableNote, marker };
}

async function cleanup(c: pg.Client, f: Fixture) {
  for (const sql of [
    'DELETE FROM agent_memory WHERE org_id=$1',
    'DELETE FROM agent_actions WHERE org_id=$1',
    'DELETE FROM notifications WHERE org_id=$1',
    'DELETE FROM meeting_briefs WHERE org_id=$1',
    'DELETE FROM automation_runs WHERE org_id=$1',
    'DELETE FROM events WHERE org_id=$1',
    'DELETE FROM messages WHERE org_id=$1',
    'DELETE FROM task_activity WHERE org_id=$1',
    'DELETE FROM tasks WHERE org_id=$1',
    'DELETE FROM projects WHERE org_id=$1',
    'DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)',
    'DELETE FROM spaces WHERE org_id=$1',
    'DELETE FROM org_members WHERE org_id=$1',
    'DELETE FROM orgs WHERE id=$1',
  ]) {
    for (const org of [f.org, f.otherOrg]) await c.query(sql, [org]).catch(() => undefined);
  }
  await c.query('DELETE FROM users WHERE id = ANY($1)', [f.users]).catch(() => undefined);
}

function firstSourceId(serialized: string): string {
  const match = /source_id\\?":\\?"([^"\\]+)/.exec(serialized);
  assert.ok(match, 'the evidence carries source ids');
  return match[1]!;
}

function toolCalls(f: Fixture) {
  return [
    { type: 'tool_use', id: 'tu-mem', name: 'remember', input: { key: `k-${f.marker}`, value: f.readableNote, scope: 'org' } },
    { type: 'tool_use', id: 'tu-msg', name: 'search_messages', input: { query: f.marker } },
  ];
}

const toolCallResponses: Array<[string, (f: Fixture, call: ProviderCall) => { content: any[]; stop_reason: string }]> = [
  ['a tool_use turn', (f) => ({ content: toolCalls(f), stop_reason: 'tool_use' })],
  ['a read-only tool_use turn', (f) => ({ content: toolCalls(f).slice(1), stop_reason: 'tool_use' })],
  ['a draft with tool calls at end_turn', (f, call) => ({
    content: [
      { type: 'text', text: JSON.stringify({ agenda: [{ text: 'Draft item', source_ids: [firstSourceId(call.serialized)] }], decisions: [], updates: [] }) },
      ...toolCalls(f),
    ],
    stop_reason: 'end_turn',
  })],
];

for (const [label, firstResponse] of toolCallResponses) {
  test(`a meeting-prep run offers no tools and ${label} falls back without dispatch`, async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
    const f = await seed(c);
    providerCalls.length = 0; emitted.length = 0;
    respond = (call, index) => index === 0 ? firstResponse(f, call) : {
      content: [{ type: 'text', text: JSON.stringify({ agenda: [{ text: 'Follow-up item', source_ids: [firstSourceId(call.serialized)] }], decisions: [], updates: [] }) }],
      stop_reason: 'end_turn',
    };
    try {
      const result = await generateMeetingPrep(f.event);
      assert.ok(result.brief, 'the brief was delivered');
      assert.ok(providerCalls.length >= 1);
      assert.deepEqual(providerCalls[0]!.tools, [], 'the meeting-prep run offers the model no tools');
      assert.equal(providerCalls.length, 1, 'the returned tool call is not followed up');
      // Where a write is returned it comes first, so an empty memory table means no call was dispatched.
      assert.equal((await c.query('SELECT 1 FROM agent_memory WHERE org_id=$1', [f.org])).rowCount, 0, 'no tool runs on the recipient\'s behalf');

      const input = providerCalls[0]!.serialized;
      assert.ok(!input.includes(f.marker), 'no private, restricted or other-workspace content reaches the model');
      for (const visible of [f.attendeeTask, f.keywordTask, f.publicNote, f.readableNote]) {
        assert.ok(input.includes(visible), `recipient-visible evidence reaches the model: ${visible}`);
      }
      const brief = result.brief!;
      assert.equal(brief.user_id, f.recipient);
      assert.ok(!brief.brief_text.includes(f.marker), 'no private, restricted or other-workspace content reaches the delivered brief');
      assert.ok(!brief.brief_text.includes('Draft item'), 'a draft that came with tool calls is not used');
      assert.ok(brief.brief_text.includes(f.attendeeTask), 'the evidence-only fallback still reports recipient-visible work');
      assert.equal(result.run?.generator, 'fallback');
      assert.equal(result.run?.status, 'delivered');

      const notes = (await c.query('SELECT user_id, body FROM notifications WHERE org_id=$1', [f.org])).rows;
      assert.equal(notes.length, 1, 'one notification');
      assert.equal(notes[0].user_id, f.recipient, 'the brief is delivered to the recipient only');
      assert.ok(!String(notes[0].body).includes(f.marker));
      const briefPush = emitted.find((push) => push.event === 'meeting-brief:new');
      assert.ok(briefPush, 'the brief is pushed in real time');
      assert.equal(JSON.parse(briefPush.data).event_id, f.event);
      assert.equal(JSON.parse(briefPush.data).brief_text, brief.brief_text);
      for (const push of emitted) {
        assert.deepEqual([push.orgId, push.userId], [f.org, f.recipient], 'real-time pushes go to the recipient only');
        assert.ok(!push.data.includes(f.marker));
      }
    } finally {
      await cleanup(c, f); await c.end();
    }
  });
}

test('a grounded meeting-prep draft without tool calls is still used', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  providerCalls.length = 0; emitted.length = 0;
  respond = (call) => ({
    content: [{ type: 'text', text: JSON.stringify({ agenda: [{ text: 'Grounded agenda item', source_ids: [firstSourceId(call.serialized)] }], decisions: [], updates: [] }) }],
    stop_reason: 'end_turn',
  });
  try {
    const result = await generateMeetingPrep(f.event);
    assert.ok(result.brief);
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerCalls[0]!.tools, []);
    assert.ok(!providerCalls[0]!.serialized.includes(f.marker), 'the model input holds only recipient-visible evidence');
    assert.ok(result.brief!.brief_text.includes('Grounded agenda item'));
    assert.equal(result.run?.generator, 'agent');
  } finally {
    await cleanup(c, f); await c.end();
  }
});

test('a meeting-prep draft with an approval requirement the evidence does not state is not delivered', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  providerCalls.length = 0; emitted.length = 0;
  respond = (call) => ({
    content: [{ type: 'text', text: JSON.stringify({ agenda: [{ text: 'Account manager sign-off is required before the review.', source_ids: [firstSourceId(call.serialized)] }], decisions: [], updates: [] }) }],
    stop_reason: 'end_turn',
  });
  try {
    const result = await generateMeetingPrep(f.event);
    assert.ok(result.brief);
    assert.ok(!/sign-off is required/.test(result.brief!.brief_text), 'the ungrounded claim is not delivered');
    assert.ok(result.brief!.brief_text.includes(f.attendeeTask), 'the evidence-only fallback is delivered');
    assert.equal(result.run?.generator, 'fallback');
  } finally {
    await cleanup(c, f); await c.end();
  }
});

test('a meeting-prep item restating an approval requirement from its cited evidence is delivered', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const f = await seed(c);
  const [space] = (await c.query(`SELECT id FROM spaces WHERE org_id=$1 AND name='general'`, [f.org])).rows;
  const messageId = randomUUID();
  await c.query(
    'INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,$5)',
    [messageId, f.org, space.id, f.users[1], 'Read-only rollout: account manager sign-off is required before launch.'],
  );
  providerCalls.length = 0; emitted.length = 0;
  respond = () => ({
    content: [{ type: 'text', text: JSON.stringify({ agenda: [{ text: 'Account manager sign-off is required before launch.', source_ids: [`message:${messageId}`] }], decisions: [], updates: [] }) }],
    stop_reason: 'end_turn',
  });
  try {
    const result = await generateMeetingPrep(f.event);
    assert.ok(result.brief!.brief_text.includes('Account manager sign-off is required before launch.'));
    assert.equal(result.run?.generator, 'agent');
  } finally {
    await cleanup(c, f); await c.end();
  }
});
