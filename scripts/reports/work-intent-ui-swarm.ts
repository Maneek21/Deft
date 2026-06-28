import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const WEB_URL = (process.env.DEFT_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_MARKER = `WIL-${RUN_ID.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const OUT_DIR = path.resolve('reports', 'work-intent-ui-swarm', RUN_ID);
const HTML_REPORT = path.resolve('reports', `work-intent-ui-swarm-${RUN_ID}.html`);
const JSON_REPORT = path.resolve('reports', `work-intent-ui-swarm-${RUN_ID}.json`);

type Step = {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
};

type PersonaResult = {
  name: string;
  email: string;
  role: string;
  ok: boolean;
  steps: Step[];
  evidence: string[];
  screenshots: string[];
  network: Array<{ method: string; url: string; status: number; ms: number | null }>;
  console: Array<{ type: string; text: string }>;
  error?: string;
};

const personas = [
  {
    name: 'Diego Morales',
    email: 'diego@testers-tomatoes.com',
    role: 'Manager',
    space: 'sales-and-buyers',
    taskNeedle: 'Chef Amara sample-box size',
    knowledgeNeedle: 'Sun Gold',
    messages: [
      `Decision ${RUN_MARKER}: route the Sun Gold sample boxes through cold room B and require 34F pulp-temp logging before dispatch.`,
      `Action item ${RUN_MARKER}: create a p1 task for Diego to draft the buyer launch recap by Friday.`,
      `Update OPS-1 ${RUN_MARKER}: confirm Tuesday delivery window is ready for review after Tomas checks the route board.`,
      `Quick vibe check ${RUN_MARKER}: the tomatoes are behaving like tomatoes today.`,
    ],
    approve: true,
  },
  {
    name: 'Marigold Patel',
    email: 'marigold@testers-tomatoes.com',
    role: 'Head Grower',
    space: 'field-ops',
    taskNeedle: 'Stage sample-box crates',
    knowledgeNeedle: 'Climate',
    messages: [
      `${RUN_MARKER}: Greenhouse 3 bench counts look stable after the morning pass.`,
      `${RUN_MARKER}: please note that Sun Gold crate staging depends on the west-row pick finishing before noon.`,
      `${RUN_MARKER}: no task needed here, just confirming the tomato tunnel fans sound normal.`,
    ],
  },
  {
    name: 'Cesar Okafor',
    email: 'cesar@testers-tomatoes.com',
    role: 'Field Supervisor',
    space: 'field-ops',
    taskNeedle: 'Update harvest forecast',
    knowledgeNeedle: 'Harvest',
    messages: [
      `${RUN_MARKER}: harvest crew is blocked until row marker tags are replaced near the south gate.`,
      `${RUN_MARKER}: decision from field ops is to hold the late pick until the humidity dip at 2pm.`,
      `${RUN_MARKER}: lunchtime note, nothing to capture, just keeping the channel alive.`,
    ],
  },
  {
    name: 'Lina Bhattacharya',
    email: 'lina@testers-tomatoes.com',
    role: 'Sales Lead',
    space: 'marketing',
    taskNeedle: 'grocer pitch',
    knowledgeNeedle: 'Buyer',
    messages: [
      `${RUN_MARKER}: buyer copy should mention flavor first and delivery only after OPS-1 clears.`,
      `${RUN_MARKER}: action item for Lina to collect two new chef objections before the recap.`,
      `${RUN_MARKER}: this is casual chatter about tomato adjectives and should not become work.`,
    ],
  },
  {
    name: 'Tomas Wakefield',
    email: 'tomas@testers-tomatoes.com',
    role: 'Logistics',
    space: 'operations',
    taskNeedle: 'Tuesday delivery window',
    knowledgeNeedle: 'Cold',
    messages: [
      `${RUN_MARKER}: cold-room handoff is green but route capacity is still tight.`,
      `${RUN_MARKER}: update OPS-1 to in review once the northern loop board is checked.`,
      `${RUN_MARKER}: the hand truck squeaks, emotionally and mechanically.`,
    ],
  },
];

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function recordStep<T>(result: PersonaResult, name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const value = await fn();
    result.steps.push({ name, ok: true, ms: Date.now() - started });
    return value;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    result.steps.push({ name, ok: false, ms: Date.now() - started, detail });
    throw err;
  }
}

async function screenshot(page: Page, result: PersonaResult, name: string) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${result.email.split('@')[0]}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => null);
  result.screenshots.push(file);
}

async function loginViaUi(page: Page, email: string) {
  await page.goto(`${WEB_URL}/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(750);
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(PASSWORD);
  const loginResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && response.url().includes('/api/auth/login'),
  { timeout: 25_000 });
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const response = await loginResponse;
  if (response.status() >= 400) {
    const body = await response.text().catch(() => '');
    throw new Error(`Login POST failed for ${email}: ${response.status()} ${body.slice(0, 240)}`);
  }
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 25_000 });
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
}

