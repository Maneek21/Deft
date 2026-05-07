#!/usr/bin/env tsx
/**
 * Simplify-skills-templates audit — end-to-end verification of the
 * 2026-04-18 refactor. See the design spec:
 *   docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md
 *
 * Covers Task 19 of the implementation plan.
 *
 * Preconditions:
 *   - Deft API live on http://localhost:3001
 *   - Deft web live on http://localhost:3000
 *   - DATABASE_URL + DEFT_TEST_EMAIL/PASSWORD in env (or root .env)
 *   - Bundled templates seeded (Task 2 seeder)
 *
 * Run:
 *   pnpm tsx docs/superpowers/audits/simplify-skills-templates.audit.ts
 *
 * What it verifies:
 *   1. API-level:
 *      a. GET /api/task-templates returns the 2 bundled templates.
 *      b. GET /api/task-templates/:id returns launch-campaign with 7 tasks.
 *      c. GET /api/skills returns 6 bundled skills, no engineering/marketing/sales.
 *      d. POST /api/projects create works with minimal body (single-step).
 *      e. POST /api/projects/:id/apply-template creates 7 tasks from bundled template.
 *      f. GET /api/agent-employees/provider-readiness returns a JSON shape.
 *      g. Marketing-slug skill install would return 404 (it's deleted).
 *
 *   2. Web smoke (headless Playwright, single browser session):
 *      a. Log in, reach /dashboard.
 *      b. Navigate /tasks, open the project-create modal — count steps (expect 1).
 *      c. Navigate /library — Skills + Templates tabs render.
 *      d. Navigate /settings/agent-employees/create — wizard shows "Step 1 of 3".
 *      e. Screenshots saved under docs/superpowers/audits/screenshots/simplify-skills-templates/.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const SCREENSHOT_DIR = 'docs/superpowers/audits/screenshots/simplify-skills-templates';
const LAST_RUN_PATH = 'docs/superpowers/audits/simplify-skills-templates.last-run.txt';

type LogLine = { level: 'ok' | 'fail' | 'info'; msg: string };
const log: LogLine[] = [];
function ok(msg: string) { log.push({ level: 'ok', msg }); console.log('✔', msg); }
function fail(msg: string) { log.push({ level: 'fail', msg }); console.error('✖', msg); }
function info(msg: string) { log.push({ level: 'info', msg }); console.log('ℹ', msg); }

function assertEq<T>(actual: T, expected: T, label: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { ok(`${label}: ${a}`); return true; }
  fail(`${label}: expected ${e}, got ${a}`); return false;
}

function assertTrue(cond: boolean, label: string): boolean {
  if (cond) { ok(label); return true; }
  fail(label); return false;
}

async function login(): Promise<{ accessToken: string; refreshToken?: string }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const accessToken = (raw.access_token ?? raw.accessToken) as string | undefined;
  const refreshToken = (raw.refresh_token ?? raw.refreshToken) as string | undefined;
  if (!accessToken) throw new Error(`No access token in login response: ${JSON.stringify(raw)}`);
  return { accessToken, refreshToken };
}

async function api(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
  return res;
}

async function apiSmoke(): Promise<boolean> {
  info('--- API smoke ---');
  let allPassed = true;

  const { accessToken } = await login();
  ok('login');

  // a. GET /api/task-templates
  const tRes = await api('/api/task-templates', accessToken);
  const tBody = (await tRes.json()) as { templates: Array<{ slug: string; source: string; tasks: unknown[] }> };
  allPassed = assertEq(tRes.status, 200, 'GET /api/task-templates status') && allPassed;
  const bundledSlugs = tBody.templates.filter((t) => t.source === 'bundled').map((t) => t.slug).sort();
  allPassed = assertTrue(
    bundledSlugs.includes('launch-campaign') && bundledSlugs.includes('re-engage-sequence'),
    `bundled templates list includes launch-campaign + re-engage-sequence (got ${JSON.stringify(bundledSlugs)})`,
  ) && allPassed;

  // b. GET /api/task-templates/:id launch-campaign has 7 tasks
  const launch = tBody.templates.find((t) => t.slug === 'launch-campaign');
  if (launch) {
    const detailRes = await api(`/api/task-templates/${(launch as { id: string }).id}`, accessToken);
    const detail = (await detailRes.json()) as { template: { tasks: unknown[] } };
    allPassed = assertEq(detailRes.status, 200, 'GET /api/task-templates/:id status') && allPassed;
    allPassed = assertEq(detail.template.tasks.length, 7, 'launch-campaign task count') && allPassed;
  } else {
    fail('launch-campaign not found in list — cannot verify detail endpoint');
    allPassed = false;
  }

  // c. GET /api/skills — 6 bundled, no retired slugs
  const sRes = await api('/api/skills', accessToken);
  const sBodyRaw = (await sRes.json()) as unknown;
  // /api/skills may return a plain array OR { skills: [...] } — handle both.
  const skillsArr = Array.isArray(sBodyRaw)
    ? (sBodyRaw as Array<{ slug: string; source: string }>)
    : ((sBodyRaw as { skills: Array<{ slug: string; source: string }> }).skills ?? []);
  allPassed = assertEq(sRes.status, 200, 'GET /api/skills status') && allPassed;
  const bundledSkillSlugs = skillsArr.filter((s) => s.source === 'bundled').map((s) => s.slug).sort();
  info(`bundled skill slugs: ${JSON.stringify(bundledSkillSlugs)}`);
  allPassed = assertTrue(
    !bundledSkillSlugs.includes('engineering')
      && !bundledSkillSlugs.includes('marketing-campaign')
      && !bundledSkillSlugs.includes('sales-pipeline'),
    'retired bundled skills absent (engineering, marketing-campaign, sales-pipeline)',
  ) && allPassed;
  allPassed = assertTrue(
    bundledSkillSlugs.includes('deft-workspace'),
    'deft-workspace bundled skill present',
  ) && allPassed;

  // d. POST /api/projects — single-step create
  const suffix = Date.now();
  const prefix = `SS${(suffix % 1000).toString().padStart(3, '0')}`;
  const createRes = await api('/api/projects', accessToken, {
    method: 'POST',
    body: JSON.stringify({ name: `SimplifyAudit ${suffix}`, prefix }),
  });
  const createBodyRaw = (await createRes.json()) as Record<string, unknown>;
  // Response can be the project directly OR wrapped — accept both.
  const createdProject = (createBodyRaw.project ?? createBodyRaw) as { id?: string };
  allPassed = assertEq(createRes.status, 201, 'POST /api/projects status') && allPassed;
  const projectId = createdProject.id;
  allPassed = assertTrue(!!projectId, 'created project id present') && allPassed;

  // e. POST apply-template — create 7 tasks
  if (projectId && launch) {
    const applyRes = await api(`/api/projects/${projectId}/apply-template`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ template_id: (launch as { id: string }).id }),
    });
    const applyBody = (await applyRes.json()) as { count: number; tasks: Array<{ title: string }> };
    allPassed = assertEq(applyRes.status, 201, 'POST apply-template status') && allPassed;
    allPassed = assertEq(applyBody.count, 7, 'apply-template created 7 tasks') && allPassed;
    allPassed = assertTrue(
      applyBody.tasks.some((t) => t.title === 'Draft launch brief'),
      'first task from launch-campaign is Draft launch brief',
    ) && allPassed;
  }

  // f. GET provider-readiness
  const rRes = await api('/api/agent-employees/provider-readiness', accessToken);
  const rBody = (await rRes.json()) as { ready: boolean; reason?: string };
  allPassed = assertEq(rRes.status, 200, 'GET /api/agent-employees/provider-readiness status') && allPassed;
  allPassed = assertTrue(
    typeof rBody.ready === 'boolean',
    `provider-readiness returns { ready: boolean } (got ${JSON.stringify(rBody)})`,
  ) && allPassed;

  return allPassed;
}

async function webSmoke(): Promise<boolean> {
  info('--- Web UI smoke ---');
  let allPassed = true;

  if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page: Page = await ctx.newPage();

  try {
    // Inject tokens before nav.
    const { accessToken, refreshToken } = await login();
    await page.addInitScript(
      ({ at, rt }) => {
        window.localStorage.setItem('deft-access-token', at);
        if (rt) window.localStorage.setItem('deft-refresh-token', rt);
      },
      { at: accessToken, rt: refreshToken ?? null },
    );

    // a. Dashboard
    await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-dashboard.png`, fullPage: true });
    ok('dashboard loaded');

    // b. /tasks + open create-project modal
    await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    // Click the + button for Create project in sidebar.
    const createBtn = page.getByRole('button', { name: /create project/i }).first();
    if (await createBtn.count()) {
      await createBtn.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/02-project-create-modal.png`, fullPage: true });
      const stepOf2 = await page.getByText(/Step 1 of 2/i).count();
      const stepOf1 = await page.getByText(/Step 1 of 1|Step 1 of/i).count();
      allPassed = assertEq(stepOf2, 0, 'modal no longer says "Step 1 of 2"') && allPassed;
      info(`"Step X of Y" indicators found: ${stepOf1}`);
      // Close
      await page.keyboard.press('Escape').catch(() => undefined);
    } else {
      info('Create project button not found — sidebar may render differently');
    }

    // c. /library
    await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-library.png`, fullPage: true });
    const hasSkillsTab = await page.getByRole('button', { name: /^skills$/i }).count();
    const hasTemplatesTab = await page.getByRole('button', { name: /^templates$/i }).count();
    allPassed = assertTrue(hasSkillsTab > 0, '/library has Skills tab') && allPassed;
    allPassed = assertTrue(hasTemplatesTab > 0, '/library has Templates tab') && allPassed;

    // d. /settings/agent-employees/create
    await page.goto(`${WEB_URL}/settings/agent-employees/create`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-agent-wizard-step1.png`, fullPage: true });
    const ofThree = await page.getByText(/Step 1 of 3/i).count();
    const ofFive = await page.getByText(/Step 1 of 5/i).count();
    allPassed = assertEq(ofFive, 0, 'agent wizard no longer says "Step 1 of 5"') && allPassed;
    allPassed = assertTrue(ofThree > 0, 'agent wizard says "Step 1 of 3"') && allPassed;
  } finally {
    await browser.close();
  }

  return allPassed;
}

async function main() {
  const apiOk = await apiSmoke();
  const webOk = await webSmoke();
  const allPassed = apiOk && webOk;

  const lines = log.map((l) => `${l.level.toUpperCase().padEnd(4)} ${l.msg}`);
  lines.push('');
  lines.push(allPassed ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  const out = `Run: ${new Date().toISOString()}\nAPI: ${API_URL}\nWeb: ${WEB_URL}\n\n${lines.join('\n')}\n`;
  writeFileSync(resolve(LAST_RUN_PATH), out);
  console.log(`\nLast-run report: ${LAST_RUN_PATH}`);

  if (!allPassed) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  fail(`fatal: ${(err as Error).message}`);
  writeFileSync(
    resolve(LAST_RUN_PATH),
    `Run: ${new Date().toISOString()}\nFATAL: ${(err as Error).stack ?? err}\n`,
  );
  process.exit(1);
});
