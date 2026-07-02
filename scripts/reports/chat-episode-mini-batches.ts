import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { agentActions, messageClassifications, wikiPages, workIntents } from '@deft/db/schema';
import { db } from '../../apps/api/src/lib/db.js';

const WEB_URL = (process.env.DEFT_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_URL = (process.env.DEFT_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3301').replace(/\/$/, '');
const EMAIL = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const RUN_ID = process.env.DEFT_CHAT_MINI_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.resolve('reports', 'chat-episode-mini-batches', RUN_ID);
const HTML_REPORT = path.resolve('reports', `chat-episode-mini-batches-${RUN_ID}.html`);
const JSON_REPORT = path.resolve('reports', `chat-episode-mini-batches-${RUN_ID}.json`);
const CLEANUP_SPACES = process.env.DEFT_CHAT_MINI_CLEANUP === '1';

type Status = 'pass' | 'warn' | 'fail';
type Auth = {
  accessToken: string;
  user: { id: string; email: string; name?: string };
  orgId: string;
};
type Space = { id: string; name: string; type?: string };
type ScenarioExpectation = {
  wiki: 'none' | 'some';
  task: 'none' | 'mention';
};
type Scenario = {
  id: string;
  title: string;
  spacePreference: string[];
  spaceType?: 'public' | 'private';
  about: string;
  expectation: ScenarioExpectation;
  messages: string[];
};
type ScenarioResult = {
  id: string;
  title: string;
  space: Space;
  about: string;
  expectation: ScenarioExpectation;
  messageIds: string[];
  messageCount: number;
  classifications: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
  intents: Array<Record<string, unknown>>;
  wiki: Array<Record<string, unknown>>;
  screenshots: string[];
  checks: Array<{ status: Status; name: string; detail?: unknown }>;
};

const scenarios: Scenario[] = [
  {
    id: 'pizza-social',
    title: 'Lunch Debate Stays Ephemeral',
    spacePreference: ['general', 'marketing', 'operations'],
    about: 'A spirited pizza/lunch argument with fake policy language. This should not enter wiki.',
    expectation: { wiki: 'none', task: 'none' },
    messages: [
      'Morning vote: I want thin crust pizza for lunch, and I will emotionally filibuster any deep dish proposal.',
      'Deep dish is obviously soup with confidence. Still not a company policy, just my personal lunch hill.',
      'If anyone suggests pineapple I am moving my chair three feet away from the table.',
      'Counterpoint: jalapenos make every pizza less boring. This is lunch chatter, not an operating rule.',
      'Fine, we can decide at noon. No one please put this in the workspace memory.',
    ],
  },
  {
    id: 'launch-decision',
    title: 'Durable Launch Decision Becomes Knowledge',
    spacePreference: ['marketing', 'sales-and-buyers', 'general'],
    about: 'A real launch operating decision with client and route implications. This should become one durable wiki update/create.',
    expectation: { wiki: 'some', task: 'none' },
    messages: [
      'For the Sun Gold launch, buyer copy changes are still coming in too late for route planning.',
      'I think Friday 3pm should be the cutoff. Anything after that moves into the next delivery window.',
      'Agreed. Going forward, Friday 3pm is the source of truth cutoff for Sun Gold buyer copy changes.',
      'That also keeps Tomas from rebuilding the cold-chain route sheet on Saturday morning.',
      'I will mention this in the launch standup so sales and ops stop negotiating it ad hoc.',
    ],
  },
  {
    id: 'blocker-no-task',
    title: 'Blocker Discussion Does Not Auto-Create Task',
    spacePreference: ['operations', 'field-ops', 'general'],
    about: 'A blocker conversation without Defty being called. It should remain context, not an automatic task.',
    expectation: { wiki: 'none', task: 'none' },
    messages: [
      'I am blocked on the carton label proof because the nutrition copy is still missing from the packhouse note.',
      'Can someone confirm whether the old copy is acceptable for the pilot shelf talker?',
      'Please do not create a task yet. I want to check with Maya first because this may already be covered.',
      'Maya is checking the last approved PDF now. We should know in ten minutes.',
      'If the PDF is stale, I will call Defty separately and have it draft the proper task.',
    ],
  },
  {
    id: 'conflict-defty-task',
    title: 'Conflict Resolution Becomes Defty-Led Task',
    spacePreference: ['quality', 'operations', 'general'],
    about: 'A messy task conflict gets resolved by a manager, then Defty is called to create the clean task.',
    expectation: { wiki: 'none', task: 'mention' },
    messages: [
      'The QA checklist cannot keep changing after labels are already printed. It is causing rework.',
      'Ops keeps saying it is a tiny change, but the label printer queue is not tiny when it slips.',
      'Let us cool this down. Maya owns final QA wording, Tomas owns print timing, and both need one handoff point.',
      'Resolution: Maya will deliver final wording before print release, Tomas will not print until that signoff lands.',
      '@Defty create a task from this discussion: formalize the label QA handoff between Maya and Tomas, assign it to Maya, due 2026-07-08.',
    ],
  },
  {
    id: 'mixed-client-social',
    title: 'Mixed Social Plus Client Decision Captures Only Work Memory',
    spacePreference: ['sales-and-buyers', 'marketing', 'general'],
    about: 'Coffee banter surrounds a real client decision. The wiki candidate should ignore the social part.',
    expectation: { wiki: 'some', task: 'none' },
    messages: [
      'I am bringing terrible vending machine coffee to the buyer review, apologies in advance.',
      'BrightMart confirmed they want the Sun Gold trial pallet photos before Thursday route staging.',
      'Decision: BrightMart launch QA signoff must happen before pallet staging every Thursday.',
      'That means buyer-facing photos need to be reviewed before Tomas locks the truck sequence.',
      'Also, no one should judge the coffee. The coffee is fighting its own battle.',
    ],
  },
  {
    id: 'sarcastic-task-joke',
    title: 'Sarcastic Task Joke Stays Out',
    spacePreference: ['general', 'marketing', 'operations'],
    about: 'A joking fake task with work-ish words should not create passive wiki or task work.',
    expectation: { wiki: 'none', task: 'none' },
    messages: [
      'Please create a P0 task to nominate the official greenhouse playlist captain. This is a joke, before anyone panics.',
      'Assign it to the tomato vines, due never.',
      'The actual launch work is fine; I am only making fun of our task hygiene.',
      'No Defty action needed here. This thread is comedy plus venting.',
    ],
  },
  {
    id: 'half-decision',
    title: 'Half Decision Does Not Become Memory',
    spacePreference: ['operations', 'marketing', 'general'],
    about: 'The team floats a possible operating change but never settles it.',
    expectation: { wiki: 'none', task: 'none' },
    messages: [
      'Maybe we should move the cherry tomato harvest review to Wednesdays, but I am not sure yet.',
      'That might collide with the buyer route call.',
      'Let us not decide now. I want field numbers first.',
      'Agreed, park the idea until the morning yield sheet lands.',
    ],
  },
  {
    id: 'reversed-decision',
    title: 'Reversed Decision Captures Settled Final Context',
    spacePreference: ['sales-and-buyers', 'operations', 'general'],
    about: 'A decision changes during the conversation. The final settled decision is durable; earlier uncertainty should not become a separate task.',
    expectation: { wiki: 'some', task: 'none' },
    messages: [
      'Initial thought: move the Co-op tasting kit to Tuesday because Monday packing is crowded.',
      'Actually, the buyer just confirmed Tuesday does not work for their chef lead.',
      'Decision: keep the Co-op tasting kit on Monday, but cap it at 24 sample boxes so packing can finish by noon.',
      'That final Monday cap is the thing we should remember. Ignore the Tuesday idea.',
    ],
  },
  {
    id: 'private-space-decision',
    title: 'Private Space Decision Stays Scoped',
    spacePreference: ['leadership', 'general'],
    spaceType: 'private',
    about: 'A private channel records durable context. It should capture knowledge without becoming a public-space artifact.',
    expectation: { wiki: 'some', task: 'none' },
    messages: [
      'For the pilot customer call, we should keep the pricing concession internal to the leadership thread.',
      'Decision: the pilot discount is capped at 12 percent and only Maneek can approve exceptions.',
      'This should be remembered for the customer pilot prep, but it should stay scoped to this space.',
    ],
  },
  {
    id: 'vague-defty-call',
    title: 'Vague Defty Call Does Not Create Passive Wiki',
    spacePreference: ['operations', 'general'],
    about: 'A vague agent invocation should keep passive knowledge quiet until Defty has a clear action path.',
    expectation: { wiki: 'none', task: 'none' },
    messages: [
      'The morning got messy: cold-chain checks slipped, buyer notes are scattered, and Tomas is annoyed.',
      'I do not know what the right action is yet.',
      '@Defty can you look at this later and help us make sense of it?',
      'Let us wait for the actual route sheet before creating anything.',
    ],
  },
];

const artifact = {
  run_id: RUN_ID,
  web_url: WEB_URL,
  api_url: API_URL,
  cleanup_spaces: CLEANUP_SPACES,
  started_at: new Date().toISOString(),
  finished_at: '',
  summary: { pass: 0, warn: 0, fail: 0 },
  results: [] as ScenarioResult[],
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
}

function asArray<T = any>(value: any, keys: string[] = []): T[] {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function containsAnyMessageId(value: unknown, ids: string[]): boolean {
  if (!value) return false;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return ids.some((id) => text.includes(id));
}

function hasSocialLeak(value: unknown): boolean {
  const text = JSON.stringify(value ?? '').toLowerCase();
  return /\b(?:pizza|deep dish|pineapple|jalapeno|lunch|coffee|vending machine)\b/.test(text);
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { ok: res.ok, status: res.status, body, text };
}

async function loginApi(): Promise<Auth> {
  const res = await fetchJson<Auth>(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok || !res.body?.accessToken) {
    throw new Error(`API login failed: ${res.status} ${res.text.slice(0, 240)}`);
  }
  const me = await fetchJson<{ org?: { id?: string } }>(`${API_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${res.body.accessToken}` },
  });
  const orgId = me.body?.org?.id;
  if (!me.ok || !orgId) {
    throw new Error(`/api/auth/me did not return an org id: ${me.status} ${me.text.slice(0, 240)}`);
  }
  return { ...res.body, orgId };
}

async function api<T = any>(auth: Auth, route: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  const res = await fetchJson<T>(`${API_URL}${route}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${auth.accessToken}`,
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${route} returned ${res.status}: ${res.text.slice(0, 500)}`);
  }
  return res.body;
}

async function loginUi(page: Page) {
  await page.goto(`${WEB_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#login-email').fill(EMAIL);
  await page.locator('#login-password').fill(PASSWORD);
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/api/auth/login'),
    { timeout: 15_000 },
  ).catch(() => null);
  const shellPromise = page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 }).catch(() => null);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const response = await Promise.race([responsePromise, shellPromise]);
  if (response && 'status' in response && response.status() >= 400) {
    const body = await response.text().catch(() => '');
    throw new Error(`UI login failed: ${response.status()} ${body.slice(0, 240)}`);
  }
  if (page.url().includes('/login')) {
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
  }
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
}