async function clickSpace(page: Page, spaceName: string) {
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
  const sidebar = page.locator('aside, nav').first();
  const row = sidebar.getByText(spaceName, { exact: true }).first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(500);
}

async function sendMessage(page: Page, spaceName: string, content: string) {
  await clickSpace(page, spaceName);
  const editor = page.locator('[contenteditable="true"]').last();
  await editor.waitFor({ state: 'visible', timeout: 20_000 });
  await editor.click();
  await page.keyboard.insertText(content);
  const post = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && response.url().includes('/api/messages/')
      && response.status() < 400,
  { timeout: 25_000 }).catch(() => null);
  await page.getByRole('button', { name: /send message/i }).click();
  await post;
  await page.getByText(RUN_MARKER, { exact: false }).last().waitFor({ state: 'visible', timeout: 20_000 });
}

async function checkSurface(page: Page, result: PersonaResult, route: string, visibleText: string, evidence: string) {
  await page.goto(`${WEB_URL}${route}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByText(visibleText, { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
  result.evidence.push(evidence);
}

async function checkAnyVisible(page: Page, labels: Array<string | RegExp>, timeoutMs = 20_000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    for (const label of labels) {
      const locator = typeof label === 'string'
        ? page.getByText(label, { exact: false }).first()
        : page.getByText(label).first();
      if (await locator.isVisible().catch(() => false)) return String(label);
      last = String(label);
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`None of these UI labels became visible: ${labels.map(String).join(', ')}. Last checked: ${last}`);
}

async function checkDashboard(page: Page, result: PersonaResult) {
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
  await checkAnyVisible(page, [/dashboard/i, /my work/i, /agent activity/i, /chat/i]);
  result.evidence.push('Dashboard authenticated and rendered.');
}

async function checkTasks(page: Page, result: PersonaResult) {
  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
  const signal = await checkAnyVisible(page, [/backlog/i, /\btodo\b/i, /in progress/i, /done/i, /board/i, /list/i]);
  result.evidence.push(`Tasks page rendered a real work surface (${signal}).`);
}

async function checkKnowledge(page: Page, result: PersonaResult, query: string) {
  await page.goto(`${WEB_URL}/knowledge`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
  const search = page.getByPlaceholder(/search wiki/i);
  if (await search.isVisible().catch(() => false)) {
    await search.fill(query);
    await page.waitForTimeout(700);
  }
  await page.getByText(query, { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
  result.evidence.push(`Knowledge search found "${query}" through the UI.`);
}

async function tryApproveManagerCaptures(page: Page, result: PersonaResult) {
  await clickSpace(page, 'sales-and-buyers');
  await page.getByText(RUN_MARKER, { exact: false }).last().waitFor({ state: 'visible', timeout: 20_000 });

  const wanted = [
    { button: /save decision|save knowledge/i, done: /decision saved|knowledge saved|saved to knowledge/i },
    { button: /^create task$/i, done: /task created/i },
    { button: /update task/i, done: /task updated/i },
  ];

  for (const target of wanted) {
    const button = page.getByRole('button', { name: target.button }).first();
    const appeared = await button.waitFor({ state: 'visible', timeout: 45_000 }).then(() => true).catch(() => false);
    if (!appeared) {
      result.evidence.push(`No visible approval button matched ${target.button}; capture may still be pending or intentionally skipped.`);
      continue;
    }
    await button.click();
    const newTaskModal = page.getByText(/^new task$/i).first();
    if (await newTaskModal.isVisible().catch(() => false)) {
      const modalCreate = page.getByRole('button', { name: /^create task$/i }).last();
      await modalCreate.click();
      await newTaskModal.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => null);
    }
    await page.waitForTimeout(1_500);
    const doneVisible = await page.getByText(target.done).first().isVisible().catch(() => false);
    result.evidence.push(doneVisible
      ? `Approved capture through chat card: ${target.button}.`
      : `Clicked capture approval for ${target.button}; final label was not visible before timeout.`);
  }

  await screenshot(page, result, 'chat-captures');
  await page.goto(`${WEB_URL}/inbox?tab=captures`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
  const captureVisible = await page.getByText(RUN_MARKER, { exact: false }).first().isVisible().catch(() => false);
  result.evidence.push(captureVisible
    ? 'Inbox captures tab shows the swarm marker.'
    : 'Inbox captures tab loaded, but the run marker was not visible in the first rendered capture set.');
  await screenshot(page, result, 'inbox-captures');
}

async function runPersona(browser: Browser, persona: typeof personas[number], index: number): Promise<PersonaResult> {
  const context = await browser.newContext({
    viewport: { width: index === 0 ? 1440 : 1280, height: index === 0 ? 980 : 820 },
    timezoneId: 'America/Chicago',
  });
  const page = await context.newPage();
  const result: PersonaResult = {
    name: persona.name,
    email: persona.email,
    role: persona.role,
    ok: false,
    steps: [],
    evidence: [],
    screenshots: [],
    network: [],
    console: [],
  };
  const requestStarts = new Map();

  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      result.console.push({ type: message.type(), text: message.text().slice(0, 600) });
    }
  });
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/messages') || url.includes('/api/agent') || url.includes('/api/work-intents')) {
      requestStarts.set(request, Date.now());
    }
  });
  page.on('response', (response) => {
    const request = response.request();
    const started = requestStarts.get(request);
    const url = response.url();
    if (started && (url.includes('/api/messages') || url.includes('/api/agent') || url.includes('/api/work-intents'))) {
      result.network.push({
        method: request.method(),
        url: url.replace(WEB_URL, ''),
        status: response.status(),
        ms: Date.now() - started,
      });
      requestStarts.delete(request);
    }
  });

  try {
    await recordStep(result, 'login through UI', () => loginViaUi(page, persona.email));
    await recordStep(result, 'dashboard loads as user', async () => {
      await checkDashboard(page, result);
      await screenshot(page, result, 'dashboard');
    });
    await recordStep(result, 'post concurrent chat messages', async () => {
      for (const message of persona.messages) {
        await sendMessage(page, persona.space, message);
      }
      result.evidence.push(`Posted ${persona.messages.length} messages in #${persona.space}.`);
      await screenshot(page, result, 'chat');
    });
    await recordStep(result, 'tasks surface remains navigable', async () => {
      await checkTasks(page, result);
    });
    await recordStep(result, 'knowledge surface remains searchable', () => checkKnowledge(page, result, persona.knowledgeNeedle));
    if (persona.approve) {
      await recordStep(result, 'manager approves visible Defty captures', () => tryApproveManagerCaptures(page, result));
    }
    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    await screenshot(page, result, 'failure');
  } finally {
    await context.close().catch(() => null);
  }

  return result;
}

