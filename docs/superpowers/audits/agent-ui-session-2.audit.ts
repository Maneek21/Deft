#!/usr/bin/env tsx
/**
 * Session 2 audit — approval cards + metadata trust signals.
 *
 * New assertions (7):
 *   1. friendly tool name       — approval card shows humanized label
 *   2. params visible           — approval card shows tool params (URL for browser_navigate)
 *   3. no follow-ups pending    — follow-up chips hidden while action pending
 *   4. no confidence pending    — confidence indicator hidden while action pending
 *   5. tool-backed = high       — final bubble for a tool-backed answer shows "High confidence"
 *   6. tokens aggregated        — multi-iter response shows cumulative tokens on terminal row
 *   7. in-flight label humanized — AgentThinking text during streaming is humanized
 *
 * Regression:
 *   Re-runs all 7 Session 1 assertions by spawning `pnpm audit:session1`.
 *
 * Prereqs:
 *   - pnpm audit:setup has been run
 *   - API on :3001, web on :3000
 *   - Session 1 green (regression must still pass)
 *
 * Run:  pnpm audit:session2
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { eq, desc } from 'drizzle-orm';
import { assert } from './lib/assert.js';
import { db, schema } from './lib/db.js';
import { getStatePath } from './lib/auth.js';

const { agentConversations } = schema;

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const ALEX_PM_ID = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633';
const AGENT_URL = `${WEB_URL}/agent?employee=${ALEX_PM_ID}`;

// ── helpers ──────────────────────────────────────────────────────────

async function newConversation(page: Page): Promise<void> {
  await page.goto(AGENT_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea[placeholder*="Ask Alex"]', { state: 'visible', timeout: 10_000 });
}

async function sendAndWaitForResponse(page: Page, prompt: string, timeoutMs = 90_000): Promise<void> {
  const ta = page.locator('textarea[placeholder*="Ask Alex"]');
  await ta.fill(prompt);
  await ta.press('Enter');
  await page.waitForFunction(
    () => {
      const main = document.querySelector('main');
      const text = main?.innerText || '';
      return /tokens\b/.test(text.slice(-500)) || /Approve/.test(text.slice(-500));
    },
    null,
    { timeout: timeoutMs },
  );
}

async function sendAndWaitForApprovalCard(page: Page, prompt: string, timeoutMs = 60_000): Promise<void> {
  const ta = page.locator('textarea[placeholder*="Ask Alex"]');
  await ta.fill(prompt);
  await ta.press('Enter');
  await page.waitForFunction(
    () => {
      const btns = Array.from(document.querySelectorAll('main button'));
      return btns.some((b) => (b.textContent || '').trim() === 'Approve');
    },
    null,
    { timeout: timeoutMs },
  );
}

async function getLatestConversationId(): Promise<string> {
  const [conv] = await db
    .select({ id: agentConversations.id })
    .from(agentConversations)
    .where(eq(agentConversations.agent_employee_id, ALEX_PM_ID))
    .orderBy(desc(agentConversations.updated_at))
    .limit(1);
  assert(conv, 'No conversation found for Alex PM');
  return conv.id;
}

async function screenshotOnFail(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: `audit-failure-${name}.png`, fullPage: true });
    console.error(`  📸 audit-failure-${name}.png`);
  } catch { /* ignore */ }
}

// ── Session 2 tests ──────────────────────────────────────────────────

async function testFriendlyToolName(page: Page): Promise<void> {
  console.log('  Test 1/7: friendly tool name in approval card...');
  await newConversation(page);
  await sendAndWaitForApprovalCard(
    page,
    'please navigate my browser to https://example.com to verify the page is reachable',
  );
  const mainText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  assert(
    !mainText.includes('mcp__playwright-browser__browser_navigate'),
    `Found raw tool name in main DOM — humanization failed.\nMain innerText tail: ${mainText.slice(-600)}`,
  );
  const humanizedFound =
    mainText.includes('Playwright Browser') ||
    mainText.includes('Browser Navigate');
  assert(
    humanizedFound,
    `Expected humanized label (Playwright Browser / Browser Navigate) in card, got: ${mainText.slice(-400)}`,
  );
  console.log('    ✓ humanized label shown, raw name hidden');
}

async function testParamsVisible(page: Page): Promise<void> {
  console.log('  Test 2/7: params visible in approval card...');
  // Reuse the state from Test 1 — the approval card is still on screen.
  const mainText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  assert(
    mainText.includes('example.com'),
    `Expected the URL "example.com" to be visible in the approval card, got: ${mainText.slice(-400)}`,
  );
  console.log('    ✓ URL param visible in card');
}

async function testNoFollowUpsPending(page: Page): Promise<void> {
  console.log('  Test 3/7: no follow-ups rendered while pending action exists...');
  const buttonsText = await page.$$eval('main button', (btns) =>
    btns.map((b) => (b.textContent || '').trim()),
  );
  const hasTellMeMore = buttonsText.some((t) => t === 'Tell me more');
  const hasWhatShould = buttonsText.some((t) => t === 'What should I focus on next?');
  assert(
    !hasTellMeMore && !hasWhatShould,
    `Follow-up chips should NOT render while action is pending. Buttons: ${JSON.stringify(buttonsText.slice(0, 20))}`,
  );
  console.log('    ✓ no follow-up chips during pending action');
}