async function getSpaces(auth: Auth): Promise<Space[]> {
  const body = await api<any>(auth, '/api/spaces');
  return asArray<Space>(body, ['spaces']);
}

async function createScenarioSpace(auth: Auth, scenario: Scenario): Promise<Space> {
  const suffix = RUN_ID.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase();
  const name = `mini-${scenario.id}-${suffix}`.slice(0, 80);
  return api<Space>(auth, '/api/spaces', {
    method: 'POST',
    body: JSON.stringify({
      name,
      type: scenario.spaceType ?? 'public',
      description: `Temporary mini-batch certification space for ${scenario.title}.`,
    }),
  });
}

async function archiveScenarioSpace(auth: Auth, space: Space) {
  if (!CLEANUP_SPACES || !space.name?.startsWith('mini-')) return;
  await api(auth, `/api/spaces/${encodeURIComponent(space.id)}`, { method: 'DELETE' })
    .catch((err) => {
      console.warn(`[cleanup] Failed to archive #${space.name}:`, err instanceof Error ? err.message : String(err));
    });
}

function pickSpace(spaces: Space[], preference: string[]): Space {
  const normalized = new Map(spaces.map((space) => [(space.name || '').toLowerCase(), space]));
  for (const name of preference) {
    const exact = normalized.get(name.toLowerCase());
    if (exact) return exact;
  }
  return spaces.find((space) => space.type === 'public') ?? spaces[0]!;
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const started = Date.now();
  let last: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value as T;
      last = value;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)}`);
}

async function sendChatMessage(page: Page, space: Space, content: string): Promise<string> {
  await page.goto(`${WEB_URL}/chat?space=${encodeURIComponent(space.id)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  const editor = page.locator('[contenteditable="true"].deft-editor').last();
  await editor.waitFor({ state: 'visible', timeout: 25_000 });
  await editor.click();
  await editor.fill(content);
  const sendButton = page.getByRole('button', { name: /send message/i }).last();
  await waitFor('send button enabled', async () => {
    const disabled = await sendButton.evaluate((button) => (button as HTMLButtonElement).disabled).catch(() => true);
    return disabled ? null : true;
  }, { timeoutMs: 10_000, intervalMs: 250 });
  const post = page.waitForResponse(
    (response) => {
      if (response.request().method() !== 'POST') return false;
      try {
        const url = new URL(response.url());
        return url.pathname === `/api/messages/${space.id}` || url.pathname.startsWith(`/api/messages/${space.id}/`);
      } catch {
        return false;
      }
    },
    { timeout: 30_000 },
  );
  await sendButton.click();
  const response = await post;
  if (response.status() >= 400) {
    const body = await response.text().catch(() => '');
    throw new Error(`Message send failed with ${response.status()}: ${body.slice(0, 240)}`);
  }
  const responseBody = await response.json().catch(() => null);
  if (!responseBody?.id) throw new Error('Message send did not return an id');
  return responseBody.id;
}

