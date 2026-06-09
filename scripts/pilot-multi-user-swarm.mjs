import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3301';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.resolve('reports', `multi-user-swarm-${RUN_ID}`);
const HTML_REPORT = path.resolve('reports', 'multi-user-swarm-report-2026-06-09.html');
const JSON_REPORT = path.resolve('reports', 'multi-user-swarm-report-2026-06-09.json');

const PASSWORD = 'tomato123';

const personas = [
  {
    name: 'Marigold Patel',
    email: 'marigold@testers-tomatoes.com',
    role: 'Head Grower',
    chatSpace: 'field-ops',
    project: 'Greenhouse 3 Build-out',
    taskNeedle: 'Dehumidifier',
    knowledgeQuery: 'Greenhouse Climate',
    message:
      'Swarm check: transplant benches look good. I am logging greenhouse humidity risk and need GH-3 dehumidifier notes kept visible.',
  },
  {
    name: 'Cesar Okafor',
    email: 'cesar@testers-tomatoes.com',
    role: 'Field Supervisor',
    chatSpace: 'harvest-room',
    project: 'Spring 2026 Harvest',
    taskNeedle: 'hail netting',
    knowledgeQuery: 'Irrigation Schedules',
    message:
      'Swarm check: south field crew finished first pass. Please keep Roma firmness notes attached to harvest planning.',
  },
  {
    name: 'Lina Bhattacharya',
    email: 'lina@testers-tomatoes.com',
    role: 'Sales Lead',
    chatSpace: 'sales-and-buyers',
    project: 'Wholesale Expansion',
    taskNeedle: 'Sunbelt',
    knowledgeQuery: 'Wholesale Buyer',
    message:
      'Swarm check: buyer follow-up is moving. I need the cold-chain promise and pricing story ready before the next call.',
  },
  {
    name: 'Tomas Wakefield',
    email: 'tomas@testers-tomatoes.com',
    role: 'Logistics',
    chatSpace: 'logistics',
    project: 'Wholesale Expansion',
    taskNeedle: 'cold',
    knowledgeQuery: 'Cold-Chain Protocol',
    message:
      'Swarm check: dock schedule is tight. Please keep pulp-temp logging and cold-room handoff visible for the team.',
  },
  {
    name: 'Sage Nakamura',
    email: 'sage@testers-tomatoes.com',
    role: 'QC + Food Safety',
    chatSpace: 'greenhouse',
    project: 'Spring 2026 Harvest',
    taskNeedle: 'pre-GAP',
    knowledgeQuery: 'USDA GAP',
    message:
      'Swarm check: audit binder needs one owner for water logs and one owner for harvest-room sign-in sheets.',
  },
];

function nowMs() {
  return Date.now();
}

async function mark(step, fn, result) {
  const start = nowMs();
  try {
    const value = await fn();
    result.steps.push({ step, ok: true, ms: nowMs() - start });
    return value;
  } catch (error) {
    result.steps.push({
      step,
      ok: false,
      ms: nowMs() - start,
      error: error?.message || String(error),
    });
    throw error;
  }
}

async function login(page, persona) {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: persona.email, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`API login failed for ${persona.email}: ${res.status}`);
  }
  const data = await res.json();
  if (!data.accessToken || !data.refreshToken) {
    throw new Error(`API login did not return tokens for ${persona.email}`);
  }
  await page.context().addInitScript((tokens) => {
    window.localStorage.setItem('deft-access-token', tokens.accessToken);
    window.localStorage.setItem('deft-refresh-token', tokens.refreshToken);
  }, { accessToken: data.accessToken, refreshToken: data.refreshToken });
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
}

async function sendChatMessage(page, persona, result) {
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
  await clickChatSpace(page, persona.chatSpace);
  await page.waitForTimeout(600);

  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type(`${persona.message} [${RUN_ID}]`, { delay: 2 });

  const sendButton = page.getByRole('button', { name: 'Send message' });
  await expectEnabled(sendButton, 'send message');
  await sendButton.click();
  await page.getByText(`[${RUN_ID}]`).waitFor({ state: 'visible', timeout: 10_000 });
  result.evidence.chat = `${persona.chatSpace}: posted and visible`;
}

async function clickChatSpace(page, spaceName) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const button = page.getByRole('button', { name: spaceName, exact: true });
      await button.waitFor({ state: 'visible', timeout: 8_000 });
      await button.click({ timeout: 8_000 });
      await page.waitForTimeout(700);
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(400 + attempt * 250);
    }
  }
  throw lastError;
}