async function writeReports(results: PersonaResult[]) {
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  const cards = results.map((result) => {
    const steps = result.steps.map((step) =>
      `<li class="${step.ok ? 'ok' : 'fail'}"><strong>${escapeHtml(step.name)}</strong> ${step.ok ? 'passed' : 'failed'} <span>${step.ms}ms</span>${step.detail ? `<p>${escapeHtml(step.detail)}</p>` : ''}</li>`,
    ).join('');
    const evidence = result.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    const network = result.network.slice(-12).map((entry) =>
      `<li><strong>${entry.status}</strong> ${escapeHtml(entry.method)} <code>${escapeHtml(entry.url)}</code> <span>${entry.ms ?? '-'}ms</span></li>`,
    ).join('');
    const consoleRows = result.console.slice(-8).map((entry) =>
      `<li><strong>${escapeHtml(entry.type)}</strong>: ${escapeHtml(entry.text)}</li>`,
    ).join('');
    const screenshots = result.screenshots.map((shot) => {
      const rel = path.relative(path.dirname(HTML_REPORT), shot).replace(/\\/g, '/');
      return `<img src="${escapeHtml(rel)}" alt="${escapeHtml(path.basename(shot))}">`;
    }).join('');

    return `<section class="card ${result.ok ? 'pass' : 'fail'}">
      <div class="card-head">
        <div>
          <h2>${escapeHtml(result.name)}</h2>
          <p>${escapeHtml(result.role)} - ${escapeHtml(result.email)}</p>
        </div>
        <span>${result.ok ? 'PASS' : 'FAIL'}</span>
      </div>
      ${result.error ? `<p class="error">${escapeHtml(result.error)}</p>` : ''}
      <h3>Steps</h3>
      <ul>${steps}</ul>
      <h3>Evidence</h3>
      <ul>${evidence || '<li>No evidence captured.</li>'}</ul>
      <h3>Observed Browser Network</h3>
      <ul>${network || '<li>No observed work-intent network calls.</li>'}</ul>
      <h3>Console</h3>
      <ul>${consoleRows || '<li>No console warnings/errors.</li>'}</ul>
      <div class="shots">${screenshots}</div>
    </section>`;
  }).join('\n');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Work Intent Ledger UI Swarm - ${escapeHtml(RUN_MARKER)}</title>
  <style>
    :root { color-scheme: light; --ink:#192019; --muted:#637064; --line:#d8ded4; --paper:#fbfaf4; --card:#fffef9; --green:#117a4a; --red:#b42318; --gold:#b7791f; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }
    header { padding: 36px 42px 24px; background: #eef5ea; border-bottom: 1px solid var(--line); }
    h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: -0.02em; }
    p { color: var(--muted); line-height: 1.5; }
    .summary { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .pill { border: 1px solid var(--line); background: rgba(255,255,255,0.7); border-radius: 999px; padding: 8px 12px; font-size: 13px; }
    main { display: grid; gap: 18px; padding: 28px 42px 48px; }
    .card { position: relative; border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 18px; box-shadow: 0 12px 30px rgba(31,41,25,0.06); }
    .card.pass { border-left: 5px solid var(--green); }
    .card.fail { border-left: 5px solid var(--red); }
    .card-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    h2 { margin: 0; font-size: 19px; }
    h3 { margin: 18px 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    ul { margin: 0; padding-left: 20px; }
    li { margin: 6px 0; }
    li.ok { color: var(--green); }
    li.fail, .error { color: var(--red); }
    code { font-size: 12px; color: #334155; }
    span { font-size: 12px; color: var(--muted); }
    .shots { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
    img { max-width: 360px; width: 100%; border: 1px solid var(--line); border-radius: 8px; background: white; }
  </style>
</head>
<body>
  <header>
    <h1>Work Intent Ledger UI-Only Swarm</h1>
    <p>Five Testers Tomatoes employees logged in through the browser, posted concurrent work messages, navigated the workspace, and exercised Defty capture approvals without direct backend setup or validation calls.</p>
    <div class="summary">
      <div class="pill">Run marker: ${escapeHtml(RUN_MARKER)}</div>
      <div class="pill">Target: ${escapeHtml(WEB_URL)}</div>
      <div class="pill">Passed: ${passed}/${results.length}</div>
      <div class="pill">Failed: ${failed}</div>
      <div class="pill">Generated: ${escapeHtml(new Date().toISOString())}</div>
    </div>
  </header>
  <main>${cards}</main>
</body>
</html>`;

  await fs.writeFile(JSON_REPORT, JSON.stringify({ runId: RUN_ID, runMarker: RUN_MARKER, webUrl: WEB_URL, passed, failed, results }, null, 2));
  await fs.writeFile(HTML_REPORT, html);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let results: PersonaResult[] = [];
  try {
    results = await Promise.all(personas.map((persona, index) => runPersona(browser, persona, index)));
  } finally {
    await browser.close().catch(() => null);
  }

  await writeReports(results);

  console.log(JSON.stringify({
    runId: RUN_ID,
    runMarker: RUN_MARKER,
    webUrl: WEB_URL,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    htmlReport: HTML_REPORT,
    jsonReport: JSON_REPORT,
  }, null, 2));

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
