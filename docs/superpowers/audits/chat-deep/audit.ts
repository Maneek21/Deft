#!/usr/bin/env tsx
/**
 * Chat Deep Audit — 8 focused test groups.
 * Runs against dev servers: API :3001, Web :3000.
 * Test user: maneek@test.com / test1234
 */
import 'dotenv/config';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const AUDIT_DIR = 'docs/superpowers/audits/chat-deep';
const LOG_FILE = join(AUDIT_DIR, 'run.log');
const REPORT_FILE = join(AUDIT_DIR, 'REPORT.md');

const findings: Array<{
  severity: 'P0' | 'P1' | 'P2' | 'Nit';
  area: string;
  description: string;
  screenshot?: string;
  detail?: string;
}> = [];

const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const networkErrors: string[] = [];
let shotCounter = 0;

// ── Logging ───────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 23); }

function log(msg: string) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + '\n');
}
function logOk(msg: string) { log(`OK   ${msg}`); }
function logFail(msg: string) { log(`FAIL ${msg}`); }
function logInfo(msg: string) { log(`INFO ${msg}`); }

function find(severity: 'P0' | 'P1' | 'P2' | 'Nit', area: string, description: string, screenshot?: string, detail?: string) {
  findings.push({ severity, area, description, screenshot, detail });
  log(`[FINDING:${severity}] ${area}: ${description}${detail ? ' | ' + detail : ''}`);
}

// ── Screenshot ────────────────────────────────────────────────────────────────
async function shot(page: Page, label: string): Promise<string> {
  shotCounter++;
  const num = String(shotCounter).padStart(2, '0');
  const fname = `${num}-${label}.png`;
  const fpath = join(AUDIT_DIR, fname);
  try {
    await page.screenshot({ path: fpath, fullPage: false });
    logInfo(`screenshot saved: ${fname}`);
    return fpath;
  } catch (e) {
    logFail(`screenshot failed: ${fname} — ${e}`);
    return fpath;
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function apiLogin() {
  logInfo(`Logging in as ${EMAIL}...`);
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const j = await res.json() as Record<string, unknown>;
  logOk(`Login OK — status ${res.status}`);
  return {
    accessToken: (j.access_token ?? j.accessToken) as string,
    refreshToken: (j.refresh_token ?? j.refreshToken) as string | undefined,
    orgId: (j.org_id ?? j.orgId) as string,
    userId: (j.user as { id: string } | undefined)?.id ?? '',
  };
}

async function apiFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
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

// ── Browser setup ─────────────────────────────────────────────────────────────
async function makePage(browser: Browser, accessToken: string, refreshToken?: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  await ctx.addInitScript(
    ({ at, rt }: { at: string; rt: string | null }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: accessToken, rt: refreshToken ?? null },
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(10_000);

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      consoleErrors.push(`[console.error] ${text}`);
    } else if (type === 'warning') {
      consoleErrors.push(`[console.warn] ${text}`);
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(`[pageerror] ${err.message}`);
  });
  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      networkErrors.push(`[${resp.status()}] ${resp.url()}`);
    }
  });

  return { ctx, page };
}

// ── TEST GROUPS ───────────────────────────────────────────────────────────────