async function checkTasks(page, persona, result) {
  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'domcontentloaded' });
  let projectVisible = false;
  let lastProjectError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const projectButton = page.locator('aside').getByText(persona.project, { exact: true }).first();
      await projectButton.waitFor({ state: 'visible', timeout: 10_000 });
      await projectButton.click({ timeout: 10_000 });
      await page.waitForTimeout(700 + attempt * 300);
      projectVisible = await page.locator('main').getByText(persona.project, { exact: false }).first().isVisible().catch(() => false);
      if (projectVisible) break;
    } catch (error) {
      lastProjectError = error;
    }
  }
  if (!projectVisible) {
    throw new Error(`Project did not become active: ${persona.project}${lastProjectError ? ` (${lastProjectError.message || lastProjectError})` : ''}`);
  }

  let needleVisible = await page.getByText(persona.taskNeedle, { exact: false }).first().isVisible().catch(() => false);
  let scrollPasses = 0;
  while (!needleVisible && scrollPasses < 8) {
    scrollPasses += 1;
    await page.mouse.wheel(0, 650);
    await page.waitForTimeout(250);
    needleVisible = await page.getByText(persona.taskNeedle, { exact: false }).first().isVisible().catch(() => false);
  }
  if (!needleVisible) {
    throw new Error(`Task signal "${persona.taskNeedle}" not discoverable in ${persona.project}`);
  }

  result.evidence.tasks = scrollPasses === 0
    ? `${persona.project}: task signal "${persona.taskNeedle}" visible in first viewport`
    : `${persona.project}: task signal "${persona.taskNeedle}" discoverable after ${scrollPasses} scroll pass${scrollPasses === 1 ? '' : 'es'}`;
}

async function checkKnowledge(page, persona, result) {
  await page.goto(`${WEB_URL}/knowledge`, { waitUntil: 'domcontentloaded' });
  const search = page.getByPlaceholder('Search wiki...');
  await search.fill(persona.knowledgeQuery);
  await page.getByText(persona.knowledgeQuery, { exact: false }).first().waitFor({ state: 'visible', timeout: 12_000 });
  result.evidence.knowledge = `search "${persona.knowledgeQuery}" returned visible wiki context`;
}

