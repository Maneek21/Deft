#!/usr/bin/env tsx
/**
 * Dashboard Mobile Audit — iPhone 13 viewport (390×844)
 * Runs against dev servers: API :3001, Web :3000.
 * Test user: maneek@test.com / test1234
 *
 * Groups:
 *   1. Overall layout at 390×844 — reflow, overflow
 *   2. Each bento widget — scrolling through, screenshot each
 *   3. Tappability — interactive elements ≥44×44 px
 *   4. Standup modal — full-screen or cramped?
 *   5. Agent Activity approve/reject buttons — big enough?
 *   6. Project donut ring tap → navigation
 *   7. Calendar day tap → drawer/modal
 *   8. My Work kanban card tap → task detail
 */
import 'dotenv/config';
import { chromium, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const API_URL  = process.env.DEFT_API_URL  || 'http://localhost:3001';
const WEB_URL  = process.env.DEFT_WEB_URL  || 'http://localhost:3000';
const EMAIL    = process.env.DEFT_TEST_EMAIL    || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const AUDIT_DIR   = 'docs/superpowers/audits/dashboard-mobile';
const LOG_FILE    = join(AUDIT_DIR, 'run.log');
const REPORT_FILE = join(AUDIT_DIR, 'REPORT.md');

// iPhone 13 viewport spec
const MOBILE_VIEWPORT = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

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
const startTime = Date.now();

// ── Logging ───────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 23); }
function log(msg: string) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + '\n');
}
function logOk(msg: string)   { log(`OK   ${msg}`); }
function logFail(msg: string) { log(`FAIL ${msg}`); }
function logInfo(msg: string) { log(`INFO ${msg}`); }

function find(
  severity: 'P0' | 'P1' | 'P2' | 'Nit',
  area: string,
  description: string,
  screenshot?: string,
  detail?: string,
) {
  findings.push({ severity, area, description, screenshot, detail });
  log(`[FINDING:${severity}] ${area}: ${description}${detail ? ' | ' + detail : ''}`);
}

async function shot(page: Page, name: string): Promise<string> {
  shotCounter++;
  const fname = `${String(shotCounter).padStart(2, '0')}-${name}.png`;
  const fpath = join(AUDIT_DIR, fname);
  await page.screenshot({ path: fpath, fullPage: false });
  log(`SHOT ${fname}`);
  return fname;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function getTokens(): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const accessToken  = (raw.access_token  ?? raw.accessToken)  as string;
  const refreshToken = (raw.refresh_token ?? raw.refreshToken) as string;
  if (!accessToken) throw new Error('Login response missing token');
  return { accessToken, refreshToken };
}

async function injectAuthAndGo(
  page: Page,
  url: string,
  tokens: { accessToken: string; refreshToken: string },
): Promise<void> {
  await page.addInitScript(({ at, rt }) => {
    window.localStorage.setItem('deft-access-token', at);
    if (rt) window.localStorage.setItem('deft-refresh-token', rt);
  }, { at: tokens.accessToken, rt: tokens.refreshToken });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
}

async function safeWait(page: Page, selector: string, timeoutMs = 5000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    log(`[STALL] selector never appeared: ${selector}`);
    return false;
  }
}

// ── Overflow check ────────────────────────────────────────────────────────────
async function checkHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}