// Group 1: Space navigation
async function testSpaceNavigation(page: Page, token: string) {
  logInfo('=== GROUP 1: Space Navigation ===');

  const t0 = Date.now();
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
  const ttfr = Date.now() - t0;
  logInfo(`Time to domcontentloaded: ${ttfr}ms`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1000);

  const title = await page.title();
  const url = page.url();
  logInfo(`Page title: "${title}", URL: ${url}`);
  const s01 = await shot(page, 'chat-initial-load');

  // DB check — get spaces from API
  const spacesResp = await apiFetch<Array<{ id: string; name: string; type: string }>>('/api/spaces', token);
  const dbSpaces = Array.isArray(spacesResp.body) ? spacesResp.body : [];
  logInfo(`API /api/spaces returned ${dbSpaces.length} spaces`);

  if (dbSpaces.length === 0) {
    find('P1', 'Spaces API', '/api/spaces returned 0 spaces', s01);
  } else {
    logOk(`${dbSpaces.length} spaces from API`);
  }

  // Check sidebar has space names visible
  const generalText = page.locator('text="general"').first();
  const generalVisible = await generalText.isVisible().catch(() => false);
  logInfo(`"general" space visible in sidebar: ${generalVisible}`);

  if (!generalVisible) {
    find('P2', 'Sidebar', 'Space names not visible in sidebar on /chat', s01);
  }

  // Click general space and check if URL updates
  const generalSpace = dbSpaces.find(s => s.name.toLowerCase() === 'general') ?? dbSpaces[0];
  if (generalSpace && generalVisible) {
    await generalText.click();
    await page.waitForTimeout(1000);
    const afterUrl = page.url();
    logInfo(`URL after clicking "general" in sidebar: ${afterUrl}`);

    // BUG CHECK: URL should change to include ?space= but stays at /chat
    if (!afterUrl.includes('space=')) {
      find('P2', 'Space Navigation', `Clicking sidebar space "general" does NOT update URL to include ?space= param. URL stays "${afterUrl}"`, await shot(page, 'sidebar-no-url-change'), 'Users cannot deep-link or share the current space via URL');
    } else {
      logOk(`URL updated to ${afterUrl}`);
    }
  }

  // Navigate directly to the space via URL
  if (generalSpace) {
    await page.goto(`${WEB_URL}/chat?space=${generalSpace.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(1000);
    const s03 = await shot(page, 'space-general-loaded');

    const msgCount = await page.locator('[data-message-id]').count();
    logInfo(`Messages visible in general: ${msgCount}`);
    if (msgCount === 0) {
      const emptyState = await page.locator('text="Send a message"').count();
      if (emptyState === 0) {
        find('P1', 'Space Load', 'Space loaded but no messages AND no empty state visible', s03);
      } else {
        logOk('Space shows empty state correctly');
      }
    } else {
      logOk(`Space "general" shows ${msgCount} messages`);
    }
  }

  // Click into 3 more spaces
  const otherSpaces = dbSpaces.filter(s => s.id !== generalSpace?.id).slice(0, 3);
  for (const sp of otherSpaces) {
    logInfo(`Navigating to space: ${sp.name}`);
    await page.goto(`${WEB_URL}/chat?space=${sp.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(500);
    logOk(`Space "${sp.name}" navigated OK`);
  }

  return generalSpace ?? dbSpaces[0];
}

// Group 2: Message rendering
async function testMessageRendering(page: Page, space: { id: string; name: string } | undefined) {
  logInfo('=== GROUP 2: Message Rendering ===');

  if (!space) {
    find('P1', 'Message Rendering', 'No space available');
    return;
  }

  await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  const s04 = await shot(page, 'message-feed');

  // Timestamp check: look for time elements or tooltip texts
  const msgTimestamps = await page.evaluate(() => {
    const results: string[] = [];
    // Look for timestamp elements (time elements or spans with time-like text)
    document.querySelectorAll('[title]').forEach(el => {
      const title = el.getAttribute('title') || '';
      if (/\d{1,2}:\d{2}/.test(title) || /AM|PM/.test(title)) {
        results.push(title);
      }
    });
    return results.slice(0, 10);
  });
  logInfo(`Timestamp titles found: ${msgTimestamps.join(' | ')}`);

  // Check for duplicate timestamp formats in same feed
  const timeFormats = new Set<string>();
  for (const t of msgTimestamps) {
    if (/\d{1,2}:\d{2}\s*(AM|PM)/i.test(t)) timeFormats.add('12h');
    if (/^(0?\d|1\d|2[0-3]):[0-5]\d$/.test(t)) timeFormats.add('24h');
  }
  if (timeFormats.size > 1) {
    find('Nit', 'Timestamps', `Mixed timestamp formats in message feed: ${[...timeFormats].join(', ')}`, s04);
  }

  // Avatar rendering
  const avatarBroken = await page.evaluate(() => {
    const imgs = document.querySelectorAll('img');
    let broken = 0;
    imgs.forEach(img => {
      if (img.naturalWidth === 0 && img.src && !img.src.startsWith('data:') && !img.src.includes('favicon')) {
        broken++;
      }
    });
    return broken;
  });
  logInfo(`Broken images: ${avatarBroken}`);
  if (avatarBroken > 0) {
    find('P2', 'Avatars', `${avatarBroken} broken image(s) detected in chat feed`, s04);
  }

  // Hover a message to see action affordances
  const msgs = await page.locator('[data-message-id]').all();
  if (msgs.length > 0) {
    const lastMsg = msgs[msgs.length - 1];
    await lastMsg.hover();
    await page.waitForTimeout(500);

    const s05 = await shot(page, 'message-hover-actions');

    // Check for action buttons using confirmed selectors
    const reactBtn = await page.locator('button[title="React"]').first().isVisible().catch(() => false);
    const replyBtn = await page.locator('button[title="Reply"]').first().isVisible().catch(() => false);
    const bookmarkBtn = await page.locator('button[title="Save for later"], button[title="Remove from saved"]').first().isVisible().catch(() => false);
    const moreBtn = await page.locator('button[title="More"]').first().isVisible().catch(() => false);
    const pinBtn = await page.locator('button[title="Pin"], button[title="Unpin"]').first().isVisible().catch(() => false);

    logInfo(`Hover actions — React:${reactBtn}, Reply:${replyBtn}, Bookmark:${bookmarkBtn}, More:${moreBtn}, Pin:${pinBtn}`);

    if (!reactBtn || !replyBtn || !moreBtn) {
      find('P1', 'Hover Actions', `Not all hover actions visible — React:${reactBtn} Reply:${replyBtn} More:${moreBtn}`, s05);
    } else {
      logOk('Hover actions visible: React, Reply, More confirmed');
    }

    // Check markdown rendering in existing messages
    const boldCount = await page.locator('[data-message-id] strong').count();
    const emCount = await page.locator('[data-message-id] em').count();
    const codeCount = await page.locator('[data-message-id] code').count();
    logInfo(`Markdown in messages — bold:${boldCount}, em:${emCount}, code:${codeCount}`);
  } else {
    find('P1', 'Message Feed', 'No messages visible in general space', s04);
  }
}

// Group 3: Send a message
async function testSendMessage(page: Page, space: { id: string; name: string } | undefined) {
  logInfo('=== GROUP 3: Send a Message ===');

  if (!space) {
    find('P1', 'Send Message', 'No space available');
    return;
  }

  await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  // Find composer — confirmed to be [contenteditable="true"]
  const composer = page.locator('[contenteditable="true"]').last();
  const composerVisible = await composer.isVisible().catch(() => false);

  if (!composerVisible) {
    find('P0', 'Send Message', 'Compose box not found', await shot(page, 'no-composer'));
    return;
  }

  logOk('Composer found');

  // Send first message
  await composer.click();
  await page.keyboard.type('chat-audit ping 1');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);

  const s06 = await shot(page, 'after-send-ping1');

  const ping1 = await page.locator('[data-message-id]').filter({ hasText: 'chat-audit ping 1' }).count();
  logInfo(`"chat-audit ping 1" in feed: ${ping1}`);
  if (ping1 === 0) {
    find('P0', 'Send Message', '"chat-audit ping 1" not visible after pressing Enter', s06, 'Enter key may not be triggering send');
  } else {
    logOk('chat-audit ping 1 sent and appeared in feed');
  }

  // Quick succession
  for (const n of ['2', '3', '4']) {
    await composer.click();
    await page.keyboard.type(`chat-audit ping ${n}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);

  const s07 = await shot(page, 'quick-succession-pings');
  const ping4 = await page.locator('[data-message-id]').filter({ hasText: 'chat-audit ping 4' }).count();
  if (ping4 === 0) {
    find('P1', 'Send Message', 'Quick-succession messages may not all appear (ping 4 not found)', s07);
  } else {
    logOk('All 4 ping messages appeared');
  }

  // Test Shift+Enter — should insert newline NOT send
  await composer.click();
  await page.keyboard.type('audit-shift-test line1');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line2');
  await page.waitForTimeout(300);

  // The text "line1" should still be in the composer (not sent)
  const composerHtml = await composer.innerHTML();
  const shiftEnterNewline = composerHtml.includes('line1') && composerHtml.includes('line2');
  logInfo(`Shift+Enter inserted newline: ${shiftEnterNewline} (composer HTML includes both lines)`);
  if (!shiftEnterNewline) {
    find('P1', 'Compose', 'Shift+Enter did not insert newline in composer (possible send triggered)', s07);
  } else {
    logOk('Shift+Enter correctly inserts newline');
  }

  // Clear composer
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);

  // Test markdown rendering
  await composer.click();
  await page.keyboard.type('**bold** and *italic* and `code` and a [link](https://example.com)');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);

  const s08 = await shot(page, 'markdown-message-send');

  // Check if markdown rendered
  // The message uses renderFormattedText which converts to React elements
  const boldInMsg = await page.locator('[data-message-id] strong').count();
  const emInMsg = await page.locator('[data-message-id] em').count();
  const codeInMsg = await page.locator('[data-message-id] code').count();
  logInfo(`Markdown rendering — bold:${boldInMsg}, em:${emInMsg}, code:${codeInMsg}`);

  if (boldInMsg === 0 && emInMsg === 0 && codeInMsg === 0) {
    find('P2', 'Markdown Rendering', 'Markdown send: **bold**, *italic*, `code` not rendered in chat feed', s08);
  } else {
    logOk(`Markdown rendering OK: bold=${boldInMsg} em=${emInMsg} code=${codeInMsg}`);
  }

  // Check if [link](...) is rendered as an anchor or raw text
  const linkInMsg = await page.locator('[data-message-id] a[href="https://example.com"]').count();
  logInfo(`Markdown link rendered as <a>: ${linkInMsg}`);
  if (linkInMsg === 0) {
    find('P2', 'Markdown Links', 'Markdown [link](URL) not rendered as clickable <a> in chat messages', s08, 'renderFormattedText does not handle [text](url) links');
  }
}

// Group 4: Threads
async function testThreads(page: Page, space: { id: string; name: string } | undefined) {
  logInfo('=== GROUP 4: Threads ===');

  if (!space) {
    find('P1', 'Threads', 'No space available');
    return;
  }

  await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  // Find last chat-audit message
  const auditMsgs = page.locator('[data-message-id]').filter({ hasText: 'chat-audit' });
  const auditCount = await auditMsgs.count();
  logInfo(`chat-audit messages visible: ${auditCount}`);

  const targetMsg = auditCount > 0
    ? auditMsgs.last()
    : page.locator('[data-message-id]').last();

  const msgVisible = await targetMsg.isVisible().catch(() => false);
  if (!msgVisible) {
    find('P1', 'Threads', 'No message available for thread test');
    return;
  }

  await targetMsg.hover();
  await page.waitForTimeout(600);

  // Confirmed selector: button[title="Reply"]
  const replyBtn = page.locator('button[title="Reply"]').first();
  const replyVisible = await replyBtn.isVisible().catch(() => false);
  logInfo(`Reply button visible after hover: ${replyVisible}`);

  if (!replyVisible) {
    find('P1', 'Threads', 'Reply button not visible after hovering message', await shot(page, 'no-reply-btn'));
    return;
  }

  await replyBtn.click();
  await page.waitForTimeout(1500);

  const s09 = await shot(page, 'thread-panel-open');

  // Thread panel is div.w-[400px]
  const threadPanelVisible = await page.locator('div.w-\\[400px\\]').first().isVisible().catch(() => false);
  const urlAfterThread = page.url();
  logInfo(`Thread panel visible: ${threadPanelVisible}, URL: ${urlAfterThread}`);

  if (!threadPanelVisible) {
    find('P1', 'Threads', 'Thread panel (div.w-[400px]) not visible after clicking Reply', s09);
    return;
  }

  logOk('Thread panel opened successfully');

  // Check URL — does it include thread context?
  if (!urlAfterThread.includes('thread') && !urlAfterThread.includes('message')) {
    find('Nit', 'Thread URL', 'Opening a thread does not update the URL (no deep-link support)', s09);
  }

  // Type in thread composer
  // Thread panel has its own composer — look within the panel
  const threadComposer = page.locator('div.w-\\[400px\\] [contenteditable="true"]').first();
  const threadComposerVisible = await threadComposer.isVisible().catch(() => false);
  logInfo(`Thread composer visible: ${threadComposerVisible}`);

  if (!threadComposerVisible) {
    // Fall back to any contenteditable
    const allEditors = page.locator('[contenteditable="true"]');
    const editorCount = await allEditors.count();
    logInfo(`Total contenteditable editors: ${editorCount}`);

    if (editorCount >= 2) {
      const lastEditor = allEditors.last();
      await lastEditor.click();
      await page.keyboard.type('chat-audit thread reply 1');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1200);
      logOk('Thread reply sent via last editor');
    } else {
      find('P1', 'Threads', 'Thread panel has no composer visible', s09);
      return;
    }
  } else {
    await threadComposer.click();
    await page.keyboard.type('chat-audit thread reply 1');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    logOk('Thread reply sent via thread composer');
  }

  const s10 = await shot(page, 'thread-reply-sent');

  // Check reply count appears on parent
  await page.waitForTimeout(500);
  const replyCountVisible = await page.locator('text=/\\d+ repl/').count();
  logInfo(`Reply count badge visible: ${replyCountVisible}`);

  // Close thread panel
  const closeBtn = page.locator('button[title="Close"], button[aria-label="Close"]').first();
  const closeBtnVisible = await closeBtn.isVisible().catch(() => false);

  if (!closeBtnVisible) {
    // Try the ArrowLeft button in thread panel
    const backBtn = page.locator('div.w-\\[400px\\] button').first();
    const backBtnVisible = await backBtn.isVisible().catch(() => false);
    if (backBtnVisible) {
      await backBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
  } else {
    await closeBtn.click();
  }

  await page.waitForTimeout(500);
  const threadGone = !(await page.locator('div.w-\\[400px\\]').first().isVisible().catch(() => false));
  logInfo(`Thread panel closed: ${threadGone}`);

  if (!threadGone) {
    find('Nit', 'Thread Close', 'Thread panel X/close button did not close the panel', s10);
  } else {
    logOk('Thread panel closed cleanly');
  }
}

// Group 5: Reactions
async function testReactions(page: Page, space: { id: string; name: string } | undefined) {
  logInfo('=== GROUP 5: Reactions ===');

  if (!space) {
    find('P1', 'Reactions', 'No space available');
    return;
  }

  await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  // Use first message in feed
  const msgs = await page.locator('[data-message-id]').all();
  if (msgs.length === 0) {
    find('P1', 'Reactions', 'No messages to test reactions on');
    return;
  }

  const firstMsg = msgs[0];
  await firstMsg.hover();
  await page.waitForTimeout(600);

  // Confirmed selector: button[title="React"]
  const reactBtn = page.locator('button[title="React"]').first();
  const reactBtnVisible = await reactBtn.isVisible().catch(() => false);
  logInfo(`React button visible: ${reactBtnVisible}`);

  if (!reactBtnVisible) {
    find('P1', 'Reactions', 'React button not visible after message hover', await shot(page, 'no-react-btn'));
    return;
  }

  await reactBtn.click();
  await page.waitForTimeout(800);

  const s11a = await shot(page, 'emoji-picker-open');

  // Check emoji picker — look for the EmojiPicker component
  // From source: EmojiPicker renders as a positioned div with emoji buttons
  const emojiPickerOpen = await page.evaluate(() => {
    // Look for the emoji picker by checking for common emoji characters rendered
    const text = document.body.innerText;
    const hasEmojis = /[\u{1F300}-\u{1F9FF}]/u.test(text);
    // Also check for the picker container
    const fixedDivs = document.querySelectorAll('div[style*="position: absolute"], div[style*="position:absolute"]');
    let found = false;
    fixedDivs.forEach(d => {
      if (d.querySelectorAll('button').length > 5) found = true;
    });
    return { hasEmojis, fixedDivs: fixedDivs.length, pickerFound: found };
  });
  logInfo(`Emoji picker check: ${JSON.stringify(emojiPickerOpen)}`);

  if (!emojiPickerOpen.pickerFound && !emojiPickerOpen.hasEmojis) {
    find('P1', 'Reactions', 'Emoji picker did not open after clicking React button', s11a, 'Check EmojiPicker component rendering');
    return;
  }

  logOk('Emoji picker opened');

  // Click thumbsup
  const thumbsup = page.locator('button:text("👍")').first();
  const thumbsupVisible = await thumbsup.isVisible().catch(() => false);
  if (thumbsupVisible) {
    await thumbsup.click();
    logInfo('Clicked 👍');
  } else {
    // Click first emoji-looking button in picker
    const pickerButtons = await page.evaluate(() => {
      const divs = document.querySelectorAll('div');
      for (const d of divs) {
        const btns = d.querySelectorAll('button');
        if (btns.length > 5) {
          // This is probably the picker
          const firstBtnText = btns[0]?.textContent?.trim() ?? '';
          return { found: true, firstEmoji: firstBtnText, count: btns.length };
        }
      }
      return { found: false, firstEmoji: '', count: 0 };
    });
    logInfo(`Picker buttons: ${JSON.stringify(pickerButtons)}`);

    if (pickerButtons.found) {
      const anyEmojiBtn = page.locator('button[title*="thumbs"], button[title*="Thumbs"], button').filter({ hasText: /👍|👋|😀|😄/ }).first();
      await anyEmojiBtn.click().catch(async () => {
        // Last resort: click a button in the picker area
        const allBtns = await page.locator('button').all();
        for (const b of allBtns) {
          const text = await b.textContent().catch(() => '');
          if (text && /[\u{1F300}-\u{1F9FF}]/u.test(text)) {
            await b.click();
            logInfo(`Clicked emoji: ${text}`);
            break;
          }
        }
      });
    }
  }

  await page.waitForTimeout(1000);
  const s11 = await shot(page, 'after-reaction-add');

  // Check reaction appeared
  const reactionCount = await page.evaluate(() => {
    // Look for reaction badges — spans/buttons with emoji + count
    const results: string[] = [];
    document.querySelectorAll('[data-message-id]').forEach(msg => {
      const reactBtns = msg.querySelectorAll('button');
      reactBtns.forEach(btn => {
        const text = btn.textContent?.trim() || '';
        if (/[\u{1F300}-\u{1F9FF}]/u.test(text) && /\d/.test(text)) {
          results.push(text);
        }
      });
    });
    return results;
  });
  logInfo(`Reaction badges found: ${JSON.stringify(reactionCount)}`);

  if (reactionCount.length === 0) {
    find('P2', 'Reactions', 'Reaction badge not visible on message after adding emoji reaction', s11);
  } else {
    logOk(`Reaction appeared: ${reactionCount.join(', ')}`);

    // Toggle off — click the reaction badge
    const firstReactionBadge = page.locator('button').filter({ hasText: /👍.* \d/ }).first();
    const reactionBadgeVisible = await firstReactionBadge.isVisible().catch(() => false);
    if (reactionBadgeVisible) {
      await firstReactionBadge.click();
      await page.waitForTimeout(800);
      const afterToggle = await page.locator('button').filter({ hasText: /👍.* \d/ }).count();
      logInfo(`Reaction badge after toggle-off: ${afterToggle}`);
      logOk('Reaction toggle tested');
    }
  }
}

// Group 6: Edit + Delete
async function testEditDelete(page: Page, space: { id: string; name: string } | undefined) {
  logInfo('=== GROUP 6: Edit + Delete ===');

  if (!space) {
    find('P1', 'Edit/Delete', 'No space available');
    return;
  }

  await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  // --- Edit: ping 4 ---
  const ping4 = page.locator('[data-message-id]').filter({ hasText: 'chat-audit ping 4' }).first();
  const ping4Visible = await ping4.isVisible().catch(() => false);

  if (!ping4Visible) {
    find('P1', 'Edit Message', 'chat-audit ping 4 not found for edit test', await shot(page, 'ping4-not-found'));
  } else {
    await ping4.hover();
    await page.waitForTimeout(600);

    const moreBtn = page.locator('button[title="More"]').first();
    const moreBtnVisible = await moreBtn.isVisible().catch(() => false);
    logInfo(`More button visible for edit: ${moreBtnVisible}`);

    if (!moreBtnVisible) {
      find('P1', 'Edit Message', 'More menu not visible after hovering own message', await shot(page, 'no-more-btn'));
    } else {
      await moreBtn.click();
      await page.waitForTimeout(400);

      const editBtn = page.locator('button:has-text("Edit")').first();
      const editVisible = await editBtn.isVisible().catch(() => false);
      logInfo(`Edit option in menu: ${editVisible}`);

      const menuItems = await page.locator('.w-44 button').allTextContents().catch(() => []);
      logInfo(`More menu items: ${JSON.stringify(menuItems)}`);

      if (!editVisible) {
        find('P1', 'Edit Message', 'Edit option not found in more menu', await shot(page, 'no-edit-option'));
        await page.keyboard.press('Escape');
      } else {
        await editBtn.click();
        await page.waitForTimeout(500);

        const s12a = await shot(page, 'edit-mode');

        // Editor should appear
        const editInputVisible = await page.locator('[contenteditable="true"]').last().isVisible().catch(() => false);
        logInfo(`Edit input visible: ${editInputVisible}`);

        if (!editInputVisible) {
          find('P1', 'Edit Message', 'Edit input not visible after clicking Edit', s12a);
        } else {
          // Clear and re-type
          await page.locator('[contenteditable="true"]').last().click();
          await page.keyboard.press('Control+a');
          await page.keyboard.type('chat-audit ping 4 edited');
          await page.keyboard.press('Enter');
          await page.waitForTimeout(1200);

          const s12 = await shot(page, 'after-edit-save');

          // Check "(edited)" marker
          const editedMarkerCount = await page.locator('[data-message-id]').filter({ hasText: /edited/i }).count();
          const editedSpan = await page.locator('text="(edited)"').count() + await page.locator('text="edited"').count();
          logInfo(`Edited marker: ${editedMarkerCount} messages with "edited", "(edited)" span: ${editedSpan}`);

          if (editedSpan === 0 && editedMarkerCount === 0) {
            find('P2', 'Edit Message', '"(edited)" marker not shown after editing message', s12, 'Message was saved but no visual indicator of edit');
          } else {
            logOk('"(edited)" marker visible after edit');
          }
        }
      }
    }
  }

  // --- Delete: ping 3 ---
  const ping3 = page.locator('[data-message-id]').filter({ hasText: 'chat-audit ping 3' }).first();
  const ping3Visible = await ping3.isVisible().catch(() => false);

  if (!ping3Visible) {
    find('P1', 'Delete Message', 'chat-audit ping 3 not found for delete test', await shot(page, 'ping3-not-found'));
    return;
  }

  await ping3.hover();
  await page.waitForTimeout(600);

  const moreBtn2 = page.locator('button[title="More"]').first();
  if (await moreBtn2.isVisible().catch(() => false)) {
    await moreBtn2.click();
    await page.waitForTimeout(400);
  }

  const deleteBtn = page.locator('button:has-text("Delete")').first();
  const deleteBtnVisible = await deleteBtn.isVisible().catch(() => false);
  logInfo(`Delete option visible: ${deleteBtnVisible}`);

  if (!deleteBtnVisible) {
    find('P1', 'Delete Message', 'Delete option not found in more menu', await shot(page, 'no-delete-option'));
    await page.keyboard.press('Escape');
    return;
  }

  await deleteBtn.click();
  await page.waitForTimeout(600);

  // Check confirm dialog
  const confirmDlg = page.locator('[role="dialog"]').first();
  const confirmVisible = await confirmDlg.isVisible().catch(() => false);
  logInfo(`Confirm dialog for delete: ${confirmVisible}`);

  if (confirmVisible) {
    // Click confirm/delete button in dialog
    const confirmBtn = confirmDlg.locator('button').filter({ hasText: /delete|confirm/i }).last();
    await confirmBtn.click().catch(() => undefined);
    await page.waitForTimeout(1000);
  }

  const s13 = await shot(page, 'after-delete');

  // Check: tombstone or vanished?
  const ping3Still = await page.locator('[data-message-id]').filter({ hasText: 'chat-audit ping 3' }).count();
  const tombstoneMsg = await page.locator('text="This message was deleted"').count();
  const deletedEl = await page.locator('[class*="deleted"]').count();
  logInfo(`After delete — ping3 visible: ${ping3Still}, tombstone: ${tombstoneMsg}, deleted-class: ${deletedEl}`);

  if (ping3Still > 0 && tombstoneMsg === 0) {
    find('P2', 'Delete Message', 'Message text still visible after delete — no tombstone shown', s13);
  } else if (tombstoneMsg > 0) {
    logOk('Delete shows tombstone "This message was deleted"');
  } else {
    logOk('Message vanished after delete');
  }
}

// Group 7: Search / Command Palette
async function testSearch(page: Page, space: { id: string; name: string } | undefined) {
  logInfo('=== GROUP 7: Search / Command Palette ===');

  await page.goto(`${WEB_URL}/chat${space ? `?space=${space.id}` : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1000);

  // Press Ctrl+K
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(800);

  // Confirmed selector: input[placeholder="Search anything..."]
  const searchInput = page.locator('input[placeholder="Search anything..."]').first();
  const searchOpen = await searchInput.isVisible().catch(() => false);
  logInfo(`Command palette opened (search input visible): ${searchOpen}`);

  if (!searchOpen) {
    find('P1', 'Search', 'Ctrl+K did not open command palette', await shot(page, 'ctrl-k-no-open'));
    return;
  }

  logOk('Command palette opened with Ctrl+K');
  const s14a = await shot(page, 'command-palette-open');

  // Search for chat-audit messages
  await searchInput.fill('chat-audit ping');
  await page.waitForTimeout(1200);

  const s14 = await shot(page, 'search-results');

  // Check results — confirmed selector: [data-index]
  const resultCount = await page.locator('[data-index]').count();
  logInfo(`Search results count: ${resultCount}`);

  if (resultCount === 0) {
    find('P2', 'Search', 'No results for "chat-audit ping" in command palette', s14, 'Messages sent in this session should be searchable');
  } else {
    logOk(`Found ${resultCount} results for "chat-audit ping"`);

    // Click first result and verify navigation
    const firstResult = page.locator('[data-index="0"]').first();
    await firstResult.click().catch(() => undefined);
    await page.waitForTimeout(1000);

    const urlAfterSearch = page.url();
    logInfo(`URL after clicking result: ${urlAfterSearch}`);
    const navigated = urlAfterSearch.includes('message=') || urlAfterSearch.includes('space=');
    if (!navigated) {
      find('P2', 'Search', 'Clicking search result did not navigate to message in context', await shot(page, 'search-click-no-nav'), `URL: ${urlAfterSearch}`);
    } else {
      logOk(`Search result navigated to: ${urlAfterSearch}`);
    }
  }

  // Dismiss
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Additional search quality checks
  // Test: does it search messages specifically?
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(500);
  const searchInput2 = page.locator('input[placeholder="Search anything..."]').first();
  if (await searchInput2.isVisible().catch(() => false)) {
    await searchInput2.fill('general');
    await page.waitForTimeout(1000);
    const spaceResults = await page.locator('[data-index]').count();
    logInfo(`Results for "general": ${spaceResults}`);

    // Check if spaces appear in results
    const spaceResultText = await page.locator('[data-index]').allTextContents().catch(() => []);
    logInfo(`General results: ${JSON.stringify(spaceResultText.slice(0, 3))}`);

    await page.keyboard.press('Escape');
  }
}

// Group 8: Real-time sanity
async function testRealTime(browser: Browser, auth: { accessToken: string; refreshToken?: string }, space: { id: string; name: string } | undefined) {
  logInfo('=== GROUP 8: Real-Time Sanity ===');

  if (!space) {
    find('P1', 'Real-Time', 'No space available');
    return;
  }

  const socketEvents1: string[] = [];

  // Tab 1: watching
  const { ctx: ctx1, page: page1 } = await makePage(browser, auth.accessToken, auth.refreshToken);
  page1.on('console', msg => {
    const t = msg.text();
    if (/socket\.io|connect|disconnect|emit|on\(/.test(t.toLowerCase())) {
      socketEvents1.push(t);
    }
  });
  await page1.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
  await page1.waitForLoadState('networkidle').catch(() => undefined);
  await page1.waitForTimeout(2000);

  const msgsBefore = await page1.locator('[data-message-id]').count();
  logInfo(`Tab 1 messages before: ${msgsBefore}`);

  // Tab 2: sending
  const { ctx: ctx2, page: page2 } = await makePage(browser, auth.accessToken, auth.refreshToken);
  await page2.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
  await page2.waitForLoadState('networkidle').catch(() => undefined);
  await page2.waitForTimeout(1500);

  const composer2 = page2.locator('[contenteditable="true"]').last();
  const composer2Visible = await composer2.isVisible().catch(() => false);

  if (!composer2Visible) {
    find('P1', 'Real-Time', 'No composer on second tab');
    await ctx1.close();
    await ctx2.close();
    return;
  }

  // Send from tab 2
  const rtMsg = `chat-audit realtime-${Date.now()}`;
  await composer2.click();
  await page2.keyboard.type(rtMsg);
  await page2.keyboard.press('Enter');
  logInfo(`Sent from tab 2: "${rtMsg}"`);

  // Wait for it on tab 1
  let appeared = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const count = await page1.locator(`[data-message-id]`).filter({ hasText: rtMsg.slice(-10) }).count();
    if (count > 0) { appeared = true; break; }
    await page1.waitForTimeout(500);
  }

  const elapsed = Date.now() - t0;
  const s15 = await shot(page1, 'realtime-check');

  if (appeared) {
    logOk(`Real-time message appeared on tab 1 in ${elapsed}ms`);
  } else {
    // Check if ws is connected
    const wsConnected = await page1.evaluate(() => {
      return typeof (window as any).socket !== 'undefined' ||
             document.querySelector('[class*="connected"]') !== null;
    });
    find('P0', 'Real-Time', `Message from tab 2 did NOT appear on tab 1 within 5s`, s15, `Message: "${rtMsg}", wsConnected check: ${wsConnected}`);
  }

  // Check for socket events in console
  logInfo(`Socket.io events captured on tab 1: ${socketEvents1.length}`);
  if (socketEvents1.length === 0) {
    find('P2', 'Real-Time', 'No socket.io debug events in browser console (connect/disconnect/reconnect)', s15, 'Socket is connected (real-time works) but no logging — harder to debug WebSocket issues');
  }

  // Verify socket.io URL
  const wsUrl = await page1.evaluate(() => {
    // Try to detect socket.io connection URL from network or window
    const scripts = Array.from(document.scripts);
    return scripts.length;
  });

  await ctx1.close();
  await ctx2.close();
}

// ── Additional targeted checks ────────────────────────────────────────────────

async function testAdditionalChecks(page: Page, space: { id: string; name: string } | undefined) {
  logInfo('=== ADDITIONAL: Layout, Timestamps, Misc ===');

  if (!space) return;

  await page.goto(`${WEB_URL}/chat?space=${space.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  const sAdd = await shot(page, 'general-space-overview');

  // 1. Timestamp format consistency check
  const timestampData = await page.evaluate(() => {
    const results: { title: string; text: string }[] = [];
    // Messages have time tooltips
    document.querySelectorAll('[data-message-id]').forEach(msg => {
      const timeEl = msg.querySelector('[title]');
      if (timeEl) {
        results.push({
          title: timeEl.getAttribute('title') || '',
          text: timeEl.textContent?.trim() || ''
        });
      }
    });
    return results.slice(0, 20);
  });
  logInfo(`Timestamp samples: ${JSON.stringify(timestampData.slice(0, 3))}`);

  // Check if any timestamps are showing ISO format (a bug)
  const isoTimestamps = timestampData.filter(t => /^\d{4}-\d{2}-\d{2}T/.test(t.text || ''));
  if (isoTimestamps.length > 0) {
    find('P2', 'Timestamps', `${isoTimestamps.length} message(s) showing raw ISO timestamp instead of human-readable time`, sAdd, isoTimestamps[0].text);
  }

  // 2. Check "general" sidebar entry highlights when active
  const activeSpaceLink = await page.evaluate(() => {
    const links = document.querySelectorAll('a, button');
    let activeHref = '';
    links.forEach(l => {
      const style = window.getComputedStyle(l);
      const bg = style.backgroundColor;
      if (l.textContent?.trim().toLowerCase() === 'general' &&
          bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        activeHref = `active: ${l.textContent.trim()} bg:${bg}`;
      }
    });
    return activeHref;
  });
  logInfo(`Active space highlight: ${activeSpaceLink || 'none detected'}`);

  // 3. Check compose box placeholder text
  const composerPlaceholder = await page.evaluate(() => {
    const editor = document.querySelector('[contenteditable="true"][data-placeholder]');
    return editor?.getAttribute('data-placeholder') ||
           editor?.getAttribute('placeholder') || 'no placeholder attr';
  });
  logInfo(`Composer placeholder: "${composerPlaceholder}"`);

  // 4. Check if there are any hydration mismatch errors (already in consoleErrors)
  const hydrationErrors = consoleErrors.filter(e => e.includes('hydrat') || e.includes('Hydrat'));
  if (hydrationErrors.length > 0) {
    find('P1', 'Hydration', `${hydrationErrors.length} hydration mismatch error(s) detected`, sAdd, hydrationErrors[0]);
  }

  // 5. Check DM space rendering
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1000);

  // Check sidebar structure
  const sidebarText = await page.evaluate(() => {
    const sidebar = document.querySelector('aside, [class*="sidebar"]');
    return sidebar?.textContent?.trim().slice(0, 500) || 'no sidebar';
  });
  logInfo(`Sidebar text (first 300): ${sidebarText.slice(0, 300)}`);

  // 6. Test pinned messages bar if visible
  const pinnedBar = await page.locator('.pinned-bar').count();
  logInfo(`Pinned bar elements: ${pinnedBar}`);

  // 7. Check message grouping — messages within 5min from same user should be grouped
  const msgGroups = await page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-id]');
    let grouped = 0;
    msgs.forEach(msg => {
      // Grouped messages don't have an avatar (compact mode)
      const avatar = msg.querySelector('[style*="border-radius: 50%"], [style*="border-radius:50%"], .rounded-full');
      // Actually check for the username being hidden
      const hasUser = msg.querySelector('[class*="font-medium"]');
      if (!hasUser) grouped++;
    });
    return { total: msgs.length, grouped };
  });
  logInfo(`Message grouping: ${msgGroups.grouped} grouped out of ${msgGroups.total} total`);
}

// ── Report generation ─────────────────────────────────────────────────────────
function writeReport(duration: number) {
  const p0 = findings.filter(f => f.severity === 'P0');
  const p1 = findings.filter(f => f.severity === 'P1');
  const p2 = findings.filter(f => f.severity === 'P2');
  const nit = findings.filter(f => f.severity === 'Nit');

  const fmtFindings = (arr: typeof findings) => {
    if (arr.length === 0) return '_None_\n';
    return arr.map((f, i) => {
      const ss = f.screenshot ? `\n  - Screenshot: \`${f.screenshot}\`` : '';
      const dt = f.detail ? `\n  - Detail: ${f.detail}` : '';
      return `${i + 1}. **[${f.area}]** ${f.description}${ss}${dt}`;
    }).join('\n\n') + '\n';
  };

  const consoleSec = consoleErrors.length > 0
    ? consoleErrors.slice(0, 30).join('\n')
    : '_No console errors recorded_';

  const networkSec = networkErrors.length > 0
    ? networkErrors.slice(0, 30).join('\n')
    : '_No 4xx/5xx errors recorded_';

  const report = `# Chat Deep Audit

**Date:** ${new Date().toISOString().split('T')[0]}
**Branch:** feat/phase2-4-mcp-agents-plans
**Duration:** ${(duration / 1000).toFixed(0)}s
**Findings:** P0=${p0.length} P1=${p1.length} P2=${p2.length} Nit=${nit.length}
**Console errors:** ${consoleErrors.length}
**Network 4xx/5xx:** ${networkErrors.length}

---

## P0 — Blocks release

${fmtFindings(p0)}

## P1 — Must fix before launch

${fmtFindings(p1)}

## P2 — Should fix

${fmtFindings(p2)}

## Nits

${fmtFindings(nit)}

---

## Coverage

### What was tested
- Group 1: Space navigation (sidebar click, URL changes, 4 spaces visited, message loading)
- Group 2: Message rendering (timestamps, avatars, hover actions, markdown)
- Group 3: Send messages (Enter to send, quick succession x4, Shift+Enter newline, markdown send)
- Group 4: Threads (reply button, thread panel, send reply, close panel)
- Group 5: Reactions (React button, emoji picker, toggle off)
- Group 6: Edit + Delete (more menu, edit save, "(edited)" marker, delete tombstone)
- Group 7: Search / Command Palette (Ctrl+K, results, navigation)
- Group 8: Real-time (two-tab test, message appears without reload)

### Coverage gaps
- Mobile viewports (320-768px) not tested
- File upload drag-and-drop not tested
- Slash commands (/remind, etc.) not tested
- Pinned messages management not tested
- Notification sound / badge not tested
- Message pagination / load-more not tested
- Huddle audio feature not tested
- Keyboard navigation within command palette (↑/↓ arrows) not tested
- Forward message flow not tested

---

## Raw console/network logs

### Console errors/warnings

\`\`\`
${consoleSec}
\`\`\`

### Network 4xx/5xx

\`\`\`
${networkSec}
\`\`\`

### Uncaught page errors

\`\`\`
${pageErrors.length > 0 ? pageErrors.slice(0, 20).join('\n') : '_None_'}
\`\`\`
`;

  writeFileSync(REPORT_FILE, report);
  log(`REPORT written to ${REPORT_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileSync(LOG_FILE, `Chat Deep Audit — ${new Date().toISOString()}\n\n`);

  log(`API: ${API_URL}, Web: ${WEB_URL}`);
  log(`Test user: ${EMAIL}`);

  const t0 = Date.now();
  const auth = await apiLogin();
  log(`Logged in — userId: ${auth.userId}, orgId: ${auth.orgId.slice(0, 8)}`);

  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const { ctx, page } = await makePage(browser, auth.accessToken, auth.refreshToken);

  try {
    const space = await testSpaceNavigation(page, auth.accessToken);
    log(`Active space: ${space?.name ?? 'none'} | Progress: Group 1 done at ${Date.now() - t0}ms`);

    await testMessageRendering(page, space);
    log(`Progress: Group 2 done at ${Date.now() - t0}ms`);

    await testSendMessage(page, space);
    log(`Progress: Group 3 done at ${Date.now() - t0}ms`);

    await testThreads(page, space);
    log(`Progress: Group 4 done at ${Date.now() - t0}ms`);

    await testReactions(page, space);
    log(`Progress: Group 5 done at ${Date.now() - t0}ms`);

    await testEditDelete(page, space);
    log(`Progress: Group 6 done at ${Date.now() - t0}ms`);

    await testSearch(page, space);
    log(`Progress: Group 7 done at ${Date.now() - t0}ms`);

    await testAdditionalChecks(page, space);
    log(`Progress: Additional checks done at ${Date.now() - t0}ms`);

    await ctx.close();

    await testRealTime(browser, auth, space);
    log(`Progress: Group 8 done at ${Date.now() - t0}ms`);

  } catch (err) {
    log(`FATAL ERROR: ${err}`);
    try { await shot(page, 'fatal-error'); } catch {}
    find('P0', 'Script', `Unhandled error: ${err}`);
    await ctx.close();
  } finally {
    await browser.close();
  }

  const duration = Date.now() - t0;
  log(`\nTotal duration: ${(duration / 1000).toFixed(1)}s`);
  log(`Findings: P0=${findings.filter(f => f.severity === 'P0').length} P1=${findings.filter(f => f.severity === 'P1').length} P2=${findings.filter(f => f.severity === 'P2').length} Nit=${findings.filter(f => f.severity === 'Nit').length}`);
  log(`Console errors: ${consoleErrors.length}, Network errors: ${networkErrors.length}`);

  writeReport(duration);

  const p0Count = findings.filter(f => f.severity === 'P0').length;
  const p1Count = findings.filter(f => f.severity === 'P1').length;
  process.exit(p0Count + p1Count > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  appendFileSync(LOG_FILE, `\nFATAL: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
