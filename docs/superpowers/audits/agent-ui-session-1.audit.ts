#!/usr/bin/env tsx
/**
 * Session 1 audit — content safety + identity.
 *
 * Asserts:
 *   1. agentName in bubble   — bubble header shows "Alex PM" not "Deft"
 *   2. table renders         — GFM table renders as <table>, not raw pipes
 *   3. code fence isolated   — content inside ```...``` has no stray <li>
 *   4. links clickable       — markdown links become <a href>
 *   5. XSS neutralized       — img/onerror in injected content does not execute
 *   6. tool badges on reload — 💬 pill present after history reload
 *   7. single bubble reload  — multi-iteration response shows as 1 bubble, not N
 *
 * Prereqs:
 *   - pnpm audit:setup has been run and playwright-auth.json exists
 *   - API on :3001, web on :3000
 *
 * Run:  pnpm audit:session1
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { eq, desc } from 'drizzle-orm';
import { assert } from './lib/assert.js';
import { db, schema } from './lib/db.js';
import { getStatePath } from './lib/auth.js';

const { agentMessages, agentConversations } = schema;

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
      return /tokens\b/.test(text.slice(-500));
    },
    null,
    { timeout: timeoutMs },
  );
}

async function countBubblesWithLabel(page: Page, label: string): Promise<number> {
  return await page.$$eval(
    'main p',
    (els, lbl) => els.filter((e) => (e.textContent?.trim() || '') === lbl).length,
    label,
  );
}

async function screenshotOnFail(page: Page, name: string): Promise<void> {
  try {
    const file = `audit-failure-${name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.error(`  📸 ${file}`);
  } catch {
    // ignore screenshot errors
  }
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

// ── tests ────────────────────────────────────────────────────────────

async function testBubbleLabel(page: Page): Promise<void> {
  console.log('  Test 1/7: agent name in bubble...');
  await newConversation(page);
  await sendAndWaitForResponse(page, 'hi alex, say hello back in one short sentence');
  const alexCount = await countBubblesWithLabel(page, 'Alex PM');
  const deftCount = await countBubblesWithLabel(page, 'Deft');
  assert(
    alexCount >= 1,
    `Expected bubble header to say "Alex PM" at least once; saw ${alexCount}. Deft-labeled bubbles: ${deftCount}`,
  );
  console.log(`    ✓ bubble label = Alex PM (${alexCount} found)`);
}

async function testTableRendering(page: Page): Promise<void> {
  console.log('  Test 2/7: markdown table renders as <table>...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'respond ONLY with a markdown table that has 3 rows comparing useState, useEffect, useMemo with columns hook, purpose. no other text.',
  );
  const tableCount = await page.locator('main table').count();
  assert(tableCount >= 1, `Expected at least one <table> in response, got ${tableCount}`);
  const rowCount = await page.locator('main table tr').count();
  assert(rowCount >= 3, `Expected at least 3 <tr> rows (header + 2 data), got ${rowCount}`);
  console.log(`    ✓ table rendered with ${rowCount} rows`);
}

async function testCodeFenceIsolation(page: Page): Promise<void> {
  console.log('  Test 3/7: code fence content is isolated...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'write a react component in a typescript code fence that uses useState with items: string[] and maps over them with items.map(item => (- {item}))',
  );
  const preInnerHTML = await page.$$eval('main pre code', (els) =>
    els.map((e) => e.innerHTML).join('\n'),
  );
  assert(preInnerHTML.length > 0, 'Expected at least one <pre><code> block');
  assert(
    !/<li\b/.test(preInnerHTML),
    `Code fence contains <li> tags (markdown parser leaked into code block): ${preInnerHTML.slice(0, 300)}`,
  );
  console.log(`    ✓ code fence isolated (${preInnerHTML.length} chars, 0 <li>)`);
}

async function testLinksClickable(page: Page): Promise<void> {
  console.log('  Test 4/7: markdown links render as <a href>...');
  await newConversation(page);
  // Prompt is tight: don't use any tools, just echo a specific markdown block.
  // Without the "no tools" constraint the agent calls Tavily/fetch to verify
  // URLs and takes 4+ iterations / 100+ seconds — blowing past the default
  // 90s wait. Echoing fixed markdown finishes in one iteration.
  await sendAndWaitForResponse(
    page,
    'reply ONLY with this exact markdown (no tools, no extra text):\n- [useState](https://react.dev/reference/react/useState)\n- [useEffect](https://react.dev/reference/react/useEffect)\n- [useMemo](https://react.dev/reference/react/useMemo)',
  );
  const linkCount = await page.locator('main a[href*="react.dev"]').count();
  assert(
    linkCount >= 1,
    `Expected at least one <a href*="react.dev"> link, got ${linkCount}`,
  );
  console.log(`    ✓ ${linkCount} react.dev link(s) rendered`);
}

async function testXssNeutralized(page: Page): Promise<void> {
  console.log('  Test 5/7: XSS payload is neutralized...');
  // Use the latest existing Alex conversation and insert a synthetic
  // assistant row with an XSS payload directly into the DB.
  const convId = await getLatestConversationId();

  const xssContent = `<img src=x onerror="window.__deft_xss_triggered=true">`;
  await db.insert(agentMessages).values({
    conversation_id: convId,
    role: 'assistant',
    content: xssContent,
    hidden: false,
  });

  // Navigate to that conversation and check the flag.
  await page.goto(`${WEB_URL}/agent?id=${convId}&employee=${ALEX_PM_ID}`, {
    waitUntil: 'networkidle',
  });
  // Give the message list a moment to render.
  await page.waitForTimeout(2000);

  const xssTriggered = await page.evaluate(() => (window as any).__deft_xss_triggered === true);
  assert(
    xssTriggered === false,
    'XSS payload executed — sanitizer did not block onerror',
  );

  const imgWithOnerror = await page.locator('main img[onerror]').count();
  assert(
    imgWithOnerror === 0,
    `Found ${imgWithOnerror} <img onerror> elements in the DOM — sanitizer failed`,
  );

  console.log('    ✓ XSS neutralized (no execution, no <img onerror>)');
}

async function testToolBadgesReload(page: Page): Promise<void> {
  console.log('  Test 6/7: tool badges visible after reload...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'what is the current time in Tokyo? use the time tool',
    120_000,
  );
  const convId = await getLatestConversationId();

  // Reload the conversation from URL (fresh history load path).
  await page.goto(`${WEB_URL}/agent?id=${convId}&employee=${ALEX_PM_ID}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(2000);

  const badges = await page.$$eval('main button', (btns) =>
    btns.map((b) => b.textContent?.trim() || '').filter((t) => t.includes('💬')),
  );
  assert(
    badges.length >= 1,
    `Expected at least one 💬 tool badge after reload, got ${badges.length}. Buttons: ${JSON.stringify(badges)}`,
  );
  console.log(`    ✓ ${badges.length} tool badge(s) on reload: ${badges.join(', ')}`);
}

async function testSingleBubbleReload(page: Page): Promise<void> {
  console.log('  Test 7/7: multi-iteration response = 1 bubble on reload...');
  await newConversation(page);
  // Tavily search with a follow-up prompt usually triggers multi-iteration.
  await sendAndWaitForResponse(
    page,
    'use tavily search to find 2 recent articles about react 19 and summarize them in 3 bullet points',
    180_000,
  );
  const convId = await getLatestConversationId();

  await page.goto(`${WEB_URL}/agent?id=${convId}&employee=${ALEX_PM_ID}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(2000);

  const bubbleCount = await countBubblesWithLabel(page, 'Alex PM');
  assert(
    bubbleCount === 1,
    `Expected exactly 1 Alex PM bubble on reload of a multi-iter response, got ${bubbleCount}`,
  );
  console.log(`    ✓ exactly 1 Alex PM bubble on reload`);
}

// ── runner ───────────────────────────────────────────────────────────

async function main() {
  console.log('Session 1 audit — content safety + identity\n');

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: getStatePath() });
  const page = await ctx.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error(`  [page.console.error] ${msg.text()}`);
    }
  });

  const tests = [
    testBubbleLabel,
    testTableRendering,
    testCodeFenceIsolation,
    testLinksClickable,
    testXssNeutralized,
    testToolBadgesReload,
    testSingleBubbleReload,
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
    console.error(`\n❌ Session 1 audit: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log(`\n✅ Session 1 audit: all ${tests.length} assertions passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Audit runner crashed:', e);
  process.exit(1);
});