async function screenshot(page: Page, scenarioId: string, label: string): Promise<string> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${scenarioId}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function waitForClassifications(orgId: string, messageIds: string[]) {
  return waitFor('message classifications', async () => {
    const rows = await db
      .select({
        message_id: messageClassifications.message_id,
        intent: messageClassifications.intent,
        confidence: messageClassifications.confidence,
        agent_mentioned: messageClassifications.agent_mentioned,
        blocked: messageClassifications.blocked,
        memorable_facts: messageClassifications.memorable_facts,
        decision: messageClassifications.decision,
      })
      .from(messageClassifications)
      .where(and(
        eq(messageClassifications.org_id, orgId),
        inArray(messageClassifications.message_id, messageIds),
      ));
    return rows.length > 0 ? rows : null;
  }, { timeoutMs: 35_000, intervalMs: 1_000 }).catch(() => []);
}

async function collectEffects(orgId: string, messageIds: string[], startedAt: Date) {
  const [actions, intents, pages] = await Promise.all([
    db.select({
      id: agentActions.id,
      action: agentActions.action,
      source: agentActions.source,
      approval_status: agentActions.approval_status,
      message_id: agentActions.message_id,
      params: agentActions.params,
      created_at: agentActions.created_at,
      executed_at: agentActions.executed_at,
      error: agentActions.error,
    })
      .from(agentActions)
      .where(and(eq(agentActions.org_id, orgId), gte(agentActions.created_at, startedAt)))
      .orderBy(desc(agentActions.created_at))
      .limit(200),
    db.select({
      id: workIntents.id,
      kind: workIntents.kind,
      status: workIntents.status,
      proposed_action: workIntents.proposed_action,
      source_message_id: workIntents.source_message_id,
      title: workIntents.title,
      summary: workIntents.summary,
      metadata: workIntents.metadata,
      created_at: workIntents.created_at,
    })
      .from(workIntents)
      .where(and(eq(workIntents.org_id, orgId), gte(workIntents.created_at, startedAt)))
      .orderBy(desc(workIntents.created_at))
      .limit(200),
    db.select({
      id: wikiPages.id,
      title: wikiPages.title,
      type: wikiPages.type,
      scope: wikiPages.scope,
      origin_message_id: wikiPages.origin_message_id,
      origin_space_id: wikiPages.origin_space_id,
      content: wikiPages.content,
      summary: wikiPages.summary,
      metadata: wikiPages.metadata,
      created_at: wikiPages.created_at,
      updated_at: wikiPages.updated_at,
    })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.is_deleted, false), gte(wikiPages.updated_at, startedAt)))
      .orderBy(desc(wikiPages.updated_at))
      .limit(200),
  ]);

  return {
    actions: actions.filter((row) => row.message_id && messageIds.includes(row.message_id) || containsAnyMessageId(row.params, messageIds)),
    intents: intents.filter((row) => row.source_message_id && messageIds.includes(row.source_message_id) || containsAnyMessageId(row.metadata, messageIds)),
    wiki: pages.filter((row) => row.origin_message_id && messageIds.includes(row.origin_message_id) || containsAnyMessageId(row.metadata, messageIds)),
  };
}