async function checkDashboard(page, persona, result) {
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 15_000 });
  if (page.url().includes('/login')) {
    throw new Error(`Dashboard redirected ${persona.email} to login`);
  }
  const firstNameNeedle = persona.name.split(' ')[0].slice(0, 3);
  await page.getByText(firstNameNeedle, { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByRole('link', { name: 'Chat' }).waitFor({ state: 'visible', timeout: 15_000 });
  result.evidence.dashboard = 'authenticated dashboard shell and navigation loaded';
}

async function expectEnabled(locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  const enabled = await locator.isEnabled();
  if (!enabled) throw new Error(`${label} is not enabled`);
}

async function runPersona(browser, persona, index) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    timezoneId: 'America/Chicago',
  });
  const page = await context.newPage();
  const requestStarts = new Map();
  const network = [];
  const consoleErrors = [];
  const result = {
    name: persona.name,
    email: persona.email,
    role: persona.role,
    ok: false,
    startedAt: new Date().toISOString(),
    steps: [],
    evidence: {},
    screenshot: null,
    diagnostics: { network, consoleErrors },
  };

  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleErrors.push({ type: message.type(), text: message.text().slice(0, 500) });
    }
  });
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/wiki')) {
      requestStarts.set(request, Date.now());
    }
  });
  page.on('response', (response) => {
    const request = response.request();
    const started = requestStarts.get(request);
    const url = response.url();
    if (url.includes('/api/wiki')) {
      network.push({
        url,
        status: response.status(),
        ms: started ? Date.now() - started : null,
      });
      requestStarts.delete(request);
    }
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (url.includes('/api/wiki')) {
      const error = request.failure()?.errorText || 'request failed';
      network.push({
        url,
        status: error === 'net::ERR_ABORTED' ? 'canceled' : 'failed',
        error,
      });
      requestStarts.delete(request);
    }
  });

  try {
    await mark('login', () => login(page, persona), result);
    await page.waitForTimeout(index * 250);
    await mark('dashboard', () => checkDashboard(page, persona, result), result);
    await mark('chat post', () => sendChatMessage(page, persona, result), result);
    await mark('task board', () => checkTasks(page, persona, result), result);
    await mark('knowledge search', () => checkKnowledge(page, persona, result), result);
    result.ok = true;
  } catch (error) {
    result.error = error?.message || String(error);
  } finally {
    const screenshotPath = path.join(OUT_DIR, `${persona.email.split('@')[0]}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => null);
    result.screenshot = screenshotPath;
    result.finishedAt = new Date().toISOString();
    await context.close().catch(() => null);
  }

  return result;
}

async function writeReports(results) {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const rows = results
    .map((r) => {
      const stepList = r.steps
        .map((s) => `<li class="${s.ok ? 'ok' : 'fail'}">${s.step}: ${s.ok ? 'OK' : s.error} <span>${s.ms}ms</span></li>`)
        .join('');
      const evidence = Object.entries(r.evidence)
        .map(([k, v]) => `<li><strong>${k}</strong>: ${v}</li>`)
        .join('');
      const network = (r.diagnostics?.network || [])
        .slice(-8)
        .map((n) => `<li><strong>${n.status}</strong> ${n.ms ?? '-'}ms <code>${n.url.replace(/&/g, '&amp;')}</code>${n.error ? ` â€” ${n.error}` : ''}</li>`)
        .join('');
      const consoleErrors = (r.diagnostics?.consoleErrors || [])
        .slice(-6)
        .map((e) => `<li><strong>${e.type}</strong>: ${e.text.replace(/</g, '&lt;')}</li>`)
        .join('');
      const shot = r.screenshot ? `<img src="${path.relative(path.dirname(HTML_REPORT), r.screenshot).replace(/\\/g, '/')}" alt="${r.name} screenshot">` : '';
      return `<section class="card ${r.ok ? 'pass' : 'fail'}">
        <h2>${r.name}</h2>
        <p>${r.role} · ${r.email}</p>
        <div class="badge">${r.ok ? 'PASS' : 'FAIL'}</div>
        ${r.error ? `<p class="error">${r.error}</p>` : ''}
        <h3>Steps</h3>
        <ul>${stepList}</ul>
        <h3>Evidence</h3>
        <ul>${evidence || '<li>No evidence captured</li>'}</ul>
        <h3>Knowledge Network</h3>
        <ul>${network || '<li>No wiki network calls captured</li>'}</ul>
        <h3>Console</h3>
        <ul>${consoleErrors || '<li>No console warnings/errors captured</li>'}</ul>
        ${shot}
      </section>`;
    })
    .join('\n');

  const html = `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>Deft Multi-User Swarm Report - 2026-06-09</title>
    <style>
      body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f8fa; color: #18212f; }
      header { padding: 32px 40px 20px; background: #fff; border-bottom: 1px solid #dfe4ea; }
      h1 { margin: 0 0 8px; font-size: 28px; }
      .summary { display: flex; gap: 12px; margin-top: 18px; flex-wrap: wrap; }
      .pill { border: 1px solid #d8dee8; border-radius: 999px; padding: 8px 12px; background: #fff; }
      main { padding: 24px 40px 48px; display: grid; gap: 18px; }
      .card { background: #fff; border: 1px solid #dfe4ea; border-radius: 8px; padding: 18px; position: relative; }
      .card.pass { border-left: 5px solid #059669; }
      .card.fail { border-left: 5px solid #dc2626; }
      h2 { margin: 0; font-size: 20px; }
      h3 { margin: 18px 0 8px; font-size: 14px; color: #475569; }
      p { color: #475569; }
      ul { margin: 0; padding-left: 20px; }
      li { margin: 5px 0; }
      li.ok { color: #166534; }
      li.fail, .error { color: #991b1b; }
      li span { color: #64748b; font-size: 12px; margin-left: 6px; }
      .badge { position: absolute; right: 18px; top: 18px; font-weight: 700; font-size: 12px; letter-spacing: .08em; }
      img { margin-top: 14px; max-width: 420px; border: 1px solid #dfe4ea; border-radius: 6px; }
    </style>
  </head>
  <body>
    <header>
      <h1>Deft Multi-User Swarm Report</h1>
      <p>Five seeded Testers Tomatoes users worked simultaneously against one local Deft installation.</p>
      <div class="summary">
        <div class="pill">Run: ${RUN_ID}</div>
        <div class="pill">Passed: ${passed}/${results.length}</div>
        <div class="pill">Failed: ${failed}</div>
        <div class="pill">Target: ${WEB_URL}</div>
        <div class="pill">API: ${API_URL}</div>
      </div>
    </header>
    <main>${rows}</main>
  </body>
  </html>`;

  await fs.writeFile(JSON_REPORT, JSON.stringify({ runId: RUN_ID, webUrl: WEB_URL, passed, failed, results }, null, 2));
  await fs.writeFile(HTML_REPORT, html);
}

await fs.mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true });
const started = Date.now();
let results;
try {
  results = await Promise.all(personas.map((persona, index) => runPersona(browser, persona, index)));
} finally {
  await browser.close().catch(() => null);
}
await writeReports(results);

console.log(JSON.stringify({
  runId: RUN_ID,
  elapsedMs: Date.now() - started,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  htmlReport: HTML_REPORT,
  jsonReport: JSON_REPORT,
}, null, 2));

if (results.some((r) => !r.ok)) {
  process.exitCode = 1;
}
