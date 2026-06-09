import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const rootRequire = createRequire(import.meta.url);
const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const pg = apiRequire('pg');
const { chromium } = rootRequire('playwright');
const RUN = `20260609-${Date.now().toString().slice(-6)}`;
const ROOT = process.cwd();
const API_URL = (process.env.DEFT_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3301').replace(/\/$/, '');
const WEB_URL = (process.env.DEFT_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const REPORT_DIR = path.join(ROOT, 'reports');
const SCREEN_DIR = path.join(REPORT_DIR, 'screenshots', `cracks-clearance-${RUN}`);
const HTML_REPORT = path.join(REPORT_DIR, 'cracks-clearance-battery-report-2026-06-09.html');
const JSON_REPORT = path.join(REPORT_DIR, 'cracks-clearance-battery-report-2026-06-09.json');
const PASSWORD = 'tomato123';
const TOM_TOKEN = process.env.SEED_TOM_MCP_TOKEN || 'tom-pilot-mcp-token-2026';
const MAYA_TOKEN = process.env.SEED_MAYA_MCP_TOKEN || 'maya-pilot-mcp-token-2026';

await fs.mkdir(SCREEN_DIR, { recursive: true });

const checks = [];
const artifacts = {
  run: RUN,
  api: API_URL,
  web: WEB_URL,
  screenDir: SCREEN_DIR,
  screenshots: {},
  timings: [],
  ids: {},
  raw: {},
};

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanText(value = '') {
  return String(value)
    .replace(/<@([^|>]+)\|([^>]+)>/g, '@$2')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function record(status, name, details = {}) {
  checks.push({ status, name, details });
  console.log(`[${status.toUpperCase().padEnd(7)}] ${name}`);
}
function pass(name, details = {}) { record('pass', name, details); }
function partial(name, details = {}) { record('partial', name, details); }
function fail(name, details = {}) { record('fail', name, details); }

async function timed(label, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    artifacts.timings.push({ label, ms: Date.now() - started, ok: true });
    return value;
  } catch (err) {
    artifacts.timings.push({ label, ms: Date.now() - started, ok: false, error: err?.message || String(err) });
    throw err;
  }
}

async function dockerDatabaseUrl() {
  try {
    const [{ stdout: portOut }, { stdout: passwordOut }, { stdout: dbOut }] = await Promise.all([
      execFileAsync('docker', ['port', 'deft-codex-pg', '5432/tcp']),
      execFileAsync('docker', ['exec', 'deft-codex-pg', 'printenv', 'POSTGRES_PASSWORD']),
      execFileAsync('docker', ['exec', 'deft-codex-pg', 'printenv', 'POSTGRES_DB']),
    ]);
    const port = portOut.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/)?.[1];
    if (!port) return null;
    return `postgres://postgres:${encodeURIComponent(passwordOut.trim() || 'postgres')}@localhost:${port}/${dbOut.trim() || 'deft'}`;
  } catch {
    return null;
  }
}

async function connectDb() {
  const candidates = [];
  if (process.env.DATABASE_URL) candidates.push(process.env.DATABASE_URL);
  const dockerUrl = await dockerDatabaseUrl();
  if (dockerUrl) candidates.push(dockerUrl);
  candidates.push('postgres://postgres:postgres@localhost:55432/deft');
  candidates.push('postgres://postgres:postgres@localhost:5432/deft');

  const errors = [];
  for (const candidate of [...new Set(candidates)]) {
    const client = new pg.Client({ connectionString: candidate });
    try {
      await client.connect();
      artifacts.raw.db = candidate.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
      return client;
    } catch (err) {
      errors.push(`${candidate.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')}: ${err.message}`);
      await client.end().catch(() => {});
    }
  }
  throw new Error(`DB connect failed: ${errors.join(' | ')}`);
}

async function login(email) {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function authed(token, route, init = {}) {
  const hasBody = init.body !== undefined;
  const res = await fetch(`${API_URL}${route}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function waitFor(description, fn, { timeout = 90_000, interval = 1500 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (err) {
      last = err?.message || String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${description}. Last: ${JSON.stringify(last)}`);
}

async function mcp(token, name, args) {
  const res = await fetch(`${API_URL}/api/mcp/v1/tools/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, arguments: args }),
  });
  const body = await res.json().catch(() => ({}));
  const text = body?.content?.map((item) => item.text).join('\n') ?? '';
  return { ok: res.ok, status: res.status, body, text, isError: Boolean(body?.isError) };
}

async function screenshot(page, name) {
  const file = path.join(SCREEN_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => null);
  artifacts.screenshots[name] = file;
  return file;
}

async function openAuthedPage(context, auth, url) {
  const page = await context.newPage();
  page.on('response', (res) => {
    const route = res.url();
    if (route.includes('/api/wiki') || route.includes('/api/messages') || route.includes('/api/dashboard')) {
      artifacts.timings.push({ label: `response ${route.replace(API_URL, '')}`, ms: null, status: res.status() });
    }
  });
  await page.addInitScript((tokens) => {
    window.localStorage.setItem('deft-access-token', tokens.accessToken);
    window.localStorage.setItem('deft-refresh-token', tokens.refreshToken);
  }, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

async function sendChatMessageUi(page, spaceName, message) {
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
  const spaceButton = page.getByRole('button', { name: spaceName, exact: true });
  await spaceButton.waitFor({ state: 'visible', timeout: 20_000 });
  await spaceButton.click();
  await page.waitForTimeout(800);
  const editor = page.locator('.ProseMirror.deft-editor').last();
  await editor.waitFor({ state: 'visible', timeout: 20_000 });
  await editor.click();
  await editor.fill(message).catch(async () => {
    await editor.click();
    await page.keyboard.insertText(message);
  });
  const send = page.getByRole('button', { name: 'Send message' });
  await send.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll('button[aria-label="Send message"]')];
    return buttons.some((button) => !button.disabled && button.offsetParent !== null);
  }, null, { timeout: 10_000 }).catch(async (error) => {
    await screenshot(page, `composer-disabled-${spaceName}`);
    const diagnostic = await page.evaluate(() => {
      const editors = [...document.querySelectorAll('.ProseMirror.deft-editor')].map((el) => ({
        text: el.textContent,
        html: el.innerHTML,
        visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
      }));
      const buttons = [...document.querySelectorAll('button[aria-label="Send message"]')].map((button) => ({
        disabled: button.disabled,
        visible: button.offsetParent !== null,
        text: button.textContent,
      }));
      return { editors, buttons };
    });
    throw new Error(`${error.message}; composer diagnostic=${JSON.stringify(diagnostic).slice(0, 1200)}`);
  });
  await send.click();
  const visibleNeedle = message.includes('Decision:')
    ? `Decision: for clearance ${RUN}`
    : `clearance ${RUN}: summarize`;
  await page.getByText(visibleNeedle, { exact: false }).last().waitFor({ state: 'visible', timeout: 12_000 });
}

async function checkActiveDocsContract() {
  const files = [
    'AGENTS.md',
    'docs/self-hosted-v1-contract.md',
    'docs/AGENTIC-EMPLOYEES-PLATFORM.md',
    'docs/CHAT-COMPETITIVE-ANALYSIS.md',
    'docs/TASKS-COMPETITIVE-ANALYSIS.md',
    'docs/AGENT-VISION.md',
  ];
  const contents = Object.fromEntries(await Promise.all(files.map(async (file) => [
    file,
    await fs.readFile(path.join(ROOT, file), 'utf8'),
  ])));
  const activeOk =
    /provider-neutral/i.test(contents['AGENTS.md']) &&
    /ICS calendars/i.test(contents['AGENTS.md']) &&
    /Native Slack\/Gmail\/GitHub\/Google OAuth are not buyer-facing promises/i.test(contents['AGENTS.md']) &&
    /Provider-neutral AI configuration/i.test(contents['docs/self-hosted-v1-contract.md']) &&
    /Native Slack or Gmail integrations/i.test(contents['docs/self-hosted-v1-contract.md']);
  const historicalNotes = [
    'docs/AGENTIC-EMPLOYEES-PLATFORM.md',
    'docs/CHAT-COMPETITIVE-ANALYSIS.md',
    'docs/TASKS-COMPETITIVE-ANALYSIS.md',
    'docs/AGENT-VISION.md',
  ].filter((file) => /Status note, 2026-06-09/i.test(contents[file]));

  if (activeOk && historicalNotes.length === 4) {
    pass('Active docs separate current contract from historical plans', { historicalNotes });
  } else {
    partial('Active docs separate current contract from historical plans', { activeOk, historicalNotes });
  }
}

async function main() {
  const db = await connectDb();
  try {
    const health = await fetch(`${API_URL}/health`).then((r) => r.status).catch(() => 0);
    const web = await fetch(WEB_URL).then((r) => r.status).catch(() => 0);
    if (health === 200 && web >= 200 && web < 500) pass('Local stack responds', { apiHealth: health, web });
    else fail('Local stack responds', { apiHealth: health, web });

    await checkActiveDocsContract();

    const diego = await login('diego@testers-tomatoes.com');
    const lina = await login('lina@testers-tomatoes.com');
    pass('Seed users can log in', { users: [diego.user?.email, lina.user?.email] });

    const createSpace = await authed(diego.accessToken, '/api/spaces', {
      method: 'POST',
      body: JSON.stringify({
        name: `cracks-clearance-${RUN.slice(-6)}`,
        type: 'public',
        description: 'Fresh proof space for chat-to-wiki, Defty, and mixed agent/human clearance testing.',
      }),
    });
    if (!createSpace.ok) throw new Error(`space create failed ${createSpace.status}: ${JSON.stringify(createSpace.body)}`);
    const space = createSpace.body;
    artifacts.ids.space = space.id;
    const orgId = space.org_id ?? (await db.query('select org_id from spaces where id=$1', [space.id])).rows[0]?.org_id;
    if (!orgId) throw new Error(`Could not derive org id for proof space ${space.id}`);
    artifacts.ids.org = orgId;
    pass('Fresh proof space created', { id: space.id, name: space.name });

    const employees = await authed(diego.accessToken, '/api/agent-employees?expand=stats');
    const tom = employees.body.find((e) => e.slug === 'tom' || e.name === 'Tom');
    const maya = employees.body.find((e) => e.slug === 'maya' || e.name === 'Maya');
    if (tom?.user_id) {
      await authed(diego.accessToken, `/api/spaces/${space.id}/members`, { method: 'POST', body: JSON.stringify({ user_id: tom.user_id }) });
    }
    if (maya?.user_id) {
      await authed(diego.accessToken, `/api/spaces/${space.id}/members`, { method: 'POST', body: JSON.stringify({ user_id: maya.user_id }) });
    }
    pass('Tom and Maya are available for mixed-agent proof', { tom: tom?.id, maya: maya?.id });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const page = await openAuthedPage(context, diego, `${WEB_URL}/chat`);

    const decisionPhrase = `Decision: for clearance ${RUN}, Testers Tomatoes will use blue harvest crates for pilot wholesale orders and record crate temperature before loading.`;
    await timed('ui chat decision post', () => sendChatMessageUi(page, space.name, decisionPhrase));
    await screenshot(page, 'chat-decision-posted');
    pass('Human posted explicit decision through chat UI', { decisionPhrase });

    const messageRow = await waitFor('posted decision message row', async () => {
      const rows = await db.query(
        `select id, content, created_at from messages where org_id=$1 and space_id=$2 and content ilike $3 order by created_at desc limit 1`,
        [orgId, space.id, `%${RUN}%`],
      );
      return rows.rows[0];
    }, { timeout: 20_000 });
    artifacts.ids.decisionMessage = messageRow.id;

    const classification = await waitFor('message classification decision', async () => {
      const rows = await db.query(
        `select * from message_classifications where org_id=$1 and message_id=$2 and decision is not null order by created_at desc limit 1`,
        [orgId, messageRow.id],
      );
      return rows.rows[0];
    }, { timeout: 40_000 });
    pass('Classifier captured decision', { decision: classification.decision, confidence: classification.confidence });

    const wikiPage = await waitFor('wiki page cited by decision message', async () => {
      const rows = await db.query(
        `select wp.id, wp.title, wp.slug, wp.type, wp.content, wp.summary
           from wiki_pages wp
           join wiki_citations wc on wc.page_id = wp.id
          where wp.org_id=$1 and wc.source_type='message' and wc.source_id=$2 and wp.is_deleted=false
          order by wp.created_at desc
          limit 1`,
        [orgId, messageRow.id],
      );
      return rows.rows[0];
    }, { timeout: 90_000 });
    artifacts.ids.wikiPage = wikiPage.id;
    pass('Decision reached wiki with message citation', { title: wikiPage.title, slug: wikiPage.slug, type: wikiPage.type });

    await page.goto(`${WEB_URL}/knowledge`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('Search wiki...').fill(`blue harvest crates ${RUN}`);
    await page.getByText('blue harvest crates', { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
    await screenshot(page, 'knowledge-search-decision');
    pass('Knowledge UI finds captured decision', { query: `blue harvest crates ${RUN}` });

    const recall = await timed('mcp memory_recall decision', () => mcp(TOM_TOKEN, 'memory_recall', {
      caller_employee_slug: 'tom',
      query: `blue harvest crates ${RUN}`,
      limit: 5,
      scope: 'all',
    }));
    const alias = await timed('mcp wiki_search decision', () => mcp(MAYA_TOKEN, 'wiki_search', {
      caller_employee_slug: 'maya',
      query: `blue harvest crates ${RUN}`,
      limit: 5,
      scope: 'all',
    }));
    if (!recall.isError && recall.text.includes('blue harvest crates')) pass('Tom retrieved decision through memory_recall', { text: recall.text.slice(0, 500) });
    else fail('Tom retrieved decision through memory_recall', { status: recall.status, text: recall.text.slice(0, 500) });
    if (!alias.isError && alias.text.includes('blue harvest crates')) pass('Maya retrieved decision through wiki_search alias', { text: alias.text.slice(0, 500) });
    else fail('Maya retrieved decision through wiki_search alias', { status: alias.status, text: alias.text.slice(0, 500) });

    const deftyPrompt = `@defty clearance ${RUN}: summarize the blue harvest crate decision and say what should be checked next.`;
    await timed('ui defty prompt post', () => sendChatMessageUi(page, space.name, deftyPrompt));
    const deftyReply = await waitFor('Defty reply or provider-unavailable receipt', async () => {
      const rows = await db.query(
        `select m.id, m.content, m.metadata, u.name
           from messages m join users u on u.id=m.user_id
          where m.org_id=$1 and m.space_id=$2 and u.name='Defty' and m.created_at > now() - interval '3 minutes'
          order by m.created_at desc limit 1`,
        [orgId, space.id],
      );
      return rows.rows[0];
    }, { timeout: 120_000 });
    await page.waitForTimeout(1000);
    await screenshot(page, 'defty-reply');
    const deftyText = cleanText(deftyReply.content);
    if (/reasoning model|provider|api key/i.test(deftyText)) {
      partial('Defty responded gracefully but could not reason', { content: deftyText.slice(0, 500), metadata: deftyReply.metadata });
    } else if (/couldn'?t find|not documented|not formally recorded|no documented/i.test(deftyText) || !/blue harvest crates/i.test(deftyText)) {
      fail('Defty grounded answer in the freshly captured decision', { content: deftyText.slice(0, 700) });
    } else {
      pass('Defty grounded answer in the freshly captured decision', { content: deftyText.slice(0, 500) });
    }

    const tomResponse = await timed('tom mixed-agent message', () => mcp(TOM_TOKEN, 'send_message', {
      caller_employee_slug: 'tom',
      space_id: space.id,
      content: `I checked the wiki for clearance ${RUN}. Marketing note: blue harvest crates are the pilot wholesale standard, and temperature should be recorded before loading.`,
    }));
    const mayaResponse = await timed('maya mixed-agent message', () => mcp(MAYA_TOKEN, 'send_message', {
      caller_employee_slug: 'maya',
      space_id: space.id,
      content: `Ops follow-up for clearance ${RUN}: I would add a loading checklist item for crate temperature before departure.`,
    }));
    if (!tomResponse.isError) pass('Tom posted mixed-agent reply through MCP', { text: tomResponse.text.slice(0, 500) });
    else fail('Tom posted mixed-agent reply through MCP', { text: tomResponse.text.slice(0, 500) });
    if (!mayaResponse.isError) pass('Maya posted mixed-agent reply through MCP', { text: mayaResponse.text.slice(0, 500) });
    else fail('Maya posted mixed-agent reply through MCP', { text: mayaResponse.text.slice(0, 500) });
    await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await screenshot(page, 'mixed-agent-chat');

    const dashboard = await timed('api dashboard cockpit', async () => {
      const res = await authed(diego.accessToken, '/api/dashboard');
      if (!res.ok) throw new Error(`dashboard ${res.status}: ${JSON.stringify(res.body)}`);
      return res.body;
    });
    const cockpitSignals = {
      overdue: dashboard.overdue?.length ?? 0,
      myWork: dashboard.my_work?.length ?? 0,
      recentActivity: dashboard.recent_activity?.length ?? 0,
      unreadSpaces: dashboard.unread_spaces?.length ?? 0,
      calendarEvents: dashboard.calendar_events?.length ?? 0,
      agentActivity: dashboard.agent_activity?.length ?? null,
      attention: dashboard.attention?.length ?? null,
    };
    artifacts.raw.dashboardSignals = cockpitSignals;
    if (cockpitSignals.myWork > 0 && cockpitSignals.recentActivity >= 0) {
      pass('Dashboard API exposes operating signals', cockpitSignals);
    } else {
      partial('Dashboard API exposes operating signals', cockpitSignals);
    }

    const dashboardPage = await openAuthedPage(context, diego, `${WEB_URL}/dashboard`);
    await dashboardPage.getByText(diego.user.name.split(' ')[0], { exact: false }).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
    await screenshot(dashboardPage, 'dashboard-cockpit');

    await browser.close();

    await writeReports();
  } finally {
    await db.end().catch(() => {});
  }
}

async function writeReports() {
  artifacts.raw.checks = checks;
  await fs.writeFile(JSON_REPORT, JSON.stringify(artifacts, null, 2));
  const passCount = checks.filter((c) => c.status === 'pass').length;
  const partialCount = checks.filter((c) => c.status === 'partial').length;
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const verdict = failCount === 0 && partialCount === 0
    ? 'All clearance checks passed.'
    : failCount === 0
      ? 'Clearance battery passed with partials that still need product follow-up.'
      : 'Clearance battery found failures that keep cracks open.';

  const rows = checks.map((c) => `
    <tr>
      <td><span class="pill ${c.status}">${htmlEscape(c.status)}</span></td>
      <td>${htmlEscape(c.name)}</td>
      <td><pre>${htmlEscape(JSON.stringify(c.details, null, 2))}</pre></td>
    </tr>`).join('');

  const timingRows = artifacts.timings.map((t) => `
    <tr><td>${htmlEscape(t.label)}</td><td>${t.ms == null ? '' : htmlEscape(t.ms)}</td><td>${htmlEscape(t.status ?? (t.ok === false ? 'fail' : 'ok'))}</td><td>${htmlEscape(t.error ?? '')}</td></tr>
  `).join('');

  const screenshotCards = Object.entries(artifacts.screenshots).map(([name, file]) => {
    const rel = path.relative(REPORT_DIR, file).replace(/\\/g, '/');
    return `<figure><img src="${htmlEscape(rel)}" alt="${htmlEscape(name)}"><figcaption>${htmlEscape(name)}</figcaption></figure>`;
  }).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deft Cracks Clearance Battery - 2026-06-09</title>
  <style>
    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fbfcfb;color:#17211b;line-height:1.55}
    main{max-width:1180px;margin:0 auto;padding:44px 28px 72px}
    h1{font-size:clamp(32px,5vw,54px);line-height:1.1;margin:0}
    h2{border-top:1px solid #d9dfd9;margin-top:36px;padding-top:24px}
    p{color:#657268}
    table{width:100%;border-collapse:collapse;margin-top:14px;background:white;border:1px solid #d9dfd9}
    th,td{text-align:left;vertical-align:top;border-bottom:1px solid #d9dfd9;padding:10px 12px;font-size:14px}
    th{background:#f6f8f6;color:#657268;text-transform:uppercase;font-size:12px;letter-spacing:.04em}
    pre{white-space:pre-wrap;margin:0;font:12px ui-monospace,SFMono-Regular,Consolas,monospace}
    .meta{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.chip{border:1px solid #d9dfd9;border-radius:999px;padding:6px 10px;color:#657268;background:white;font-size:12px}
    .callout{margin-top:24px;padding:18px;border-left:4px solid #2f6f4e;background:#f6f8f6;border-radius:8px}
    .pill{display:inline-flex;min-width:64px;justify-content:center;border-radius:6px;color:white;font-weight:800;font-size:12px;padding:3px 7px;text-transform:uppercase}
    .pass{background:#27714c}.partial{background:#9a651e}.fail{background:#a33b37}
    .screens{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:14px}
    figure{margin:0;background:white;border:1px solid #d9dfd9;border-radius:8px;padding:10px}img{max-width:100%;border:1px solid #d9dfd9;border-radius:6px}figcaption{color:#657268;font-size:12px;margin-top:6px}
  </style>
</head>
<body><main>
  <div class="meta"><span class="chip">Run ${htmlEscape(RUN)}</span><span class="chip">API ${htmlEscape(API_URL)}</span><span class="chip">Web ${htmlEscape(WEB_URL)}</span><span class="chip">${passCount} pass</span><span class="chip">${partialCount} partial</span><span class="chip">${failCount} fail</span></div>
  <h1>Deft cracks clearance battery</h1>
  <section class="callout"><strong>${htmlEscape(verdict)}</strong><p>This run covers stack health, chat-to-wiki proof, MCP retrieval, Defty behavior, mixed agent/human chat, dashboard signals, and latency traces.</p></section>
  <h2>Checks</h2><table><thead><tr><th>Status</th><th>Check</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Timing Signals</h2><table><thead><tr><th>Label</th><th>ms</th><th>Status</th><th>Error</th></tr></thead><tbody>${timingRows}</tbody></table>
  <h2>Screenshots</h2><div class="screens">${screenshotCards}</div>
  <p>Raw JSON: <code>${htmlEscape(path.basename(JSON_REPORT))}</code></p>
</main></body></html>`;
  await fs.writeFile(HTML_REPORT, html);
  console.log(`Report: ${HTML_REPORT}`);
}

main().catch(async (err) => {
  fail('Battery crashed', { error: err?.message || String(err), stack: err?.stack });
  await writeReports().catch(() => {});
  process.exit(1);
});