async function testNoConfidencePending(page: Page): Promise<void> {
  console.log('  Test 4/7: no confidence label while pending action exists...');
  const mainText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  const forbidden = ['Low confidence', 'High confidence', 'Based on limited data'];
  for (const f of forbidden) {
    assert(
      !mainText.includes(f),
      `Confidence label "${f}" should not render during pending action. Tail: ${mainText.slice(-400)}`,
    );
  }
  console.log('    ✓ no confidence label during pending action');
}

async function testToolBackedIsHighConfidence(page: Page): Promise<void> {
  console.log('  Test 5/7: tool-backed answer shows High confidence...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'what time is it in Tokyo right now — use a time tool',
    90_000,
  );
  const mainText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  assert(
    mainText.includes('High confidence'),
    `Expected "High confidence" on a tool-backed response, got tail: ${mainText.slice(-500)}`,
  );
  assert(
    !mainText.includes('Low confidence'),
    `A tool-backed response should NOT show "Low confidence". Got tail: ${mainText.slice(-500)}`,
  );
  console.log('    ✓ tool-backed answer shows High confidence');
}

async function testTokensAggregated(page: Page): Promise<void> {
  console.log('  Test 6/7: cumulative tokens shown on terminal row...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'use tavily search to find 2 articles about React Server Components and summarize',
    180_000,
  );
  const convId = await getLatestConversationId();
  await page.goto(`${WEB_URL}/agent?id=${convId}&employee=${ALEX_PM_ID}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(2000);

  const mainText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  const m = mainText.match(/·\s+(\d+)\s+tokens/);
  assert(m, `Expected a "· N tokens" token readout, got tail: ${mainText.slice(-400)}`);
  const tokens = parseInt(m![1]!, 10);
  assert(
    tokens >= 20_000,
    `Expected cumulative tokens >= 20000 on a multi-iter Tavily response, got ${tokens}`,
  );
  console.log(`    ✓ cumulative tokens = ${tokens}`);
}

async function testInFlightLabelHumanized(page: Page): Promise<void> {
  console.log('  Test 7/7: in-flight tool label humanized...');
  await newConversation(page);
  const ta = page.locator('textarea[placeholder*="Ask Alex"]');
  await ta.fill('use tavily to search for recent react news, keep it brief');
  await ta.press('Enter');
  const captured = await page.waitForFunction(
    () => {
      const text = document.querySelector('main')?.innerText || '';
      const hasRaw = /mcp__tavily[-_]search__tavily_search/.test(text);
      const hasHuman = /Tavily Search/.test(text);
      if (hasRaw || hasHuman) return { hasRaw, hasHuman };
      return null;
    },
    null,
    { timeout: 60_000 },
  );
  const { hasRaw, hasHuman } = (await captured.jsonValue()) as { hasRaw: boolean; hasHuman: boolean };
  assert(
    !hasRaw,
    'Raw tool name "mcp__tavily-search__tavily_search" observed in live UI — humanization of in-flight label failed',
  );
  assert(hasHuman, 'Did not observe a humanized "Tavily Search" label during streaming');
  // Wait for completion before returning so subsequent tests start clean.
  await page.waitForFunction(
    () => /tokens\b/.test((document.querySelector('main')?.innerText || '').slice(-500)),
    null,
    { timeout: 120_000 },
  );
  console.log('    ✓ in-flight label humanized (no raw mcp__ string observed)');
}

// ── Session 1 regression ─────────────────────────────────────────────

async function runSession1Regression(): Promise<void> {
  console.log('\n── Session 1 regression ──');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('pnpm', ['audit:session1'], {
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`Session 1 regression audit failed (exit ${result.status})`);
  }
  console.log('── Session 1 regression passed ──\n');
}

// ── runner ───────────────────────────────────────────────────────────

async function main() {
  console.log('Session 2 audit — approval cards + metadata trust signals\n');

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: getStatePath() });
  const page = await ctx.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error(`  [page.console.error] ${msg.text()}`);
    }
  });

  const tests = [
    testFriendlyToolName,
    testParamsVisible,
    testNoFollowUpsPending,
    testNoConfidencePending,
    testToolBackedIsHighConfidence,
    testTokensAggregated,
    testInFlightLabelHumanized,
  ];

  let failed = 0;
  for (const t of tests) {
    try {
      await t(page);
    } catch (err) {
      failed++;
      console.error(`  ❌ ${t.name}: ${err instanceof Error ? err.message : err}`);
      await screenshotOnFail(page, t.name);
    }
  }

  await browser.close();

  if (failed > 0) {
    console.error(`\n❌ Session 2 audit: ${failed} failure(s)`);
    process.exit(1);
  }

  try {
    await runSession1Regression();
  } catch (err) {
    console.error(`\n❌ Session 2 audit passed but regression failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.log(`\n✅ Session 2 audit: all ${tests.length} assertions passed + Session 1 regression clean`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Audit runner crashed:', e);
  process.exit(1);
});
