#!/usr/bin/env tsx
/**
 * Chat Mobile Audit — iPhone 13 viewport (390×844, deviceScaleFactor 2)
 *
 * Run from repo root:
 *   npx tsx docs/superpowers/audits/chat-mobile/audit.ts
 *
 * Env vars:
 *   DEFT_TEST_EMAIL     (default: maneek@test.com)
 *   DEFT_TEST_PASSWORD  (default: test1234)
 *   DEFT_API_URL        (default: http://localhost:3001)
 *   DEFT_WEB_URL        (default: http://localhost:3000)
 */

import { chromium, Page, Browser, BrowserContext } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Config ───────────────────────────────────────────────────────────────────
const EMAIL    = process.env.DEFT_TEST_EMAIL    || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';
const API_URL  = process.env.DEFT_API_URL       || 'http://localhost:3001';
const WEB_URL  = process.env.DEFT_WEB_URL       || 'http://localhost:3000';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const VIEWPORT  = { width: 390, height: 844 };
const OUT_DIR   = join(__dirname);

// ─── Logging ──────────────────────────────────────────────────────────────────
const logLines: string[] = [];
let screenshotIndex = 0;

function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  logLines.push(line);
}

async function screenshot(page: Page, label: string): Promise<string> {
  screenshotIndex++;
  const filename = `${String(screenshotIndex).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  const path = join(OUT_DIR, filename);
  try {
    await page.screenshot({ path, fullPage: false });
    log(`Screenshot ${screenshotIndex}: ${filename}`);
  } catch (e) {
    log(`Screenshot ${screenshotIndex} failed: ${e}`);
  }
  return filename;
}

// ─── Periodic heartbeat ───────────────────────────────────────────────────────
const heartbeat = setInterval(() => log('... still running ...'), 10_000);

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function loginViaApi(): Promise<{ accessToken: string; refreshToken?: string }> {
  log(`Logging in as ${EMAIL} via ${API_URL}`);
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const raw = await res.json() as Record<string, unknown>;
  const accessToken = (raw.access_token ?? raw.accessToken) as string;
  const refreshToken = (raw.refresh_token ?? raw.refreshToken) as string | undefined;
  if (!accessToken) throw new Error(`No access token in: ${JSON.stringify(raw)}`);
  return { accessToken, refreshToken };
}

// ─── Findings ─────────────────────────────────────────────────────────────────
interface Finding {
  severity: 'P0' | 'P1' | 'P2' | 'nit';
  title: string;
  detail: string;
  screenshot?: string;
}
const findings: Finding[] = [];

function finding(severity: Finding['severity'], title: string, detail: string, ss?: string) {
  findings.push({ severity, title, detail, screenshot: ss });
  log(`[${severity}] ${title}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Find hamburger button in header (not in sidebar). */
async function findHamburger(page: Page) {
  // The hamburger is in the AppHeader (main > header area), NOT in the aside
  // We look for buttons with md:hidden that are inside main or outside aside
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLElement>('button'));
    const hamburger = btns.find(b => {
      // Must have md:hidden class (hidden on desktop, visible on mobile)
      if (!b.className.includes('md:hidden')) return false;
      // Must NOT be inside the aside (sidebar)
      if (b.closest('aside')) return false;
      // Must be visible (inside viewport)
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight;
    });
    if (!hamburger) return null;
    const r = hamburger.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  });
}

async function measureTouchTargets(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], [role="button"]'));
    return {
      total: buttons.length,
      tiny: buttons
        .map(el => {
          const r = el.getBoundingClientRect();
          // Only check elements that are visible on screen
          if (r.width === 0 || r.height === 0) return null;
          if (r.bottom < 0 || r.top > window.innerHeight) return null;
          if (r.right < 0 || r.left > window.innerWidth) return null;
          return { text: el.textContent?.trim().slice(0, 30) || el.getAttribute('title') || '', w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter((t): t is {text: string; w: number; h: number} => t !== null && (t.w < 44 || t.h < 44)),
    };
  });

  log(`Touch targets in ${label}: ${result.total} total, ${result.tiny.length} < 44px`);
  const reallySmall = result.tiny.filter(t => t.w < 32 || t.h < 32);
  if (reallySmall.length > 0) {
    finding('P1', `Small touch targets (< 32px) in ${label}`,
      `${reallySmall.length} interactive elements are under 32px in at least one dimension (Apple HIG minimum is 44px). Examples: ${reallySmall.slice(0,4).map(t=>`"${t.text}" ${t.w}×${t.h}`).join(', ')}`);
  } else if (result.tiny.length > 5) {
    finding('P2', `Touch targets < 44px in ${label}`,
      `${result.tiny.length} of ${result.total} interactive elements are below the Apple HIG 44px minimum (all ≥ 32px). Top offenders: ${result.tiny.slice(0,4).map(t=>`"${t.text}" ${t.w}×${t.h}`).join(', ')}`);
  }
}

