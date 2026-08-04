import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { createDemoCertificationReportPaths } from './demo-claim-certification-paths.js';

const WEB_URL = (process.env.DEFT_WEB_URL || 'https://demo.deft.ing').replace(/\/$/, '');
const API_URL = (process.env.DEFT_API_URL || WEB_URL).replace(/\/$/, '');
const EMAIL = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const reportPaths = createDemoCertificationReportPaths(
  process.env.DEFT_DEMO_CERT_RUN_ID,
);
const RUN_ID = reportPaths.runId;
const RUN_MARKER = reportPaths.runMarker;
const args = new Set(process.argv.slice(2));
const OUT_DIR = reportPaths.outDir;
const HTML_REPORT = reportPaths.htmlReport;
const JSON_REPORT = reportPaths.jsonReport;

type Auth = {
  accessToken: string;
  user: { id: string; email: string; org_id: string; name?: string };
};

type Space = { id: string; name: string; type?: string };
type CheckStatus = 'pass' | 'warn' | 'fail';
type Check = { status: CheckStatus; name: string; detail?: unknown; ms?: number };

type Artifact = {
  run_id: string;
  marker: string;
  web_url: string;
  api_url: string;
  started_at: string;
  finished_at?: string;
  checks: Check[];
  screenshots: Record<string, string>;
  ids: Record<string, string>;
  evidence: Record<string, unknown>;
  findings: Array<{ severity: 'P0' | 'P1' | 'P2' | 'P3'; title: string; detail: string }>;
};

