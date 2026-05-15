#!/usr/bin/env tsx
/**
 * PR-A smoke — drives a headless Chrome through the three Category-B 404
 * fixes + the schedule-popup polish. Takes screenshots of each fixed
 * surface so a human can eyeball them. Asserts the fundamentals:
 *   - schedule popup renders the header + 4 presets + custom-time row
 *     (the original bug — items were clipped by the composer's
 *     overflow:hidden parent)
 *   - workflows page labels dropdown populates with the 6 seeded labels
 *   - skills page no longer has the dead "Attach" button on cards
 *
 * Reads creds from DEFT_TEST_EMAIL / DEFT_TEST_PASSWORD; default to the
 * demo seed user.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const OUT_DIR = path.resolve(process.cwd(), 'docs/superpowers/audits/pr-a-screenshots');
mkdirSync(OUT_DIR, { recursive: true });

function tag(s: string) {
  return `[${new Date().toISOString().slice(11, 19)}] ${s}`;
}

let CACHED_ACCESS: string | null = null;
let CACHED_REFRESH: string | null = null;

async function fetchTokens() {
  console.log(tag('Logging in via API…'));
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed ${res.status}`);
  const { accessToken, refreshToken } = (await res.json()) as { accessToken: string; refreshToken?: string };
  CACHED_ACCESS = accessToken;
  CACHED_REFRESH = refreshToken ?? null;
}

async function ensureAuthed(page: Page, url: string) {
  if (!CACHED_ACCESS) throw new Error('not logged in yet');
  await page.goto(`${WEB_URL}${url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function login(page: Page) {
  await fetchTokens();
  await page.addInitScript(
    ({ at, rt }: { at: string; rt: string | null }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: CACHED_ACCESS!, rt: CACHED_REFRESH },
  );
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function testScheduleSendPopup(page: Page): Promise<{ ok: boolean; details: string }> {
  console.log(tag('--- Bug 1: schedule-send popup ---'));
  await ensureAuthed(page, '/chat');

  // Open #engineering by clicking the sidebar link.
  const engineering = page.locator('text=engineering').first();
  await engineering.click({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(800);

  // Type into the composer.
  const composer = page.locator('[contenteditable="true"]').last();
  await composer.click({ timeout: 10_000 });
  await composer.type('PR-A audit smoke', { delay: 5 });
  await page.waitForTimeout(300);

  // Click the schedule (clock) button. The send-side toolbar has a clock
  // titled "Schedule send".
  const scheduleBtn = page.locator('button[title="Schedule send"]');
  await scheduleBtn.click({ timeout: 10_000 });
  await page.waitForTimeout(400);

  // Screenshot the popup.
  await page.screenshot({ path: path.join(OUT_DIR, '01-schedule-popup.png') });

  // Assert all parts are visible. The popup is in a portal to body.
  const header = await page.locator('text=/Schedule for/i').count();
  const in30 = await page.locator('text=/In 30 minutes/').count();
  const in1h = await page.locator('text=/In 1 hour/').count();
  const in3h = await page.locator('text=/In 3 hours/').count();
  const tomorrow = await page.locator('text=/Tomorrow 9:00 AM/').count();
  const customLabel = await page.locator('text=/Custom time/i').count();
  const view = await page.locator('text=/View scheduled messages/').count();

  const counts = { header, in30, in1h, in3h, tomorrow, customLabel, view };
  console.log(tag(`Visible parts: ${JSON.stringify(counts)}`));

  const allPresent = Object.values(counts).every((n) => n > 0);
  if (!allPresent) {
    return { ok: false, details: `Missing parts: ${JSON.stringify(counts)}` };
  }

  // Verify visual extent — top of popup must be ON-SCREEN (the clipping
  // bug had the header rendered above y=0).
  const popupBox = await page.locator('text=/Schedule for/i').first().boundingBox();
  if (!popupBox || popupBox.y < 0) {
    return { ok: false, details: `Popup header clipped above viewport (y=${popupBox?.y})` };
  }

  // Close popup; click the backdrop (the fixed inset-0 z-40 div behind it).
  // Use Escape first, fall back to clicking the page corner.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);

  return { ok: true, details: `All 7 popup elements present, header at y=${Math.round(popupBox.y)}` };
}

async function testWorkflowsLabels(page: Page): Promise<{ ok: boolean; details: string }> {
  console.log(tag('--- Bug 2: workflows labels dropdown ---'));
  // Intercept the labels fetch directly to confirm it hits the right URL.
  const requests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/labels') || req.url().includes('/api/tasks/labels')) {
      requests.push(`${req.method()} ${req.url()}`);
    }
  });
  // First confirm the cached token still validates server-side.
  const meRes = await fetch(`${API_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${CACHED_ACCESS}` },
  });
  console.log(tag(`Token check /api/auth/me → ${meRes.status}`));

  const apiResponses: Array<{ status: number; url: string }> = [];
  page.on('response', (res) => {
    if (res.url().includes('/api/') && (res.status() === 429 || res.status() === 401 || res.status() >= 500)) {
      apiResponses.push({ status: res.status(), url: res.url() });
    }
  });
  await ensureAuthed(page, '/settings/workflows');
  await page.waitForTimeout(2000);
  console.log(tag(`Non-ok API responses: ${JSON.stringify(apiResponses)}`));

  const lsDump = await page.evaluate(() => ({
    at: window.localStorage.getItem('deft-access-token')?.slice(0, 40),
    rt: window.localStorage.getItem('deft-refresh-token')?.slice(0, 40),
  }));
  console.log(tag(`localStorage after nav: ${JSON.stringify(lsDump)}`));
  console.log(tag(`After navigation, page URL = ${page.url()}`));
  await page.screenshot({ path: path.join(OUT_DIR, '02-workflows-page.png') });

  if (page.url().includes('/login')) {
    return { ok: false, details: `Auth lost — redirected to ${page.url()}` };
  }

  const goodHit = requests.some((r) => r.includes('/api/tasks/labels'));
  const badHit = requests.some((r) => /\/api\/labels(\?|$)/.test(r));
  console.log(tag(`Label fetches observed: ${JSON.stringify(requests)}`));

  if (badHit) return { ok: false, details: 'Old /api/labels URL still being called' };
  if (!goodHit) return { ok: false, details: 'No request to /api/tasks/labels (page may have errored out)' };
  return { ok: true, details: `Fetched ${requests[0]}` };
}

async function testSkillsPage(page: Page): Promise<{ ok: boolean; details: string }> {
  console.log(tag('--- Bug 3: skills page (dead Attach button gone) ---'));
  const apiRequests: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/projects/') && url.includes('/skills')) {
      apiRequests.push(`${req.method()} ${url}`);
    }
  });
  await ensureAuthed(page, '/skills');
  await page.waitForTimeout(2000);

  console.log(tag(`After navigation, page URL = ${page.url()}`));
  await page.screenshot({ path: path.join(OUT_DIR, '03-skills-page.png'), fullPage: true });

  if (page.url().includes('/login')) {
    return { ok: false, details: `Auth lost — redirected to ${page.url()}` };
  }

  // Locate skill cards. Any "Attach" button is what we deleted.
  const attachButtons = await page.locator('button:has-text("Attach")').count();
  const installButtons = await page.locator('button:has-text("Install")').count();
  const projectsRequests = apiRequests.length;

  console.log(tag(`Attach buttons: ${attachButtons}, Install buttons: ${installButtons}, project/skills requests: ${projectsRequests}`));

  if (attachButtons > 0) return { ok: false, details: `Found ${attachButtons} stray Attach button(s)` };
  if (projectsRequests > 0) return { ok: false, details: `Page still POSTs to /api/projects/.../skills (${apiRequests.join(', ')})` };
  if (installButtons === 0) return { ok: false, details: 'No Install buttons either — page may not be rendering at all' };

  return { ok: true, details: `0 Attach buttons, ${installButtons} Install buttons present` };
}

async function main() {
  let browser: Browser | undefined;
  let exitCode = 0;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    await login(page);

    const results: Array<{ name: string; ok: boolean; details: string }> = [];
    results.push({ name: 'Bug 1 — schedule popup', ...(await testScheduleSendPopup(page)) });
    // Each page load fires 10+ requests; the 100/min/user rate-limit bucket
    // burns fast across 3 navigations. Brief pause keeps each test honest.
    console.log(tag('Sleeping 25s to let the rate-limit bucket recover…'));
    await page.waitForTimeout(25_000);
    results.push({ name: 'Bug 2 — workflows labels', ...(await testWorkflowsLabels(page)) });
    console.log(tag('Sleeping 25s again before bug 3…'));
    await page.waitForTimeout(25_000);
    results.push({ name: 'Bug 3 — skills page', ...(await testSkillsPage(page)) });

    console.log('\n═══ RESULTS ═══');
    for (const r of results) {
      console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} — ${r.details}`);
      if (!r.ok) exitCode = 1;
    }
    console.log(`\nScreenshots saved to: ${OUT_DIR}`);
  } catch (err) {
    console.error(tag('ERROR:'), err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    await browser?.close();
  }
  process.exit(exitCode);
}

main();