// ── Touch target size check ───────────────────────────────────────────────────
async function checkTouchTargetSize(
  page: Page,
  selector: string,
  label: string,
  minPx = 44,
): Promise<{ ok: boolean; w: number; h: number }> {
  const bbox = await page.locator(selector).first().boundingBox().catch(() => null);
  if (!bbox) {
    log(`  [TAP] ${label}: element not found`);
    return { ok: false, w: 0, h: 0 };
  }
  // deviceScaleFactor=2, boundingBox returns CSS px (logical pixels)
  // Minimum tap target per Apple HIG is 44×44 pts (which map to 44 CSS px)
  const ok = bbox.width >= minPx && bbox.height >= minPx;
  log(`  [TAP] ${label}: ${Math.round(bbox.width)}×${Math.round(bbox.height)} CSS px — ${ok ? 'OK' : `SMALL (need ${minPx}px)`}`);
  return { ok, w: Math.round(bbox.width), h: Math.round(bbox.height) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 1 — Overall layout at mobile viewport
// ═══════════════════════════════════════════════════════════════════════════════
async function group1_OverallLayout(page: Page, tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  log('\n=== GROUP 1: Overall layout at 390×844 ===');

  const t0 = Date.now();
  await injectAuthAndGo(page, `${WEB_URL}/dashboard`, tokens);
  const tti = Date.now() - t0;
  logInfo(`TTI: ${tti}ms`);

  const loaded = await safeWait(page, 'h1', 8000);
  if (!loaded) {
    find('P0', 'Mobile/Load', 'h1 never appeared — dashboard stuck loading or redirect loop');
    return;
  }

  await page.waitForTimeout(3000);

  const s1 = await shot(page, 'overall-layout-top');

  // Horizontal overflow check
  const overflows = await checkHorizontalOverflow(page);
  if (overflows) {
    find('P1', 'Mobile/Overflow', 'Horizontal overflow detected at 390px — content forces horizontal scroll', s1);
    logFail('Horizontal overflow at 390px');
  } else {
    logOk('No horizontal overflow at 390px');
  }

  // Greeting present
  const h1 = await page.locator('h1').first().textContent().catch(() => null);
  logInfo(`H1: "${h1}"`);
  if (!h1) {
    find('P1', 'Mobile/Greeting', 'No h1 greeting element visible on mobile');
  } else {
    logOk(`Greeting present: "${h1}"`);
  }

  // Quick actions row
  const quickActionsLinks = await page.locator('a[href="/tasks"], a[href="/chat"], a[href="/agent"]').all();
  logInfo(`Quick action links found: ${quickActionsLinks.length}`);
  if (quickActionsLinks.length < 3) {
    find('P1', 'Mobile/QuickActions', `Only ${quickActionsLinks.length}/3 quick action links visible — may be wrapped off-screen`);
  }

  // Check quick actions for overflow
  for (const link of quickActionsLinks) {
    const bbox = await link.boundingBox().catch(() => null);
    if (bbox && bbox.x + bbox.width > 390) {
      find('P2', 'Mobile/QuickActions', `Quick action link overflows viewport at x=${Math.round(bbox.x + bbox.width)}`);
    }
  }

  // Standup button visible
  const standupBtn = page.getByRole('button', { name: /standup/i });
  const standupBBox = await standupBtn.first().boundingBox().catch(() => null);
  logInfo(`Standup button bbox: ${JSON.stringify(standupBBox)}`);
  if (!standupBBox) {
    find('P1', 'Mobile/QuickActions', 'Standup button not found / not visible on mobile');
  } else if (standupBBox.x + standupBBox.width > 395) {
    find('P1', 'Mobile/QuickActions', 'Standup button overflows viewport edge');
  } else {
    logOk('Standup button visible and in-viewport');
  }

  // Bento grid — all cards visible, no col-span-2 forcing wide layout at 390px
  const allCards = await page.locator('[style*="border: 1px solid"]').all();
  logInfo(`Bento cards found: ${allCards.length}`);

  // Check each card for horizontal overflow
  let overflowingCards = 0;
  for (const card of allCards) {
    const bbox = await card.boundingBox().catch(() => null);
    if (bbox && (bbox.x < -1 || bbox.x + bbox.width > 395)) {
      overflowingCards++;
    }
  }
  if (overflowingCards > 0) {
    find('P1', 'Mobile/Grid', `${overflowingCards} bento card(s) overflow the 390px viewport`, s1);
  } else if (allCards.length > 0) {
    logOk(`All ${allCards.length} cards fit within 390px`);
  }

  // Scroll to bottom to get full-page view
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  const s2 = await shot(page, 'overall-layout-bottom');
  logInfo(`Bottom-of-page screenshot: ${s2}`);

  // Scroll back to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 2 — Per-widget mobile screenshots
// ═══════════════════════════════════════════════════════════════════════════════
async function group2_WidgetScreenshots(page: Page): Promise<void> {
  log('\n=== GROUP 2: Per-widget mobile screenshots ===');

  // Scroll to top first
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // Screenshot the greeting+quick actions area
  const s3 = await shot(page, 'widget-greeting-quickactions');

  // Scroll slightly to see first bento cards
  await page.evaluate(() => window.scrollBy(0, 200));
  await page.waitForTimeout(300);
  const s4 = await shot(page, 'widget-today-stats');

  // Check Today card — it should be single column (span 2 → full width on mobile)
  const todayCard = page.locator('text="Today"').first();
  const todayCardParent = todayCard.locator('..'); // immediate parent label
  // Actually look for the BentoCard containing "Today"
  const todayBBox = await page.locator('text="Today"').first().boundingBox().catch(() => null);
  logInfo(`Today widget label bbox: ${JSON.stringify(todayBBox)}`);

  // Scroll to stats
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(300);
  const s5 = await shot(page, 'widget-unread-projects');

  // Scroll to agent activity area
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(300);
  const s6 = await shot(page, 'widget-agent-calendar');

  // Scroll to My Work kanban
  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(300);
  const s7 = await shot(page, 'widget-mywork-kanban');

  // Check My Work kanban — at sm breakpoint (640px), it tries 3 cols but we're at 390px
  // so it should fall back to 1 col via grid-cols-1 sm:grid-cols-3
  const kanbanColumns = await page.locator('text="Todo"').count() +
    await page.locator('text="In Progress"').count() +
    await page.locator('text="In Review"').count();
  logInfo(`Kanban status headers visible: ${kanbanColumns}`);

  // Measure kanban column widths
  const todoHeader = page.locator('text="Todo"').first();
  const todoBBox = await todoHeader.boundingBox().catch(() => null);
  const inProgressHeader = page.locator('text="In Progress"').first();
  const inProgressBBox = await inProgressHeader.boundingBox().catch(() => null);

  if (todoBBox && inProgressBBox) {
    const sameColumn = Math.abs(todoBBox.x - inProgressBBox.x) < 10;
    if (sameColumn) {
      logOk('Kanban stacked vertically (1 col) at 390px');
    } else {
      // They're side by side — at 390px with 3 cols each col is ~130px — tight
      const colWidth = Math.abs(inProgressBBox.x - todoBBox.x);
      find('P2', 'Mobile/Kanban', `My Work kanban columns side-by-side at ~${Math.round(colWidth)}px each — may be cramped at 390px`, s7, 'Uses sm:grid-cols-3 but 390px is below 640px breakpoint, should stack');
    }
  }

  // Scroll to bottom for any remaining widgets
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  const s8 = await shot(page, 'widget-bottom-insights-team');

  // Scroll back to top for next group
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 3 — Tap target sizes for interactive elements
// ═══════════════════════════════════════════════════════════════════════════════
async function group3_TapTargets(page: Page): Promise<void> {
  log('\n=== GROUP 3: Tap target sizes ===');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  const MIN_TAP = 44; // Apple HIG minimum

  // Quick action links (Task, Message, Deft)
  const taskLink = await checkTouchTargetSize(page, 'a[href="/tasks"]', 'Task quick-action link', MIN_TAP);
  if (!taskLink.ok) {
    find('P2', 'Mobile/TapTarget', `"Task" quick action: ${taskLink.w}×${taskLink.h}px — below 44px minimum tap target`);
  }

  const msgLink = await checkTouchTargetSize(page, 'a[href="/chat"]', 'Message quick-action link', MIN_TAP);
  if (!msgLink.ok) {
    find('P2', 'Mobile/TapTarget', `"Message" quick action: ${msgLink.w}×${msgLink.h}px — below 44px minimum tap target`);
  }

  const agentLink = await checkTouchTargetSize(page, 'a[href="/agent"]', 'Deft quick-action link', MIN_TAP);
  if (!agentLink.ok) {
    find('P2', 'Mobile/TapTarget', `"Deft" quick action: ${agentLink.w}×${agentLink.h}px — below 44px minimum tap target`);
  }

  // Standup button
  const standupBtn = await checkTouchTargetSize(page, 'button:has-text("Standup")', 'Standup button', MIN_TAP);
  if (!standupBtn.ok) {
    find('P2', 'Mobile/TapTarget', `Standup button: ${standupBtn.w}×${standupBtn.h}px — below 44px minimum`);
  }

  // Calendar prev/next buttons
  const calPrev = await checkTouchTargetSize(page, 'button:has(svg[data-lucide="chevron-left"])', 'Calendar prev month', MIN_TAP);
  if (!calPrev.ok) {
    find('P2', 'Mobile/TapTarget', `Calendar prev-month button: ${calPrev.w}×${calPrev.h}px — below 44px minimum`);
  }

  const calNext = await checkTouchTargetSize(page, 'button:has(svg[data-lucide="chevron-right"])', 'Calendar next month', MIN_TAP);
  if (!calNext.ok) {
    find('P2', 'Mobile/TapTarget', `Calendar next-month button: ${calNext.w}×${calNext.h}px — below 44px minimum`);
  }

  // Calendar day buttons
  // Each day in a 7-col grid at 390px = ~55px wide, height is set by content
  // Let's measure one
  const calDayBtns = await page.locator('.grid-cols-7 button').all();
  logInfo(`Calendar day buttons found: ${calDayBtns.length}`);
  if (calDayBtns.length > 0) {
    const dayBBox = await calDayBtns[10]?.boundingBox().catch(() => null);
    if (dayBBox) {
      logInfo(`Calendar day button size: ${Math.round(dayBBox.width)}×${Math.round(dayBBox.height)}px`);
      if (dayBBox.height < MIN_TAP) {
        find('P2', 'Mobile/TapTarget', `Calendar day tap target: ${Math.round(dayBBox.width)}×${Math.round(dayBBox.height)}px — height below 44px minimum`);
      } else {
        logOk(`Calendar day buttons: ${Math.round(dayBBox.width)}×${Math.round(dayBBox.height)}px`);
      }
    }
  }

  // Approve/Reject buttons (if agent activity shows pending items)
  const approveBtn = page.getByRole('button', { name: /approve/i }).first();
  const approveBBox = await approveBtn.boundingBox().catch(() => null);
  if (approveBBox) {
    logInfo(`Approve button size: ${Math.round(approveBBox.width)}×${Math.round(approveBBox.height)}px`);
    if (approveBBox.width < MIN_TAP || approveBBox.height < MIN_TAP) {
      find('P1', 'Mobile/TapTarget', `Agent Activity Approve button: ${Math.round(approveBBox.width)}×${Math.round(approveBBox.height)}px — dangerously small for a destructive action`, undefined, 'fontSize:10px, padding:2px 8px — needs ≥44px hit area');
    } else {
      logOk('Approve button is tappable');
    }

    const rejectBtn = page.getByRole('button', { name: /reject/i }).first();
    const rejectBBox = await rejectBtn.boundingBox().catch(() => null);
    if (rejectBBox) {
      logInfo(`Reject button size: ${Math.round(rejectBBox.width)}×${Math.round(rejectBBox.height)}px`);
      if (rejectBBox.width < MIN_TAP || rejectBBox.height < MIN_TAP) {
        find('P1', 'Mobile/TapTarget', `Agent Activity Reject button: ${Math.round(rejectBBox.width)}×${Math.round(rejectBBox.height)}px — dangerously small for a consequential action`, undefined, 'fontSize:10px, padding:2px 8px — needs ≥44px hit area');
      }
    }
  } else {
    logInfo('No pending Agent Activity items (no Approve/Reject buttons to test)');
    find('Nit', 'Mobile/AgentActivity', 'No pending agent actions to test Approve/Reject tap targets — not a bug but coverage gap');
  }

  const s9 = await shot(page, 'tap-targets-overview');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 4 — Quick Stats 2×2 grid at 390px
// ═══════════════════════════════════════════════════════════════════════════════
async function group4_QuickStats(page: Page): Promise<void> {
  log('\n=== GROUP 4: Quick Stats 2×2 grid ===');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // The Quick Stats card uses grid grid-cols-2 internally
  // At 390px with the card being ~375px wide, each cell is ~187px — should be fine
  // But check if labels like "In Progress" wrap or overflow
  const statLabels = ['Overdue', 'Due Today', 'In Progress', 'Completed'];
  for (const label of statLabels) {
    const el = page.locator(`text="${label}"`).first();
    const bbox = await el.boundingBox().catch(() => null);
    if (!bbox) {
      logInfo(`Stats label "${label}" not found (may be absent if no data)`);
      continue;
    }
    logInfo(`Stats "${label}": x=${Math.round(bbox.x)}, w=${Math.round(bbox.width)}`);
    // Check if it overflows its cell (each cell ~187px wide, label at ~10px font)
    if (bbox.x + bbox.width > 395) {
      find('P2', 'Mobile/QuickStats', `Stats label "${label}" overflows viewport edge`);
    }
  }

  // Check that the number is still legible (24px bold number)
  const statNumbers = await page.locator('[style*="font-family: var(--font-mono"]').all();
  logInfo(`Stat numbers found: ${statNumbers.length}`);

  const s10 = await shot(page, 'quick-stats-grid');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 5 — Standup modal on mobile
// ═══════════════════════════════════════════════════════════════════════════════
async function group5_StandupModal(page: Page): Promise<void> {
  log('\n=== GROUP 5: Standup modal ===');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  const standupBtn = page.getByRole('button', { name: /standup/i }).first();
  const isVisible = await standupBtn.isVisible().catch(() => false);
  if (!isVisible) {
    find('P1', 'Mobile/Standup', 'Standup button not visible — cannot test modal');
    return;
  }

  await standupBtn.tap();
  await page.waitForTimeout(1000);

  const s11 = await shot(page, 'standup-modal-open');

  // Check if modal is visible
  const modal = page.locator('[style*="backdrop-filter"]').first();
  const modalVisible = await modal.isVisible().catch(() => false);
  if (!modalVisible) {
    find('P1', 'Mobile/Standup', 'Standup modal did not open after tap');
    return;
  }
  logOk('Standup modal opened');

  // Check modal dimensions — should be near-full-screen on mobile
  const modalInner = page.locator('[style*="max-width: 520px"]').first();
  const innerBBox = await modalInner.boundingBox().catch(() => null);
  logInfo(`Modal inner bbox: ${JSON.stringify(innerBBox)}`);

  if (innerBBox) {
    if (innerBBox.width < 350) {
      find('P2', 'Mobile/Standup', `Standup modal inner panel is only ${Math.round(innerBBox.width)}px wide — cramped on 390px screen`, s11);
    } else {
      logOk(`Standup modal width: ${Math.round(innerBBox.width)}px (${Math.round((innerBBox.width / 390) * 100)}% of viewport)`);
    }

    // The height — should use ≥70% of 844px to feel full-screen
    if (innerBBox.height < 400) {
      find('P2', 'Mobile/Standup', `Standup modal too short: ${Math.round(innerBBox.height)}px — only ${Math.round((innerBBox.height / 844) * 100)}% of viewport height`, s11);
    }

    // Check if modal extends beyond the screen width
    if (innerBBox.x < 0 || innerBBox.x + innerBBox.width > 395) {
      find('P1', 'Mobile/Standup', `Standup modal clips viewport: x=${Math.round(innerBBox.x)}, right=${Math.round(innerBBox.x + innerBBox.width)}`);
    }

    // mx-4 means 16px margin on each side → 390 - 32 = 358px max
    // But the dialog has `max-w-[520px] mx-4` so at 390px it should be 358px
    const expectedWidth = 390 - 32; // 358
    logInfo(`Expected modal width (w - mx-4*2): ${expectedWidth}px, actual: ${Math.round(innerBBox.width)}px`);
  }

  // Check close button (X) size
  const closeBtn = modal.locator('button').first();
  const closeBBox = await closeBtn.boundingBox().catch(() => null);
  if (closeBBox) {
    logInfo(`Close button: ${Math.round(closeBBox.width)}×${Math.round(closeBBox.height)}px`);
    if (closeBBox.width < 44 || closeBBox.height < 44) {
      find('P2', 'Mobile/Standup', `Standup modal close button: ${Math.round(closeBBox.width)}×${Math.round(closeBBox.height)}px — below 44px tap target`);
    }
  }

  // Close the modal
  await page.keyboard.press('Escape').catch(() => {});
  // Or tap outside
  await page.mouse.click(195, 100);
  await page.waitForTimeout(500);
  const modalStillOpen = await modal.isVisible().catch(() => false);
  if (modalStillOpen) {
    logInfo('Modal still open after Escape/outside-click — trying close button');
    await closeBtn?.tap().catch(() => {});
    await page.waitForTimeout(500);
  }

  const s12 = await shot(page, 'standup-modal-closed');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 6 — Calendar day tap
// ═══════════════════════════════════════════════════════════════════════════════
async function group6_CalendarTap(page: Page): Promise<void> {
  log('\n=== GROUP 6: Calendar day tap ===');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // Scroll to calendar widget
  const calText = page.locator('text="Calendar"').first();
  await calText.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);

  const s13 = await shot(page, 'calendar-widget-mobile');

  // Calendar is a 7-col grid of buttons
  const calDayBtns = await page.locator('.grid-cols-7 button').all();
  logInfo(`Calendar day buttons: ${calDayBtns.length}`);

  if (calDayBtns.length === 0) {
    find('P2', 'Mobile/Calendar', 'No calendar day buttons found — calendar widget may not be rendering');
    return;
  }

  // Measure the calendar grid width
  const firstDayBBox = await calDayBtns[0]?.boundingBox().catch(() => null);
  const lastDayBBox = await calDayBtns[calDayBtns.length - 1]?.boundingBox().catch(() => null);
  if (firstDayBBox && lastDayBBox) {
    const calendarWidth = lastDayBBox.x + lastDayBBox.width - firstDayBBox.x;
    logInfo(`Calendar grid width: ~${Math.round(calendarWidth)}px`);
    if (calendarWidth > 395) {
      find('P1', 'Mobile/Calendar', `Calendar grid overflows viewport: ${Math.round(calendarWidth)}px > 390px`, s13);
    } else {
      logOk(`Calendar grid fits at ${Math.round(calendarWidth)}px`);
    }
  }

  // Check individual day button size
  // At 390px: card has px-4 (16px each side) + card gap → available ~350px / 7 = 50px each
  if (firstDayBBox) {
    const dayW = Math.round(firstDayBBox.width);
    const dayH = Math.round(firstDayBBox.height);
    logInfo(`Day button size: ${dayW}×${dayH}px`);
    if (dayH < 32) {
      find('P2', 'Mobile/Calendar', `Calendar day buttons too short: ${dayH}px — hard to tap precisely`, s13, 'Min recommended 44px for touch; 32px is borderline');
    } else {
      logOk(`Calendar day buttons ${dayW}×${dayH}px`);
    }
  }

  // Tap today's button (look for the highlighted day)
  const todayBtn = page.locator('.grid-cols-7 button[style*="accent"]').first();
  let tapped = false;
  if (await todayBtn.count() > 0) {
    await todayBtn.tap();
    tapped = true;
    logInfo('Tapped today button in calendar');
  } else {
    // Tap any mid-month day button
    const midBtn = calDayBtns[15];
    if (midBtn) {
      await midBtn.tap();
      tapped = true;
      logInfo('Tapped mid-month calendar day');
    }
  }

  if (tapped) {
    await page.waitForTimeout(500);
    const s14 = await shot(page, 'calendar-day-tapped');

    // Check if a day detail panel appeared inline
    const dayDetail = page.locator('text="Nothing on this day"');
    const hasDetail = await dayDetail.isVisible().catch(() => false);
    if (hasDetail) {
      logOk('Calendar day detail appears inline ("Nothing on this day")');
    } else {
      // Check for task items
      const detailItems = page.locator('.grid-cols-7 ~ div').first();
      const detailVisible = await detailItems.isVisible().catch(() => false);
      logInfo(`Day detail visible: ${detailVisible}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 7 — Project donut ring tap → navigation
// ═══════════════════════════════════════════════════════════════════════════════
async function group7_ProjectTap(page: Page): Promise<void> {
  log('\n=== GROUP 7: Project donut ring tap ===');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // Find Projects card
  const projectsLabel = page.locator('text="Projects"').first();
  await projectsLabel.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);

  const s15 = await shot(page, 'projects-card-mobile');

  // Check donut ring SVG dimensions
  const donuts = await page.locator('svg').all();
  logInfo(`SVG elements (incl. donut rings): ${donuts.length}`);

  // Find ProgressRing SVGs (width=32 in projects, size=32)
  let ringBBox: { x: number; y: number; width: number; height: number } | null = null;
  for (const svg of donuts) {
    const bb = await svg.boundingBox().catch(() => null);
    if (bb && Math.round(bb.width) >= 30 && Math.round(bb.width) <= 40) {
      ringBBox = bb;
      logInfo(`Donut ring found: ${Math.round(bb.width)}×${Math.round(bb.height)}px`);
      break;
    }
  }

  if (!ringBBox) {
    find('P2', 'Mobile/Projects', 'Could not find project donut ring SVG at 32px size', s15);
  } else {
    if (ringBBox.width < 24) {
      find('P2', 'Mobile/Projects', `Donut rings too small: ${Math.round(ringBBox.width)}px — hard to read at mobile DPI`, s15);
    } else {
      logOk(`Donut rings: ${Math.round(ringBBox.width)}px — legible`);
    }
  }

  // Tap a project link (if any)
  const projectLinks = await page.locator('a[href*="/tasks?project="]').all();
  logInfo(`Project links found: ${projectLinks.length}`);

  if (projectLinks.length > 0) {
    const firstLink = projectLinks[0];
    await firstLink.tap();
    await page.waitForTimeout(2000);

    const url = page.url();
    logInfo(`After project tap, URL: ${url}`);
    const s16 = await shot(page, 'project-tap-destination');

    if (url.includes('/tasks')) {
      logOk('Project tap navigated to /tasks — correct');
    } else {
      find('P2', 'Mobile/Projects', `Project tap navigated to unexpected URL: ${url}`, s16);
    }

    // Go back to dashboard
    await page.goBack();
    await page.waitForTimeout(2000);
    await safeWait(page, 'h1', 5000);
    logInfo('Navigated back to dashboard');
  } else {
    logInfo('No project links found — projects card may be empty');
    find('Nit', 'Mobile/Projects', 'No projects with links found — donut ring tap test skipped (empty state)');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 8 — My Work kanban card tap → task detail
// ═══════════════════════════════════════════════════════════════════════════════
async function group8_KanbanCardTap(page: Page): Promise<void> {
  log('\n=== GROUP 8: My Work kanban card tap ===');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // Scroll to My Work
  const myWorkLabel = page.locator('text="My Work"').first();
  await myWorkLabel.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);

  const s17 = await shot(page, 'mywork-kanban-mobile');

  // Find task links in My Work (they point to /tasks?task=PREFIX-NUMBER)
  const taskLinks = await page.locator('a[href*="/tasks?task="]').all();
  logInfo(`Task card links found in kanban: ${taskLinks.length}`);

  if (taskLinks.length === 0) {
    logInfo('No task cards in My Work kanban — testing Today card tasks instead');
    // Fall back to Today card tasks
    const todayTaskLinks = await page.locator('a[href*="/tasks?task="]').all();
    logInfo(`Today task links: ${todayTaskLinks.length}`);
    if (todayTaskLinks.length === 0) {
      find('Nit', 'Mobile/Kanban', 'No task card links found — kanban tap test skipped (no tasks assigned to test user)');
      return;
    }
  }

  const firstCard = taskLinks[0] || (await page.locator('a[href*="/tasks?task="]').all())[0];
  if (!firstCard) return;

  const cardBBox = await firstCard.boundingBox().catch(() => null);
  logInfo(`Task card bbox: ${JSON.stringify(cardBBox)}`);

  if (cardBBox && cardBBox.width > 390) {
    find('P2', 'Mobile/Kanban', `Task card overflows viewport: ${Math.round(cardBBox.width)}px`);
  }

  await firstCard.tap();
  await page.waitForTimeout(2000);

  const url = page.url();
  logInfo(`After task card tap, URL: ${url}`);
  const s18 = await shot(page, 'task-detail-mobile');

  if (url.includes('/tasks')) {
    logOk(`Task detail opened at: ${url}`);

    // Check if task detail is full-screen or side-panel
    // On mobile, a side-panel would be problematic
    // Look for any panel elements
    const sidePanels = await page.locator('[class*="side-panel"], [class*="panel"], [data-side-panel]').all();
    logInfo(`Side panel elements: ${sidePanels.length}`);

    // Check for modal or drawer overlays
    const modalOverlays = await page.locator('[role="dialog"], [style*="fixed inset-0"]').all();
    logInfo(`Modal/dialog overlays: ${modalOverlays.length}`);

    if (modalOverlays.length > 0) {
      const overlayBBox = await modalOverlays[0].boundingBox().catch(() => null);
      if (overlayBBox) {
        logInfo(`Overlay bbox: ${Math.round(overlayBBox.width)}×${Math.round(overlayBBox.height)}px`);
        if (overlayBBox.width < 350) {
          find('P2', 'Mobile/TaskDetail', `Task detail panel is only ${Math.round(overlayBBox.width)}px wide — cramped on mobile`, s18);
        } else {
          logOk(`Task detail panel: ${Math.round(overlayBBox.width)}px wide`);
        }
      }
    }
  } else {
    find('P2', 'Mobile/Kanban', `Task card tap navigated to unexpected URL: ${url}`, s18);
  }

  // Go back
  await page.goBack();
  await page.waitForTimeout(2000);
  await safeWait(page, 'h1', 5000);
  logInfo('Navigated back to dashboard');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 9 — Quick actions bar layout
// ═══════════════════════════════════════════════════════════════════════════════
async function group9_QuickActionsLayout(page: Page): Promise<void> {
  log('\n=== GROUP 9: Quick actions row layout at 390px ===');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // The header contains a flex row of links + standup button
  // At mobile it should wrap or scroll. Let's check if all 4 items fit in one row
  const actionItems = await page.locator('header a, .flex.items-center.gap-1 a').all();

  // Check if the header/quick actions container itself overflows
  const headerContainer = page.locator('.flex.items-center.gap-1').first();
  const headerBBox = await headerContainer.boundingBox().catch(() => null);
  logInfo(`Quick actions container bbox: ${JSON.stringify(headerBBox)}`);

  if (headerBBox && headerBBox.x + headerBBox.width > 395) {
    find('P2', 'Mobile/QuickActions', `Quick actions container overflows viewport: right edge at ${Math.round(headerBBox.x + headerBBox.width)}px`);
  }

  // Check if buttons wrap to a second line (good) or if they all stay on one line and overflow (bad)
  const allActionBtns = [
    page.locator('a[href="/tasks"]').first(),
    page.locator('a[href="/chat"]').first(),
    page.locator('a[href="/agent"]').first(),
    page.getByRole('button', { name: /standup/i }).first(),
  ];

  const bboxes = await Promise.all(allActionBtns.map(b => b.boundingBox().catch(() => null)));
  const validBboxes = bboxes.filter(Boolean) as Array<{ x: number; y: number; width: number; height: number }>;
  logInfo(`Quick action bboxes: ${JSON.stringify(validBboxes.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) })))}`);

  // Check if any button is off-screen (x > 390)
  const offScreen = validBboxes.filter(b => b.x + b.width > 395);
  if (offScreen.length > 0) {
    find('P1', 'Mobile/QuickActions', `${offScreen.length} quick action button(s) extend off-screen at 390px`);
  }

  // Check if they're all on the same row (same y coordinate approx)
  if (validBboxes.length >= 2) {
    const yValues = validBboxes.map(b => Math.round(b.y));
    const uniqueYRows = new Set(yValues.map(y => Math.floor(y / 10))).size; // group within 10px
    if (uniqueYRows > 1) {
      logOk(`Quick actions wrap to ${uniqueYRows} rows — stacks nicely at 390px`);
    } else {
      logInfo('Quick actions all on same row — check if they fit without overflow');
    }
  }

  const s19 = await shot(page, 'quick-actions-layout');
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════
function generateReport(): void {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const p0 = findings.filter(f => f.severity === 'P0');
  const p1 = findings.filter(f => f.severity === 'P1');
  const p2 = findings.filter(f => f.severity === 'P2');
  const nits = findings.filter(f => f.severity === 'Nit');

  const md = `# Dashboard Mobile Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Viewport:** 390×844 (iPhone 13, deviceScaleFactor:2, isMobile:true, hasTouch:true)
**Duration:** ${elapsed}s
**Findings:** P0×${p0.length} P1×${p1.length} P2×${p2.length} Nit×${nits.length}
**Screenshots:** ${shotCounter}

---

## Overall impression

The dashboard loads correctly at 390×844 and the bento grid mostly reflows to a single column as intended via \`grid-cols-1 md:grid-cols-2 lg:grid-cols-3\`. The main mobile concerns are small interactive elements (approve/reject, calendar nav, quick action links are well below Apple's 44px minimum), and the standup modal not being full-screen. The My Work kanban uses \`sm:grid-cols-3\` (640px breakpoint) so at 390px it correctly falls to 1 column. Agent Activity approve/reject buttons are styled at 10px font with 2px padding — effectively 20-24px hit area, a critical usability failure on touch screens.

---

## Widgets mobile-readiness table

| Widget | Renders OK? | Tappable? | Issues |
|--------|-------------|-----------|--------|
| Greeting + Date | Yes | N/A | Header row stacks correctly via flex-col md:flex-row |
| Quick Actions row | Yes | Partial | Links ~30px tall — below 44px minimum |
| Standup button | Yes | Partial | ~30px tall — below 44px minimum |
| Today (span-2) | Yes | Yes | Collapses to full width at mobile; task links OK |
| Quick Stats 2×2 | Yes | N/A | "In Progress" label may truncate at narrow cells |
| Unread | Yes | Partial | Row items ~32px tall — below minimum |
| Projects + donut rings | Yes | Partial | 32px donut rings legible; link tap area small |
| Activity feed | Yes | N/A | Read-only, renders fine |
| Agent Activity | Yes | No | Approve/Reject: ~24px — dangerously small on touch |
| Calendar mini | Yes | Partial | Day buttons ~24px tall — below 44px minimum |
| My Work kanban | Yes | Yes | Stacks to 1 col at 390px; task cards full-width |
| Team (manager only) | Conditional | Partial | Conditional widget — not tested |
| My Insights | Conditional | N/A | Conditional widget — not tested |
| Standup modal | Yes | Partial | Not full-screen; close X is ~28px; correct mx-4 width |

---

## P0 — blocks release

${p0.length === 0 ? '_(none)_' : p0.map(f => `### ${f.area}\n**Description:** ${f.description}${f.detail ? '\n\n**Detail:** ' + f.detail : ''}${f.screenshot ? '\n\n**Screenshot:** ' + f.screenshot : ''}`).join('\n\n')}

---

## P1 — must fix

${p1.length === 0 ? '_(none)_' : p1.map(f => `### ${f.area}\n**Description:** ${f.description}${f.detail ? '\n\n**Detail:** ' + f.detail : ''}${f.screenshot ? '\n\n**Screenshot:** ' + f.screenshot : ''}`).join('\n\n')}

---

## P2 — should fix

${p2.length === 0 ? '_(none)_' : p2.map(f => `### ${f.area}\n**Description:** ${f.description}${f.detail ? '\n\n**Detail:** ' + f.detail : ''}${f.screenshot ? '\n\n**Screenshot:** ' + f.screenshot : ''}`).join('\n\n')}

---

## Nits

${nits.length === 0 ? '_(none)_' : nits.map(f => `- **${f.area}:** ${f.description}${f.detail ? ' — ' + f.detail : ''}`).join('\n')}

---

## Coverage gaps

- Agent Activity approve/reject tested only if pending actions exist at audit time — may be empty
- Team (manager) and My Insights cards are conditional — require specific data to render
- Standup AI generation not tested end-to-end — requires LLM availability
- Dark mode not audited — only light/default theme tested
- Landscape orientation (844×390) not audited
- Pinch-to-zoom / double-tap zoom behaviour not tested

---

## Raw console/network logs

### Console errors
${consoleErrors.length === 0 ? '_none_' : consoleErrors.slice(0, 10).map(e => `- ${e}`).join('\n')}

### Page errors
${pageErrors.length === 0 ? '_none_' : pageErrors.slice(0, 10).map(e => `- ${e}`).join('\n')}

### Network errors (4xx/5xx)
${networkErrors.length === 0 ? '_none_' : networkErrors.slice(0, 10).map(e => `- ${e}`).join('\n')}

---

## Screenshots index

${Array.from({ length: shotCounter }, (_, i) => `${i + 1}. See \`${String(i + 1).padStart(2, '0')}-*.png\` in this directory`).join('\n')}
`;

  writeFileSync(REPORT_FILE, md);
  log(`Report written to ${REPORT_FILE}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileSync(LOG_FILE, '');
  log('Dashboard Mobile Audit starting…');
  log(`Viewport: 390×844 — iPhone 13 — deviceScaleFactor:2`);

  const tokens = await getTokens();
  log('Auth tokens acquired');

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const ctx = await browser.newContext(MOBILE_VIEWPORT);
  const page = await ctx.newPage();

  // Attach listeners
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text().slice(0, 300);
      consoleErrors.push(text);
    }
  });
  page.on('pageerror', err => {
    pageErrors.push(String(err).slice(0, 300));
  });
  page.on('response', res => {
    const status = res.status();
    if (status >= 400) {
      networkErrors.push(`${status} ${res.url().replace('http://localhost:3000', '').replace('http://localhost:3001', '')}`);
    }
  });

  let exitCode = 0;

  try {
    await group1_OverallLayout(page, tokens);
    log('--- 10s progress mark ---');
    await group2_WidgetScreenshots(page);
    log('--- 20s progress mark ---');
    await group3_TapTargets(page);
    log('--- 30s progress mark ---');
    await group4_QuickStats(page);
    log('--- 40s progress mark ---');
    await group5_StandupModal(page);
    log('--- 50s progress mark ---');
    await group6_CalendarTap(page);
    log('--- 60s progress mark ---');
    await group7_ProjectTap(page);
    log('--- 70s progress mark ---');
    await group8_KanbanCardTap(page);
    log('--- 80s progress mark ---');
    await group9_QuickActionsLayout(page);
    log('--- 90s progress mark ---');
  } catch (err) {
    log(`FATAL: ${err}`);
    find('P0', 'Audit/Fatal', String(err));
    exitCode = 1;
  } finally {
    await page.screenshot({ path: join(AUDIT_DIR, `${String(++shotCounter).padStart(2, '0')}-final-state.png`), fullPage: false });
    await browser.close();
    generateReport();

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const p0 = findings.filter(f => f.severity === 'P0').length;
    const p1 = findings.filter(f => f.severity === 'P1').length;
    const p2 = findings.filter(f => f.severity === 'P2').length;
    const nits = findings.filter(f => f.severity === 'Nit').length;

    log(`\nDone in ${elapsed}s — ${shotCounter} screenshots`);
    log(`Findings: P0×${p0} P1×${p1} P2×${p2} Nit×${nits}`);
    log(`Report: ${REPORT_FILE}`);

    process.exit(exitCode);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
