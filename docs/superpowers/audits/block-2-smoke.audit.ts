#!/usr/bin/env tsx
/**
 * Block 2 end-to-end smoke — verifies every Block 2 surface ships.
 *
 * Runs against dev API on :3001 + web on :3000. Uses maneek@test.com.
 *
 * Most of Block 2's logic is covered by executor unit tests (83 passing
 * earlier in the branch). This audit is the thin lap around the API +
 * UI surfaces that matter in production.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const SHOT_DIR = 'docs/superpowers/audits/screenshots/block-2-smoke';
const REPORT = 'docs/superpowers/audits/block-2-smoke.last-run.txt';

const log: Array<{ level: 'ok' | 'fail' | 'info'; msg: string }> = [];
const ok = (m: string) => { log.push({ level: 'ok', msg: m }); console.log('OK', m); };
const fail = (m: string) => { log.push({ level: 'fail', msg: m }); console.error('FAIL', m); };
const info = (m: string) => { log.push({ level: 'info', msg: m }); console.log('INFO', m); };
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

  // 2.8 — GET /api/agent/actions/recent returns a list shape
  const recent = await api<{ actions: unknown[] }>('/api/agent/actions/recent?limit=5', auth.accessToken);
  assertTrue(
    recent.status === 200 && Array.isArray(recent.body?.actions),
    `2.8 GET /api/agent/actions/recent → ${recent.status} count=${recent.body?.actions?.length}`,
  );

  // 2.8 — /api/agent/actions/recent caps limit to 50
  const bigLimit = await api<{ actions: unknown[] }>('/api/agent/actions/recent?limit=9999', auth.accessToken);
  assertTrue(
    bigLimit.status === 200 && (bigLimit.body?.actions?.length ?? 0) <= 50,
    `2.8 recent limit clamped to 50 (got ${bigLimit.body?.actions?.length})`,
  );

  // 2.8 — /api/dashboard/agent-activity returns array
  const da = await api<unknown[]>('/api/dashboard/agent-activity', auth.accessToken);
  assertTrue(
    da.status === 200 && Array.isArray(da.body),
    `2.8 GET /api/dashboard/agent-activity → ${da.status}`,
  );

  // ─── Web UI (Playwright) ──────────────────────────────────────────

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(
    ({ at, rt }: { at: string; rt: string | null }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: auth.accessToken, rt: auth.refreshToken ?? null },
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(12_000);

  try {
    // 2.8 — dashboard renders Agent Activity card
    await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await shot(page, '01-dashboard');
    const agentActivityHeader = await page.getByText('Agent Activity').count();
    assertTrue(agentActivityHeader > 0, '2.8 Dashboard renders "Agent Activity" bento card');

    // 2.9 — Personality editor with HEARTBEAT.md shows the structured builder
    const emps = await api<Array<{ id: string; kind: string }>>(
      '/api/agent-employees',
      auth.accessToken,
    );
    const openclawEmp = Array.isArray(emps.body)
      ? emps.body.find((e) => e.kind === 'openclaw')
      : undefined;
    if (openclawEmp) {
      await page.goto(`${WEB_URL}/settings/agent-employees/${openclawEmp.id}/personality`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(400);
      // Click HEARTBEAT.md
      const hb = page.getByRole('button', { name: /HEARTBEAT\.md/i }).first();
      if (await hb.count() > 0) {
        await hb.click();
        await page.waitForTimeout(500);
        await shot(page, '02-heartbeat-builder');
        const hasAddCheck = await page.getByRole('button', { name: /add check/i }).count();
        const hasRawMarkdown = await page.getByText(/raw markdown/i).count();
        assertTrue(hasAddCheck > 0, '2.9 HEARTBEAT.md shows structured builder ("Add check" button)');
        assertTrue(hasRawMarkdown > 0, '2.9 builder exposes collapsible raw markdown');

        // Add a row, verify it renders
        await page.getByRole('button', { name: /add check/i }).click();
        await page.waitForTimeout(200);
        await shot(page, '03-heartbeat-builder-with-row');
        const numberInputs = await page.locator('input[type="number"]').count();
        assertTrue(numberInputs >= 1, '2.9 clicking "Add check" inserts a new row');
      } else {
        info('2.9 HEARTBEAT.md button not visible — personality list did not load');
      }

      // Compare: SOUL.md should still show the plain textarea, not the builder
      const soul = page.getByRole('button', { name: /SOUL\.md/i }).first();
      if (await soul.count() > 0) {
        await soul.click();
        await page.waitForTimeout(400);
        const addCheckOnSoul = await page.getByRole('button', { name: /add check/i }).count();
        assertTrue(addCheckOnSoul === 0, '2.9 SOUL.md does NOT show the heartbeat builder');
      }
    } else {
      info('2.9 no openclaw employee — skipping personality builder check');
    }

    // Regression — Library page still shows 3 tabs from Block 1.5
    await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const clawhubTab = await page.getByRole('button', { name: /^clawhub$/i }).count();
    assertTrue(clawhubTab > 0, 'regression: ClawHub tab from Block 1.5 still present');
  } finally {
    await browser.close();
  }

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