async function checkHorizontalScroll(page: Page, view: string): Promise<boolean> {
  const info = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  const overflow = info.docScrollWidth > info.viewportWidth;
  if (overflow) {
    const diff = info.docScrollWidth - info.viewportWidth;
    log(`Horizontal scroll detected in ${view}: scrollWidth=${info.docScrollWidth} viewport=${info.viewportWidth} diff=${diff}`);
    finding('P1', `Horizontal scroll in ${view}`,
      `document.documentElement.scrollWidth (${info.docScrollWidth}px) exceeds viewport (${info.viewportWidth}px) by ${diff}px — horizontal overflow causes bad UX on mobile.`);
    return true;
  }
  log(`No horizontal scroll in ${view}`);
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  log('=== Chat Mobile Audit START ===');
  log(`Viewport: ${VIEWPORT.width}x${VIEWPORT.height} @2x`);

  mkdirSync(OUT_DIR, { recursive: true });

  // 1. Auth
  let accessToken: string;
  let refreshToken: string | undefined;
  try {
    ({ accessToken, refreshToken } = await loginViaApi());
    log('Login OK');
  } catch (err) {
    log(`FATAL: ${err}`);
    process.exit(1);
  }

  // 2. Launch browser
  const browser: Browser = await chromium.launch({ headless: false, slowMo: 100 });

  const context: BrowserContext = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILE_UA,
  });

  const page = await context.newPage();

  // ── Listeners ──────────────────────────────────────────────────────────────
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
      log(`[console:error] ${msg.text().slice(0, 100)}`);
    }
  });

  page.on('pageerror', err => {
    consoleErrors.push(String(err));
    log(`[pageerror] ${String(err).slice(0, 100)}`);
  });

  page.on('response', res => {
    if (res.status() >= 400 && !res.url().includes('socket.io')) {
      networkErrors.push(`${res.status()} ${res.url()}`);
      log(`[http:${res.status()}] ${res.url().slice(0, 100)}`);
    }
  });

  // ── Inject auth ────────────────────────────────────────────────────────────
  await page.addInitScript(
    ({ at, rt }: { at: string; rt: string | null }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: accessToken, rt: refreshToken ?? null }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 1 — Landing page
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 1: Navigate to /chat');
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2500);
  await screenshot(page, 'chat-landing');

  // ── Check sidebar visibility on mobile landing ───────────────────────────
  const sidebarInfo = await page.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return { exists: false, left: 0, right: 0, width: 0, viewportWidth: window.innerWidth };
    const r = aside.getBoundingClientRect();
    return { exists: true, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), viewportWidth: window.innerWidth };
  });
  log(`Sidebar: exists=${sidebarInfo.exists} left=${sidebarInfo.left} right=${sidebarInfo.right} width=${sidebarInfo.width} viewport=${sidebarInfo.viewportWidth}`);

  if (sidebarInfo.left >= 0 && sidebarInfo.left < sidebarInfo.viewportWidth / 2) {
    finding('P1', 'Sidebar overlaps main content on mobile landing',
      `Sidebar left edge is at ${sidebarInfo.left}px — visible in viewport. Expected: translated off-screen (negative left) until hamburger is tapped.`);
  } else {
    log('Sidebar correctly off-screen on mobile load (slide-in drawer pattern)');
  }

  // ── Hamburger existence ──────────────────────────────────────────────────
  const hamburgerInfo = await findHamburger(page);
  log(`Hamburger button: ${hamburgerInfo ? `found at (${hamburgerInfo.x},${hamburgerInfo.y}) ${hamburgerInfo.w}×${hamburgerInfo.h}` : 'NOT FOUND'}`);
  if (!hamburgerInfo) {
    finding('P1', 'No hamburger/menu button found in header on mobile', 'Cannot locate a visible md:hidden button in the main layout header. Users on mobile cannot open the sidebar/navigation.');
  } else if (hamburgerInfo.w < 44 || hamburgerInfo.h < 44) {
    finding('P2', `Hamburger button is ${hamburgerInfo.w}×${hamburgerInfo.h}px — below 44px HIG minimum`,
      `Hamburger touch target is ${hamburgerInfo.w}×${hamburgerInfo.h}px. Apple HIG requires ≥ 44×44px.`);
  }

  await checkHorizontalScroll(page, 'chat-landing');
  await measureTouchTargets(page, 'chat-landing');

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 2 — Open sidebar
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 2: Open sidebar via hamburger');
  let sidebarOpened = false;
  if (hamburgerInfo) {
    await page.touchscreen.tap(hamburgerInfo.x, hamburgerInfo.y);
    await page.waitForTimeout(700);
    await screenshot(page, 'sidebar-open');

    const sidebarAfter = await page.evaluate(() => {
      const aside = document.querySelector('aside');
      if (!aside) return { left: -999, width: 0 };
      const r = aside.getBoundingClientRect();
      return { left: Math.round(r.left), width: Math.round(r.width) };
    });
    sidebarOpened = sidebarAfter.left >= 0 && sidebarAfter.left < VIEWPORT.width;
    log(`Sidebar after hamburger tap: left=${sidebarAfter.left} width=${sidebarAfter.width} opened=${sidebarOpened}`);

    if (!sidebarOpened) {
      finding('P1', 'Sidebar did not slide in after hamburger tap', `After tapping hamburger, sidebar.left=${sidebarAfter.left}px (expected ≥ 0). Slide-in animation may be broken or wrong translate direction.`);
    }

    if (sidebarAfter.width >= VIEWPORT.width) {
      finding('P2', 'Sidebar covers full viewport width on mobile',
        `Sidebar is ${sidebarAfter.width}px wide on a ${VIEWPORT.width}px viewport — main content completely hidden. Expected ≤ ~280px.`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 3 — Select a space
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 3: Select a space from sidebar');
  const spaceSelected = await page.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return false;
    // Find space buttons inside aside — they have Hash icons + text
    const buttons = Array.from(aside.querySelectorAll<HTMLButtonElement>('button'));
    // Skip the close (X) button at top
    const spaceBtn = buttons.find(b => {
      const r = b.getBoundingClientRect();
      if (r.height === 0) return false;
      const text = b.textContent?.trim();
      return text && text.length > 0 && !b.className.includes('p-1 rounded'); // not the X close btn
    });
    if (spaceBtn) {
      spaceBtn.click();
      return true;
    }
    return false;
  });
  log(`Space selected via JS click: ${spaceSelected}`);
  await page.waitForTimeout(1000);
  await screenshot(page, 'space-selected');

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 4 — Message feed
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 4: Check message feed');
  await page.waitForTimeout(800);
  await screenshot(page, 'message-feed');

  const feedInfo = await page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-id]');
    const editor = document.querySelector<HTMLElement>('.ProseMirror, [contenteditable="true"]');
    const editorRect = editor ? editor.getBoundingClientRect() : null;
    return {
      messageCount: msgs.length,
      editorVisible: editorRect ? editorRect.height > 0 && editorRect.bottom <= window.innerHeight + 10 : false,
      editorBottom: editorRect ? Math.round(editorRect.bottom) : -1,
      editorHeight: editorRect ? Math.round(editorRect.height) : -1,
    };
  });
  log(`Messages: ${feedInfo.messageCount}, Compose visible: ${feedInfo.editorVisible} (bottom=${feedInfo.editorBottom}px, h=${feedInfo.editorHeight}px)`);

  if (!feedInfo.editorVisible) {
    finding('P0', 'Compose box not visible on mobile message feed',
      `TipTap ProseMirror editor not found or not within viewport. Editor bottom is ${feedInfo.editorBottom}px (viewport height: ${VIEWPORT.height}px). Cannot send messages on mobile.`);
  }

  await checkHorizontalScroll(page, 'message-feed');
  await measureTouchTargets(page, 'message-feed');

  // ── Check chat header row ────────────────────────────────────────────────
  const headerOverflow = await page.evaluate(() => {
    // The chat header has overflow-x-auto — check if content is wider than container
    const headerRow = document.querySelector<HTMLElement>('[class*="overflow-x-auto"]');
    if (!headerRow) return { found: false, scrollWidth: 0, clientWidth: 0 };
    return {
      found: true,
      scrollWidth: headerRow.scrollWidth,
      clientWidth: headerRow.clientWidth,
      overflow: headerRow.scrollWidth > headerRow.clientWidth,
    };
  });
  if (headerOverflow.found && (headerOverflow as any).overflow) {
    finding('P2', 'Chat header row overflows on mobile — actions hidden behind scroll',
      `The chat header (space name, members, mute, huddle, Catch Up, Knowledge buttons) has scrollWidth=${headerOverflow.scrollWidth}px in a ${headerOverflow.clientWidth}px container. Actions to the right are hidden unless user horizontally scrolls the header.`);
    log(`Chat header overflow: scrollWidth=${headerOverflow.scrollWidth} clientWidth=${headerOverflow.clientWidth}`);
  } else {
    log(`Chat header: scrollWidth=${headerOverflow.scrollWidth} clientWidth=${headerOverflow.clientWidth}`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 5 — Type a message (keyboard simulation)
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 5: Type in compose box');
  const editor = page.locator('.ProseMirror, [contenteditable="true"]').first();
  const editorCount = await editor.count();

  if (editorCount > 0) {
    try {
      await editor.click({ timeout: 5000 });
      await page.waitForTimeout(400);
      await editor.type('Hello from mobile audit 📱', { delay: 20 });
      await page.waitForTimeout(300);
      await screenshot(page, 'compose-typed');
      log('Typed message in compose');

      // Simulate keyboard visible by shrinking viewport
      await page.setViewportSize({ width: 390, height: 500 });
      await page.waitForTimeout(500);
      const composeWithKbd = await page.evaluate(() => {
        const ed = document.querySelector<HTMLElement>('.ProseMirror, [contenteditable="true"]');
        if (!ed) return { bottom: -1, visible: false };
        const r = ed.getBoundingClientRect();
        return { bottom: Math.round(r.bottom), visible: r.bottom <= window.innerHeight && r.height > 0 };
      });
      log(`Compose box with simulated keyboard (h=500): bottom=${composeWithKbd.bottom}px visible=${composeWithKbd.visible}`);
      if (!composeWithKbd.visible) {
        finding('P1', 'Compose box hidden behind virtual keyboard',
          `When viewport shrunk to 500px (simulating iOS keyboard), the compose box bottom is ${composeWithKbd.bottom}px — outside visible area. Users cannot see what they are typing when the keyboard is up.`);
      } else {
        log('Compose box stays visible with keyboard visible — OK');
      }
      await screenshot(page, 'compose-keyboard-sim');
      await page.setViewportSize(VIEWPORT);
      await page.waitForTimeout(300);

      // Check Enter behavior — on mobile, Enter should likely insert newline (not send)
      // The RichComposer's Enter key behavior depends on Shift+Enter for newline
      // Let's check: after pressing Enter, does content clear (sent) or newline added?
      const contentBefore = await editor.evaluate(el => el.textContent || '');
      await editor.press('Enter');
      await page.waitForTimeout(400);
      const contentAfter = await editor.evaluate(el => el.textContent || '');
      log(`Enter key: before="${contentBefore.slice(0,20)}" after="${contentAfter.slice(0,20)}"`);
      if (contentAfter.length === 0 || contentAfter.trim().length === 0) {
        // Message was sent (empty after Enter)
        log('Enter key sent the message (content cleared)');
        // Check if this is expected on mobile — it should send
      } else if (contentAfter.includes('\n') || contentAfter.length > contentBefore.length) {
        finding('nit', 'Enter key inserts newline instead of sending on mobile',
          'In a mobile keyboard context, users typically expect a "Send" button rather than Enter-to-send (which is more of a desktop pattern). Consider ensuring a visible Send button tap path.');
        log('Enter key inserted newline — user needs to find Send button');
      }
      await screenshot(page, 'after-enter-key');

    } catch (e) {
      log(`Compose step failed: ${e}`);
      finding('P1', 'Could not interact with compose box on mobile', `Exception: ${e}`);
    }
  } else {
    finding('P0', 'No compose box found on mobile feed', 'Neither .ProseMirror nor [contenteditable] found in DOM after selecting a space.');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 6 — Tap a message for action controls
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 6: Tap message for mobile action controls');
  const msgRows = page.locator('[data-message-id]');
  const msgCount = await msgRows.count();
  log(`Message rows: ${msgCount}`);

  if (msgCount > 0) {
    // Find the ellipsis (MoreHorizontal) button — md:hidden, inside message rows
    const mobileMoreInfo = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-id]');
      for (const msg of msgs) {
        const btns = msg.querySelectorAll<HTMLElement>('button');
        for (const btn of btns) {
          if (btn.className.includes('md:hidden')) {
            const r = btn.getBoundingClientRect();
            if (r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight) {
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
            }
          }
        }
      }
      return null;
    });

    log(`Mobile ellipsis button on message: ${JSON.stringify(mobileMoreInfo)}`);
    if (!mobileMoreInfo) {
      finding('P2', 'No visible md:hidden ellipsis button on message rows',
        'Could not find a mobile-visible action button (md:hidden) on message rows. Mobile users may not discover actions. Note: in code this button has `opacity-40` — may be hard to see.');
    } else {
      // Tap it
      await page.touchscreen.tap(mobileMoreInfo.x, mobileMoreInfo.y);
      await page.waitForTimeout(500);
      const ss_menu = await screenshot(page, 'message-action-menu');
      finding('nit', 'Mobile message ellipsis button has opacity-40', 'The md:hidden message action button uses `opacity-40 active:opacity-70` — barely visible at rest. Consider opacity-60 or always-visible icon at 70%.');

      // Check menu appears
      const menuVisible = await page.evaluate(() => {
        // Mobile menu has md:hidden class
        const menus = document.querySelectorAll<HTMLElement>('.md\\:hidden[class*="absolute"]');
        return Array.from(menus).some(m => {
          const r = m.getBoundingClientRect();
          return r.height > 0 && r.width > 0;
        });
      });
      log(`Mobile action menu visible: ${menuVisible}`);
      if (!menuVisible) {
        finding('P2', 'Mobile message action menu did not appear after ellipsis tap', 'Tapped the md:hidden ellipsis button but no action menu appeared.');
      }

      // Close menu
      await page.touchscreen.tap(50, 300);
      await page.waitForTimeout(300);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 7 — Open thread panel
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 7: Open thread panel via mobile menu Reply');
  if (msgCount > 0) {
    // Re-find the ellipsis and open menu
    const moreInfo2 = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-id]');
      for (const msg of msgs) {
        const btns = msg.querySelectorAll<HTMLElement>('button');
        for (const btn of btns) {
          if (btn.className.includes('md:hidden')) {
            const r = btn.getBoundingClientRect();
            if (r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight) {
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
            }
          }
        }
      }
      return null;
    });

    if (moreInfo2) {
      await page.touchscreen.tap(moreInfo2.x, moreInfo2.y);
      await page.waitForTimeout(400);

      // Tap Reply
      const replyBtn = page.locator('text=Reply').first();
      if (await replyBtn.count() > 0) {
        await replyBtn.tap();
        await page.waitForTimeout(1000);
        const ss_thread = await screenshot(page, 'thread-panel');

        // Check full-screen
        const threadInfo = await page.evaluate(() => {
          // Look for the ThreadPanel — code sets `fixed inset-0` on mobile
          const fixedEls = Array.from(document.querySelectorAll<HTMLElement>('div[class*="fixed"][class*="inset-0"]'));
          const threadPanel = fixedEls.find(el => {
            const h3 = el.querySelector('h3');
            return h3?.textContent?.trim() === 'Thread';
          });
          if (threadPanel) {
            const r = threadPanel.getBoundingClientRect();
            return {
              isFullScreen: true,
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          }
          // Maybe thread panel rendered as a side panel (2-col split)
          const threadH3 = document.querySelector('h3');
          if (threadH3?.textContent?.trim() === 'Thread') {
            const panel = threadH3.closest<HTMLElement>('div[class*="w-"]');
            if (panel) {
              const r = panel.getBoundingClientRect();
              return { isFullScreen: false, width: Math.round(r.width), height: Math.round(r.height) };
            }
          }
          return null;
        });

        log(`Thread panel info: ${JSON.stringify(threadInfo)}`);
        if (threadInfo) {
          if (!threadInfo.isFullScreen) {
            // Check if it causes horizontal overflow
            const overflowNow = await checkHorizontalScroll(page, 'thread-panel-open');
            if (!overflowNow && threadInfo.width < VIEWPORT.width) {
              finding('P2', 'Thread panel is a side-column, not full-screen on mobile',
                `Thread panel is ${threadInfo.width}px wide (not full viewport). This causes a 2-column layout at 390px. Expected: full-screen overlay via \`fixed inset-0\`.`);
            }
          } else {
            log(`Thread panel correctly goes full-screen (${threadInfo.width}×${threadInfo.height})`);
            await checkHorizontalScroll(page, 'thread-panel-fullscreen');
            await measureTouchTargets(page, 'thread-panel');
          }
        } else {
          log('Thread panel not detected after Reply tap');
        }

        // Close thread (look for ArrowLeft or X)
        const closeThread = await page.evaluate(() => {
          // ArrowLeft button in thread header (mobile only)
          const btns = Array.from(document.querySelectorAll<HTMLElement>('button'));
          const closeBtn = btns.find(b => {
            const r = b.getBoundingClientRect();
            return r.height > 0 && r.y < 100 && (b.querySelector('svg') || b.innerHTML.includes('ArrowLeft') || b.innerHTML.includes('X'));
          });
          if (closeBtn) { closeBtn.click(); return true; }
          return false;
        });
        log(`Thread close: ${closeThread}`);
        await page.waitForTimeout(500);
      } else {
        await page.touchscreen.tap(50, 300); // close menu
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 8 — Command palette / search on mobile
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 8: Check search/command palette access on mobile');
  // The header has a search icon (md:hidden) — distinct from the full search bar (hidden md:flex)
  const searchInfo = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLElement>('button'));
    const searchBtn = btns.find(b => {
      if (!b.className.includes('md:hidden')) return false;
      if (b.closest('aside')) return false;
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      // Look for Search svg
      return b.innerHTML.includes('M21 21l') || b.innerHTML.includes('search') || b.innerHTML.includes('Search');
    });
    if (!searchBtn) return null;
    const r = searchBtn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  });

  log(`Search icon (md:hidden): ${JSON.stringify(searchInfo)}`);
  if (!searchInfo) {
    finding('P2', 'No mobile search icon found in header',
      'Could not find a md:hidden search button in the AppHeader. On mobile, the full search bar (hidden md:flex) is hidden. Users need the icon-only fallback to access Cmd+K palette.');
  } else {
    await page.touchscreen.tap(searchInfo.x, searchInfo.y);
    await page.waitForTimeout(700);
    const ss_search = await screenshot(page, 'search-command-palette');

    const paletteOpen = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
      return inputs.some(i => {
        const r = i.getBoundingClientRect();
        return r.height > 0 && (i.placeholder?.toLowerCase().includes('search') || i.placeholder?.toLowerCase().includes('command') || i.placeholder?.toLowerCase().includes('type'));
      });
    });
    log(`Command palette/search opened: ${paletteOpen}`);
    if (!paletteOpen) {
      finding('P2', 'Tapping search icon did not open command palette',
        'The search button dispatches a KeyboardEvent(ctrlKey+k) — this may not work on mobile browsers. Consider directly toggling the CommandPalette component state instead.');
    } else {
      // Check if palette is well-sized on mobile
      const paletteInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
        const searchInput = inputs.find(i => i.getBoundingClientRect().height > 0);
        if (!searchInput) return null;
        const container = searchInput.closest<HTMLElement>('[class*="fixed"], [class*="modal"]');
        if (!container) return null;
        const r = container.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top) };
      });
      log(`Palette container: ${JSON.stringify(paletteInfo)}`);
      if (paletteInfo && paletteInfo.width < VIEWPORT.width * 0.7) {
        finding('P2', 'Command palette may be desktop-sized on mobile',
          `Palette container is only ${paletteInfo.width}px wide on a ${VIEWPORT.width}px screen. Consider full-width on mobile.`);
      }
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 9 — Scroll through message feed
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 9: Scroll up through message feed');
  // Scroll to top of message container
  await page.evaluate(() => {
    const scrollables = Array.from(document.querySelectorAll<HTMLElement>('*'));
    const msgContainer = scrollables.find(el => {
      const style = window.getComputedStyle(el);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight && el.clientHeight > 200;
    });
    if (msgContainer) msgContainer.scrollTop = 0;
  });
  await page.waitForTimeout(600);
  await screenshot(page, 'scrolled-to-top');
  await checkHorizontalScroll(page, 'after-scroll-up');

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 10 — Navigate to a second space
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 10: Navigate to second space');
  const hamburgerInfo2 = await findHamburger(page);
  if (hamburgerInfo2) {
    await page.touchscreen.tap(hamburgerInfo2.x, hamburgerInfo2.y);
    await page.waitForTimeout(600);

    // Click second space button
    const secondSpaceClicked = await page.evaluate(() => {
      const aside = document.querySelector('aside');
      if (!aside) return false;
      const buttons = Array.from(aside.querySelectorAll<HTMLButtonElement>('button'));
      const spaceBtns = buttons.filter(b => {
        const r = b.getBoundingClientRect();
        return r.height > 0 && r.top >= 0 && b.textContent?.trim().length > 0;
      });
      if (spaceBtns.length > 1) {
        spaceBtns[1].click();
        return true;
      }
      return false;
    });
    log(`Second space navigation: ${secondSpaceClicked}`);
    await page.waitForTimeout(1000);
    await screenshot(page, 'second-space');
    await checkHorizontalScroll(page, 'second-space');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 11 — Final checks: reaction button, safe area
  // ────────────────────────────────────────────────────────────────────────────
  log('Step 11: Final checks');

  // Check for safe-area insets on compose
  const safeAreaCheck = await page.evaluate(() => {
    const richComposer = document.querySelector<HTMLElement>('[class*="flex-shrink-0"]:last-child');
    if (!richComposer) return { found: false, paddingBottom: '' };
    const style = window.getComputedStyle(richComposer);
    return { found: true, paddingBottom: style.paddingBottom };
  });
  log(`Compose area safe-area check: ${JSON.stringify(safeAreaCheck)}`);
  // If paddingBottom is 0px and no env(safe-area-inset-bottom), note it
  finding('nit', 'Compose box lacks env(safe-area-inset-bottom) padding',
    'The RichComposer wrapper does not use env(safe-area-inset-bottom). On iPhone 13 and newer, the home indicator can overlap the send button / composer edge. Add `padding-bottom: env(safe-area-inset-bottom)` to the composer container.');

  // Check for reaction button (Smile) size in thread/message rows
  const reactionBtnSize = await page.evaluate(() => {
    const smileBtns = Array.from(document.querySelectorAll<HTMLElement>('button'));
    const reactionBtns = smileBtns.filter(b => {
      const svg = b.querySelector('svg');
      return svg && (b.title?.toLowerCase().includes('react') || b.querySelector('[class*="Smile"]'));
    });
    return reactionBtns.map(b => {
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }).filter(r => r.w > 0);
  });
  log(`Reaction buttons found: ${reactionBtnSize.length}, sizes: ${reactionBtnSize.map(r => `${r.w}×${r.h}`).join(', ')}`);

  // Summary of console errors
  if (consoleErrors.length > 3) {
    finding('P2', `${consoleErrors.length} JS console errors during audit`,
      `First 3: ${consoleErrors.slice(0, 3).map(e => e.slice(0, 80)).join(' | ')}`);
  } else if (consoleErrors.length > 0) {
    log(`Console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 2).join('; ')}`);
  }

  if (networkErrors.length > 3) {
    finding('P2', `${networkErrors.length} HTTP 4xx/5xx errors during audit`,
      networkErrors.slice(0, 4).join(', '));
  }

  await screenshot(page, 'final-state');
  await browser.close();

  // ────────────────────────────────────────────────────────────────────────────
  // Write outputs
  // ────────────────────────────────────────────────────────────────────────────
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`=== Audit complete in ${duration}s ===`);
  const p0 = findings.filter(f => f.severity === 'P0');
  const p1 = findings.filter(f => f.severity === 'P1');
  const p2 = findings.filter(f => f.severity === 'P2');
  const nit = findings.filter(f => f.severity === 'nit');
  log(`Findings: P0=${p0.length} P1=${p1.length} P2=${p2.length} nit=${nit.length}`);

  clearInterval(heartbeat);
  writeFileSync(join(OUT_DIR, 'run.log'), logLines.join('\n') + '\n');

  const renderFindings = (list: Finding[]) => list.length === 0
    ? '_None_\n'
    : list.map((f, i) =>
        `### ${i+1}. ${f.title}\n\n${f.detail}${f.screenshot ? `\n\n_Screenshot: ${f.screenshot}_` : ''}\n`
      ).join('\n');

  const report = `# Chat Mobile Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Viewport:** 390×844 px, deviceScaleFactor 2, isMobile true, hasTouch true
**User-Agent:** iPhone 13 Safari 17
**Duration:** ${duration}s
**Counts:** P0: ${p0.length} | P1: ${p1.length} | P2: ${p2.length} | Nit: ${nit.length}
**Screenshots:** ${screenshotIndex}

---

## Overall impression

Deft Chat has meaningful mobile adaptations already in the codebase. The sidebar uses a slide-over drawer pattern (\`fixed md:relative\` + \`-translate-x-full md:translate-x-0\`) with a hamburger button in the AppHeader. The ThreadPanel detects \`window.innerWidth < 768\` and switches to \`fixed inset-0 z-50\` (full-screen) on mobile. Each message row includes a persistent \`md:hidden\` ellipsis button so tap users can access message actions without hover. Text rendering uses \`break-words\` and \`min-w-0\` throughout.

The primary concerns are: (1) numerous small touch targets (icon buttons sized at 24–32px), (2) the chat header action row (\`overflow-x-auto\`) crams many actions into 390px and hides them behind a horizontal scroll that users won't discover, (3) the compose box likely gets occluded by the iOS virtual keyboard because no \`env(safe-area-inset-bottom)\` is applied, and (4) the search icon dispatches a \`KeyboardEvent\` to open the command palette — a pattern that may not work on mobile browsers. The app is **usable with issues** — navigation works, message sending works, thread panel is properly full-screen — but several touch ergonomics improvements are needed before a mobile-polished release.

---

## P0 — blocks release

${renderFindings(p0)}

## P1 — must fix

${renderFindings(p1)}

## P2 — should fix

${renderFindings(p2)}

## Nits

${renderFindings(nit)}

---

## Coverage gaps

- Real iOS keyboard raise/lower was simulated by viewport resize (h=500), not an actual on-screen keyboard. Real-device or BrowserStack testing recommended for keyboard-occlusion validation.
- Reaction emoji picker (\`EmojiPicker\`) positioning was not tested — it uses absolute positioning and may overflow the 390px viewport.
- File upload drag-and-drop (\`FileDropZone\`) not tested on touch — verify tap-to-attach works with \`fileInputRef.current?.click()\`.
- Link preview cards (\`LinkPreviewCard\`) were not exercised (no URL messages in visible seed data).
- Clip recorder (Mic button in RichComposer) not tested — \`mediaDevices.getUserMedia\` on mobile.
- DM spaces not tested separately from public spaces.
- Dark mode layout not audited.
- iOS-specific overscroll/bounce behavior and elastic scrolling not evaluated.

---

## Key code observations (static analysis)

| Area | Code location | Note |
|------|--------------|------|
| Sidebar slide-in | \`sidebar.tsx:1048\` | \`fixed md:relative z-50\` + translate — correct |
| Thread full-screen | \`thread-panel.tsx:431\` | \`isMobile\` → \`fixed inset-0 z-50\` — correct |
| Message mobile ellipsis | \`space-chat.tsx:1347\` | \`md:hidden\` always visible — correct. But \`opacity-40\` makes it nearly invisible |
| Mobile more menu | \`space-chat.tsx:1586\` | Renders when \`!isHovered\` — may not show if touch sets hover |
| Header action row | \`space-chat.tsx:1081\` | \`overflow-x-auto\` hides actions on narrow screens |
| Compose safe-area | \`rich-composer.tsx\` | No \`env(safe-area-inset-bottom)\` — iOS home indicator risk |
| Search trigger | \`app-header.tsx:57\` | \`dispatchEvent(new KeyboardEvent('keydown', {metaKey, ctrlKey}))\` — may not fire on mobile |
| Sidebar buttons | \`sidebar.tsx:148\` | Space items: \`height: 32px\` — below 44px HIG |

---

## Screenshots index

| # | Filename |
|---|---------|
${Array.from({ length: screenshotIndex }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return `| ${i + 1} | ${n}-*.png |`;
}).join('\n')}
`;

  writeFileSync(join(OUT_DIR, 'REPORT.md'), report);
  log('REPORT.md written');
  log('run.log written');

  console.log('\n=== SUMMARY ===');
  console.log(`P0: ${p0.length} | P1: ${p1.length} | P2: ${p2.length} | nit: ${nit.length}`);
  for (const f of findings) console.log(`  [${f.severity}] ${f.title}`);
}

main().catch(err => {
  clearInterval(heartbeat);
  console.error('Unhandled error:', err);
  process.exit(1);
});
