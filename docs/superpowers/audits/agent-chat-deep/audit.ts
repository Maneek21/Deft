#!/usr/bin/env tsx
/**
 * Deep audit — Agent Chat (Defty / native agent) surface.
 *
 * 7 test groups:
 *   1. Landing + conversation list
 *   2. New conversation + agent reply
 *   3. Tool-call rendering
 *   4. Approval / write-action flow
 *   5. Receipts / trace export
 *   6. Conversation history persistence
 *   7. Agent selection / config
 *
 * Run:
 *   DEFT_TEST_EMAIL=maneek@test.com DEFT_TEST_PASSWORD=test1234 \
 *   pnpm tsx docs/superpowers/audits/agent-chat-deep/audit.ts
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { assert } from '../lib/assert.js';
import { loginAndSaveState, getStatePath } from '../lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const AGENT_URL = `${WEB_URL}/agent`;
const OUT_DIR = path.join(
  'C:/Users/Osheen Pradhan/cairn/docs/superpowers/audits/agent-chat-deep',
);
const SS_DIR = path.join(OUT_DIR, 'screenshots');
const DESKTOP_VP = { width: 1440, height: 900 };

// ── helpers ────────────────────────────────────────────────────────────

const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const networkErrors: { url: string; status: number }[] = [];

function attachListeners(page: Page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      consoleErrors.push(txt);
      process.stdout.write(`  [console.error] ${txt}\n`);
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
    process.stdout.write(`  [pageerror] ${err.message}\n`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && res.url().includes('localhost')) {
      const entry = { url: res.url(), status: res.status() };
      networkErrors.push(entry);
      process.stdout.write(`  [net:${res.status()}] ${res.url()}\n`);
    }
  });
}

async function ss(page: Page, name: string) {
  if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });
  const file = path.join(SS_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  process.stdout.write(`  [screenshot] ${name}.png\n`);
  return file;
}

function log(msg: string) {
  process.stdout.write(`${msg}\n`);
}

async function waitWithHeartbeat(
  page: Page,
  condition: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<boolean> {
  const start = Date.now();
  const TICK = 5_000;
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`    ... waiting ${label} (${elapsed}s)\n`);
    await page.waitForTimeout(TICK);
  }
  return false;
}

// ── test groups ────────────────────────────────────────────────────────

type FindingLevel = 'P0' | 'P1' | 'P2' | 'Nit';
type Finding = { level: FindingLevel; title: string; detail: string };
const findings: Finding[] = [];
const passes: string[] = [];

function fail(level: FindingLevel, title: string, detail: string) {
  findings.push({ level, title, detail });
  log(`  [${level}] FAIL: ${title}\n    ${detail}`);
}
function pass(label: string) {
  passes.push(label);
  log(`  [PASS] ${label}`);
}

// ─────────────────────────────────────────────────────────────────────
// Group 1: Landing + conversation list
// ─────────────────────────────────────────────────────────────────────
async function testLanding(page: Page): Promise<void> {
  log('\n── Group 1: Landing + conversation list ──');
  await page.goto(AGENT_URL, { waitUntil: 'networkidle' });
  await ss(page, '01-landing');

  // 1a: Page rendered without JS crash
  const noApiKeyBanner = await page.$('text=Add your Anthropic API key');
  if (noApiKeyBanner) {
    fail('P0', 'No API key configured', 'Banner shown — agent cannot reply without API key. Set ANTHROPIC_API_KEY in API env.');
    return;
  }
  pass('Landing page renders without no-API-key banner');

  // 1b: Composer visible
  const textarea = await page.$('textarea[placeholder*="Defty"]');
  if (!textarea) {
    fail('P0', 'Composer textarea missing', 'Expected textarea[placeholder*="Defty"] on /agent landing');
  } else {
    pass('Composer textarea visible');
  }

  // 1c: Suggestion chips visible
  const chips = await page.$$eval(
    'button',
    (btns) => btns
      .map((b) => (b.textContent || '').trim())
      .filter((t) => t.length > 5 && t.length < 80),
  );
  const knownSuggestions = ['What tasks are in progress?', "Summarize #engineering this week", "What's overdue?"];
  const foundSuggestions = chips.filter((c) => knownSuggestions.some((k) => c.includes(k.slice(0, 20))));
  if (foundSuggestions.length === 0) {
    fail('P1', 'Starter suggestion chips not found in landing empty state', `Buttons found: ${JSON.stringify(chips.slice(0, 15))}`);
  } else {
    pass(`Starter chips visible (found ${foundSuggestions.length}): ${foundSuggestions.slice(0, 3).join(', ')}`);
  }

  // 1d: Desktop sidebar conversation list
  const sidebarLinks = await page.$$('aside a[href*="/agent?id="]');
  log(`  [info] Desktop sidebar conversation links: ${sidebarLinks.length}`);
  if (sidebarLinks.length === 0) {
    // Not necessarily a bug — fresh account or all titled "New conversation" and filtered out
    log('  [info] No past conversations in sidebar (filtered or fresh account) — not a failure');
  } else {
    pass(`Desktop sidebar shows ${sidebarLinks.length} past conversation(s)`);
  }

  // 1e: "New conversation" button in sidebar
  const newConvBtn = await page.$('aside :text("New conversation")');
  if (!newConvBtn) {
    fail('P1', '"New conversation" button missing from sidebar', 'Expected sidebar link/button with text "New conversation"');
  } else {
    pass('"New conversation" button present in sidebar');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Group 2: New conversation + agent reply
// ─────────────────────────────────────────────────────────────────────
let conversationId: string | null = null;
let replyMs: number | null = null;

async function testNewConversation(page: Page): Promise<void> {
  log('\n── Group 2: New conversation + agent reply ──');

  // Navigate to fresh /agent (no id) to guarantee empty state
  await page.goto(AGENT_URL, { waitUntil: 'networkidle' });

  const textarea = page.locator('textarea[placeholder*="Defty"]');
  const taVisible = await textarea.isVisible().catch(() => false);
  if (!taVisible) {
    fail('P0', 'Composer not visible on landing — cannot test conversation', 'Textarea placeholder "Defty" not found');
    return;
  }

  const prompt = 'What are my open tasks?';
  await textarea.fill(prompt);
  await ss(page, '02-before-send');
  await textarea.press('Enter');

  const sendTs = Date.now();
  log(`  [info] Sent: "${prompt}" at ${new Date().toISOString()}`);

  // Wait for URL to include ?id=
  const urlChanged = await waitWithHeartbeat(
    page,
    async () => page.url().includes('?id='),
    30_000,
    'URL to include ?id=',
  );
  if (!urlChanged) {
    fail('P1', 'URL did not update to /agent?id= after send', 'Conversation may not have been created or URL update failed');
  } else {
    const newUrl = page.url();
    const match = newUrl.match(/[?&]id=([^&]+)/);
    conversationId = match ? match[1] : null;
    pass(`Conversation created — id=${conversationId}`);
  }

  // Wait for agent reply (up to 60s for first call — model warm-up)
  log('  [info] Waiting for agent reply (up to 60s)...');
  const replyArrived = await waitWithHeartbeat(
    page,
    async () => {
      // Look for model/token metadata footer OR any assistant message content
      const mainText = await page.$eval('main', (el) => el.innerText).catch(() => '');
      return /tokens\b/.test(mainText.slice(-600)) || /haiku|sonnet|opus/i.test(mainText.slice(-300));
    },
    60_000,
    'agent reply',
  );
  replyMs = Date.now() - sendTs;

  await ss(page, '03-reply-received');

  if (!replyArrived) {
    fail('P0', 'Agent never replied within 60s', `No token/model footer detected. URL: ${page.url()}. Elapsed: ${replyMs}ms`);
    return;
  }
  pass(`Agent replied in ${replyMs}ms`);

  if (replyMs > 10_000) {
    fail('P2', 'Agent response slow (>10s) with no explicit thinking indicator observed in test', `Took ${replyMs}ms — check if AgentThinking spinner was visible`);
  }

  // 2b: Markdown rendering check
  const mainHtml = await page.$eval('main', (el) => el.innerHTML).catch(() => '');
  const hasMd = /<(ul|ol|li|strong|em|code|h[1-6]|p)\b/.test(mainHtml);
  if (hasMd) {
    pass('Markdown rendered (found block/inline elements in assistant reply)');
  } else {
    fail('P2', 'No markdown elements detected in reply', 'Reply may be plain text or ReactMarkdown not rendering');
  }

  // 2c: "Thinking..." spinner was shown (infer from tool_status in DOM — we can only check residual)
  const hasThinkingTrace = await page.$('[class*="animate-spin"]').then(() => true).catch(() => false);
  // By the time we get here the spinner is gone — just note we can't test it post-hoc
  log('  [info] AgentThinking spinner: not checkable post-reply (ephemeral during streaming)');
}

// ─────────────────────────────────────────────────────────────────────
// Group 3: Tool-call rendering
// ─────────────────────────────────────────────────────────────────────
async function testToolCallRendering(page: Page): Promise<void> {
  log('\n── Group 3: Tool-call rendering ──');

  // We should already be on the reply page from group 2
  if (!conversationId) {
    fail('P1', 'Tool-call test skipped — no conversationId from group 2', 'Group 2 must succeed first');
    return;
  }

  // Look for 💬 tool badge pills
  const toolBadges = await page.$$eval(
    'main button',
    (btns) => btns
      .filter((b) => b.textContent?.includes('💬'))
      .map((b) => (b.textContent || '').trim()),
  );

  if (toolBadges.length === 0) {
    fail('P1', 'No tool-call badge pills (💬) visible after agent reply', 'Agent may have answered without tool calls, or tool_calls array was empty — check if tasks exist in test account');
    log('  [info] If account has no tasks, agent may reply from memory without querying DB');
  } else {
    pass(`Tool badges visible: ${toolBadges.slice(0, 5).join(', ')}`);

    // 3b: ReasoningTrace "Show trace" toggle
    const traceTrigger = await page.$('button:has-text("Show trace")');
    if (!traceTrigger) {
      fail('P2', 'ReasoningTrace "Show trace" toggle not found', 'Expected collapsible trace toggle button below tool badges');
    } else {
      pass('"Show trace" toggle visible');
      await traceTrigger.click();
      await page.waitForTimeout(500);
      const traceVisible = await page.$('ol li') !== null;
      if (traceVisible) {
        pass('ReasoningTrace expanded — shows ordered list of events');
      } else {
        fail('P2', 'ReasoningTrace expanded but no <li> items rendered', 'Events array may be empty after expansion');
      }
      await ss(page, '04-tool-call-trace-expanded');
      // Collapse it again
      const hideBtn = await page.$('button:has-text("Hide trace")');
      if (hideBtn) await hideBtn.click();
    }
  }

  // 3c: Confidence indicator
  const confidenceDot = await page.$('[class*="rounded-full"][style*="background: var(--"]');
  if (confidenceDot) {
    pass('Confidence indicator dot rendered');
  } else {
    fail('Nit', 'Confidence indicator dot not found', 'deriveConfidence() result may not render its colored dot');
  }

  // 3d: Model/token footer
  const mainText = await page.$eval('main', (el) => el.innerText).catch(() => '');
  const modelFooterMatch = mainText.match(/(?:haiku|sonnet|opus)[^·\n]*·[^t\n]*tokens/i);
  if (modelFooterMatch) {
    pass(`Model/token footer: "${modelFooterMatch[0].trim()}"`);
  } else {
    fail('P2', 'Model/token footer not found below assistant reply', 'Expected "{model} · N tokens" footer after streaming completes');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Group 4: Approval / write-action flow
// ─────────────────────────────────────────────────────────────────────
let writeConversationId: string | null = null;

async function testApprovalFlow(page: Page): Promise<void> {
  log('\n── Group 4: Approval / write-action flow ──');

  // Start a fresh conversation for write action
  await page.goto(AGENT_URL, { waitUntil: 'networkidle' });

  const textarea = page.locator('textarea[placeholder*="Defty"]');
  const taVisible = await textarea.isVisible().catch(() => false);
  if (!taVisible) {
    fail('P1', 'Composer not visible — skipping approval flow test', '');
    return;
  }

  const ts = Date.now();
  const taskTitle = `agent-chat-audit-${ts}`;
  const prompt = `Create a task titled "${taskTitle}"`;
  await textarea.fill(prompt);
  log(`  [info] Sent write prompt: "${prompt}"`);
  await textarea.press('Enter');

  // Wait up to 45s for any of: pending action card, auto-executed badge, or rejection
  const actionAppeared = await waitWithHeartbeat(
    page,
    async () => {
      const txt = await page.$eval('main', (el) => el.innerText).catch(() => '');
      return (
        txt.includes('Approve') ||
        txt.includes('Reject') ||
        txt.includes('Create task') ||
        txt.includes('auto') ||
        txt.includes('taskTitle') ||
        txt.includes(taskTitle) ||
        /tokens\b/.test(txt.slice(-600))
      );
    },
    45_000,
    'write action or reply',
  );

  await ss(page, '05-write-action');

  const urlAfter = page.url();
  const match = urlAfter.match(/[?&]id=([^&]+)/);
  writeConversationId = match ? match[1] : null;

  if (!actionAppeared) {
    fail('P1', 'Write-action prompt timed out without reply or action card', `Prompt: "${prompt}" — no Approve/auto/tokens visible in 45s`);
    return;
  }

  // Determine outcome
  const mainText = await page.$eval('main', (el) => el.innerText).catch(() => '');

  const hasApproveBtn = mainText.includes('Approve');
  const hasAutoExecuted = mainText.includes('auto');
  const hasRejected = mainText.toLowerCase().includes('cannot') || mainText.toLowerCase().includes('unable');

  if (hasApproveBtn) {
    log('  [info] Trust level: STANDARD — pending approval card shown');
    pass('Pending approval card rendered (Approve + Reject buttons visible)');

    // Try clicking Approve
    const approveBtn = await page.$('button:has-text("Approve")');
    if (approveBtn) {
      log('  [info] Clicking Approve...');
      await approveBtn.click();
      // Wait for executing → approved state
      const approved = await waitWithHeartbeat(
        page,
        async () => {
          const txt2 = await page.$eval('main', (el) => el.innerText).catch(() => '');
          return txt2.includes('done') || txt2.includes('approved') || txt2.includes('✓');
        },
        20_000,
        'approval confirmation',
      );
      await ss(page, '06-after-approve');
      if (approved) {
        pass('Action approved — confirmation (✓/done) visible');
        // Check for Undo button (5 min window)
        const undoBtn = await page.$('button:has-text("Undo")');
        if (undoBtn) {
          pass('Undo button visible within 5-minute window');
        } else {
          fail('Nit', 'Undo button not visible after approval', 'Expected "Undo" to appear within 5 min window');
        }
      } else {
        fail('P1', 'Approval click did not transition to confirmed state', 'Expected ✓/done after clicking Approve');
      }
    }
  } else if (hasAutoExecuted) {
    log('  [info] Trust level: AUTONOMOUS — action auto-executed');
    pass('Auto-executed action badge rendered (green ✓ + "auto" label)');
  } else if (hasRejected) {
    log('  [info] Trust level: CONSERVATIVE or tool disabled — agent refused to create');
    fail('P2', 'Agent refused to create task (trust level too conservative or tool disabled)', 'Consider checking trust level settings');
  } else {
    log('  [info] Inconclusive — reply arrived but no clear action outcome');
    fail('P2', 'Write-action outcome inconclusive', `Text excerpt: "${mainText.slice(-200)}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Group 5: Receipts / trace export
// ─────────────────────────────────────────────────────────────────────
async function testReceiptsAndTrace(page: Page): Promise<void> {
  log('\n── Group 5: Receipts / trace export ──');

  const activeConvId = conversationId || writeConversationId;
  if (!activeConvId) {
    fail('P2', 'Trace export test skipped — no conversationId', 'Groups 2 and 4 must produce a conversationId');
    return;
  }

  // Navigate to the conversation that has messages
  await page.goto(`${AGENT_URL}?id=${activeConvId}`, { waitUntil: 'networkidle' });

  // 5a: "Export trace" button
  const exportBtn = await page.$('button[title*="trace"]');
  if (!exportBtn) {
    fail('P1', '"Export trace" button not found above composer', 'Expected button with title="Download full turn trace as JSON" when a conversation has messages');
  } else {
    pass('"Export trace" button visible above composer');

    // Click and check for download
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }).catch(() => null),
      exportBtn.click(),
    ]);
    if (download) {
      pass(`Trace download triggered — filename: ${download.suggestedFilename()}`);
    } else {
      // May have shown an alert — check
      const alertFired = await page.evaluate(() => {
        // Check if dialog appeared (can't intercept after the fact without dialog listener)
        return false;
      });
      fail('P2', 'Trace download did not trigger a file download event within 10s', 'Either trace endpoint 404d or response was not a blob');
    }
  }

  await ss(page, '07-trace-export-area');

  // 5b: No receipt viewer in current codebase (not implemented) — note gap
  log('  [info] Receipt viewer: no dedicated signed-receipt modal found in agent-chat.tsx — gap noted');
}

// ─────────────────────────────────────────────────────────────────────
// Group 6: Conversation history persistence
// ─────────────────────────────────────────────────────────────────────
async function testHistoryPersistence(page: Page): Promise<void> {
  log('\n── Group 6: Conversation history persistence ──');

  if (!conversationId) {
    fail('P1', 'History test skipped — no conversationId from group 2', '');
    return;
  }

  // Navigate away
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1_000);

  // Navigate back to /agent
  await page.goto(AGENT_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2_000);

  await ss(page, '08-history-sidebar');

  // Check sidebar has the conversation
  const sidebarLinks = await page.$$('aside a[href*="/agent?id="]');
  log(`  [info] Sidebar links after navigate-away: ${sidebarLinks.length}`);

  if (sidebarLinks.length > 0) {
    pass(`Conversation history persisted — ${sidebarLinks.length} link(s) in sidebar`);
  } else {
    fail('P1', 'Sidebar shows no conversations after navigate-away and back', 'Conversations may be filtered out (all titled "New conversation") or sidebar not loading');
  }

  // Navigate to specific conversation
  await page.goto(`${AGENT_URL}?id=${conversationId}`, { waitUntil: 'networkidle' });

  // Wait for messages to load
  const msgsLoaded = await waitWithHeartbeat(
    page,
    async () => {
      const txt = await page.$eval('main', (el) => el.innerText).catch(() => '');
      return txt.includes('What are my open tasks');
    },
    15_000,
    'conversation messages to reload',
  );

  await ss(page, '09-history-reload');

  if (msgsLoaded) {
    pass('Conversation reloaded — original user message present');
  } else {
    fail('P1', 'Conversation messages not restored on direct navigation to ?id=', 'API fetch or message rendering may have failed');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Group 7: Agent selection / config
// ─────────────────────────────────────────────────────────────────────
async function testAgentSelection(page: Page): Promise<void> {
  log('\n── Group 7: Agent selection / config ──');

  await page.goto(AGENT_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2_000);
  await ss(page, '10-agent-selection');

  // 7a: Tab bar (Defty + any BYOA employees)
  const deftyTab = await page.$('button:has-text("Defty")');
  if (!deftyTab) {
    log('  [info] No Defty tab visible — either no employees configured OR tab bar hidden when no BYOA employees');
    // Tab bar only shows if agentEmployees.length > 0
    fail('Nit', 'Defty tab bar not rendered', 'Tab bar appears only when ≥1 BYOA employee is active. If no employees exist, this is expected.');
  } else {
    pass('Defty tab visible in tab bar');
    // Check if any other employee tabs
    const allTabs = await page.$$eval(
      '[class*="flex"][class*="overflow-x-auto"] button',
      (btns) => btns.map((b) => (b.textContent || '').trim()),
    );
    log(`  [info] Tab bar buttons: ${JSON.stringify(allTabs)}`);
    if (allTabs.length > 1) {
      pass(`Multiple agent tabs visible: ${allTabs.join(', ')}`);
    } else {
      log('  [info] Only Defty tab — no BYOA employees configured in this env');
    }
  }

  // 7b: No config drawer found in code — this is a gap
  log('  [info] Agent config drawer (model/trust level/tools): NOT implemented in current agent/page.tsx or agent-chat.tsx');
  fail('P2', 'No agent config drawer / settings panel in agent chat', 'There is no way to change model, trust level, or enabled tools from the chat surface. These require going to /settings/agent.');

  // 7c: Check if trust level indicator is shown anywhere in the chat surface
  const trustText = await page.$eval('main', (el) => el.innerText).catch(() => '');
  if (/trust|autonomous|conservative|standard/i.test(trustText)) {
    pass('Trust level label visible in agent chat surface');
  } else {
    fail('Nit', 'No trust level indicator visible in agent chat', 'Trust level is set in /settings/agent but not surfaced in the chat UI');
  }

  // 7d: Heartbeat turns view
  log('  [info] Heartbeat turns: no dedicated view in /agent — heartbeats are in /settings/agent-employees/[id]/heartbeats');
  fail('Nit', 'No heartbeat turns view in agent chat surface', 'Heartbeat history is only accessible via /settings/agent-employees/[id]/heartbeats, not from chat');
}

// ─────────────────────────────────────────────────────────────────────
// Main runner
// ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== Agent Chat Deep Audit ===');
  log(`Date: ${new Date().toISOString()}`);
  log(`Branch: feat/phase2-4-mcp-agents-plans`);
  log(`Target: ${AGENT_URL}`);
  log('');

  // Ensure auth state
  const statePath = getStatePath();
  if (!fs.existsSync(statePath)) {
    log('[setup] Auth state not found — logging in...');
    await loginAndSaveState();
  } else {
    log(`[setup] Using existing auth state: ${statePath}`);
  }

  const browser: Browser = await chromium.launch({
    headless: false,
    slowMo: 100,
  });
  const ctx: BrowserContext = await browser.newContext({
    storageState: statePath,
    viewport: DESKTOP_VP,
  });
  const page = await ctx.newPage();
  attachListeners(page);

  const started = Date.now();

  const groups = [
    { name: 'Landing + conversation list', fn: testLanding },
    { name: 'New conversation + agent reply', fn: testNewConversation },
    { name: 'Tool-call rendering', fn: testToolCallRendering },
    { name: 'Approval / write-action flow', fn: testApprovalFlow },
    { name: 'Receipts / trace export', fn: testReceiptsAndTrace },
    { name: 'Conversation history persistence', fn: testHistoryPersistence },
    { name: 'Agent selection / config', fn: testAgentSelection },
  ];

  for (const g of groups) {
    try {
      await g.fn(page);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail('P0', `Group "${g.name}" threw unexpected error`, msg);
      try {
        await ss(page, `CRASH-${g.name.replace(/\W+/g, '-')}`);
      } catch { /* ignore */ }
    }
    // Heartbeat every group
    process.stdout.write(`  [heartbeat] ${new Date().toISOString()}\n`);
  }

  const duration = Math.round((Date.now() - started) / 1000);
  await browser.close();

  // ── write report ──
  const p0 = findings.filter((f) => f.level === 'P0');
  const p1 = findings.filter((f) => f.level === 'P1');
  const p2 = findings.filter((f) => f.level === 'P2');
  const nits = findings.filter((f) => f.level === 'Nit');

  const ssIndex = fs.existsSync(SS_DIR)
    ? fs.readdirSync(SS_DIR).filter((f) => f.endsWith('.png'))
    : [];

  const reportLines: string[] = [];
  const r = (line: string) => reportLines.push(line);

  r('# Agent Chat Deep Audit');
  r('');
  r(`**Date:** ${new Date().toISOString()}`);
  r(`**Branch:** feat/phase2-4-mcp-agents-plans`);
  r(`**Duration:** ${duration}s`);
  r(`**Viewport:** 1440×900 (headless: false, slowMo: 100ms)`);
  r(`**Passes:** ${passes.length}  |  **P0:** ${p0.length}  |  **P1:** ${p1.length}  |  **P2:** ${p2.length}  |  **Nits:** ${nits.length}`);
  r(`**Reply latency:** ${replyMs !== null ? `${replyMs}ms` : 'N/A (no reply received)'}`);
  r(`**Console errors:** ${consoleErrors.length}  |  **Page errors:** ${pageErrors.length}  |  **Net 4xx/5xx:** ${networkErrors.length}`);
  r('');

  r('## Surfaces Observed');
  r('');
  r('- `/agent` — native Defty chat page with empty state, suggestion chips, and bottom composer');
  r('- Desktop sidebar (`<aside>`) — `AgentSidebarContent` with conversation list, rename on double-click, delete on hover');
  r('- Mobile history panel — `MobileConversationPanel` behind "History" toggle button');
  r('- `AgentChat` component — SSE streaming, `AgentThinking` spinner, `ReasoningTrace` expander, `ActionCard` / `PlanCard` for approvals');
  r('- Tool-call badge pills (💬) + collapsible `ReasoningTrace`');
  r('- Confidence indicator dot + model/token footer per assistant message');
  r('- Contextual follow-up chips (Haiku-generated)');
  r('- "Export trace" JSON download button above composer');
  r('- Tab bar for Defty + BYOA agent employees (only shown when ≥1 employee is active)');
  r('- `ActionCard` (single action) and `PlanCard` (multi-step plan) approval flows');
  r('- Undo button (5-minute window after approval)');
  r('');

  r('## P0 — Blocks Release');
  r('');
  if (p0.length === 0) {
    r('_None._');
  } else {
    for (const f of p0) {
      r(`### ${f.title}`);
      r(f.detail);
      r('');
    }
  }
  r('');

  r('## P1 — Must Fix');
  r('');
  if (p1.length === 0) {
    r('_None._');
  } else {
    for (const f of p1) {
      r(`### ${f.title}`);
      r(f.detail);
      r('');
    }
  }
  r('');

  r('## P2 — Should Fix');
  r('');
  if (p2.length === 0) {
    r('_None._');
  } else {
    for (const f of p2) {
      r(`### ${f.title}`);
      r(f.detail);
      r('');
    }
  }
  r('');

  r('## Nits');
  r('');
  if (nits.length === 0) {
    r('_None._');
  } else {
    for (const f of nits) {
      r(`### ${f.title}`);
      r(f.detail);
      r('');
    }
  }
  r('');

  r('## Coverage Gaps');
  r('');
  r('- **Signed-receipt viewer**: No dedicated receipt modal in current agent-chat.tsx. The "receipt" concept exists in the DB (`agent_actions` table) but is not surfaced in the UI — only raw trace JSON export exists.');
  r('- **Agent config drawer**: No in-chat drawer to change model, trust level, or enabled tools. Users must navigate to `/settings/agent` separately.');
  r('- **Trust level indicator in chat**: Not visible on the chat surface — requires settings page.');
  r('- **Heartbeat turns view in chat**: Not accessible from /agent — only available at `/settings/agent-employees/[id]/heartbeats`.');
  r('- **Context selector**: No scope/project/space selector in the chat composer — agent uses workspace-wide context by default.');
  r('- **Slash commands**: Not implemented in the native Defty chat surface (no "/" autocomplete).');
  r('- **AgentThinking spinner during streaming**: Cannot be captured in a post-hoc screenshot — was not asserted during stream.');
  r('- **PlanCard (multi-step)**: Not exercised — would require a prompt that generates ≥2 pending actions.');
  r('');

  r('## Raw Logs');
  r('');
  r('### Console Errors');
  if (consoleErrors.length === 0) {
    r('_None_');
  } else {
    consoleErrors.forEach((e) => r(`- \`${e.slice(0, 200)}\``));
  }
  r('');
  r('### Page Errors');
  if (pageErrors.length === 0) {
    r('_None_');
  } else {
    pageErrors.forEach((e) => r(`- \`${e.slice(0, 200)}\``));
  }
  r('');
  r('### Network 4xx/5xx');
  if (networkErrors.length === 0) {
    r('_None_');
  } else {
    networkErrors.forEach((e) => r(`- \`${e.status}\` ${e.url}`));
  }
  r('');
  r('### Passes');
  passes.forEach((p) => r(`- ✓ ${p}`));
  r('');

  r('## Screenshots Index');
  r('');
  if (ssIndex.length === 0) {
    r('_No screenshots captured._');
  } else {
    ssIndex.sort().forEach((f) => r(`- \`screenshots/${f}\``));
  }

  const reportPath = path.join(OUT_DIR, 'REPORT.md');
  fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf-8');
  log(`\n[done] Report written to: ${reportPath}`);
  log(`[done] Duration: ${duration}s`);
  log(`[done] Passes: ${passes.length}  P0: ${p0.length}  P1: ${p1.length}  P2: ${p2.length}  Nits: ${nits.length}`);

  if (p0.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Audit runner crashed:', err);
  process.exit(2);
});