function scoreScenario(result: ScenarioResult) {
  const knowledgeActions = result.actions.filter((action) =>
    ['wiki_create', 'wiki_update'].includes(String(action.action)) ||
    JSON.stringify(action).includes('wiki_create') ||
    JSON.stringify(action).includes('wiki_update')
  );
  const taskActions = result.actions.filter((action) =>
    ['create_task', 'task_create', 'task_update', 'update_task', 'task_transition'].includes(String(action.action))
  );

  if (result.expectation.wiki === 'none' && (knowledgeActions.length > 0 || result.wiki.length > 0)) {
    result.checks.push({
      status: 'fail',
      name: 'No passive wiki capture expected',
      detail: { knowledgeActions: knowledgeActions.length, wiki: result.wiki.length },
    });
  } else if (result.expectation.wiki === 'some' && knowledgeActions.length === 0 && result.wiki.length === 0) {
    result.checks.push({ status: 'fail', name: 'Durable wiki capture expected', detail: 'No wiki create/update was traced to this scenario.' });
  } else {
    result.checks.push({ status: 'pass', name: `Wiki expectation: ${result.expectation.wiki}` });
  }

  if (result.expectation.task === 'none' && taskActions.length > 0) {
    result.checks.push({ status: 'fail', name: 'No task action expected', detail: taskActions.map((item) => item.action) });
  } else if (result.expectation.task === 'mention' && taskActions.length === 0) {
    result.checks.push({ status: 'warn', name: 'Defty mention task action expected', detail: 'No create/update task action was found yet.' });
  } else {
    result.checks.push({ status: 'pass', name: `Task expectation: ${result.expectation.task}` });
  }

  const leaked = result.wiki.some(hasSocialLeak) || knowledgeActions.some(hasSocialLeak);
  if (leaked) {
    result.checks.push({ status: 'fail', name: 'No social/lunch leakage in knowledge', detail: 'Social terms appeared in traced wiki/action payloads.' });
  } else {
    result.checks.push({ status: 'pass', name: 'No social/lunch leakage in traced knowledge payloads' });
  }
}

