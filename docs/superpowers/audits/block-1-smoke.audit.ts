#!/usr/bin/env tsx
/**
 * Block 1 end-to-end smoke — verifies every Block 1 surface ships.
 *
 * Live OpenClaw gateway acceptance (attach slack → install → call tool,
 * reasoning trace, per-org gateway reuse in Railway) cannot run without
 * a running gateway. This suite covers everything that CAN run without
 * one: API contract shape, UI routes render, new routes return correct
 * shape for the no-gateway-connected case.
 *
 * Runs against dev API on :3001 + web on :3000. Uses maneek@test.com.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const SHOT_DIR = 'docs/superpowers/audits/screenshots/block-1-smoke';
const REPORT = 'docs/superpowers/audits/block-1-smoke.last-run.txt';

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

  // 1.5 — /api/clawhub/browse returns allowlist shape
  const browse = await api<{ mode: string; entries: unknown[] }>('/api/clawhub/browse', auth.accessToken);
  assertTrue(
    browse.status === 200 && browse.body?.mode === 'allowlist' && Array.isArray(browse.body.entries),
    `1.5 GET /api/clawhub/browse → ${browse.status} mode=${browse.body?.mode} entries=${Array.isArray(browse.body?.entries) ? browse.body.entries.length : 'non-array'}`,
  );

  // 1.5 — /api/clawhub/browse?advanced=1 requires admin (our test user is admin)
  const adv = await api<{ mode: string }>('/api/clawhub/browse?advanced=1', auth.accessToken);
  assertTrue(
    adv.status === 200 || adv.status === 403,
    `1.5 GET /api/clawhub/browse?advanced=1 → ${adv.status} (200 or 403 both acceptable)`,
  );

  // 1.5 — POST /api/clawhub/import with unknown slug → 400
  const badImport = await api('/api/clawhub/import', auth.accessToken, {
    method: 'POST',
    body: JSON.stringify({ slug: 'this-slug-definitely-does-not-exist-12345' }),
  });
  assertTrue(
    badImport.status === 400,
    `1.5 POST /api/clawhub/import {unknown} → ${badImport.status} (expect 400)`,
  );

  // 1.5 — POST /api/clawhub/import with an existing allowlist slug → 201 or 200 (reused)
  const firstEntry = (browse.body?.entries as Array<{ slug: string }> | undefined)?.[0];
  if (firstEntry) {
    const goodImport = await api<{ skill: { id: string; slug: string }; reused: boolean }>(
      '/api/clawhub/import',
      auth.accessToken,
      { method: 'POST', body: JSON.stringify({ slug: firstEntry.slug }) },
    );
    assertTrue(
      (goodImport.status === 201 || goodImport.status === 200) && !!goodImport.body?.skill?.id,
      `1.5 POST /api/clawhub/import {${firstEntry.slug}} → ${goodImport.status} skill.id=${goodImport.body?.skill?.id?.slice(0, 8)} reused=${goodImport.body?.reused}`,
    );
  } else {
    info('1.5 allowlist empty — skipping successful-import check (cron has not run yet)');
  }

  // 1.2 — list an openclaw employee's files. Need an openclaw employee.
  const emps = await api<Array<{ id: string; kind: string; name: string }>>(
    '/api/agent-employees',
    auth.accessToken,
  );
  const openclawEmp = Array.isArray(emps.body)
    ? emps.body.find((e) => e.kind === 'openclaw')
    : undefined;
  if (openclawEmp) {
    const files = await api<{
      files: Array<{ filename: string; exists: boolean | null }>;
      canonical: string[];
      gateway_unreachable?: boolean;
    }>(`/api/agent-employees/${openclawEmp.id}/files`, auth.accessToken);
    assertTrue(
      files.status === 200 && Array.isArray(files.body?.files),
      `1.2 GET /files → ${files.status} files=${files.body?.files?.length}`,
    );
    assertTrue(
      Array.isArray(files.body?.canonical) && files.body.canonical.includes('SOUL.md'),
      `1.2 canonical files include SOUL.md (got ${JSON.stringify(files.body?.canonical)})`,
    );

    // PUT with invalid filename → 400
    const badPut = await api(`/api/agent-employees/${openclawEmp.id}/files/../evil`, auth.accessToken, {
      method: 'PUT',
      body: JSON.stringify({ content: 'nope' }),
    });
    assertTrue(
      badPut.status === 400 || badPut.status === 404,
      `1.2 PUT /files/../evil rejected → ${badPut.status} (400 or 404 acceptable)`,
    );

    // GET an individual file when gateway unreachable → 503
    const individualGet = await api(
      `/api/agent-employees/${openclawEmp.id}/files/SOUL.md`,
      auth.accessToken,
    );
    assertTrue(
      individualGet.status === 503 || individualGet.status === 200 || individualGet.status === 502,
      `1.2 GET /files/SOUL.md → ${individualGet.status} (503/502 expected without gateway)`,
    );
  } else {
    info('1.2 no openclaw employee in org — skipping files API checks');
  }

  // 1.3 — DELETE /api/skills/:id/install without agent_employee_id → 400
  const badDelete = await api('/api/skills/any-id/install', auth.accessToken, { method: 'DELETE' });
  assertTrue(
    badDelete.status === 400,
    `1.3 DELETE /install (no employee_id) → ${badDelete.status} (expect 400)`,
  );

  // 1.6 — POST /api/skills/:id/secrets validation (uppercase + underscore)
  const badSecretKey = await api('/api/skills/not-a-real-skill/secrets', auth.accessToken, {
    method: 'POST',
    body: JSON.stringify({ key_name: 'not valid key', value: 'x' }),
  });
  assertTrue(
    badSecretKey.status === 400,
    `1.6 POST /skills/:id/secrets {bad key} → ${badSecretKey.status} (expect 400)`,
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
    // 1.5 — Library page shows three tabs including ClawHub
    await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await shot(page, '01-library-default');
    const skillsTab = await page.getByRole('button', { name: /^skills$/i }).count();
    const templatesTab = await page.getByRole('button', { name: /^templates$/i }).count();
    const clawhubTab = await page.getByRole('button', { name: /^clawhub$/i }).count();
    assertTrue(skillsTab > 0 && templatesTab > 0 && clawhubTab > 0,
      `1.5 Library has all three tabs (skills=${skillsTab} templates=${templatesTab} clawhub=${clawhubTab})`);

    // Click ClawHub tab
    if (clawhubTab > 0) {
      await page.getByRole('button', { name: /^clawhub$/i }).click();
      await page.waitForTimeout(600);
      await shot(page, '02-library-clawhub');
      // Should show either entries, a "no entries" note, or an error banner — NOT a blank page
      const bodyText = await page.locator('body').innerText();
      assertTrue(
        bodyText.includes('ClawHub') || bodyText.includes('VoltAgent') || bodyText.includes('allowlist') || bodyText.includes('No allowlist'),
        '1.5 ClawHub tab renders content',
      );
    }

    // 1.2 — personality editor page renders
    if (openclawEmp) {
      await page.goto(`${WEB_URL}/settings/agent-employees/${openclawEmp.id}/personality`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(400);
      await shot(page, '03-personality-editor');
      const personalityText = await page.locator('body').innerText();
      assertTrue(
        personalityText.includes('Personality') || personalityText.includes('SOUL.md'),
        '1.2 Personality editor page renders Personality header + file list',
      );

      // Clicking on a file should NOT crash the page
      const fileButton = page.getByRole('button', { name: /SOUL\.md/i }).first();
      if (await fileButton.count() > 0) {
        await fileButton.click().catch(() => undefined);
        await page.waitForTimeout(400);
        await shot(page, '04-personality-file-selected');
      }
    }

    // Regression — Block 0.2 badge + Block 0.7 redirect still work
    await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await shot(page, '05-dashboard');
    const agentNav = await page.getByRole('link', { name: /^Agent/ }).count();
    assertTrue(agentNav > 0, 'regression: Agent nav still present');

    await page.goto(`${WEB_URL}/settings/agent/deploy`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(800);
    assertTrue(
      page.url().includes('/settings/agent-employees/create'),
      `regression: /settings/agent/deploy still redirects (got ${page.url()})`,
    );
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
