// Defty conversation simulator. Usage: node defty-sim.mjs [scenarioId ...]
// Drives the local simulation API (http://127.0.0.1:3111) as seeded users and records Defty's behaviour.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.SIM_API ?? 'http://127.0.0.1:3111';
const PASSWORD = 'DeftTest2026!';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'runs');
mkdirSync(OUT, { recursive: true });
const RUN = new Date().toISOString().replace(/[:.]/g, '-');

const people = {
  admin: 'admin@deft.test', priya: 'priya@deft.test', rahul: 'rahul@deft.test',
  arjun: 'arjun@deft.test', sara: 'sara@deft.test',
};
const sessions = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(who, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${sessions[who].token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function login() {
  for (const [k, email] of Object.entries(people)) {
    const r = await api(null, 'POST', '/api/auth/login', { email, password: PASSWORD });
    sessions[k] = { token: r.accessToken, id: r.user.id, name: r.user.name };
    await sleep(150);
  }
}

const p = (t) => `<p>${t}</p>`;

async function newChannel(name) {
  const s = await api('admin', 'POST', '/api/spaces', { name, type: 'public' });
  const id = s.id ?? s.space?.id;
  for (const k of ['priya', 'rahul', 'arjun', 'sara']) {
    await api('admin', 'POST', `/api/spaces/${id}/members`, { user_id: sessions[k].id }).catch(() => {});
  }
  return id;
}

const DEFTY_ID = process.env.DEFTY_ID;
async function channelByName(name) {
  const spaces = await api('admin', 'GET', '/api/spaces');
  const list = Array.isArray(spaces) ? spaces : spaces.spaces ?? [];
  return list.find((s) => s.name === name)?.id;
}
async function defitesDm(who) {
  const s = await api(who, 'POST', '/api/spaces', { name: 'dm', type: 'dm', user_ids: [DEFTY_ID] });
  return s.id ?? s.space?.id;
}

async function post(who, spaceId, text, parentId) {
  const m = await api(who, 'POST', `/api/messages/${spaceId}`, { content: p(text), ...(parentId ? { parent_id: parentId } : {}) });
  return m.message ?? m;
}

function isDefty(m) { return /defty/i.test(m.user_name ?? m.user?.name ?? '') || m.user_email === 'deft-agent@system.local'; }

async function listMessages(who, spaceId) {
  const r = await api(who, 'GET', `/api/messages/${spaceId}?limit=100`);
  return Array.isArray(r) ? r : r.messages ?? [];
}
async function listThread(who, parentId) {
  const r = await api(who, 'GET', `/api/messages/${parentId}/thread`);
  return Array.isArray(r) ? r : r.replies ?? r.messages ?? [];
}

// Wait for a new Defty message anywhere relevant (top level or in the trigger's thread / given thread).
async function waitDefty(who, spaceId, sinceIso, threadIds, timeoutMs = 150_000) {
  const t0 = Date.now();
  const seen = [];
  while (Date.now() - t0 < timeoutMs) {
    const pools = [await listMessages(who, spaceId)];
    for (const tid of threadIds.filter(Boolean)) pools.push(await listThread(who, tid).catch(() => []));
    for (const m of pools.flat()) {
      if (isDefty(m) && new Date(m.created_at) > new Date(sinceIso) && !seen.find((s) => s.id === m.id)) seen.push(m);
    }
    if (seen.length) { await sleep(2500); return { latencyMs: Date.now() - t0, messages: seen }; }
    await sleep(2000);
  }
  return { latencyMs: null, messages: [] };
}

function plain(html) { return String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

// ---------- scenarios ----------
// step: { as, say, thread?: 'trigger'|'root', expectDefty?: bool, noMentionProbeSec?: n, note }
const scenarios = {
  S1_catchup: {
    goal: 'Catch a returning teammate up from the channel discussion (not just the trigger line).',
    steps: [
      { as: 'rahul', say: 'Heads up: the API migration is blocked until Arjun finishes the schema review. I can\'t start the cutover before that.' },
      { as: 'arjun', say: 'Schema review will be done Wednesday EOD. Two tables need a backfill first.' },
      { as: 'priya', say: 'Then the Thursday customer demo is tight. I propose we move the demo to Friday 3pm.' },
      { as: 'admin', say: 'Agreed, demo moves to Friday 3pm. Priya, can you tell the customer?' },
      { as: 'priya', say: 'Yes, I\'ll email them today.' },
      { as: 'sara', say: '@Defty I was out yesterday, can you catch me up? What\'s the plan and who\'s doing what?', expectDefty: true },
    ],
    expect: 'Mentions schema review (Arjun, Wed EOD, backfill), migration blocked (Rahul), demo moved to Fri 3pm (decided), Priya emails customer.',
  },
  S2_task_from_discussion: {
    goal: 'Turn "what Rahul said" into a task proposal with correct owner/date, then accept a no-mention correction.',
    steps: [
      { as: 'priya', say: 'We still don\'t have a rollback plan if the cutover goes wrong.' },
      { as: 'rahul', say: 'I\'ll write the migration rollback script and test it on staging by Thursday.' },
      { as: 'priya', say: '@Defty make a task for what Rahul said', expectDefty: true },
      { as: 'priya', say: 'actually give it to Arjun instead, Rahul is out Thursday', thread: 'trigger', noMentionProbeSec: 75 },
      { as: 'priya', say: '@Defty actually give it to Arjun instead, Rahul is out Thursday', thread: 'trigger', expectDefty: true },
    ],
    expect: 'Proposal: "Write and test migration rollback script on staging", assignee Rahul, due Thursday; then reassigned to Arjun. Ideally the no-mention follow-up is understood.',
  },
  S3_paraphrase_task_ref: {
    goal: 'Resolve an existing task by paraphrase and "me".',
    steps: [
      { as: 'arjun', say: 'Errors in prod are invisible right now, we really need error tracking wired up.' },
      { as: 'arjun', say: '@Defty move the error tracking task to in progress and give it to me', expectDefty: true },
    ],
    expect: 'Resolves DEFT-7 "Wire Sentry error tracking"; proposes status in_progress + assignee Arjun.',
  },
  S4_whats_on_plate: {
    goal: 'Answer a people question from task data.',
    steps: [
      { as: 'sara', say: '@Defty what has Rahul got on his plate right now?', expectDefty: true },
    ],
    expect: 'Lists Rahul\'s open tasks: DEFT-11 in progress, DEFT-13 in review, DEFT-7 todo, DEFT-1/3 backlog.',
  },
  S5_opinion: {
    goal: 'Participate in a debate using the conversation, like a teammate.',
    steps: [
      { as: 'priya', say: 'If the schema review slips again we either slip the launch a week or cut the import feature from v1.' },
      { as: 'rahul', say: 'Cutting import hurts the two pilot customers, they asked for it specifically.' },
      { as: 'sara', say: 'But slipping a week means we miss the conference announcement.' },
      { as: 'admin', say: '@Defty what do you think?', expectDefty: true },
    ],
    expect: 'Engages with the specific trade-off (pilot customers vs conference), maybe asks a sharpening question; short and conversational.',
  },
  S6_implicit_reference: {
    goal: 'Resolve "that" from conversation to an existing task and answer its status.',
    steps: [
      { as: 'rahul', say: 'The server-side logout PR is the last auth thing before launch.' },
      { as: 'sara', say: '@Defty is that reviewed yet?', expectDefty: true },
    ],
    expect: 'Identifies DEFT-13 "Review: feat(auth) — server-side logout", status in_review (not yet approved/done).',
  },
  S7_multi_assignee_date: {
    goal: 'Handle "me and Sara" + relative date.',
    steps: [
      { as: 'priya', say: '@Defty create a task for me and Sara to update the onboarding docs, due next Monday', expectDefty: true },
    ],
    expect: 'Proposal: one task (or two) with Priya + Sara, due next Monday as a concrete date; or asks how to split owners.',
  },
  S8_ambiguous: {
    goal: 'Ask a clarifying question instead of guessing between two matching tasks.',
    steps: [
      { as: 'admin', say: '@Defty assign the review task to Sara', expectDefty: true },
    ],
    expect: 'Asks which review task: DEFT-13 (server-side logout) or DEFT-14 (plural labels).',
  },

  S10_answer_clarification: {
    goal: 'Answer Defty\'s own clarifying question in the thread and get the task drafted with the original details.',
    steps: [
      { as: 'rahul', say: 'I\'ll write the migration rollback script and test it on staging by Thursday.' },
      { as: 'priya', say: '@Defty make a task for what Rahul said', expectDefty: true },
      { as: 'priya', say: 'Deft v1', thread: 'trigger', noMentionProbeSec: 60 },
      { as: 'priya', say: '@Defty Deft v1', thread: 'trigger', expectDefty: true },
    ],
    expect: 'After the answer, proposal for Rahul, rollback script, due Thursday, project Deft v1.',
  },
  S11_long_channel: {
    goal: 'Use a detail from far back in a busy channel.',
    steps: [
      { as: 'sara', say: 'Decision from the design sync: the onboarding checklist will have exactly 4 steps, and the invite step moves to step 2.' },
      ...Array.from({ length: 22 }, (_, i) => ({ as: ['priya','rahul','arjun','admin'][i % 4], say: ['anyone else seeing slow CI today?', 'yeah builds are ~12 min', 'lunch order going in 10', 'I pushed the lint fix', 'PR #482 needs a second reviewer', 'on it', 'standup moved to 10:30 tomorrow', 'the staging db got reset, heads up', 'can someone check the flaky e2e test', 'looking now', 'it was a timezone thing', 'nice catch'][i % 12] })),
      { as: 'arjun', say: '@Defty how many steps did we land on for the onboarding checklist, and where does invite go?', expectDefty: true },
    ],
    expect: '4 steps; invite is step 2 (decision from Sara, ~23 messages earlier).',
  },
  S12_seeded_catchup: {
    goal: 'Catch up on an existing channel with older history.',
    useChannel: 'launch',
    steps: [
      { as: 'sara', say: '@Defty catch me up on this channel, what matters this week?', expectDefty: true },
    ],
    expect: 'Grounded summary of #launch seed history (not generic), with who/what.',
  },
  S9_dm_cross_channel: {
    goal: 'From a DM, summarise another channel by name.',
    dm: 'priya',
    steps: [
      { as: 'priya', say: 'What did the team decide in sim-s1-catchup about the demo?', expectDefty: true },
    ],
    expect: 'Demo moved to Friday 3pm (decided by Admin), Priya to email the customer.',
  },
};

async function runScenario(id, sc) {
  const log = { id, goal: sc.goal, expect: sc.expect, steps: [] };
  const spaceId = sc.useChannel ? await channelByName(sc.useChannel) : sc.dm ? await defitesDm(sc.dm) : await newChannel(`sim-${id.toLowerCase().split('_')[0]}-${id.split('_').slice(1).join('-')}`.slice(0, 60));
  if (!spaceId) throw new Error(`no space for ${id}`);
  log.spaceId = spaceId;
  let lastTrigger = null;
  for (const st of sc.steps) {
    const parent = st.thread === 'trigger' ? lastTrigger : undefined;
    const before = new Date(Date.now() - 1000).toISOString();
    const m = await post(st.as, spaceId, st.say, parent);
    const entry = { as: sessions[st.as].name, say: st.say, messageId: m.id, parent };
    if (st.expectDefty) lastTrigger = parent ?? m.id;
    if (st.expectDefty || st.noMentionProbeSec) {
      const r = await waitDefty(st.as, spaceId, before, [m.id, parent, lastTrigger], st.noMentionProbeSec ? st.noMentionProbeSec * 1000 : undefined);
      entry.defty = r.messages.map((d) => ({ id: d.id, parent_id: d.parent_id, text: plain(d.content), metadata: d.metadata ?? null }));
      entry.latencyMs = r.latencyMs;
      entry.responded = r.messages.length > 0;
    } else {
      await sleep(800);
    }
    log.steps.push(entry);
    console.log(`[${id}] ${entry.as}: ${st.say}`);
    for (const d of entry.defty ?? []) console.log(`   DEFTY (${entry.latencyMs}ms): ${d.text.slice(0, 600)}`);
    if ((st.expectDefty || st.noMentionProbeSec) && !entry.responded) console.log('   DEFTY: <no reply>');
  }
  return log;
}

await login();
const pick = process.argv.slice(2);
const results = [];
for (const [id, sc] of Object.entries(scenarios)) {
  if (pick.length && !pick.includes(id)) continue;
  try { results.push(await runScenario(id, sc)); } catch (e) { results.push({ id, error: String(e) }); console.log(`[${id}] ERROR ${e}`); }
  writeFileSync(join(OUT, `run-${RUN}.json`), JSON.stringify({ run: RUN, api: API, results }, null, 2));
}
console.log(`\nSaved ${join(OUT, `run-${RUN}.json`)}`);