const artifact: Artifact = {
  run_id: RUN_ID,
  marker: RUN_MARKER,
  web_url: WEB_URL,
  api_url: API_URL,
  started_at: new Date().toISOString(),
  checks: [],
  screenshots: {},
  ids: {},
  evidence: {},
  findings: [],
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

async function screenshot(page: Page, name: string) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  artifact.screenshots[name] = file;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginUi(page: Page) {
  await page.goto(`${WEB_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-email').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#login-email').fill(EMAIL);
  await page.locator('#login-password').fill(PASSWORD);
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/api/auth/login'),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const response = await responsePromise;
  if (response.status() >= 400) {
    const body = await response.text().catch(() => '');
    throw new Error(`UI login failed: ${response.status()} ${body.slice(0, 240)}`);
  }
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
  await page.locator('main').waitFor({ state: 'visible', timeout: 20_000 });
}

async function gotoSurface(page: Page, route: string, name: string, expected?: RegExp) {
  await page.goto(`${WEB_URL}${route}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  if (expected) {
    await page.getByText(expected).first().waitFor({ state: 'visible', timeout: 25_000 });
  }
  await screenshot(page, name);
}

async function pickSpace(auth: Auth): Promise<Space> {
  const body = await api<any>(auth, '/api/spaces');
  const spaces = asArray<Space>(body, ['spaces']);
  const preferred = ['marketing', 'sales-and-buyers', 'launch-war-room', 'field-ops', 'operations'];
  const found = spaces.find((space) => preferred.includes((space.name || '').toLowerCase()))
    ?? spaces.find((space) => !String(space.name).toLowerCase().includes('dm'))
    ?? spaces[0];
  if (!found?.id) throw new Error('No usable chat space found for demo certification');
  artifact.ids.space_id = found.id;
  artifact.evidence.space_name = found.name;
  return found;
}

async function sendChatMessage(page: Page, space: Space, label: string, content: string) {
  await page.goto(`${WEB_URL}/chat?space=${encodeURIComponent(space.id)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  const editor = page.locator('[contenteditable="true"].deft-editor').last();
  await editor.waitFor({ state: 'visible', timeout: 25_000 });
  await editor.click();
  await editor.fill(content);
  const composedText = await editor.textContent();
  if (!composedText?.includes(RUN_MARKER)) {
    throw new Error(`Composer did not contain marker after fill. Text was: ${composedText?.slice(0, 120)}`);
  }
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
  if (responseBody?.id) {
    artifact.ids[`message_${label}_id`] = responseBody.id;
  }
  await page.waitForFunction(
    (marker) => document.body.innerText.includes(marker),
    RUN_MARKER,
    { timeout: 25_000 },
  ).catch(async () => {
    mark('warn', `Message ${label} posted but did not appear live in chat within 25s`, responseBody?.id ?? null);
    await screenshot(page, `chat-send-render-lag-${label}`);
  });
  artifact.evidence[`message_${label}`] = content;
  await delay(1_000);
}

function containsMarker(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.includes(RUN_MARKER);
  try {
    return JSON.stringify(value).includes(RUN_MARKER);
  } catch {
    return false;
  }
}

async function getRunIntents(auth: Auth) {
  const body = await api<any>(auth, '/api/work-intents?limit=100');
  return asArray<any>(body, ['intents']).filter((intent) => containsMarker(intent));
}

async function getRunActions(auth: Auth) {
  const body = await api<any>(auth, '/api/agent/actions');
  return asArray<any>(body).filter((action) => containsMarker(action));
}

function byKind(intents: any[], kind: string) {
  return intents.find((intent) => intent.kind === kind);
}

async function waitForExpectedCaptures(auth: Auth) {
  return waitFor('task/decision/resource/note work-intent captures', async () => {
    const intents = await getRunIntents(auth);
    const actions = await getRunActions(auth);
    artifact.evidence.capture_poll = {
      intent_count: intents.length,
      action_count: actions.length,
      kinds: intents.map((intent) => `${intent.kind}:${intent.status}`),
      actions: actions.map((action) => `${action.action}:${action.approval_status}`),
    };
    const hasTask = intents.some((intent) => intent.kind === 'task_candidate' || intent.kind === 'blocker_candidate');
    const hasDecision = intents.some((intent) => intent.kind === 'decision_candidate');
    const hasResource = intents.some((intent) => intent.kind === 'resource_candidate');
    const hasNote = intents.some((intent) => intent.kind === 'note_candidate');
    return hasTask && hasDecision && hasResource && hasNote ? { intents, actions } : null;
  }, { timeoutMs: 120_000, intervalMs: 2_500 });
}

async function clickApprovalForMarker(page: Page, buttonText: string, label: string) {
  await page.goto(`${WEB_URL}/inbox?tab=captures`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.getByText(RUN_MARKER, { exact: false }).first().waitFor({ state: 'visible', timeout: 25_000 });
  await screenshot(page, `captures-before-${label}`);

  const clicked = await page.evaluate(({ marker, buttonText }) => {
    const target = buttonText.toLowerCase();
    for (const button of Array.from(document.querySelectorAll('button'))) {
      const label = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`.trim().toLowerCase();
      if (label !== target) continue;
      let node: HTMLElement | null = button;
      for (let i = 0; i < 10 && node; i += 1) {
        if ((node.textContent || '').includes(marker)) {
          button.click();
          return true;
        }
        node = node.parentElement;
      }
    }
    return false;
  }, { marker: RUN_MARKER, buttonText });

  if (!clicked) {
    throw new Error(`Could not find "${buttonText}" button in a capture card containing ${RUN_MARKER}`);
  }

  await page.waitForTimeout(1_500);
  await screenshot(page, `captures-after-${label}`);
}

async function approveCaptureWithUi(page: Page, buttonText: string, label: string) {
  await clickApprovalForMarker(page, buttonText, label);
  mark('pass', `UI approval clicked for ${label}`);
}

async function verifyReceipt(auth: Auth, actionId: string) {
  const receipt = await api<any>(auth, `/api/agent/actions/${actionId}/receipt`);
  if (!receipt?.verified) {
    throw new Error(`Receipt was missing or failed verification for ${actionId}`);
  }
  return receipt;
}

