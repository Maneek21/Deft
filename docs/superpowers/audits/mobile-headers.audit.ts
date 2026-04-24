#!/usr/bin/env tsx
/**
 * Mobile header-zone audit — locks in chrome budget per route at 390x844.
 *
 * For each route, asserts that the y-coordinate of the first content element
 * inside <main> is under the route's budget. Higher y = more chrome above
 * content = more cramped. Budgets reflect the post-Phase-4 target.
 *
 * Phase 4 of the mobile-ux-fixes plan migrates each per-page header to
 * <PageHeader> + the AppHeader pageContext slot. Until then, this audit
 * is expected to FAIL on most routes — that's the point: the failure
 * tells the implementer of each Phase-4 task whether they hit the budget.
 *
 * Prereqs:
 *   - pnpm audit:setup has been run and playwright-auth.json exists
 *   - Web on :3000, API on :3001
 *
 * Run:  pnpm tsx docs/superpowers/audits/mobile-headers.audit.ts
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { assert } from './lib/assert.js';
import { getStatePath } from './lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';

/** y-coordinate budget for the top of the first content element under <main>, at 390x844 viewport. */
const ROUTE_BUDGETS: Record<string, number> = {
  '/dashboard': 96,
  '/chat': 130,
  '/tasks': 140,
  '/agent': 110,
  '/calendar': 130,
  '/notes': 110,
  '/knowledge': 130,
  '/library': 96,
  '/skills': 96,
  '/reminders': 110,
  '/settings': 130,
};

/** How much slack we tolerate over the budget before failing. */
const SLACK_PX = 8;

async function measureChromeY(page: Page): Promise<number> {
  // Wait for the page to settle. Use a generous timeout because some routes load slowly.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  // Find the y-coordinate of the FIRST visible element inside <main>. We skip
  // hidden/zero-area elements because Tailwind's `hidden` class produces them.
  const y = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return -1;
    for (const child of Array.from(main.querySelectorAll('*'))) {
      const r = child.getBoundingClientRect();
      if (r.width > 50 && r.height > 8) return Math.round(r.top);
    }
    return -1;
  });
  return y;
}

async function audit(page: Page, route: string, budget: number): Promise<{ pass: boolean; y: number }> {
  await page.goto(`${WEB_URL}${route}`, { waitUntil: 'domcontentloaded' });
  // Small settle delay so animated chrome (e.g. dropdowns) doesn't skew measurement.
  await page.waitForTimeout(800);
  const y = await measureChromeY(page);
  const pass = y >= 0 && y <= budget + SLACK_PX;
  return { pass, y };
}

// ── runner ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: getStatePath(),
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();

  const results: { route: string; budget: number; y: number; pass: boolean }[] = [];

  for (const [route, budget] of Object.entries(ROUTE_BUDGETS)) {
    const { pass, y } = await audit(page, route, budget);
    results.push({ route, budget, y, pass });
    const tag = pass ? '✅' : '❌';
    console.log(`${tag} ${route} → chrome y=${y}px (budget ${budget}px ± ${SLACK_PX}px)`);
  }

  await browser.close();

  const failures = results.filter((r) => !r.pass);
  if (failures.length > 0) {
    console.log(`\n${failures.length} route(s) over budget:\n`);
    for (const f of failures) {
      console.log(`  - ${f.route}: ${f.y}px > ${f.budget + SLACK_PX}px (Phase 4 hasn't trimmed this yet)`);
    }
    process.exit(1);
  }

  console.log(`\nAll ${results.length} routes within chrome budget. ✨`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
