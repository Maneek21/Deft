#!/usr/bin/env tsx
/**
 * Block 0 end-to-end smoke — verifies each behavior change ships correctly.
 *
 * Runs against dev API on :3001 + web on :3000. Uses the maneek@test.com
 * seed login. Does not mutate long-lived DB state beyond creating + cleaning
 * up its own rows.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const SHOT_DIR = 'docs/superpowers/audits/screenshots/block-0-smoke';
const REPORT = 'docs/superpowers/audits/block-0-smoke.last-run.txt';

const log: Array<{ level: 'ok' | 'fail' | 'info'; msg: string }> = [];
const ok = (m: string) => { log.push({ level: 'ok', msg: m }); console.log('✔', m); };
const fail = (m: string) => { log.push({ level: 'fail', msg: m }); console.error('✖', m); };
const info = (m: string) => { log.push({ level: 'info', msg: m }); console.log('ℹ', m); };
const assertTrue = (c: boolean, m: string) => { if (c) ok(m); else fail(m); return c; };

async function login() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  return {
    accessToken: (j.access_token ?? j.accessToken) as string,
    refreshToken: (j.refresh_token ?? j.refreshToken) as string | undefined,
    orgId: (j.org_id ?? j.orgId) as string,
    userId: (j.user as { id: string } | undefined)?.id ?? '',
  };
}

async function api<T>(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
  const txt = await res.text();
  let body: unknown = txt;
  try { body = JSON.parse(txt); } catch { /* keep text */ }
  return { status: res.status, body: body as T };
}

async function shot(page: Page, name: string) {
  const path = `${SHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  info(`screenshot ${path}`);
}

async function main() {
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

  const auth = await login();
  ok(`login: org=${auth.orgId.slice(0, 8)} user=${auth.userId.slice(0, 8)}`);

  // ─── API-level checks ─────────────────────────────────────────────

  // 0.2 — pending approvals endpoint returns a valid shape
  const p = await api<unknown>('/api/agent/actions/pending', auth.accessToken);
  const okShape = p.status === 200 && (Array.isArray(p.body) || (p.body && typeof p.body === 'object'));
  assertTrue(okShape, `0.2 GET /api/agent/actions/pending → ${p.status}`);

  // 0.3 — PATCH agent-employees accepts new edit fields
  const emps = await api<Array<{ id: string; name: string }>>('/api/agent-employees', auth.accessToken);
  const firstEmp = Array.isArray(emps.body) ? emps.body[0] : undefined;
  if (firstEmp) {
    const originalName = firstEmp.name;
    const patchRes = await api(`/api/agent-employees/${firstEmp.id}`, auth.accessToken, {
      method: 'PATCH',
      body: JSON.stringify({ expertise_description: 'Block 0 audit touched this at ' + Date.now() }),
    });
    assertTrue(
      patchRes.status === 200,
      `0.3 PATCH /api/agent-employees/:id accepts expertise_description → ${patchRes.status}`,
    );
    // Restore (not strictly needed for tests but is polite)
    await api(`/api/agent-employees/${firstEmp.id}`, auth.accessToken, {
      method: 'PATCH',
      body: JSON.stringify({ expertise_description: null }),
    });
    info(`0.3 unchanged name: ${originalName}`);
  } else {
    info('0.3 no agent-employees in org — PATCH check skipped');
  }

  // 0.4 + 0.5 — reminders fire via BullMQ + create_reminder tool
  // Sanity: POST a reminder 2s in the future via the HTTP route; verify it
  // shows up in pending list immediately.
  const remindAt = new Date(Date.now() + 60_000).toISOString();
  const createRes = await api<{ id: string }>('/api/reminders', auth.accessToken, {
    method: 'POST',
    body: JSON.stringify({ content: 'block-0-smoke reminder ' + Date.now(), remind_at: remindAt }),
  });
  assertTrue(
    createRes.status === 201,
    `0.4 POST /api/reminders → ${createRes.status}`,
  );
  const reminderId = createRes.body?.id;
  if (reminderId) {
    const listRes = await api<Array<{ id: string; is_sent: boolean }>>('/api/reminders', auth.accessToken);
    const inList = Array.isArray(listRes.body) && listRes.body.some((r) => r.id === reminderId);
    assertTrue(inList, '0.4 reminder appears in pending list');
    // Cleanup
    await api(`/api/reminders/${reminderId}`, auth.accessToken, { method: 'DELETE' });
  }

  // ─── Web UI (Playwright) ──────────────────────────────────────────

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(
    ({ at, rt }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: auth.accessToken, rt: auth.refreshToken ?? null },
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(12_000);

  try {
    // 1. Dashboard
    await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await shot(page, '01-dashboard');
    ok('dashboard loads');

    // 0.2 — Agent nav entry exists; badge may or may not show depending on pending count
    const agentNav = page.getByRole('link', { name: /^Agent/ }).first();
    assertTrue(await agentNav.count() > 0, '0.2 Agent nav entry present');

    // 0.7 — old wizard route redirects
    await page.goto(`${WEB_URL}/settings/agent/deploy`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(600); // client-side redirect delay
    const url = page.url();
    assertTrue(
      url.includes('/settings/agent-employees/create'),
      `0.7 /settings/agent/deploy → ${url.includes('/settings/agent-employees/create') ? 'redirected correctly' : 'NOT redirected (got ' + url + ')'}`,
    );
    await shot(page, '02-redirect-target');

    // 0.7 — unified wizard shows "Step 1 of 3"
    const stepIndicator = await page.getByText(/Step 1 of 3/i).count();
    assertTrue(stepIndicator > 0, '0.7 wizard displays "Step 1 of 3"');

    // Assert old 5-step / 7-step indicators are absent
    const stepOf5 = await page.getByText(/Step 1 of 5/i).count();
    const stepOf7 = await page.getByText(/Step 1 of 7/i).count();
    assertTrue(stepOf5 === 0 && stepOf7 === 0, '0.7 no "Step 1 of 5" or "of 7"');

    // 0.2 — navigate to settings/agent to confirm approvals list renders
    await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(300);
    await shot(page, '03-settings-agent');
    // The "Deploy new employee" link should now point at canonical route
    const deployLink = await page
      .locator('a[href="/settings/agent-employees/create"][data-testid="deploy-new-employee"]')
      .count();
    assertTrue(deployLink > 0, '0.7 settings/agent Deploy link points at canonical route');

    // 0.11 — library page still works (smoke)
    await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await shot(page, '04-library');
    const hasSkillsTab = await page.getByRole('button', { name: /^skills$/i }).count();
    assertTrue(hasSkillsTab > 0, '0.11 /library renders Skills tab (no regression)');
  } finally {
    await browser.close();
  }

  // Report
  const pass = log.filter((l) => l.level === 'ok').length;
  const failN = log.filter((l) => l.level === 'fail').length;
  const report = [
    `Run: ${new Date().toISOString()}`,
    `API: ${API_URL}`,
    `Web: ${WEB_URL}`,
    `pass=${pass} fail=${failN}`,
    '',
    ...log.map((l) => `${l.level.toUpperCase().padEnd(4)} ${l.msg}`),
    '',
    failN === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failN})`,
  ].join('\n');
  writeFileSync(REPORT, report);
  console.log(`\n${REPORT}`);
  console.log(`pass=${pass} fail=${failN}`);
  process.exit(failN === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  writeFileSync(REPORT, `FATAL: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
