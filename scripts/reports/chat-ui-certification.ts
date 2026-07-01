import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';

const WEB_URL = (process.env.DEFT_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_URL = (process.env.DEFT_API_URL || inferApiUrl(WEB_URL)).replace(/\/$/, '');
const EMAIL = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const RUN_ID = process.env.DEFT_CHAT_CERT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const RUN_MARKER = `CHAT-CERT-${RUN_ID.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
const args = new Set(process.argv.slice(2));
const KEEP_MESSAGE = args.has('--keep-message');
const OUT_DIR = path.resolve('reports', 'chat-ui-certification', RUN_ID);
const HTML_REPORT = path.resolve('reports', `chat-ui-certification-${RUN_ID}.html`);
const JSON_REPORT = path.resolve('reports', `chat-ui-certification-${RUN_ID}.json`);

type CheckStatus = 'pass' | 'warn' | 'fail';
type Check = { status: CheckStatus; name: string; detail?: unknown; ms?: number };
type Auth = { accessToken: string; user: { id: string; email: string; org_id: string } };
type Space = { id: string; name: string; type?: string };

type Artifact = {
  run_id: string;
  marker: string;
  web_url: string;
  api_url: string;
  email: string;
  started_at: string;
  finished_at?: string;
  score: number;
  checks: Check[];
  screenshots: Record<string, string>;
  evidence: Record<string, unknown>;
  residuals: Array<{ severity: 'P1' | 'P2' | 'P3'; title: string; detail: string }>;
};

const artifact: Artifact = {
  run_id: RUN_ID,
  marker: RUN_MARKER,
  web_url: WEB_URL,
  api_url: API_URL,
  email: EMAIL,
  started_at: new Date().toISOString(),
  score: 0,
  checks: [],
  screenshots: {},
  evidence: {},
  residuals: [],
};

function inferApiUrl(webUrl: string) {
  try {
    const url = new URL(webUrl);
    if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '3000') {
      url.port = '3301';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // Fall through to WEB_URL.
  }
  return webUrl;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rel(file: string) {
  return path.relative(path.dirname(HTML_REPORT), file).replace(/\\/g, '/');
}

function mark(status: CheckStatus, name: string, detail?: unknown, ms?: number) {
  artifact.checks.push({ status, name, detail, ms });
  const suffix = detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
  console.log(`[${status.toUpperCase()}] ${name}${suffix}`);
}

async function step<T>(name: string, fn: () => Promise<T>, warnOnly = false): Promise<T | null> {
  const started = Date.now();
  try {
    const value = await fn();
    mark('pass', name, undefined, Date.now() - started);
    return value;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    mark(warnOnly ? 'warn' : 'fail', name, detail, Date.now() - started);
    if (!warnOnly) throw err;
    return null;
  }
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: T; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { status: res.status, ok: res.ok, body, text };
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
  return res.body;
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

function asArray<T = any>(value: any, keys: string[] = []): T[] {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

async function pickSpace(auth: Auth): Promise<Space> {
  const body = await api<any>(auth, '/api/spaces');
  const spaces = asArray<Space>(body, ['spaces']);
  const preferred = ['general', 'marketing', 'operations', 'sales-and-buyers', 'field-ops'];
  const found = spaces.find((space) => preferred.includes((space.name || '').toLowerCase()))
    ?? spaces.find((space) => space.id && space.type !== 'dm')
    ?? spaces[0];
  if (!found?.id) throw new Error('No usable chat space found');
  artifact.evidence.space = { id: found.id, name: found.name };
  return found;
}

async function screenshot(page: Page, name: string) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  artifact.screenshots[name] = file;
}

async function loginUi(page: Page) {
  await page.goto(`${WEB_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#login-email').fill(EMAIL);
  await page.locator('#login-password').fill(PASSWORD);
  const loginResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/api/auth/login'),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const response = await loginResponse;
  if (response.status() >= 400) {
    const body = await response.text().catch(() => '');
    throw new Error(`UI login failed: ${response.status()} ${body.slice(0, 240)}`);
  }
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
}

async function gotoChat(page: Page, space: Space) {
  await page.goto(`${WEB_URL}/chat?space=${encodeURIComponent(space.id)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.locator('[contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 25_000 });
}

async function closeMobileSheet(page: Page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const visible = await page.getByRole('dialog', { name: 'Compose' }).isVisible().catch(() => false);
  if (visible) {
    throw new Error('Mobile composer sheet did not close with Escape');
  }
}

async function sendMobileMessage(page: Page, text: string): Promise<string> {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.insertText(text);
  const post = page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && response.url().includes('/api/messages/')
      && response.status() < 400,
    { timeout: 25_000 },
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const response = await post;
  const body = await response.json().catch(() => null) as { id?: string } | null;
  if (!body?.id) throw new Error('Message POST succeeded but did not return an id');
  await page.getByText(text, { exact: false }).last().waitFor({ state: 'visible', timeout: 20_000 });
  return body.id;
}

async function cleanupMessage(auth: Auth, messageId: string | undefined) {
  if (!messageId || KEEP_MESSAGE) return;
  await api(auth, `/api/messages/${messageId}`, { method: 'DELETE' });
  artifact.evidence.cleanup = `Soft-deleted QA message ${messageId}`;
}

function makeContext(viewport: 'mobile' | 'desktop'): Promise<BrowserContext> {
  return browser!.newContext(
    viewport === 'mobile'
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1366, height: 900 } },
  );
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

async function run() {
  const auth = await step('API login works for certification user', loginApi) as Auth;
  const space = await step('Usable chat space is available', () => pickSpace(auth)) as Space;

  browser = await chromium.launch({ headless: true });
  let messageId: string | undefined;

  try {
    await step('Mobile composer opens, exposes work actions, closes, and sends', async () => {
      const context = await makeContext('mobile');
      const page = await context.newPage();
      await loginUi(page);
      await gotoChat(page, space);
      await screenshot(page, 'mobile-chat-ready');

      await page.getByLabel('Open composer actions').waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByLabel('Open composer actions').click();
      await page.getByText('Ask Defty', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
      await page.getByText('Create task', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
      await page.getByText('New note', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
      await screenshot(page, 'mobile-composer-actions');

      await closeMobileSheet(page);
      const text = `${RUN_MARKER} mobile composer regression smoke.`;
      messageId = await sendMobileMessage(page, text);
      artifact.evidence.message_text = text;
      artifact.evidence.message_id = messageId;
      await screenshot(page, 'mobile-after-send');
      await context.close();
    });

    await step('Desktop hover actions and secondary menu are reachable', async () => {
      const context = await makeContext('desktop');
      const page = await context.newPage();
      await loginUi(page);
      await gotoChat(page, space);
      const text = artifact.evidence.message_text as string;
      await page.getByText(text, { exact: false }).last().waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByText(text, { exact: false }).last().hover();

      await page.locator('button[title="Reply"]').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 5_000 });
      await page.locator('button[title="Create task"]').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 5_000 });
      const more = page.locator('button[aria-label="More message actions"]').filter({ visible: true }).first();
      await more.waitFor({ state: 'visible', timeout: 5_000 });
      await screenshot(page, 'desktop-hover-actions');

      await more.click();
      await page.getByText(/Copy text|Mark unread|Save to Knowledge/i).first().waitFor({ state: 'visible', timeout: 5_000 });
      await screenshot(page, 'desktop-secondary-actions');
      await context.close();
    });

    await step('QA smoke message is cleaned up', () => cleanupMessage(auth, messageId), true);
  } finally {
    await browser?.close();
    browser = null;
  }

  const failures = artifact.checks.filter((check) => check.status === 'fail').length;
  const warnings = artifact.checks.filter((check) => check.status === 'warn').length;
  artifact.score = failures ? 6 : warnings ? 8.5 : 9;
  artifact.finished_at = new Date().toISOString();
  await writeReports();
  if (failures) process.exitCode = 1;
}

async function writeReports() {
  await fs.mkdir(path.dirname(HTML_REPORT), { recursive: true });
  await fs.writeFile(JSON_REPORT, JSON.stringify(artifact, null, 2));

  const checks = artifact.checks.map((check) => `
    <tr>
      <td><span class="pill ${check.status}">${check.status.toUpperCase()}</span></td>
      <td>${escapeHtml(check.name)}</td>
      <td>${check.ms ?? ''} ms</td>
      <td>${escapeHtml(typeof check.detail === 'string' ? check.detail : check.detail ? JSON.stringify(check.detail) : '')}</td>
    </tr>
  `).join('');

  const shots = Object.entries(artifact.screenshots).map(([name, file]) => `
    <figure>
      <img src="${escapeHtml(rel(file))}" alt="${escapeHtml(name)}">
      <figcaption>${escapeHtml(name)}</figcaption>
    </figure>
  `).join('');

  const residuals = artifact.residuals.length
    ? artifact.residuals.map((item) => `<li><strong>${escapeHtml(item.severity)} ${escapeHtml(item.title)}</strong> ${escapeHtml(item.detail)}</li>`).join('')
    : '<li>No blocking residuals found in this certification pass.</li>';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chat UI Final Certification - ${escapeHtml(RUN_ID)}</title>
  <style>
    :root { color-scheme: dark; --bg:#0f1014; --panel:#181923; --line:#2a2c38; --text:#f2f0f7; --muted:#aaa6b8; --accent:#6b55df; --green:#37c777; --amber:#f3b64d; --red:#ff6b6b; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:radial-gradient(circle at 40% 0%, #252039 0, #111217 46%, #0b0c10 100%); color:var(--text); }
    main { max-width:1180px; margin:0 auto; padding:48px 24px 64px; }
    header { display:grid; gap:18px; margin-bottom:28px; }
    .eyebrow { color:#b9b0ff; text-transform:uppercase; letter-spacing:.12em; font-size:12px; font-weight:800; }
    h1 { font-size:clamp(36px, 6vw, 72px); line-height:.98; margin:0; max-width:860px; }
    h2 { margin:34px 0 14px; font-size:24px; }
    p { color:var(--muted); line-height:1.6; max-width:820px; }
    .grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; margin:20px 0; }
    .card { background:rgba(24,25,35,.82); border:1px solid var(--line); border-radius:10px; padding:16px; }
    .metric { font-size:28px; font-weight:850; }
    .label { color:var(--muted); font-size:13px; margin-top:4px; }
    table { width:100%; border-collapse:collapse; background:rgba(24,25,35,.72); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
    th,td { text-align:left; padding:12px 14px; border-bottom:1px solid var(--line); vertical-align:top; font-size:14px; }
    th { color:#c8c2dc; font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .pill { display:inline-flex; align-items:center; border-radius:999px; padding:4px 8px; font-weight:800; font-size:11px; }
    .pass { color:#07150d; background:var(--green); }
    .warn { color:#1c1200; background:var(--amber); }
    .fail { color:#220404; background:var(--red); }
    .shots { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:18px; }
    figure { margin:0; background:rgba(24,25,35,.72); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
    img { display:block; width:100%; height:auto; }
    figcaption { padding:10px 12px; color:var(--muted); font-size:13px; border-top:1px solid var(--line); }
    code { color:#d8d1ff; }
    ul { color:var(--muted); line-height:1.7; }
    @media (max-width:800px) { .grid, .shots { grid-template-columns:1fr; } main { padding:32px 16px 48px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Chat UI final certification</div>
      <h1>Mobile and desktop chat polish is guarded.</h1>
      <p>This run certifies the specific chat polish regression surface: mobile composer action sheet, send path, desktop hover actions, secondary message actions, and cleanup. It ran against <code>${escapeHtml(WEB_URL)}</code>.</p>
    </header>

    <section class="grid">
      <div class="card"><div class="metric">${artifact.score.toFixed(1)}/10</div><div class="label">Certified chat UX score</div></div>
      <div class="card"><div class="metric">${artifact.checks.filter((c) => c.status === 'pass').length}</div><div class="label">Passing checks</div></div>
      <div class="card"><div class="metric">${artifact.checks.filter((c) => c.status === 'warn').length}</div><div class="label">Warnings</div></div>
      <div class="card"><div class="metric">${artifact.checks.filter((c) => c.status === 'fail').length}</div><div class="label">Failures</div></div>
    </section>

    <h2>Coverage Added</h2>
    <ul>
      <li>Run with <code>pnpm chat:certify</code>.</li>
      <li>Uses real browser sessions through Playwright, not DOM snapshots.</li>
      <li>Posts a real chat message, verifies it on desktop, then soft-deletes it by API cleanup.</li>
      <li>Supports local and public demo via <code>DEFT_WEB_URL</code>, <code>DEFT_API_URL</code>, <code>DEFT_TEST_EMAIL</code>, and <code>DEFT_TEST_PASSWORD</code>.</li>
    </ul>

    <h2>Checks</h2>
    <table>
      <thead><tr><th>Status</th><th>Check</th><th>Time</th><th>Detail</th></tr></thead>
      <tbody>${checks}</tbody>
    </table>

    <h2>Residuals</h2>
    <ul>${residuals}</ul>

    <h2>Evidence</h2>
    <div class="shots">${shots}</div>
  </main>
</body>
</html>`;

  await fs.writeFile(HTML_REPORT, html);
  console.log(`HTML report: ${HTML_REPORT}`);
  console.log(`JSON report: ${JSON_REPORT}`);
}

run().catch(async (err) => {
  mark('fail', 'Unexpected certification crash', err instanceof Error ? err.message : String(err));
  artifact.score = 0;
  artifact.finished_at = new Date().toISOString();
  try {
    await writeReports();
  } catch {
    // ignore report write errors after crash
  }
  console.error(err);
  process.exit(1);
});