async function runScenario(page: Page, auth: Auth, spaces: Space[], scenario: Scenario): Promise<ScenarioResult> {
  const space = await createScenarioSpace(auth, scenario).catch(() => pickSpace(spaces, scenario.spacePreference));
  const startedAt = new Date();
  const result: ScenarioResult = {
    id: scenario.id,
    title: scenario.title,
    space,
    about: scenario.about,
    expectation: scenario.expectation,
    messageIds: [],
    messageCount: scenario.messages.length,
    classifications: [],
    actions: [],
    intents: [],
    wiki: [],
    screenshots: [],
    checks: [],
  };

  console.log(`\n[SCENARIO] ${scenario.title} in #${space.name}`);
  for (const content of scenario.messages) {
    const id = await sendChatMessage(page, space, content);
    result.messageIds.push(id);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  result.screenshots.push(await screenshot(page, scenario.id, 'chat'));

  const classifications = await waitForClassifications(auth.orgId, result.messageIds);
  result.classifications = classifications.map(toRecord);

  await api(auth, `/api/spaces/${encodeURIComponent(space.id)}/knowledge/capture-discussion`, {
    method: 'POST',
    body: JSON.stringify({ lookback_minutes: 15 }),
  });

  const waitMs = scenario.expectation.wiki === 'some' || scenario.expectation.task === 'mention'
    ? Number.parseInt(process.env.DEFT_CHAT_MINI_EFFECT_WAIT_MS ?? '30000', 10)
    : Number.parseInt(process.env.DEFT_CHAT_MINI_EFFECT_WAIT_MS ?? '12000', 10);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const effects = await collectEffects(auth.orgId, result.messageIds, startedAt);

  result.actions = effects.actions.map(toRecord);
  result.intents = effects.intents.map(toRecord);
  result.wiki = effects.wiki.map(toRecord);
  scoreScenario(result);
  await archiveScenarioSpace(auth, space);
  result.checks.forEach((check) => console.log(`[${check.status.toUpperCase()}] ${scenario.id}: ${check.name}`));
  return result;
}

async function writeReports() {
  const allChecks = artifact.results.flatMap((result) => result.checks);
  artifact.summary.pass = allChecks.filter((check) => check.status === 'pass').length;
  artifact.summary.warn = allChecks.filter((check) => check.status === 'warn').length;
  artifact.summary.fail = allChecks.filter((check) => check.status === 'fail').length;
  artifact.finished_at = new Date().toISOString();
  await fs.writeFile(JSON_REPORT, JSON.stringify(artifact, null, 2), 'utf8');
  await fs.writeFile(HTML_REPORT, renderReport(), 'utf8');
}

function renderReport(): string {
  const cards = artifact.results.map((result) => {
    const checks = result.checks.map((check) => `
      <li><span class="pill ${check.status}">${check.status.toUpperCase()}</span> ${escapeHtml(check.name)}${check.detail ? `<pre>${escapeHtml(JSON.stringify(check.detail, null, 2))}</pre>` : ''}</li>
    `).join('');
    const shots = result.screenshots.map((shot) => `<img src="${escapeHtml(shot)}" alt="${escapeHtml(result.title)} screenshot" />`).join('');
    return `
      <section class="card">
        <div class="card-head">
          <div>
            <p class="eyebrow">${escapeHtml(result.id)} · #${escapeHtml(result.space.name)}</p>
            <h2>${escapeHtml(result.title)}</h2>
          </div>
          <div class="metric">${result.messageCount}<span>messages</span></div>
        </div>
        <p>${escapeHtml(result.about)}</p>
        <ul class="checks">${checks}</ul>
        <div class="grid">
          <div><h3>Actions</h3><pre>${escapeHtml(JSON.stringify(result.actions, null, 2))}</pre></div>
          <div><h3>Wiki</h3><pre>${escapeHtml(JSON.stringify(result.wiki, null, 2))}</pre></div>
        </div>
        <div class="screens">${shots}</div>
      </section>
    `;
  }).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Chat Episode Mini-Batch Certification - ${escapeHtml(RUN_ID)}</title>
  <style>
    :root { color-scheme: dark; --bg:#0f0f12; --panel:#181820; --text:#f3f1f8; --muted:#a7a0b8; --border:#31303b; --pass:#4ade80; --warn:#fbbf24; --fail:#fb7185; --accent:#7c5cff; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: radial-gradient(circle at 60% 0%, rgba(124,92,255,.18), transparent 34%), var(--bg); color:var(--text); }
    main { max-width: 1180px; margin: 0 auto; padding: 44px 28px 80px; }
    h1 { font-size: 40px; line-height: 1.05; margin: 0 0 12px; letter-spacing: -0.03em; }
    h2 { font-size: 24px; margin: 0 0 8px; }
    h3 { margin: 0 0 8px; color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: .08em; }
    p { color: var(--muted); line-height: 1.6; }
    .summary { display:flex; gap:12px; flex-wrap:wrap; margin: 24px 0 28px; }
    .summary div, .card { border:1px solid var(--border); background: rgba(24,24,32,.88); border-radius: 10px; box-shadow: 0 20px 70px rgba(0,0,0,.24); }
    .summary div { padding:14px 16px; min-width: 130px; }
    .summary strong { display:block; font-size:28px; }
    .summary span { color:var(--muted); font-size:13px; }
    .card { padding: 22px; margin: 18px 0; }
    .card-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
    .eyebrow { margin:0 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#aaa2bd; }
    .metric { text-align:right; font-size:30px; font-weight:800; color:var(--text); }
    .metric span { display:block; font-size:12px; color:var(--muted); font-weight:500; }
    .pill { display:inline-flex; align-items:center; border-radius:999px; padding:3px 8px; font-size:11px; font-weight:800; margin-right:6px; }
    .pass { background: rgba(74,222,128,.14); color: var(--pass); }
    .warn { background: rgba(251,191,36,.14); color: var(--warn); }
    .fail { background: rgba(251,113,133,.14); color: var(--fail); }
    .checks { list-style:none; padding:0; margin:16px 0; display:grid; gap:10px; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap:14px; margin-top:16px; }
    pre { overflow:auto; max-height:360px; border:1px solid var(--border); background:#101017; border-radius:8px; padding:12px; color:#d8d3e6; font-size:12px; white-space:pre-wrap; }
    .screens { display:grid; gap:12px; margin-top:16px; }
    img { width:100%; border-radius:8px; border:1px solid var(--border); background:#111; }
    @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } h1 { font-size:32px; } }
  </style>
</head>
<body>
<main>
  <p class="eyebrow">Deft chat governance</p>
  <h1>Episode-Level Mini-Batch Certification</h1>
  <p>Fast replacement for the week-long simulation. Each batch uses natural chat, tracks actual message IDs, triggers quiet discussion capture, and validates wiki/task effects.</p>
  <div class="summary">
    <div><strong>${artifact.summary.pass}</strong><span>passed checks</span></div>
    <div><strong>${artifact.summary.warn}</strong><span>warnings</span></div>
    <div><strong>${artifact.summary.fail}</strong><span>failed checks</span></div>
    <div><strong>${artifact.results.length}</strong><span>scenarios</span></div>
    <div><strong>${CLEANUP_SPACES ? 'on' : 'off'}</strong><span>space cleanup</span></div>
  </div>
  ${cards}
</main>
</body>
</html>`;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const auth = await loginApi();
  const spaces = await getSpaces(auth);
  if (spaces.length === 0) throw new Error('No spaces available');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  try {
    await loginUi(page);
    for (const scenario of scenarios) {
      try {
        const result = await runScenario(page, auth, spaces, scenario);
        artifact.results.push(result);
      } catch (err) {
        const space = pickSpace(spaces, scenario.spacePreference);
        artifact.results.push({
          id: scenario.id,
          title: scenario.title,
          space,
          about: scenario.about,
          expectation: scenario.expectation,
          messageIds: [],
          messageCount: scenario.messages.length,
          classifications: [],
          actions: [],
          intents: [],
          wiki: [],
          screenshots: [],
          checks: [{
            status: 'fail',
            name: 'Scenario runner failed',
            detail: err instanceof Error ? err.message : String(err),
          }],
        });
      }
      await writeReports();
    }
  } finally {
    await browser.close();
  }

  await writeReports();
  console.log(`\nReport: ${HTML_REPORT}`);
  if (artifact.summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
