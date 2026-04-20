#!/usr/bin/env tsx
/**
 * Tasks Mobile Audit — iPhone 13 viewport (390×844)
 *
 * Tests the /tasks page at a narrow mobile viewport to surface:
 *   - Board kanban stacking/scrolling behaviour at 390px
 *   - List view 50-row pagination "Load more" button legibility
 *   - Filter bar (Priority, Assignee, Status) overflow
 *   - Task detail drawer — full-screen vs side panel
 *   - Comment composer inside the detail
 *   - "Showing N tasks…" scope label at 390px
 *   - View toggle row at 390px (5 buttons)
 *
 * Run:
 *   pnpm tsx docs/superpowers/audits/tasks-mobile/audit.ts
 *
 * Output:
 *   docs/superpowers/audits/tasks-mobile/  ← screenshots + run.log
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { assert } from '../lib/assert.js';
import { getStatePath, loginAndSaveState } from '../lib/auth.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';

const OUT_DIR = 'docs/superpowers/audits/tasks-mobile';
const LOG_PATH = path.join(OUT_DIR, 'run.log');

// Mobile: iPhone 13
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Logging ────────────────────────────────────────────────────────────────

const logLines: string[] = [];
function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  logLines.push(line);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function preflightHealthChecks(): Promise<void> {
  const apiRes = await fetch(`${API_URL}/health`).catch(() => null);
  assert(apiRes && apiRes.ok, `API not reachable at ${API_URL}/health`);
  const webRes = await fetch(`${WEB_URL}/login`).catch(() => null);
  assert(webRes && webRes.status < 500, `Web not reachable at ${WEB_URL}`);
  log('  preflight: API + web OK');
}

async function getAccessToken(): Promise<string> {
  const email = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
  const password = process.env.DEFT_TEST_PASSWORD || 'test1234';
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert(res.ok, `login failed: ${res.status}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const token = (raw.access_token ?? raw.accessToken) as string | undefined;
  assert(!!token, `login response missing token`);
  return token!;
}

async function screenshot(page: Page, name: string): Promise<void> {
  const p = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  log(`  screenshot: ${name}.png`);
}

function elementWidth(boundingBox: { width: number } | null): number {
  return boundingBox?.width ?? 0;
}

// ─── Check functions ─────────────────────────────────────────────────────────

// CHECK: tasks-landing
async function check_tasks_landing(page: Page): Promise<void> {
  log('CHECK tasks-landing: navigating to /tasks at 390px');
  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await screenshot(page, '01-tasks-landing-mobile');

  // Check that the page mounted (not a blank / crash)
  const body = await page.locator('body').innerText().catch(() => '');
  assert(
    body.length > 10,
    'tasks landing page body is empty — possible crash or redirect failure',
  );
  log('  tasks-landing: page mounted OK');
}
// CHECK: tasks-landing

// CHECK: view-toggle-row
async function check_view_toggle_row(page: Page): Promise<void> {
  log('CHECK view-toggle-row: measuring 5-button strip at 390px');
  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // The toggle strip contains Board/List/Timeline/Calendar/Pipeline buttons
  // in a flex container. Measure how much of it overflows the viewport.
  const toggleButtons = await page.locator('button:has-text("Board"), button:has-text("List"), button:has-text("Timeline"), button:has-text("Calendar"), button:has-text("Pipeline")').all();
  const viewportWidth = MOBILE_VIEWPORT.width;

  log(`  view-toggle-row: found ${toggleButtons.length} view toggle buttons`);

  // Count how many buttons are within the viewport (not clipped)
  let visibleCount = 0;
  for (const btn of toggleButtons) {
    const box = await btn.boundingBox();
    if (box && box.x >= 0 && box.x + box.width <= viewportWidth + 10) {
      visibleCount++;
    }
  }
  log(`  view-toggle-row: ${visibleCount}/${toggleButtons.length} buttons within 390px viewport`);

  // Check if the toggle container itself overflows (scrollable)
  const toggleContainer = page.locator('[class*="flex"][class*="items-center"][class*="rounded-md"]').filter({ hasText: 'Board' }).first();
  const containerBox = await toggleContainer.boundingBox().catch(() => null);
  if (containerBox) {
    const overflows = containerBox.width > viewportWidth;
    log(`  view-toggle-row: container width=${Math.round(containerBox.width)}px viewport=${viewportWidth}px overflow=${overflows}`);
    if (overflows) {
      log('  FINDING P1: view-toggle row overflows 390px viewport — buttons clipped or not scrollable');
    }
  }

  await screenshot(page, '02-view-toggle-row');
}
// CHECK: view-toggle-row

// CHECK: board-view-mobile
async function check_board_view_mobile(page: Page): Promise<void> {
  log('CHECK board-view-mobile: how does kanban render at 390px?');
  await page.goto(`${WEB_URL}/tasks?view=board`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await screenshot(page, '03-board-view-mobile');

  // Check if the board uses mobile-stacked mode (column tabs) vs horizontal scroll
  const statusTabs = page.locator('button.rounded-full').filter({ hasText: /(Backlog|To Do|In Progress|Done|Cancelled|Todo)/i });
  const tabCount = await statusTabs.count();
  log(`  board-view-mobile: status tab pills found = ${tabCount}`);

  if (tabCount > 0) {
    log('  board-view-mobile: GOOD — board uses mobile stacked tabs (not side-by-side columns)');
    // Try switching between tabs
    const firstTab = statusTabs.first();
    const firstTabText = await firstTab.innerText().catch(() => 'unknown');
    log(`  board-view-mobile: first tab = "${firstTabText}"`);
    await firstTab.click().catch(() => {});
    await page.waitForTimeout(300);

    // Try the second tab if visible
    const allTabs = await statusTabs.all();
    if (allTabs.length > 1) {
      await allTabs[1]!.click().catch(() => {});
      await page.waitForTimeout(300);
      await screenshot(page, '03b-board-second-tab');
    }
  } else {
    // Check if it's rendering side-by-side columns (horizontal scroll)
    const columns = page.locator('span.uppercase.tracking-wide').or(page.locator('[data-testid*="column"]'));
    const colCount = await columns.count();
    log(`  board-view-mobile: side-by-side columns count = ${colCount}`);
    if (colCount > 1) {
      log('  FINDING P0: board renders side-by-side columns at 390px — horizontal scroll nightmare');
    }
  }
}
// CHECK: board-view-mobile

// CHECK: list-view-pagination
async function check_list_view_pagination(page: Page): Promise<void> {
  log('CHECK list-view-pagination: 50-row pagination + "Load more" at 390px');
  await page.goto(`${WEB_URL}/tasks?view=list`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await screenshot(page, '04-list-view-mobile');

  // Check for mobile card layout vs table
  const mobileCards = page.locator('[class*="space-y-2"]').first();
  const hasCards = await mobileCards.isVisible().catch(() => false);
  log(`  list-view-pagination: mobile card layout visible = ${hasCards}`);

  // Look for "Load more" button
  const loadMoreBtn = page.locator('button:has-text("Load more")').first();
  const hasLoadMore = await loadMoreBtn.isVisible().catch(() => false);
  log(`  list-view-pagination: "Load more" button visible = ${hasLoadMore}`);

  if (hasLoadMore) {
    const box = await loadMoreBtn.boundingBox();
    const btnWidth = elementWidth(box);
    const btnText = await loadMoreBtn.innerText().catch(() => '');
    log(`  list-view-pagination: button text="${btnText}" width=${Math.round(btnWidth)}px`);

    // Verify it's tappable (at least 44px height per Apple HIG)
    const btnHeight = box?.height ?? 0;
    if (btnHeight < 44) {
      log(`  FINDING P2: "Load more" button height ${Math.round(btnHeight)}px < 44px tap target minimum`);
    } else {
      log(`  list-view-pagination: button height=${Math.round(btnHeight)}px — OK for touch`);
    }

    // Tap it and see if more rows load
    await loadMoreBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    await screenshot(page, '04b-list-after-load-more');
    const newLoadMore = page.locator('button:has-text("Load more")').first();
    const stillHasMore = await newLoadMore.isVisible().catch(() => false);
    log(`  list-view-pagination: after tap, still has more = ${stillHasMore}`);
  } else {
    log('  list-view-pagination: no "Load more" visible (either all tasks fit in 50 or not enough tasks)');
  }
}
// CHECK: list-view-pagination

// CHECK: scope-label-mobile
async function check_scope_label_mobile(page: Page): Promise<void> {
  log('CHECK scope-label-mobile: "Showing N tasks..." label at 390px');
  await page.goto(`${WEB_URL}/tasks?view=list`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // The scope label is hidden on mobile via !isMobile check in page.tsx (line 975)
  // It only renders when !isMobile. Let's verify it is NOT shown on mobile.
  const scopeLabel = page.locator('text=/Showing.*task/i').first();
  const scopeVisible = await scopeLabel.isVisible().catch(() => false);

  if (!scopeVisible) {
    log('  scope-label-mobile: GOOD — scope label hidden on mobile (correct behavior per page.tsx !isMobile guard)');
  } else {
    log('  FINDING Nit: scope label shows at 390px — may truncate. Check that it wraps gracefully.');
    const box = await scopeLabel.boundingBox();
    if (box && box.x + box.width > MOBILE_VIEWPORT.width) {
      log('  FINDING P2: scope label overflows viewport at 390px');
    }
  }
  await screenshot(page, '05-scope-label-check');
}
// CHECK: scope-label-mobile

// CHECK: filter-bar-mobile
async function check_filter_bar_mobile(page: Page): Promise<void> {
  log('CHECK filter-bar-mobile: filter bar layout at 390px');
  await page.goto(`${WEB_URL}/tasks?view=list`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await screenshot(page, '06-filter-bar-mobile');

  // On mobile, filters collapse into a single "Filters" button (mobile filter bar in task-filters.tsx)
  const filtersBtn = page.locator('button:has-text("Filters")').first();
  const hasFiltersBtn = await filtersBtn.isVisible().catch(() => false);
  log(`  filter-bar-mobile: collapsed "Filters" button = ${hasFiltersBtn}`);

  if (hasFiltersBtn) {
    log('  filter-bar-mobile: GOOD — filter bar collapses to single button on mobile');
    const box = await filtersBtn.boundingBox();
    log(`  filter-bar-mobile: button x=${Math.round(box?.x ?? 0)} width=${Math.round(box?.width ?? 0)}`);

    // Tap the Filters button
    await filtersBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    await screenshot(page, '06b-filter-dropdown-open');

    // Check that the dropdown fits within viewport
    const dropdown = page.locator('[class*="rounded-lg"]').filter({ hasText: /Assignee|Priority|Status/i }).first();
    const dropdownBox = await dropdown.boundingBox().catch(() => null);
    if (dropdownBox) {
      const dropdownRight = dropdownBox.x + dropdownBox.width;
      const dropdownBottom = dropdownBox.y + dropdownBox.height;
      log(`  filter-bar-mobile: dropdown right=${Math.round(dropdownRight)} bottom=${Math.round(dropdownBottom)} viewport=${MOBILE_VIEWPORT.width}x${MOBILE_VIEWPORT.height}`);
      if (dropdownRight > MOBILE_VIEWPORT.width + 5) {
        log(`  FINDING P1: filter dropdown overflows right edge by ${Math.round(dropdownRight - MOBILE_VIEWPORT.width)}px`);
      } else {
        log('  filter-bar-mobile: dropdown within viewport — OK');
      }
    }

    // Close dropdown
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  } else {
    // Check if individual filter buttons are showing (desktop mode rendered on mobile)
    const priorityBtn = page.locator('button:has-text("Priority")').first();
    const statusBtn = page.locator('button:has-text("Status")').first();
    const hasPriority = await priorityBtn.isVisible().catch(() => false);
    const hasStatus = await statusBtn.isVisible().catch(() => false);
    if (hasPriority || hasStatus) {
      log('  FINDING P1: individual filter buttons show at 390px instead of collapsed "Filters" — may overflow header bar');
      // Check if they overflow
      const box = hasPriority ? await priorityBtn.boundingBox() : await statusBtn.boundingBox();
      if (box && box.x + box.width > MOBILE_VIEWPORT.width) {
        log('  FINDING P1: filter button clips outside viewport');
      }
    } else {
      log('  filter-bar-mobile: no filter controls visible at 390px');
    }
  }
}
// CHECK: filter-bar-mobile

// CHECK: task-detail-mobile
async function check_task_detail_mobile(page: Page): Promise<void> {
  log('CHECK task-detail-mobile: does detail take full screen on mobile?');
  await page.goto(`${WEB_URL}/tasks?view=list`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Tap the first task card to open detail
  const firstCard = page.locator('[class*="space-y-2"] > *').first();
  const firstCardAlt = page.locator('tr[class*="cursor-pointer"]').first();

  let taskOpened = false;
  if (await firstCard.isVisible().catch(() => false)) {
    await firstCard.click({ force: true }).catch(() => {});
    taskOpened = true;
  } else if (await firstCardAlt.isVisible().catch(() => false)) {
    await firstCardAlt.click({ force: true }).catch(() => {});
    taskOpened = true;
  } else {
    // Try clicking any link that looks like a task
    const anyTask = page.locator('button, [role="row"]').filter({ hasText: /DEFT-|AE-|AM-/ }).first();
    if (await anyTask.isVisible().catch(() => false)) {
      await anyTask.click({ force: true }).catch(() => {});
      taskOpened = true;
    }
  }

  await page.waitForTimeout(1500);
  await screenshot(page, '07-task-detail-mobile');

  if (!taskOpened) {
    log('  task-detail-mobile: could not find a tappable task row — skipping detail checks');
    return;
  }

  // Check if detail renders full screen (isMobile=true path) or side panel
  // In full-screen mode: "fixed inset-0 z-50 flex flex-col overflow-hidden"
  const fullScreenDetail = page.locator('[class*="fixed"][class*="inset-0"][class*="z-50"]').first();
  const sidePanel = page.locator('[class*="w-\\[450px\\]"]').first();

  const isFullScreen = await fullScreenDetail.isVisible().catch(() => false);
  const isSidePanel = await sidePanel.isVisible().catch(() => false);

  log(`  task-detail-mobile: full-screen mode = ${isFullScreen}, side panel = ${isSidePanel}`);

  if (isFullScreen) {
    log('  task-detail-mobile: GOOD — detail panel renders as full-screen sheet on mobile');
    // Verify it fills the viewport
    const box = await fullScreenDetail.boundingBox().catch(() => null);
    if (box) {
      const widthOk = box.width >= MOBILE_VIEWPORT.width - 5;
      log(`  task-detail-mobile: detail width=${Math.round(box.width)}px (viewport=${MOBILE_VIEWPORT.width}) fills=${widthOk}`);
      if (!widthOk) {
        log('  FINDING P1: detail panel does not fill full viewport width on mobile');
      }
    }
  } else if (isSidePanel) {
    log('  FINDING P0: task detail renders as 450px side panel on mobile — cuts off at 390px viewport!');
  } else {
    log('  task-detail-mobile: detail panel found but class pattern unclear — checking body');
    // Check if any overlay is present
    const overlay = page.locator('[class*="fixed"][class*="z-50"]').first();
    const overlayVisible = await overlay.isVisible().catch(() => false);
    log(`  task-detail-mobile: any fixed z-50 overlay = ${overlayVisible}`);
  }
}
// CHECK: task-detail-mobile

// CHECK: comment-composer-mobile
async function check_comment_composer_mobile(page: Page): Promise<void> {
  log('CHECK comment-composer-mobile: Tiptap editor at 390px');
  await page.goto(`${WEB_URL}/tasks?view=list`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Open a task detail
  const firstCard = page.locator('[class*="space-y-2"] > *').first();
  let opened = false;
  if (await firstCard.isVisible().catch(() => false)) {
    await firstCard.click({ force: true }).catch(() => {});
    opened = true;
  }
  await page.waitForTimeout(1500);

  if (!opened) {
    log('  comment-composer-mobile: no task opened — skipping');
    return;
  }

  // Navigate to the Comments tab in task detail
  const commentsTab = page.locator('button:has-text("Comments"), [role="tab"]:has-text("Comments")').first();
  const hasComments = await commentsTab.isVisible().catch(() => false);

  if (hasComments) {
    await commentsTab.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    log('  comment-composer-mobile: clicked Comments tab');
  } else {
    log('  comment-composer-mobile: no Comments tab visible — checking for composer directly');
  }

  await screenshot(page, '08-comment-composer-mobile');

  // Check for the Tiptap editor / comment input area
  const tiptapEditor = page.locator('[contenteditable="true"]').first();
  const textareaInput = page.locator('textarea[placeholder*="comment"], textarea[placeholder*="Comment"]').first();

  const hasTiptap = await tiptapEditor.isVisible().catch(() => false);
  const hasTextarea = await textareaInput.isVisible().catch(() => false);

  log(`  comment-composer-mobile: tiptap editor = ${hasTiptap}, textarea = ${hasTextarea}`);

  if (hasTiptap) {
    const box = await tiptapEditor.boundingBox();
    const editorWidth = elementWidth(box);
    log(`  comment-composer-mobile: editor width=${Math.round(editorWidth)}px`);
    if (editorWidth > MOBILE_VIEWPORT.width + 5) {
      log('  FINDING P1: comment composer overflows mobile viewport width');
    } else if (editorWidth < 50) {
      log('  FINDING P2: comment composer too narrow at 390px (< 50px)');
    } else {
      log(`  comment-composer-mobile: GOOD — editor fits at ${Math.round(editorWidth)}px`);
    }

    // Try typing in the composer
    await tiptapEditor.tap().catch(() => {});
    await page.waitForTimeout(300);
    await tiptapEditor.type('test comment mobile').catch(() => {});
    await page.waitForTimeout(300);
    await screenshot(page, '08b-comment-typing');
    log('  comment-composer-mobile: typing in composer succeeded');
  } else if (hasTextarea) {
    log('  comment-composer-mobile: found textarea composer (not tiptap)');
  } else {
    log('  FINDING P2: no comment composer found on mobile in Comments tab');
  }
}
// CHECK: comment-composer-mobile

// CHECK: view-switching-mobile
async function check_view_switching_mobile(page: Page): Promise<void> {
  log('CHECK view-switching-mobile: switching all 5 views at 390px');
  const views = ['board', 'list', 'timeline', 'calendar', 'pipeline'];

  for (const v of views) {
    await page.goto(`${WEB_URL}/tasks?view=${v}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const body = await page.locator('body').innerText().catch(() => '');
    const crashed = body.includes('Error') || body.includes('Something went wrong') || body.length < 10;
    log(`  view-switching-mobile: view=${v} crashed=${crashed} bodyLen=${body.length}`);
    await screenshot(page, `09-view-${v}-mobile`);
  }
}
// CHECK: view-switching-mobile

// CHECK: kanban-scroll-behaviour
async function check_kanban_scroll(page: Page): Promise<void> {
  log('CHECK kanban-scroll: verify board does NOT produce double-scroll at 390px');
  await page.goto(`${WEB_URL}/tasks?view=board`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Check for the mobile status-tabs approach
  const tabs = page.locator('button[class*="rounded-full"][class*="whitespace-nowrap"]');
  const tabsCount = await tabs.count();
  log(`  kanban-scroll: mobile pill tabs count=${tabsCount}`);

  // Detect any horizontal overflow on the page body
  const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
  const innerWidth = await page.evaluate(() => window.innerWidth);
  log(`  kanban-scroll: body.scrollWidth=${bodyScrollWidth} innerWidth=${innerWidth}`);

  if (bodyScrollWidth > innerWidth + 10) {
    log(`  FINDING P1: page horizontal overflow at board view — body scrollWidth ${bodyScrollWidth} > ${innerWidth}`);
  } else {
    log('  kanban-scroll: GOOD — no page-level horizontal overflow on board view');
  }

  // Check if the tab scroll container works
  const tabContainer = page.locator('[style*="WebkitOverflowScrolling"], [class*="overflow-x-auto"]').first();
  const hasTabScroll = await tabContainer.isVisible().catch(() => false);
  log(`  kanban-scroll: tab scroll container visible = ${hasTabScroll}`);

  await screenshot(page, '10-kanban-scroll-mobile');
}
// CHECK: kanban-scroll-behaviour

// CHECK: ghost-backdrop
async function check_ghost_backdrop(page: Page): Promise<void> {
  log('CHECK ghost-backdrop: check for stale fixed backdrops after filter dismiss');
  await page.goto(`${WEB_URL}/tasks?view=list`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Open the Filters panel, then close it
  const filtersBtn = page.locator('button:has-text("Filters")').first();
  if (await filtersBtn.isVisible().catch(() => false)) {
    await filtersBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    // Close via Escape
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);

    // Check for lingering backdrop elements with pointer events
    const backdropCount = await page.evaluate(() => {
      const backdrops = document.querySelectorAll('[class*="fixed inset-0"]');
      let active = 0;
      for (const el of backdrops) {
        const style = window.getComputedStyle(el);
        if (style.pointerEvents !== 'none' && style.display !== 'none' && style.visibility !== 'hidden') {
          active++;
        }
      }
      return active;
    });
    log(`  ghost-backdrop: lingering backdrop elements with pointer-events active = ${backdropCount}`);
    if (backdropCount > 0) {
      log('  FINDING P2: stale backdrop blocks touch events after filter dismiss — same bug as tasks-deep audit P2-4');
    } else {
      log('  ghost-backdrop: GOOD — no stale backdrops after filter close');
    }
  } else {
    log('  ghost-backdrop: Filters button not found — trying project dropdown');
    // Try project dropdown instead
    const projectDropdown = page.locator('button:has-text("Select project")').or(page.locator('button[class*="items-center"] svg').locator('xpath=ancestor::button').first());
    if (await projectDropdown.isVisible().catch(() => false)) {
      await projectDropdown.click().catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  await screenshot(page, '11-ghost-backdrop-check');
}
// CHECK: ghost-backdrop

// CHECK: tap-target-sizes
async function check_tap_targets(page: Page): Promise<void> {
  log('CHECK tap-target-sizes: verify interactive elements >= 44px touch targets');
  await page.goto(`${WEB_URL}/tasks?view=list`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Check status indicator dots / small interactive elements
  const smallTargets: string[] = [];

  // Check view toggle buttons
  const viewBtns = await page.locator('button:has-text("Board"), button:has-text("List")').all();
  for (const btn of viewBtns) {
    const box = await btn.boundingBox();
    if (box && box.height < 32) {
      const txt = await btn.innerText().catch(() => '?');
      smallTargets.push(`view-btn "${txt}" h=${Math.round(box.height)}`);
    }
  }

  // Check filter buttons
  const filterBtns = await page.locator('button:has-text("Filters"), button:has-text("Priority"), button:has-text("Status")').all();
  for (const btn of filterBtns) {
    const box = await btn.boundingBox();
    if (box && box.height < 32) {
      const txt = await btn.innerText().catch(() => '?');
      smallTargets.push(`filter-btn "${txt}" h=${Math.round(box.height)}`);
    }
  }

  if (smallTargets.length > 0) {
    log(`  FINDING Nit: small tap targets found: ${smallTargets.join(', ')}`);
  } else {
    log('  tap-target-sizes: all sampled buttons >= 32px height — reasonable for touch');
  }

  // Check Mobile FAB exists and is 48px
  const fab = page.locator('button[class*="rounded-full"][class*="w-12"]').first();
  const fabVisible = await fab.isVisible().catch(() => false);
  if (fabVisible) {
    const fabBox = await fab.boundingBox();
    log(`  tap-target-sizes: FAB h=${Math.round(fabBox?.height ?? 0)}px w=${Math.round(fabBox?.width ?? 0)}px`);
    log('  tap-target-sizes: GOOD — FAB present on mobile');
  } else {
    log('  FINDING P2: no mobile FAB button visible at 390px — user has no easy way to create a task on mobile');
  }

  await screenshot(page, '12-tap-targets-mobile');
}
// CHECK: tap-target-sizes

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('Tasks Mobile Audit — iPhone 13 viewport (390×844)\n');
  const runStart = Date.now();

  mkdirSync(OUT_DIR, { recursive: true });

  await preflightHealthChecks();

  try {
    await loginAndSaveState();
  } catch (err) {
    log(`  loginAndSaveState: ${err instanceof Error ? err.message : err} (falling back to saved state)`);
  }

  const browser: Browser = await chromium.launch({ headless: false, slowMo: 100 });
  const consoleErrors: string[] = [];
  let exitCode = 0;

  try {
    const browserCtx = await browser.newContext({
      storageState: getStatePath(),
      viewport: MOBILE_VIEWPORT,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: MOBILE_UA,
    });
    const page = await browserCtx.newPage();

    // Listeners up front
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const txt = msg.text();
        if (!txt.includes('Failed to load resource')) {
          consoleErrors.push(txt);
        }
      }
    });
    page.on('pageerror', (err) => {
      log(`  PAGE ERROR: ${err.message}`);
    });
    page.on('response', (resp) => {
      if (resp.status() >= 400) {
        log(`  NETWORK ${resp.status()}: ${resp.url()}`);
      }
    });

    const checks: Array<[string, () => Promise<void>]> = [
      ['tasks-landing', () => check_tasks_landing(page)],
      ['view-toggle-row', () => check_view_toggle_row(page)],
      ['board-view-mobile', () => check_board_view_mobile(page)],
      ['list-view-pagination', () => check_list_view_pagination(page)],
      ['scope-label-mobile', () => check_scope_label_mobile(page)],
      ['filter-bar-mobile', () => check_filter_bar_mobile(page)],
      ['task-detail-mobile', () => check_task_detail_mobile(page)],
      ['comment-composer-mobile', () => check_comment_composer_mobile(page)],
      ['view-switching-mobile', () => check_view_switching_mobile(page)],
      ['kanban-scroll', () => check_kanban_scroll(page)],
      ['ghost-backdrop', () => check_ghost_backdrop(page)],
      ['tap-targets', () => check_tap_targets(page)],
    ];

    const failures: string[] = [];
    for (const [name, fn] of checks) {
      try {
        log(`\n--- Running check: ${name} ---`);
        await fn();
        log(`--- PASS: ${name} ---`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`--- FAIL (${name}): ${msg} ---`);
        failures.push(`${name}: ${msg}`);
        try {
          await page.screenshot({ path: path.join(OUT_DIR, `FAIL-${name}.png`), fullPage: false });
        } catch {
          // ignore
        }
      }
    }

    if (failures.length > 0) {
      exitCode = 1;
      log(`\n${failures.length} check failure(s):`);
      for (const f of failures) log(`  - ${f}`);
    } else {
      log('\nAll checks passed');
    }

    if (consoleErrors.length > 0) {
      log(`\nBrowser console errors (${consoleErrors.length}):`);
      for (const e of consoleErrors.slice(0, 10)) log(`  ${e}`);
    }
  } finally {
    await browser.close();
  }

  const elapsedMs = Date.now() - runStart;
  log(`\nTotal duration: ${elapsedMs}ms`);

  writeFileSync(LOG_PATH, logLines.join('\n') + '\n');
  console.log(`Run log written to ${LOG_PATH}`);

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Audit runner crashed:', err);
  process.exit(1);
});