async function verifyConverted(auth: Auth) {
  const intents = await getRunIntents(auth);
  const actions = await getRunActions(auth);
  artifact.evidence.final_intents = intents.map((intent) => ({
    id: intent.id,
    kind: intent.kind,
    status: intent.status,
    converted_action_id: intent.converted_action_id,
    converted_task_id: intent.converted_task_id,
    title: intent.title,
  }));
  artifact.evidence.final_actions = actions.map((action) => ({
    id: action.id,
    action: action.action,
    approval_status: action.approval_status,
    has_receipt: action.has_receipt,
    result: action.result,
  }));

  const taskIntent = intents.find((intent) => (intent.kind === 'task_candidate' || intent.kind === 'blocker_candidate') && intent.status === 'converted');
  if (!taskIntent?.converted_task_id) {
    throw new Error('Task capture did not convert to a task');
  }
  const task = await api<any>(auth, `/api/tasks/${taskIntent.converted_task_id}`);
  if (!containsMarker(task.title) && !containsMarker(task.description) && !containsMarker(task.source_message?.content)) {
    throw new Error('Created task does not retain the run marker in title, description, or source message');
  }
  if (!task.source_message?.id) {
    artifact.findings.push({
      severity: 'P2',
      title: 'Created task lacks visible source-message receipt',
      detail: `Task ${task.id} was created, but task detail did not include source_message.`,
    });
  }
  artifact.ids.created_task_id = task.id;
  artifact.evidence.created_task = {
    id: task.id,
    title: task.title,
    source_message_id: task.source_message?.id ?? task.source_message_id ?? null,
    source_space: task.source_message?.space_name ?? null,
  };

  const wikiSearch = await api<any>(auth, `/api/wiki?q=${encodeURIComponent(RUN_MARKER)}&limit=20`);
  const pages = asArray<any>(wikiSearch, ['pages']);
  artifact.evidence.wiki_search = {
    total: wikiSearch.total,
    search_mode: wikiSearch.search_mode,
    pages: pages.map((page) => ({ id: page.id, title: page.title, slug: page.slug, type: page.type })),
  };
  if (pages.length < 1) {
    throw new Error('No marker-searchable wiki page was created from approved captures');
  }

  const convertedKnowledgeIntents = intents.filter((intent) =>
    ['decision_candidate', 'resource_candidate', 'note_candidate'].includes(intent.kind)
    && intent.status === 'converted'
    && intent.converted_action_id
  );
  if (convertedKnowledgeIntents.length < 3) {
    artifact.findings.push({
      severity: 'P2',
      title: 'Not all knowledge capture kinds converted',
      detail: `Expected decision, resource, and note captures to convert. Converted kinds: ${convertedKnowledgeIntents.map((intent) => intent.kind).join(', ') || 'none'}.`,
    });
  }
  if (pages.length < convertedKnowledgeIntents.length) {
    artifact.findings.push({
      severity: 'P3',
      title: 'Some converted knowledge captures were not marker-searchable',
      detail: `Converted ${convertedKnowledgeIntents.length} knowledge intents, but marker search returned ${pages.length} page(s). This may be title/content truncation or search-vector lag.`,
    });
  }

  const convertedActions = actions.filter((action) => action.approval_status === 'approved');
  const actionIdsFromIntents = intents
    .map((intent) => intent.converted_action_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const actionIdsToCheck = Array.from(new Set([
    ...convertedActions.map((action) => action.id),
    ...actionIdsFromIntents,
  ]));
  const receipts = [];
  for (const actionId of actionIdsToCheck) {
    const receipt = await verifyReceipt(auth, actionId);
    receipts.push({ action_id: actionId, verified: receipt.verified, decision: receipt.receipt?.decision });
  }
  artifact.evidence.receipts = receipts;
}

async function createAndPromoteNote(page: Page, auth: Auth) {
  await page.goto(`${WEB_URL}/notes`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await screenshot(page, 'notes-before-new-note');
  const createResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/api/daily-notes'),
    { timeout: 20_000 },
  ).catch(() => null);
  await page.getByRole('button', { name: /new note/i }).first().click();
  const blankNote = page.getByRole('button', { name: /blank note/i }).first();
  if (await blankNote.isVisible().catch(() => false)) {
    await blankNote.click();
  }
  const created = await createResponse;
  if (created && created.status() >= 400) {
    const body = await created.text().catch(() => '');
    throw new Error(`New note failed with ${created.status()}: ${body.slice(0, 240)}`);
  }
  await page.waitForTimeout(2_000);
  await screenshot(page, 'notes-after-new-note-click');
  const noteTitle = `Manager launch note ${RUN_MARKER}`;
  const noteBody = `Manager note ${RUN_MARKER}: buyer launch needs the Tuesday route promise, Sun Gold eight-ounce sample boxes, and a clear receipt trail before the demo recording.`;
  await page.locator('input[placeholder="Untitled"]').first().fill(noteTitle);
  const editor = page.locator('[contenteditable="true"].deft-notes-editor').first();
  await editor.waitFor({ state: 'visible', timeout: 20_000 });
  await editor.click();
  await page.keyboard.insertText(noteBody);
  await page.waitForTimeout(2_500);
  await screenshot(page, 'notes-manager-note-before-promote');

  await page.getByRole('button', { name: /promote to wiki/i }).first().click();
  await page.getByRole('button', { name: /^fact$/i }).click();
  page.once('dialog', async (dialog) => { await dialog.accept(); });
  await page.getByRole('button', { name: /^promote$/i }).click();
  await page.waitForTimeout(2_000);
  await screenshot(page, 'notes-manager-note-after-promote');

  const wikiSearch = await waitFor<any>('promoted note wiki page', async () => {
    const body = await api<any>(auth, `/api/wiki?q=${encodeURIComponent(noteTitle)}&limit=10`);
    const pages = asArray<any>(body, ['pages']);
    return pages.find((page) => page.title === noteTitle || containsMarker(page)) ? { body, pages } : null;
  }, { timeoutMs: 45_000, intervalMs: 2_000 });
  artifact.evidence.promoted_note = {
    title: noteTitle,
    wiki_pages: wikiSearch.pages.map((page: any) => ({ id: page.id, title: page.title, slug: page.slug, type: page.type })),
  };
}

async function captureKnowledgeSurface(page: Page) {
  await page.goto(`${WEB_URL}/knowledge`, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  const search = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill(RUN_MARKER);
    await page.waitForTimeout(1_000);
  }
  await screenshot(page, 'knowledge-search-marker');
}

function summarizeClaimStatus() {
  const checks = artifact.checks;
  const hasFail = checks.some((check) => check.status === 'fail');
  const hasWarn = checks.some((check) => check.status === 'warn') || artifact.findings.some((finding) => finding.severity === 'P1' || finding.severity === 'P2');
  if (hasFail) return 'Needs fixes before being used as proof';
  if (hasWarn) return 'Mostly works, with caveats to fix or narrate honestly';
  return 'Validated for demo use';
}

async function writeReport() {
  artifact.finished_at = new Date().toISOString();
  await fs.mkdir(path.dirname(HTML_REPORT), { recursive: true });
  await fs.writeFile(JSON_REPORT, JSON.stringify(artifact, null, 2));

  const rel = (file: string) => path.relative(path.dirname(HTML_REPORT), file).replace(/\\/g, '/');
  const counts = artifact.checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const claimRows = [
    {
      claim: 'Chat becomes context',
      verdict: artifact.checks.find((check) => check.name.includes('Expected Defty captures appeared'))?.status === 'pass' ? 'Validated' : 'Partial',
      evidence: 'Diego sent tagged messages in chat; Defty produced task, decision, resource, and note captures visible in Captures.',
    },
    {
      claim: 'Tasks become action',
      verdict: artifact.ids.created_task_id ? 'Validated' : 'Not proven',
      evidence: artifact.ids.created_task_id ? `Approved capture created task ${artifact.ids.created_task_id}.` : 'No converted task ID recorded.',
    },
    {
      claim: 'Notes become memory',
      verdict: artifact.evidence.promoted_note ? 'Validated with explicit promotion' : 'Not proven',
      evidence: 'Manager note was created through the Notes UI and promoted to a searchable wiki page.',
    },
    {
      claim: 'Approvals become governance',
      verdict: Array.isArray((artifact.evidence as any).receipts) && (artifact.evidence as any).receipts.length > 0 ? 'Validated' : 'Partial',
      evidence: 'Captured actions required UI approval and approved actions were checked for verified receipts.',
    },
  ];

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Deft Demo Claim Certification - ${escapeHtml(RUN_MARKER)}</title>
  <style>
    :root { color-scheme: light; --ink:#191714; --muted:#6f675d; --line:#ddd6ca; --paper:#faf8f3; --card:#fffdf8; --accent:#6f5fda; --green:#168a5b; --amber:#a86700; --red:#c63d32; }
    body { margin:0; background:var(--paper); color:var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height:1.45; }
    main { max-width:1120px; margin:0 auto; padding:40px 24px 64px; }
    h1 { font-size:34px; line-height:1.04; letter-spacing:0; margin:0 0 10px; }
    h2 { font-size:20px; margin:34px 0 12px; }
    h3 { font-size:15px; margin:20px 0 8px; }
    p { color:var(--muted); max-width:820px; }
    .hero { border:1px solid var(--line); background:var(--card); border-radius:10px; padding:26px; }
    .pill { display:inline-flex; align-items:center; gap:8px; padding:5px 10px; border-radius:999px; border:1px solid var(--line); background:#fff; font-size:12px; color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; }
    .card { border:1px solid var(--line); background:var(--card); border-radius:8px; padding:16px; }
    table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { text-align:left; vertical-align:top; border-bottom:1px solid var(--line); padding:11px 12px; font-size:13px; }
    th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; background:#f4efe7; }
    tr:last-child td { border-bottom:0; }
    .pass { color:var(--green); font-weight:700; }
    .warn { color:var(--amber); font-weight:700; }
    .fail { color:var(--red); font-weight:700; }
    .screens { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px; }
    figure { margin:0; border:1px solid var(--line); background:var(--card); border-radius:8px; overflow:hidden; }
    figure img { width:100%; display:block; background:#fff; }
    figcaption { padding:9px 11px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; border:1px solid var(--line); background:#fffdf8; border-radius:8px; padding:14px; font-size:12px; color:#37312b; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
<main>
  <section class="hero">
    <span class="pill">Live demo instance certification</span>
    <h1>Deft Demo Claim Certification</h1>
    <p><strong>Status:</strong> ${escapeHtml(summarizeClaimStatus())}</p>
    <p>Run marker <code>${escapeHtml(RUN_MARKER)}</code>. Tested as Diego on <code>${escapeHtml(WEB_URL)}</code>. UI actions were used for login, chat, capture approvals, note creation, and note promotion; API reads were used afterward as evidence.</p>
    <div class="grid">
      <div class="card"><strong>${counts.pass || 0}</strong><br><span class="pass">Passed checks</span></div>
      <div class="card"><strong>${counts.warn || 0}</strong><br><span class="warn">Warnings</span></div>
      <div class="card"><strong>${counts.fail || 0}</strong><br><span class="fail">Failures</span></div>
    </div>
  </section>

  <h2>Claim Verdicts</h2>
  <table>
    <thead><tr><th>Claim</th><th>Verdict</th><th>Evidence</th></tr></thead>
    <tbody>
      ${claimRows.map((row) => `<tr><td>${escapeHtml(row.claim)}</td><td><strong>${escapeHtml(row.verdict)}</strong></td><td>${escapeHtml(row.evidence)}</td></tr>`).join('')}
    </tbody>
  </table>

  <h2>Checks</h2>
  <table>
    <thead><tr><th>Status</th><th>Check</th><th>Detail</th><th>Time</th></tr></thead>
    <tbody>
      ${artifact.checks.map((check) => `<tr><td class="${check.status}">${check.status.toUpperCase()}</td><td>${escapeHtml(check.name)}</td><td>${escapeHtml(typeof check.detail === 'string' ? check.detail : check.detail ? JSON.stringify(check.detail) : '')}</td><td>${check.ms ?? ''}ms</td></tr>`).join('')}
    </tbody>
  </table>

  <h2>Findings</h2>
  ${artifact.findings.length === 0 ? '<p>No new blocker findings from this run.</p>' : `<table><thead><tr><th>Severity</th><th>Finding</th><th>Detail</th></tr></thead><tbody>${artifact.findings.map((finding) => `<tr><td>${escapeHtml(finding.severity)}</td><td>${escapeHtml(finding.title)}</td><td>${escapeHtml(finding.detail)}</td></tr>`).join('')}</tbody></table>`}

  <h2>Screenshots</h2>
  <div class="screens">
    ${Object.entries(artifact.screenshots).map(([name, file]) => `<figure><img src="${escapeHtml(rel(file))}" alt="${escapeHtml(name)}"><figcaption>${escapeHtml(name)}</figcaption></figure>`).join('')}
  </div>

  <h2>Evidence JSON</h2>
  <pre>${escapeHtml(JSON.stringify({ ids: artifact.ids, evidence: artifact.evidence }, null, 2))}</pre>
</main>
</body>
</html>`;

  await fs.writeFile(HTML_REPORT, html);
  console.log('HTML report written under the reports directory.');
  console.log('JSON report written under the reports directory.');
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) consoleErrors.push(`${msg.type()}: ${msg.text()}`);
  });

  try {
    const auth = await step('API login works for Diego', loginApi) as Auth;
    await step('UI login works for Diego', () => loginUi(page));

    if (args.has('--notes-only')) {
      await step('Create a manager note and promote it to wiki through UI', () => createAndPromoteNote(page, auth));
      await step('Knowledge search shows promoted note memory', () => captureKnowledgeSurface(page));
      mark('pass', 'Notes-only certification completed');
      return;
    }

    const space = await step('Pick a seeded public workspace space', () => pickSpace(auth)) as Space;
    await gotoSurface(page, `/chat?space=${encodeURIComponent(space.id)}`, 'surface-chat-start', new RegExp(space.name, 'i'));

    const messages = {
      noise: `Quick FYI ${RUN_MARKER}: the basil by the packhouse smells great today. No action needed, no task, no memory.`,
      workflow: [
        `Demo workflow ${RUN_MARKER}:`,
        `Task: create a P2 task named "Confirm route capacity and pack sample boxes" for the Pilot Marketing Launch project; assign it to Lina if possible; due tomorrow.`,
        `Decision: Testers Tomatoes will use the Tuesday route promise gate before sending any buyer launch copy.`,
        `Resource: buyer promise checklist is confirm Tomas route capacity, pack eight-ounce Sun Gold sample boxes, and use https://demo.deft.ing/docs/self-hosting as the self-host reference.`,
        `Fact: shelf-life trial notes say Sun Gold sample boxes should be packed as eight-ounce mixed packs for Chef Amara.`,
      ].join('\n'),
    };

    await step('Send demo workflow messages through Chat UI', async () => {
      for (const [label, content] of Object.entries(messages)) {
        await sendChatMessage(page, space, label, content);
        if (label === 'noise') {
          mark('warn', 'Waiting one limiter window between chat sends on production demo', 'Public demo hit default rate limits during rapid automated sends.');
          await delay(65_000);
        }
      }
      await screenshot(page, 'chat-after-demo-messages');
    });

    const captureBundle = await step('Expected Defty captures appeared after chat messages', () => waitForExpectedCaptures(auth)) as { intents: any[]; actions: any[] };
    artifact.evidence.initial_intents = captureBundle.intents.map((intent) => ({
      id: intent.id,
      kind: intent.kind,
      status: intent.status,
      title: intent.title,
      confidence: intent.confidence,
    }));
    artifact.evidence.initial_actions = captureBundle.actions.map((action) => ({
      id: action.id,
      action: action.action,
      approval_status: action.approval_status,
      params: action.params,
    }));

    const noiseCaptured = captureBundle.intents.some((intent) => containsMarker(intent.source_message_content) && String(intent.source_message_content).includes('No action needed'));
    if (noiseCaptured) {
      artifact.findings.push({
        severity: 'P2',
        title: 'No-action chat message was captured',
        detail: `The explicit no-action/no-memory message tagged ${RUN_MARKER} produced a capture. That is a guardrail/noise issue for high-volume teams.`,
      });
    } else {
      mark('pass', 'No-action chat message did not produce a capture');
    }

    await step('Approve task capture through Captures UI', () => approveCaptureWithUi(page, 'Create task', 'task'));
    await step('Approve decision capture through Captures UI', () => approveCaptureWithUi(page, 'Save decision', 'decision'), true);
    await step('Approve resource capture through Captures UI', () => approveCaptureWithUi(page, 'Save resource', 'resource'), true);
    await step('Approve memory capture through Captures UI', () => approveCaptureWithUi(page, 'Save knowledge', 'knowledge'), true);

    await step('Verify approved captures produced task/wiki records and receipts', () => verifyConverted(auth));
    await step('Create a manager note and promote it to wiki through UI', () => createAndPromoteNote(page, auth));
    await step('Knowledge search shows created memory', () => captureKnowledgeSurface(page));

    await step('Core surfaces render in browser after workflow', async () => {
      const surfaces: Array<[string, string, RegExp]> = [
        ['/dashboard', 'surface-dashboard', /dashboard|my work|agent activity/i],
        ['/inbox', 'surface-inbox', /inbox|nothing here|captures|approvals/i],
        ['/inbox?tab=captures', 'surface-captures', /captures|nothing here|Defty/i],
        ['/tasks', 'surface-tasks', /backlog|todo|in progress|done|tasks/i],
        ['/knowledge', 'surface-knowledge', /knowledge|wiki|graph/i],
        ['/calendar', 'surface-calendar', /calendar|today|events/i],
        ['/settings/mcp-access', 'surface-mcp-access', /mcp|connected ai apps|personal access/i],
      ];
      for (const [route, name, expected] of surfaces) {
        await gotoSurface(page, route, name, expected);
        await delay(1_500);
      }
    }, true);

    const taskId = artifact.ids.created_task_id;
    if (taskId) {
      await step('Created task opens in task detail UI', async () => {
        await page.goto(`${WEB_URL}/tasks?task=${encodeURIComponent(taskId)}`, { waitUntil: 'domcontentloaded' });
        await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
        await page.getByText(RUN_MARKER, { exact: false }).first().waitFor({ state: 'visible', timeout: 25_000 });
        await screenshot(page, 'created-task-detail');
      }, true);
    }

    const seriousConsoleErrors = consoleErrors.filter((line) => !/favicon|ResizeObserver|hydration/i.test(line));
    artifact.evidence.console_errors = seriousConsoleErrors.slice(0, 25);
    if (seriousConsoleErrors.length > 0) {
      artifact.findings.push({
        severity: 'P3',
        title: 'Console warnings/errors appeared during run',
        detail: seriousConsoleErrors.slice(0, 5).join('\n'),
      });
      mark('warn', 'Browser console contained warnings/errors', seriousConsoleErrors.length);
    } else {
      mark('pass', 'No serious browser console errors observed');
    }
  } finally {
    await browser.close();
    await writeReport();
  }
}

main().catch(async (err) => {
  artifact.findings.push({
    severity: 'P1',
    title: 'Certification run stopped early',
    detail: err instanceof Error ? err.stack || err.message : String(err),
  });
  await writeReport();
  console.error(err);
  process.exit(1);
});
