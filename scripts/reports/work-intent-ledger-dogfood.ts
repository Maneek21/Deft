import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const args = new Set(process.argv.slice(2));
const apiOnly = args.has('--api-only') || process.env.DEFT_DOGFOOD_API_ONLY === '1';

const API_URL = (process.env.DEFT_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3301').replace(/\/$/, '');
const WEB_URL = (process.env.DEFT_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const SECONDARY_EMAIL = process.env.DEFT_DOGFOOD_SECONDARY_EMAIL || 'lina@testers-tomatoes.com';
const RUN_ID = process.env.DEFT_DOGFOOD_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const RUN_COMPACT = RUN_ID.replace(/[^a-zA-Z0-9]/g, '').slice(-12);
const REPORT_ROOT = path.resolve('reports', 'work-intent-ledger-dogfood', RUN_ID);
const HTML_REPORT = path.resolve('reports', `work-intent-ledger-dogfood-${RUN_ID}.html`);
const JSON_REPORT = path.resolve('reports', `work-intent-ledger-dogfood-${RUN_ID}.json`);

type Auth = {
  accessToken: string;
  refreshToken?: string;
  user: { id: string; email: string; org_id: string; name?: string };
};

type Space = {
  id: string;
  name: string;
  type: string;
  org_id?: string;
};

type Check = {
  status: 'pass' | 'fail' | 'warn';
  name: string;
  detail?: unknown;
  ms?: number;
};

type Artifact = {
  run_id: string;
  api_url: string;
  web_url: string;
  api_only: boolean;
  started_at: string;
  finished_at?: string;
  checks: Check[];
  screenshots: Record<string, string>;
  ids: Record<string, string>;
  bugs: Array<{ severity: string; title: string; detail: string }>;
};

const artifact: Artifact = {
  run_id: RUN_ID,
  api_url: API_URL,
  web_url: WEB_URL,
  api_only: apiOnly,
  started_at: new Date().toISOString(),
  checks: [],
  screenshots: {},
  ids: {},
  bugs: [],
};

function htmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mark(status: Check['status'], name: string, detail?: unknown, ms?: number) {
  artifact.checks.push({ status, name, detail, ms });
  const suffix = detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
  console.log(`[${status.toUpperCase()}] ${name}${suffix}`);
}

async function timed<T>(name: string, fn: () => Promise<T>, statusName = name): Promise<T> {
  const started = Date.now();
  try {
    const value = await fn();
    mark('pass', statusName, undefined, Date.now() - started);
    return value;
  } catch (err) {
    mark('fail', statusName, err instanceof Error ? err.message : String(err), Date.now() - started);
    throw err;
  }
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: T; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { status: res.status, ok: res.ok, body, text };
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

async function login(email: string): Promise<Auth> {
  const res = await fetchJson<Auth>(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok || !res.body?.accessToken || !res.body?.user?.id) {
    throw new Error(`login failed for ${email}: ${res.status} ${res.text.slice(0, 300)}`);
  }
  return res.body;
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

async function ensureProject(auth: Auth): Promise<string> {
  const projects = await api<any[]>(auth, '/api/projects');
  const existing = projects.find((project) => !project.is_archived && !project.is_deleted);
  if (existing?.id) return existing.id;

  const prefix = `WI${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, 6);
  const created = await api<any>(auth, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: `Work Intent Dogfood ${RUN_ID.slice(-6)}`,
      prefix,
      description: 'Temporary project for Work Intent Ledger dogfood.',
    }),
  });
  return created.id;
}

async function createSpace(auth: Auth, type: 'public' | 'private'): Promise<Space> {
  return api<Space>(auth, '/api/spaces', {
    method: 'POST',
    body: JSON.stringify({
      name: `wil-${type}-${RUN_ID.slice(-10).toLowerCase()}`,
      type,
      description: `Work Intent Ledger ${type} proof space for ${RUN_ID}.`,
    }),
  });
}

async function issueMcpToken(auth: Auth, name: string): Promise<{ token: string; token_id: string }> {
  return api<{ token: string; token_id: string }>(auth, '/api/mcp-access/tokens', {
    method: 'POST',
    body: JSON.stringify({
      name,
      scopes: ['read:workspace', 'read:wiki', 'read:tasks', 'read:messages', 'write:tasks', 'write:messages', 'write:wiki'],
    }),
  });
}

async function revokeMcpToken(auth: Auth, tokenId?: string) {
  if (!tokenId) return;
  try {
    await api(auth, `/api/mcp-access/tokens/${tokenId}`, { method: 'DELETE' });
  } catch (err) {
    mark('warn', 'MCP token cleanup failed', err instanceof Error ? err.message : String(err));
  }
}

async function mcpCall(token: string, name: string, argumentsBody: Record<string, unknown>) {
  const res = await fetchJson<any>(`${API_URL}/api/mcp/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-${Date.now()}`,
      method: 'tools/call',
      params: { name, arguments: argumentsBody },
    }),
  });
  if (!res.ok || res.body?.error) {
    throw new Error(`MCP ${name} failed: ${res.status} ${JSON.stringify(res.body).slice(0, 500)}`);
  }
  const result = res.body.result;
  const text = Array.isArray(result?.content)
    ? result.content.map((item: any) => item.text ?? '').join('\n')
    : '';
  return { result, text };
}

async function createBrowser(auth: Auth): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await context.addInitScript((tokens) => {
    window.localStorage.setItem('deft-access-token', tokens.accessToken);
    if (tokens.refreshToken) window.localStorage.setItem('deft-refresh-token', tokens.refreshToken);
  }, { accessToken: auth.accessToken, refreshToken: auth.refreshToken ?? '' });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      artifact.bugs.push({
        severity: 'P2',
        title: 'Browser console error during dogfood',
        detail: message.text().slice(0, 500),
      });
    }
  });
  return { browser, context, page };
}

async function screenshot(page: Page, name: string) {
  await fs.mkdir(REPORT_ROOT, { recursive: true });
  const file = path.join(REPORT_ROOT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  artifact.screenshots[name] = file;
}

async function sendMessageViaUi(page: Page, space: Space, content: string): Promise<any> {
  await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
  const editor = page.locator('[contenteditable="true"]').last();
  await editor.waitFor({ state: 'visible', timeout: 20_000 });
  await editor.click();
  await page.keyboard.insertText(content);
  const responsePromise = page.waitForResponse((res) =>
    res.url().includes(`/api/messages/${space.id}`) && res.request().method() === 'POST',
  { timeout: 20_000 });
  const send = page.getByRole('button', { name: 'Send message' });
  await send.waitFor({ state: 'visible', timeout: 10_000 });
  await send.click();
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error(`UI message POST returned ${response.status()}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = await response.json();
  await page.getByText(RUN_ID, { exact: false }).last().waitFor({ state: 'visible', timeout: 15_000 });
  return body;
}

async function sendMessageViaApi(auth: Auth, space: Space, content: string): Promise<any> {
  return api(auth, `/api/messages/${space.id}`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

async function postMessage(auth: Auth, page: Page | null, space: Space, content: string): Promise<any> {
  if (!page) return sendMessageViaApi(auth, space, content);
  return sendMessageViaUi(page, space, content);
}

async function pendingAction(auth: Auth, spaceId: string, messageId: string, actionName: string): Promise<any | null> {
  const rows = await api<any[]>(auth, `/api/agent/actions/pending-by-space?space_id=${encodeURIComponent(spaceId)}`);
  return rows.find((row) => row.message_id === messageId && row.action === actionName) ?? null;
}

async function waitPendingAction(auth: Auth, space: Space, messageId: string, actionName: string) {
  return waitFor(`pending ${actionName} action for ${messageId}`, () => pendingAction(auth, space.id, messageId, actionName), {
    timeoutMs: 90_000,
    intervalMs: 1_500,
  });
}

async function approveViaApi(auth: Auth, actionId: string) {
  return api<any>(auth, `/api/agent/actions/${actionId}/approve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

async function approveViaUi(page: Page, space: Space, actionId: string, buttonName: RegExp, screenshotName: string) {
  await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
  await screenshot(page, `${screenshotName}-pending`);
  const button = page.getByRole('button', { name: buttonName }).last();
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  const responsePromise = page.waitForResponse((res) =>
    res.url().includes(`/api/agent/actions/${actionId}/approve`) && res.request().method() === 'POST',
  { timeout: 30_000 });
  await button.click();
  const response = await responsePromise;
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok()) {
    throw new Error(`UI approve returned ${response.status()}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  await screenshot(page, `${screenshotName}-approved`);
  return body;
}

async function receipt(auth: Auth, actionId: string) {
  return api<any>(auth, `/api/agent/actions/${actionId}/receipt`);
}

function assertIncludes(haystack: string, needle: string, label: string) {
  if (!haystack.toLowerCase().includes(needle.toLowerCase())) {
    throw new Error(`${label} did not include "${needle}". Text: ${haystack.slice(0, 800)}`);
  }
}

async function writeReports() {
  artifact.finished_at = new Date().toISOString();
  await fs.mkdir(path.dirname(HTML_REPORT), { recursive: true });
  await fs.writeFile(JSON_REPORT, JSON.stringify(artifact, null, 2));

  const checkRows = artifact.checks.map((check) => `
    <tr class="${check.status}">
      <td>${htmlEscape(check.status.toUpperCase())}</td>
      <td>${htmlEscape(check.name)}</td>
      <td>${htmlEscape(check.ms != null ? `${check.ms}ms` : '')}</td>
      <td><code>${htmlEscape(typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail ?? ''))}</code></td>
    </tr>`).join('');
  const bugRows = artifact.bugs.length
    ? artifact.bugs.map((bug) => `<li><strong>${htmlEscape(bug.severity)}</strong> ${htmlEscape(bug.title)}: ${htmlEscape(bug.detail)}</li>`).join('')
    : '<li>No bugs recorded by this runner.</li>';
  const shotRows = Object.entries(artifact.screenshots).map(([name, file]) => {
    const rel = path.relative(path.dirname(HTML_REPORT), file).replace(/\\/g, '/');
    return `<figure><img src="${htmlEscape(rel)}" alt="${htmlEscape(name)}"><figcaption>${htmlEscape(name)}</figcaption></figure>`;
  }).join('');
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Work Intent Ledger Dogfood - ${htmlEscape(RUN_ID)}</title>
  <style>
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #151922; }
    header { background: #fff; border-bottom: 1px solid #dde3ea; padding: 32px 40px 24px; }
    main { padding: 24px 40px 48px; display: grid; gap: 22px; }
    h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    p { color: #526071; max-width: 880px; line-height: 1.55; }
    .pill { display: inline-flex; margin: 6px 8px 0 0; padding: 7px 10px; border: 1px solid #d8dee8; border-radius: 999px; background: #fff; font-size: 12px; }
    section { background: #fff; border: 1px solid #dde3ea; border-radius: 8px; padding: 18px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #edf0f4; padding: 9px; text-align: left; vertical-align: top; }
    tr.pass td:first-child { color: #047857; font-weight: 700; }
    tr.fail td:first-child { color: #b91c1c; font-weight: 700; }
    tr.warn td:first-child { color: #a16207; font-weight: 700; }
    code { white-space: pre-wrap; word-break: break-word; color: #334155; }
    .screens { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
    figure { margin: 0; border: 1px solid #dde3ea; border-radius: 8px; overflow: hidden; background: #fff; }
    img { width: 100%; display: block; }
    figcaption { padding: 8px 10px; font-size: 12px; color: #526071; border-top: 1px solid #edf0f4; }
  </style>
</head>
<body>
  <header>
    <h1>Work Intent Ledger Dogfood</h1>
    <p>Repeatable browser/API validation for public and private chat captures, Defty approvals, receipts, and MCP recall.</p>
    <span class="pill">Run ${htmlEscape(RUN_ID)}</span>
    <span class="pill">API ${htmlEscape(API_URL)}</span>
    <span class="pill">Web ${htmlEscape(WEB_URL)}</span>
    <span class="pill">${apiOnly ? 'API only' : 'Browser + API'}</span>
  </header>
  <main>
    <section>
      <h2>Checks</h2>
      <table>
        <thead><tr><th>Status</th><th>Check</th><th>Time</th><th>Detail</th></tr></thead>
        <tbody>${checkRows}</tbody>
      </table>
    </section>
    <section>
      <h2>Bugs Observed</h2>
      <ul>${bugRows}</ul>
    </section>
    <section>
      <h2>Screenshots</h2>
      <div class="screens">${shotRows || '<p>No screenshots captured in API-only mode.</p>'}</div>
    </section>
  </main>
</body>
</html>`;
  await fs.writeFile(HTML_REPORT, html);
  console.log(`HTML report: ${HTML_REPORT}`);
  console.log(`JSON report: ${JSON_REPORT}`);
}

async function main() {
  await fs.mkdir(REPORT_ROOT, { recursive: true });
  const health = await fetchJson(`${API_URL}/health`).catch((err) => ({ ok: false, status: 0, text: String(err), body: null }));
  if (!health.ok) throw new Error(`API health failed: ${health.status} ${health.text}`);
  mark('pass', 'API health', `${API_URL}/health`);

  if (!apiOnly) {
    const web = await fetchJson(WEB_URL).catch((err) => ({ ok: false, status: 0, text: String(err), body: null }));
    if (!web.ok) throw new Error(`Web not reachable: ${web.status} ${web.text}`);
    mark('pass', 'Web root reachable', WEB_URL);
  }

  const primary = await timed('login primary user', () => login(EMAIL));
  let secondary: Auth | null = null;
  try {
    secondary = await login(SECONDARY_EMAIL);
    mark('pass', 'login secondary user', SECONDARY_EMAIL);
  } catch (err) {
    mark('warn', 'secondary user unavailable; private leak test will be skipped', err instanceof Error ? err.message : String(err));
  }

  const token = await timed('issue primary personal MCP token', () => issueMcpToken(primary, `WIL dogfood ${RUN_ID}`));
  let secondaryToken: { token: string; token_id: string } | null = null;
  if (secondary) {
    secondaryToken = await timed('issue secondary personal MCP token', () => issueMcpToken(secondary!, `WIL dogfood secondary ${RUN_ID}`));
  }

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    await timed('ensure at least one project exists', () => ensureProject(primary));
    const publicSpace = await timed('create public proof space', () => createSpace(primary, 'public'));
    const privateSpace = await timed('create private proof space', () => createSpace(primary, 'private'));
    artifact.ids.public_space = publicSpace.id;
    artifact.ids.private_space = privateSpace.id;

    if (!apiOnly) {
      const created = await timed('launch browser session', () => createBrowser(primary));
      browser = created.browser;
      context = created.context;
      page = created.page;
    }

    const publicNeedle = `WILPUB${RUN_COMPACT} TOMATO${RUN_COMPACT.slice(0, 6)}`;
    const publicDecision = `Decision: ${publicNeedle} governs the pilot crate audit note for this proof run.`;
    const publicMessage = await timed('post public decision through chat', () => postMessage(primary, page, publicSpace, publicDecision));
    artifact.ids.public_decision_message = publicMessage.id;
    if (page) await screenshot(page, 'public-decision-posted');

    const publicAction = await timed('wait for public wiki_create approval', () => waitPendingAction(primary, publicSpace, publicMessage.id, 'wiki_create'));
    if (publicAction.params?.scope !== 'org') {
      throw new Error(`public wiki_create expected scope=org, got ${publicAction.params?.scope}`);
    }
    mark('pass', 'public capture is org scoped', { action_id: publicAction.id, scope: publicAction.params?.scope });

    const publicApproval = page
      ? await timed('approve public decision from UI', () => approveViaUi(page!, publicSpace, publicAction.id, /Save decision|Save knowledge|Save/i, 'public-decision'))
      : await timed('approve public decision from API', () => approveViaApi(primary, publicAction.id));
    const publicReceipt = await timed('fetch public decision receipt', () => receipt(primary, publicAction.id));
    if (!publicReceipt.verified) throw new Error('public decision receipt did not verify');
    artifact.ids.public_wiki_page = publicApproval.result?.page_id ?? publicApproval.result?.id ?? '';
    mark('pass', 'public decision approval produced verified receipt', { action_id: publicAction.id, result: publicApproval.result });

    await timed('MCP recall sees approved org knowledge', async () => {
      const publicRecall = await mcpCall(token.token, 'memory_recall', { query: publicNeedle, scope: 'all', limit: 10 });
      assertIncludes(publicRecall.text, publicNeedle, 'primary MCP memory_recall');
      return publicRecall;
    });

    const privateNeedle = `WILPRIV${RUN_COMPACT} BASIL${RUN_COMPACT.slice(0, 6)}`;
    const privateDecision = `Decision: ${privateNeedle} is the private supplier review code for this proof run.`;
    const privateMessage = await timed('post private decision through chat', () => postMessage(primary, page, privateSpace, privateDecision));
    artifact.ids.private_decision_message = privateMessage.id;
    if (page) await screenshot(page, 'private-decision-posted');

    const privateAction = await timed('wait for private wiki_create approval', () => waitPendingAction(primary, privateSpace, privateMessage.id, 'wiki_create'));
    if (privateAction.params?.scope !== 'space') {
      throw new Error(`private wiki_create expected scope=space, got ${privateAction.params?.scope}`);
    }
    mark('pass', 'private capture is space scoped', { action_id: privateAction.id, scope: privateAction.params?.scope, space_id: privateAction.params?.space_id });

    const privateApproval = await timed('approve private decision from API', () => approveViaApi(primary, privateAction.id));
    const privateReceipt = await timed('fetch private decision receipt', () => receipt(primary, privateAction.id));
    if (!privateReceipt.verified) throw new Error('private decision receipt did not verify');
    artifact.ids.private_wiki_page = privateApproval.result?.page_id ?? privateApproval.result?.id ?? '';
    mark('pass', 'private decision approval produced verified receipt', { action_id: privateAction.id, result: privateApproval.result });

    await timed('primary MCP recall sees own private-space knowledge', async () => {
      const primaryPrivateRecall = await mcpCall(token.token, 'memory_recall', { query: privateNeedle, scope: 'all', limit: 10 });
      assertIncludes(primaryPrivateRecall.text, privateNeedle, 'primary private MCP memory_recall');
      return primaryPrivateRecall;
    });

    if (secondaryToken) {
      const secondaryPrivateRecall = await timed('secondary MCP recall checks private-space isolation', () =>
        mcpCall(secondaryToken!.token, 'memory_recall', { query: privateNeedle, scope: 'all', limit: 10 }));
      if (secondaryPrivateRecall.text.toLowerCase().includes(privateNeedle.toLowerCase())) {
        throw new Error(`secondary user recalled private-space knowledge: ${secondaryPrivateRecall.text.slice(0, 500)}`);
      }
      mark('pass', 'private-space knowledge did not leak to secondary MCP user');
    }

    const taskNeedle = `WILTASK${RUN_COMPACT}`;
    const taskMessageText = `Please create task: call the buyer about ${taskNeedle}. Description: Confirm the blue crate pilot packing note and report blockers in the launch channel.`;
    const taskMessage = await timed('post explicit task request through chat', () => postMessage(primary, page, publicSpace, taskMessageText));
    artifact.ids.task_message = taskMessage.id;
    if (page) await screenshot(page, 'task-request-posted');

    const taskAction = await timed('wait for task_create approval', () => waitPendingAction(primary, publicSpace, taskMessage.id, 'task_create'));
    const taskApproval = page
      ? await timed('approve task creation from UI', () => approveViaUi(page!, publicSpace, taskAction.id, /Create task/i, 'task-create'))
      : await timed('approve task creation from API', () => approveViaApi(primary, taskAction.id));
    const taskReceipt = await timed('fetch task receipt', () => receipt(primary, taskAction.id));
    if (!taskReceipt.verified) throw new Error('task receipt did not verify');

    const taskId = taskApproval.result?.task_id ?? taskApproval.result?.id;
    if (!taskId) throw new Error(`task approval did not return task id: ${JSON.stringify(taskApproval).slice(0, 500)}`);
    artifact.ids.task = taskId;
    mark('pass', 'task approval produced task and verified receipt', { action_id: taskAction.id, task_id: taskId });

    await timed('MCP task_get sees approved task', async () => {
      const taskGet = await mcpCall(token.token, 'task_get', { task_id: taskId });
      assertIncludes(taskGet.text, taskNeedle, 'MCP task_get');
      return taskGet;
    });

    if (page) {
      await page.goto(`${WEB_URL}/tasks?task=${taskId}`, { waitUntil: 'domcontentloaded' });
      await page.getByText(taskNeedle, { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
      await screenshot(page, 'task-detail-approved');
    }
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await revokeMcpToken(primary, token.token_id);
    if (secondary && secondaryToken) await revokeMcpToken(secondary, secondaryToken.token_id);
  }
}

main()
  .catch((err) => {
    artifact.bugs.push({
      severity: 'P1',
      title: 'Work Intent Ledger dogfood failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await writeReports();
  });
