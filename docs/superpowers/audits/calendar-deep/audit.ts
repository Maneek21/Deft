#!/usr/bin/env tsx
/**
 * Calendar Deep Audit — 7 test groups.
 * Runs against dev servers: API :3001, Web :3000.
 * Test user: maneek@test.com / test1234
 *
 * Groups:
 *  1. Landing + view toggle
 *  2. Event rendering (month view, empty state, event click)
 *  3. Create event (modal, submit, DB verify)
 *  4. Date navigation (prev/next/today, URL update)
 *  5. Task/event overlay (tasks with due dates)
 *  6. Meeting briefs (if surfaced)
 *  7. Integration / connect (Google Calendar OAuth flow, settings/integrations)
 */
import 'dotenv/config';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const AUDIT_DIR = 'docs/superpowers/audits/calendar-deep';
const LOG_FILE = join(AUDIT_DIR, 'run.log');
const REPORT_FILE = join(AUDIT_DIR, 'REPORT.md');

// ── Finding registry ──────────────────────────────────────────────────────────

const findings: Array<{
  severity: 'P0' | 'P1' | 'P2' | 'Nit' | 'GAP';
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

function find(
  severity: 'P0' | 'P1' | 'P2' | 'Nit' | 'GAP',
  area: string,
  description: string,
  screenshot?: string,
  detail?: string,
) {
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
    return fname;
  } catch (e) {
    logFail(`screenshot failed: ${fname} — ${e}`);
    return fname;
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
    if (resp.status() >= 400 && !resp.url().includes('favicon')) {
      networkErrors.push(`[${resp.status()}] ${resp.url()}`);
    }
  });

  return { ctx, page };
}

// ── TEST GROUP 1: Landing + view toggle ──────────────────────────────────────

async function testLandingAndViewToggle(page: Page, token: string) {
  logInfo('=== GROUP 1: Landing + View Toggle ===');

  const t0 = Date.now();
  await page.goto(`${WEB_URL}/calendar`, { waitUntil: 'domcontentloaded' });
  const ttfr = Date.now() - t0;
  logInfo(`Time to domcontentloaded: ${ttfr}ms`);
  if (ttfr > 3000) find('P2', 'Performance', `Calendar initial load took ${ttfr}ms (> 3s threshold)`);

  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  const title = await page.title();
  const url = page.url();
  logInfo(`Page title: "${title}", URL: ${url}`);

  const s01 = await shot(page, 'calendar-landing');

  // Check URL hasn't been redirected elsewhere (auth bounce)
  if (!url.includes('/calendar')) {
    find('P0', 'Auth', `Navigating to /calendar redirected away to: ${url}`, s01);
    return;
  }
  logOk('/calendar loaded without redirect');

  // Check for any immediate console error
  const hydrationErrors = consoleErrors.filter(e => e.toLowerCase().includes('hydrat'));
  if (hydrationErrors.length > 0) {
    find('P1', 'Hydration', `${hydrationErrors.length} hydration mismatch(es) on /calendar load`, s01, hydrationErrors[0]);
  }

  // Spinner should be gone within networkidle
  const spinnerStillVisible = await page.locator('.animate-spin').first().isVisible().catch(() => false);
  if (spinnerStillVisible) {
    find('P1', 'Loading', 'Spinner still visible after networkidle — calendar data may be stuck loading', s01);
  } else {
    logOk('No spinner visible after load');
  }

  // Check view toggle buttons: Month / Week / Day
  const viewBtns = await page.locator('button').filter({ hasText: /^(Month|Week|Day)$/ }).all();
  logInfo(`View toggle buttons found: ${viewBtns.length}`);
  if (viewBtns.length < 3) {
    find('P1', 'View Toggle', `Expected 3 view buttons (Month/Week/Day), found ${viewBtns.length}`, s01);
  } else {
    logOk(`All 3 view buttons present: ${viewBtns.length}`);
  }

  // Active view should be "Month" by default
  const monthBtnActive = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const monthBtn = btns.find(b => b.textContent?.trim() === 'Month');
    if (!monthBtn) return false;
    const bg = window.getComputedStyle(monthBtn).backgroundColor;
    // Active btn has accent background (not transparent/low-surface)
    return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
  });
  logInfo(`Month button appears active: ${monthBtnActive}`);
  if (!monthBtnActive) {
    find('Nit', 'View Toggle', 'Month view button not visually highlighted as active on first load', s01);
  }

  // Today button present
  const todayBtn = page.locator('button:has-text("Today")').first();
  const todayBtnVisible = await todayBtn.isVisible().catch(() => false);
  logInfo(`"Today" button visible: ${todayBtnVisible}`);
  if (!todayBtnVisible) {
    find('P1', 'Navigation', '"Today" button not found in calendar header', s01);
  }

  // New event button present
  const newEventBtn = page.locator('button:has-text("New event")').first();
  const newEventVisible = await newEventBtn.isVisible().catch(() => false);
  logInfo(`"New event" button visible: ${newEventVisible}`);
  if (!newEventVisible) {
    find('P1', 'Create Event', '"New event" button not found in calendar header', s01);
  }

  // Connection indicator
  const connectLink = await page.locator('text="Connect Calendar"').count();
  const connectedIndicator = await page.locator('text="Google Calendar"').count();
  logInfo(`Connect CTA visible: ${connectLink > 0}, Connected indicator: ${connectedIndicator > 0}`);

  // Switch to Week view
  const weekBtn = page.locator('button:has-text("Week")').first();
  if (await weekBtn.isVisible().catch(() => false)) {
    await weekBtn.click();
    await page.waitForTimeout(800);
    const s02 = await shot(page, 'week-view');

    // URL should not change (state is in React, not URL params)
    const weekUrl = page.url();
    logInfo(`URL after switching to Week: ${weekUrl}`);
    if (weekUrl !== url) {
      find('Nit', 'View Toggle URL', `URL changed when switching view: ${weekUrl} (expected no URL change since views are client-state)`, s02);
    }

    // Check week grid rendered — look for time slot rows
    const timeSlots = await page.locator('text=/^(12 AM|1 AM|6 AM|9 AM|12 PM|6 PM)$/').count();
    logInfo(`Time slot rows in week view: ${timeSlots}`);
    if (timeSlots === 0) {
      find('P1', 'Week View', 'Week view shows no time slot rows after switching', s02);
    } else {
      logOk(`Week view rendered with ${timeSlots} time slots`);
    }

    // Switch to Day view
    const dayBtn = page.locator('button:has-text("Day")').first();
    if (await dayBtn.isVisible().catch(() => false)) {
      await dayBtn.click();
      await page.waitForTimeout(600);
      const s03 = await shot(page, 'day-view');

      const dayTimeSlots = await page.locator('text=/^(12 AM|1 AM|6 AM|9 AM|12 PM|6 PM)$/').count();
      logInfo(`Time slot rows in day view: ${dayTimeSlots}`);
      if (dayTimeSlots === 0) {
        find('P1', 'Day View', 'Day view shows no time slot rows after switching', s03);
      } else {
        logOk(`Day view rendered with ${dayTimeSlots} time slots`);
      }
    }

    // Switch back to Month
    const monthBtn2 = page.locator('button:has-text("Month")').first();
    await monthBtn2.click();
    await page.waitForTimeout(600);
  }

  // Check API call went through
  const calApiResp = await apiFetch<Record<string, unknown>>(`/api/calendar?from=${new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()}&to=${new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString()}`, token);
  logInfo(`/api/calendar status: ${calApiResp.status}`);
  if (calApiResp.status !== 200) {
    find('P0', 'Calendar API', `/api/calendar returned ${calApiResp.status}`, s01, JSON.stringify(calApiResp.body).slice(0, 200));
  } else {
    const data = calApiResp.body as { tasks?: unknown[]; events?: unknown[]; notes?: unknown[]; reminders?: unknown[] };
    logOk(`/api/calendar OK — tasks:${data.tasks?.length ?? '?'} events:${data.events?.length ?? '?'} notes:${data.notes?.length ?? '?'} reminders:${data.reminders?.length ?? '?'}`);
  }
}

// ── TEST GROUP 2: Event rendering ─────────────────────────────────────────────

async function testEventRendering(page: Page, token: string) {
  logInfo('=== GROUP 2: Event Rendering ===');

  // Return to month view
  await page.goto(`${WEB_URL}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  const s04 = await shot(page, 'month-view-events');

  // Check month grid rendered (7 columns)
  const dayHeaders = await page.locator('text=/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/').count();
  logInfo(`Day-of-week header cells: ${dayHeaders}`);
  if (dayHeaders < 7) {
    find('P1', 'Month Grid', `Expected 7 day header cells, found ${dayHeaders}`, s04);
  } else {
    logOk('Month grid day headers present (7 columns)');
  }

  // Check event rendering from API data
  const now = new Date();
  const fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const toDate = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  const calResp = await apiFetch<{ tasks: unknown[]; events: unknown[]; notes: unknown[]; reminders: unknown[] }>(
    `/api/calendar?from=${fromDate.toISOString()}&to=${toDate.toISOString()}`,
    token,
  );
  const calData = calResp.body as { tasks?: unknown[]; events?: unknown[]; notes?: unknown[]; reminders?: unknown[] };
  logInfo(`Calendar data — tasks:${calData.tasks?.length ?? 0}, events:${calData.events?.length ?? 0}, notes:${calData.notes?.length ?? 0}, reminders:${calData.reminders?.length ?? 0}`);

  const totalItems = (calData.tasks?.length || 0) + (calData.events?.length || 0);

  if (totalItems === 0) {
    // Check for empty state
    const emptyStateText = await page.evaluate(() => document.body.innerText);
    const hasConnectCTA = emptyStateText.includes('Connect Calendar') || emptyStateText.includes('Connect');
    logInfo(`No events/tasks in calendar data. Connect CTA present: ${hasConnectCTA}`);

    if (!hasConnectCTA) {
      // Blank view with no empty-state guidance
      find('P2', 'Empty State', 'Calendar month view shows no events AND no empty-state/connect-calendar CTA guidance', s04, 'Users with no events see a blank grid with no affordance');
    } else {
      logOk('Empty calendar shows connect CTA');
    }
  } else {
    logOk(`Calendar data has ${totalItems} items — checking render`);

    // Look for rendered event chips
    const eventChips = await page.locator('[class*="calendar-item"], [class*="CalendarItem"]').count();
    // Also try the color-coded items visible in grid cells
    const coloredItems = await page.evaluate(() => {
      // CalendarItem renders spans with specific inline styles for event types
      const items = document.querySelectorAll('[style*="background"]');
      let count = 0;
      items.forEach(el => {
        // Small pill-style items in calendar cells
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length > 0 && text.length < 60 && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
          count++;
        }
      });
      return count;
    });
    logInfo(`Event chips (styled items): ${eventChips}, colored items: ${coloredItems}`);
  }

  // Try hovering a date cell to see if click is responsive
  const dayCells = await page.locator('[style*="border-right"][style*="border-bottom"]').all();
  logInfo(`Month day cells (via border style): ${dayCells.length}`);

  // Try clicking a cell in current month to open detail panel
  if (dayCells.length > 10) {
    // Click roughly the 15th cell (middle of grid) to land in current month
    const midCell = dayCells[15];
    if (midCell) {
      await midCell.click();
      await page.waitForTimeout(600);
      const s05 = await shot(page, 'day-detail-panel');

      // Check if detail panel opened (DayDetailPanel)
      const panelOpen = await page.evaluate(() => {
        // DayDetailPanel slides in as a side panel
        const panels = document.querySelectorAll('[class*="detail"], [class*="panel"]');
        return panels.length > 0;
      });
      logInfo(`Day detail panel opened after cell click: ${panelOpen}`);
      if (!panelOpen) {
        find('Nit', 'Day Detail Panel', 'Clicking a calendar day cell did not open the detail panel', s05);
      } else {
        logOk('Day detail panel opened on cell click');
      }

      // Close panel by clicking the same cell again
      await midCell.click();
      await page.waitForTimeout(400);
    }
  }

  // Agenda view not present (no "Agenda" button in source)
  const agendaBtn = await page.locator('button:has-text("Agenda")').count();
  if (agendaBtn > 0) {
    logInfo('Agenda view button found');
  } else {
    find('GAP', 'Agenda View', 'No Agenda view toggle — only Month/Week/Day supported', undefined, 'Source code confirms only 3 views. Noted as coverage gap.');
  }
}

// ── TEST GROUP 3: Create event ────────────────────────────────────────────────

async function testCreateEvent(page: Page, token: string) {
  logInfo('=== GROUP 3: Create Event ===');

  await page.goto(`${WEB_URL}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1000);

  // Click "New event" button
  const newEventBtn = page.locator('button:has-text("New event")').first();
  const newEventVisible = await newEventBtn.isVisible().catch(() => false);

  if (!newEventVisible) {
    find('P1', 'Create Event', '"New event" button not found — cannot test create flow', await shot(page, 'no-new-event-btn'));
    return;
  }

  await newEventBtn.click();
  await page.waitForTimeout(600);

  const s06 = await shot(page, 'create-event-modal-open');

  // Modal should be visible
  const modalVisible = await page.locator('text="New event"').filter({ hasNot: page.locator('button') }).first().isVisible().catch(() => false);
  const modalH2 = await page.locator('h2:has-text("New event")').isVisible().catch(() => false);
  logInfo(`Create event modal H2 visible: ${modalH2}`);

  if (!modalH2) {
    find('P0', 'Create Event Modal', 'Create event modal did not open after clicking "New event"', s06);
    return;
  }
  logOk('Create event modal opened');

  // Check form fields exist
  const titleInput = page.locator('input[placeholder="Event title"]').first();
  const dateInput = page.locator('input[type="date"]').first();
  const startInput = page.locator('input[type="time"]').first();
  const endInput = page.locator('input[type="time"]').nth(1);

  const titleVisible = await titleInput.isVisible().catch(() => false);
  const dateVisible = await dateInput.isVisible().catch(() => false);
  const startVisible = await startInput.isVisible().catch(() => false);
  const endVisible = await endInput.isVisible().catch(() => false);
  logInfo(`Form fields — title:${titleVisible}, date:${dateVisible}, start:${startVisible}, end:${endVisible}`);

  if (!titleVisible || !dateVisible || !startVisible || !endVisible) {
    find('P1', 'Create Event Form', `Modal missing required fields — title:${titleVisible} date:${dateVisible} start:${startVisible} end:${endVisible}`, s06);
    return;
  }
  logOk('All required form fields present');

  // Check title input auto-focuses
  const titleFocused = await page.evaluate(() => {
    const active = document.activeElement;
    return active?.getAttribute('placeholder') === 'Event title';
  });
  logInfo(`Title input auto-focused: ${titleFocused}`);
  if (!titleFocused) {
    find('Nit', 'Create Event UX', 'Title input not auto-focused on modal open', s06);
  }

  // Fill form
  const testTitle = `cal-audit-event-${Date.now()}`;
  await titleInput.fill(testTitle);

  // Set date to today
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await dateInput.fill(todayStr);
  await startInput.fill('14:00');
  await endInput.fill('15:00');

  // Fill optional fields
  const locationInput = page.locator('input[placeholder="Add location"]').first();
  const descInput = page.locator('textarea[placeholder="Add description"]').first();
  if (await locationInput.isVisible().catch(() => false)) {
    await locationInput.fill('Zoom / Remote');
  }
  if (await descInput.isVisible().catch(() => false)) {
    await descInput.fill('Calendar audit test event — do not delete');
  }

  // Check if end time < start time validation exists
  await endInput.fill('13:00'); // intentionally before start
  const submitBtn = page.locator('button:has-text("Create event")').first();
  await submitBtn.click();
  await page.waitForTimeout(500);

  // Should show an error or not submit
  const errorMsg = await page.locator('p[style*="red"], p[class*="error"], [style*="status-red"]').first().isVisible().catch(() => false);
  const modalStillOpen = await page.locator('h2:has-text("New event")').isVisible().catch(() => false);
  logInfo(`End-before-start: error shown:${errorMsg}, modal still open:${modalStillOpen}`);

  if (!errorMsg && !modalStillOpen) {
    find('P1', 'Create Event Validation', 'Submitted event with end < start — server should reject (end must be after start) but no client-side guard either', await shot(page, 'end-before-start'));
  } else if (!errorMsg && modalStillOpen) {
    // Server-side might catch it — check API directly
    const testStart = new Date(`${todayStr}T14:00:00`).toISOString();
    const testEnd = new Date(`${todayStr}T13:00:00`).toISOString();
    const validateResp = await apiFetch('/api/events', token, {
      method: 'POST',
      body: JSON.stringify({ title: 'test-validation', start: testStart, end: testEnd }),
    });
    logInfo(`API end-before-start response: ${validateResp.status} — ${JSON.stringify(validateResp.body).slice(0, 100)}`);
    if (validateResp.status !== 400) {
      find('P1', 'Create Event Validation', `API accepts events with end < start (status ${validateResp.status})`, undefined, JSON.stringify(validateResp.body).slice(0, 100));
    } else {
      logOk('API correctly rejects end-before-start (400)');
    }
  }

  // Fix end time and submit
  await endInput.fill('15:00');
  const s07 = await shot(page, 'create-event-filled');

  await submitBtn.click();
  await page.waitForTimeout(2000);

  const s08 = await shot(page, 'after-create-event');

  const modalGone = !(await page.locator('h2:has-text("New event")').isVisible().catch(() => false));
  logInfo(`Modal closed after submit: ${modalGone}`);

  if (!modalGone) {
    // Check for error message
    const errorAfterSubmit = await page.locator('p[style*="red"], [style*="status-red"]').allTextContents().catch(() => []);
    find('P0', 'Create Event Submit', `Modal did not close after submitting valid event — errors: ${errorAfterSubmit.join(', ')}`, s08);
    // Close modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    return;
  }

  // Check toast
  const toastVisible = await page.locator('text="Event created"').isVisible().catch(() => false);
  logInfo(`"Event created" toast visible: ${toastVisible}`);
  if (!toastVisible) {
    find('Nit', 'Create Event Toast', '"Event created" toast not shown after successful creation', s08);
  } else {
    logOk('"Event created" toast shown');
  }

  // Verify via API that the event was created
  const now = new Date();
  const rangeFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const rangeTo = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  await page.waitForTimeout(1000);

  const verifyResp = await apiFetch<{ tasks: unknown[]; events: Array<{ title: string; source: string }> }>(
    `/api/calendar?from=${rangeFrom}&to=${rangeTo}`,
    token,
  );
  const createdEvent = verifyResp.body.events?.find(e => e.title === testTitle);
  logInfo(`Event in DB: ${createdEvent ? 'YES' : 'NO'} — total today events: ${verifyResp.body.events?.length ?? 0}`);

  if (!createdEvent) {
    find('P1', 'Create Event DB', `Created event "${testTitle}" not found in /api/calendar for today after creation`, s08);
  } else {
    logOk(`Event "${testTitle}" confirmed in DB (source: ${createdEvent.source})`);
  }

  // Test Escape closes modal
  const newEventBtn2 = page.locator('button:has-text("New event")').first();
  if (await newEventBtn2.isVisible().catch(() => false)) {
    await newEventBtn2.click();
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const modalAfterEsc = await page.locator('h2:has-text("New event")').isVisible().catch(() => false);
    logInfo(`Modal closed with Escape: ${!modalAfterEsc}`);
    if (modalAfterEsc) {
      find('P1', 'Create Event UX', 'Escape key does not close the create event modal', await shot(page, 'modal-esc-fail'));
    } else {
      logOk('Escape closes create event modal');
    }
  }
}

// ── TEST GROUP 4: Date navigation ─────────────────────────────────────────────

async function testDateNavigation(page: Page) {
  logInfo('=== GROUP 4: Date Navigation ===');

  await page.goto(`${WEB_URL}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1000);

  // Get initial month title
  const initialTitle = await page.locator('h1').first().textContent().catch(() => '');
  logInfo(`Initial month header: "${initialTitle}"`);
  const initialUrl = page.url();

  const s09 = await shot(page, 'nav-initial');

  // From CalendarHeader source: the nav area has two small buttons adjacent to the h1 title
  // They use style={{ color: 'var(--text-secondary)', background: 'var(--surface-container-low)' }}
  // Strategy: find the h1 that has the month title, then find sibling buttons
  const navBtnIndices = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    if (!h1) return null;
    // Walk up to the parent flex container
    const parent = h1.parentElement;
    if (!parent) return null;
    // Get all buttons in parent
    const btns = Array.from(parent.querySelectorAll('button'));
    return btns.map((b, i) => ({
      i,
      text: b.textContent?.trim() ?? '',
      className: b.className.slice(0, 60),
    }));
  });
  logInfo(`Nav area buttons near h1: ${JSON.stringify(navBtnIndices)}`);

  // Find the two icon-only buttons (prev and next)
  // They have empty text content (just an SVG)
  const calNavBtns = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    if (!h1) return [];
    const parent = h1.parentElement;
    if (!parent) return [];
    const btns = Array.from(parent.querySelectorAll('button'));
    // Icon-only: no text, has SVG
    return btns
      .filter(b => b.querySelector('svg') && !b.textContent?.trim())
      .map((b, i) => ({ text: b.textContent?.trim(), idx: Array.from(parent.querySelectorAll('button')).indexOf(b) }));
  });
  logInfo(`Calendar nav chevron buttons: ${JSON.stringify(calNavBtns)}`);

  if (calNavBtns.length >= 2) {
    // Use the parent element context to click reliably
    const prevBtn = page.locator('h1').first().locator('..').locator('button').filter({ has: page.locator('svg') }).first();
    const nextBtn = page.locator('h1').first().locator('..').locator('button').filter({ has: page.locator('svg') }).nth(1);

    const prevVisible = await prevBtn.isVisible().catch(() => false);
    const nextVisible = await nextBtn.isVisible().catch(() => false);
    logInfo(`Prev button visible: ${prevVisible}, Next button visible: ${nextVisible}`);

    if (nextVisible) {
      await nextBtn.click();
      await page.waitForTimeout(800);
      const titleAfterNext = await page.locator('h1').first().textContent().catch(() => '');
      logInfo(`Title after clicking next: "${titleAfterNext}"`);
      const urlAfterNext = page.url();

      if (titleAfterNext === initialTitle) {
        find('P1', 'Date Navigation', `Clicking next month button did not change the month header (still "${titleAfterNext}")`, await shot(page, 'nav-next-fail'));
      } else {
        logOk(`Next month navigation works: "${initialTitle}" → "${titleAfterNext}"`);
      }

      if (urlAfterNext !== initialUrl) {
        find('Nit', 'Nav URL', `URL changed when navigating months: ${urlAfterNext}`, await shot(page, 'nav-url-changed'), 'Navigation is client-state only (by design). URL change was unexpected.');
      } else {
        logInfo('URL did not change on month navigation (by design — React state)');
      }

      // Click prev to go back
      if (prevVisible) {
        await prevBtn.click();
        await page.waitForTimeout(600);
        const titleAfterPrev = await page.locator('h1').first().textContent().catch(() => '');
        logInfo(`Title after clicking prev: "${titleAfterPrev}"`);
        if (titleAfterPrev === initialTitle) {
          logOk(`Prev month navigation works: back to "${titleAfterPrev}"`);
        } else {
          find('P1', 'Date Navigation Prev', `Clicking prev month did not return to original month "${initialTitle}", got "${titleAfterPrev}"`, await shot(page, 'nav-prev-fail'));
        }
      }
    } else {
      find('P1', 'Date Navigation', 'Next month chevron button not visible', s09);
    }
  } else {
    find('P1', 'Date Navigation', `Could not identify prev/next chevron buttons — found ${calNavBtns.length} icon-only buttons near h1`, s09);
  }

  // Today button
  const todayBtn = page.locator('button:has-text("Today")').first();
  if (await todayBtn.isVisible().catch(() => false)) {
    // Navigate to next month first
    const nextBtn2 = page.locator('h1').first().locator('..').locator('button').filter({ has: page.locator('svg') }).nth(1);
    if (await nextBtn2.isVisible().catch(() => false)) {
      await nextBtn2.click();
      await page.waitForTimeout(400);
    }

    const titleBeforeToday = await page.locator('h1').first().textContent().catch(() => '');
    await todayBtn.click();
    await page.waitForTimeout(600);
    const titleAfterToday = await page.locator('h1').first().textContent().catch(() => '');
    logInfo(`Today button: "${titleBeforeToday}" → "${titleAfterToday}"`);

    const expectedMonth = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if (!titleAfterToday?.includes(expectedMonth.split(' ')[0])) {
      find('P1', 'Today Button', `"Today" button did not return to current month. Expected "${expectedMonth}", got "${titleAfterToday}"`, await shot(page, 'today-btn-fail'));
    } else {
      logOk(`"Today" button returns to ${expectedMonth}`);
    }
  } else {
    find('P1', 'Today Button', '"Today" button not found', s09);
  }

  // Note: URL does not update on navigation — by design (React state only)
  find('Nit', 'Nav Deep-Link', 'Calendar navigation is React-state only — URL never updates. Bookmarked URLs always land on today\'s month.', undefined, 'Not a bug per current design, but limits shareability / browser back/forward.');

  await shot(page, 'nav-final');
}

// ── TEST GROUP 5: Task/event overlay ─────────────────────────────────────────

async function testTaskEventOverlay(page: Page, token: string) {
  logInfo('=== GROUP 5: Task/Event Overlay ===');

  // Check if the test user has any tasks with due dates
  const tasksResp = await apiFetch<Array<{ id: string; title: string; due_date: string | null; status: string }>>('/api/tasks', token);
  logInfo(`/api/tasks status: ${tasksResp.status}, count: ${Array.isArray(tasksResp.body) ? tasksResp.body.length : 'N/A'}`);

  const tasksWithDue = Array.isArray(tasksResp.body)
    ? tasksResp.body.filter((t) => t.due_date && t.status !== 'done')
    : [];
  logInfo(`Tasks with due_date: ${tasksWithDue.length}`);

  if (tasksWithDue.length === 0) {
    find('GAP', 'Task Overlay', 'No tasks with due dates found for test user — cannot verify task rendering on calendar', undefined, 'Seed a task with a due date to test this flow.');
  }

  await page.goto(`${WEB_URL}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  // Look for task chips in month view (TaskCardUnified with variant="calendar")
  const taskChips = await page.evaluate(() => {
    // Calendar tasks render in the month grid with project prefix dots
    const items = Array.from(document.querySelectorAll('[class*="task"]'));
    return items.length;
  });
  logInfo(`Task chip elements (class*="task"): ${taskChips}`);

  // Also check calendar data directly
  const now = new Date();
  const fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
  const toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const calResp = await apiFetch<{ tasks: Array<{ id: string; title: string; due_date: string }>; events: unknown[] }>(
    `/api/calendar?from=${fromDate.toISOString()}&to=${toDate.toISOString()}`,
    token,
  );
  const calTasks = calResp.body.tasks || [];
  logInfo(`Tasks in calendar for this month: ${calTasks.length}`);

  if (calTasks.length === 0) {
    find('GAP', 'Task Overlay', 'No tasks in calendar data for current month. Assign a task with a due_date to this user to test overlay.', await shot(page, 'task-overlay-empty'));
  } else {
    logOk(`${calTasks.length} tasks visible in calendar data`);
    const s10 = await shot(page, 'task-overlay-visible');

    // Drag-and-drop not testable without visible tasks — note gap
    find('GAP', 'Task Drag-Drop', `${calTasks.length} calendar tasks found — drag-to-reschedule UI flow not tested (requires visible drag handles in month cells)`, s10, 'Source code implements DnD via @dnd-kit/core. Functional test would need a seeded visible task.');
  }

  // Check task click navigates to task (TaskCardUnified in calendar variant)
  // From source: TaskCardUnified with variant="calendar" — clicking should navigate to task
  const taskElements = await page.locator('[data-testid*="task"], [class*="TaskCard"]').all();
  if (taskElements.length > 0) {
    const firstTask = taskElements[0];
    await firstTask.click();
    await page.waitForTimeout(800);
    const urlAfterTaskClick = page.url();
    logInfo(`URL after task chip click: ${urlAfterTaskClick}`);
    if (!urlAfterTaskClick.includes('/tasks') && urlAfterTaskClick === `${WEB_URL}/calendar`) {
      find('P2', 'Task Click Nav', 'Clicking a task chip in the calendar did not navigate to the task detail page', await shot(page, 'task-click-no-nav'));
    } else if (urlAfterTaskClick.includes('/tasks')) {
      logOk(`Task chip click navigated to: ${urlAfterTaskClick}`);
      await page.goBack();
    }
  }
}

// ── TEST GROUP 6: Meeting briefs ──────────────────────────────────────────────

async function testMeetingBriefs(page: Page, token: string) {
  logInfo('=== GROUP 6: Meeting Briefs ===');

  // Check if the test user has any events with meeting briefs
  const now = new Date();
  const fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const toDate = new Date(now.getFullYear(), now.getMonth() + 2, 0);

  const calResp = await apiFetch<{ events: Array<{ id: string; title: string }> }>(
    `/api/calendar?from=${fromDate.toISOString()}&to=${toDate.toISOString()}`,
    token,
  );
  const events = calResp.body.events || [];
  logInfo(`Events in 3-month window: ${events.length}`);

  if (events.length === 0) {
    find('GAP', 'Meeting Briefs', 'No calendar events found — meeting brief flow cannot be tested (requires synced or native events)', undefined, 'Google Calendar OAuth or native events needed to seed events.');
    return;
  }

  // Check briefs endpoint
  const eventIds = events.slice(0, 5).map((e) => e.id).join(',');
  const briefsResp = await apiFetch<{ briefs: Array<{ event_id: string; brief_text: string }> }>(
    `/api/calendar/briefs?event_ids=${eventIds}`,
    token,
  );
  logInfo(`/api/calendar/briefs status: ${briefsResp.status}, briefs: ${briefsResp.body.briefs?.length ?? 0}`);

  if (briefsResp.status !== 200) {
    find('P1', 'Briefs API', `/api/calendar/briefs returned ${briefsResp.status}`, undefined, JSON.stringify(briefsResp.body).slice(0, 200));
  } else {
    logOk(`/api/calendar/briefs OK — ${briefsResp.body.briefs?.length ?? 0} briefs`);
  }

  const hasBriefs = (briefsResp.body.briefs?.length ?? 0) > 0;

  // Navigate to calendar and check if brief indicator shows
  await page.goto(`${WEB_URL}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  if (hasBriefs) {
    // Look for brief indicator on event chips
    const briefIndicator = await page.evaluate(() => {
      // CalendarItem renders a star/indicator when hasBrief is true
      const allText = document.body.innerText;
      return allText.includes('✦') || allText.includes('●') || document.querySelector('[data-brief]') !== null;
    });
    logInfo(`Brief indicator visible: ${briefIndicator}`);
    logOk('Briefs exist — UI indicator test would require clicking the event chip');
  } else {
    find('GAP', 'Meeting Briefs UI', 'No meeting briefs in DB — cannot verify brief indicator chip or brief panel rendering', await shot(page, 'no-briefs'), 'Generate a brief via the agent or sync Google Calendar events to test this.');
  }

  // Click an event to see detail modal
  await page.goto(`${WEB_URL}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  const s11 = await shot(page, 'briefs-calendar-state');
}

// ── TEST GROUP 7: Integration / connect ───────────────────────────────────────

async function testIntegrationConnect(page: Page, token: string) {
  logInfo('=== GROUP 7: Integration / Connect ===');

  // Check connections API
  const connResp = await apiFetch<Array<{ provider: string; status: string; sync_error: string | null; last_sync_at: string | null }>>('/api/connections', token);
  logInfo(`/api/connections status: ${connResp.status}`);

  const connections = Array.isArray(connResp.body) ? connResp.body : [];
  const googleCal = connections.find((c) => c.provider === 'google_calendar');

  logInfo(`Google Calendar connection: ${googleCal ? `status=${googleCal.status}, last_sync=${googleCal.last_sync_at}, error=${googleCal.sync_error}` : 'NOT CONNECTED'}`);

  if (!googleCal) {
    find('GAP', 'Google Calendar OAuth', 'Google Calendar not connected for test user — OAuth flow not completeable in automated test (requires browser-level OAuth redirect)', undefined, 'This is a coverage gap, not a bug. Noted for manual testing.');
  } else if (googleCal.status === 'error') {
    find('P1', 'Google Calendar Sync', `Google Calendar connection has sync_error: ${googleCal.sync_error}`, undefined, `Last sync: ${googleCal.last_sync_at}`);
  } else if (googleCal.status === 'expired') {
    find('P1', 'Google Calendar Token', 'Google Calendar connection token is expired', undefined, `Provider: ${googleCal.provider}`);
  } else {
    logOk(`Google Calendar connected and status=${googleCal.status}`);
  }

  // Navigate to /settings/integrations
  await page.goto(`${WEB_URL}/settings/integrations`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  const intUrl = page.url();
  logInfo(`Settings/integrations URL: ${intUrl}`);

  const s12 = await shot(page, 'settings-integrations');

  if (!intUrl.includes('/settings')) {
    find('P1', 'Settings Integrations', `Navigating to /settings/integrations redirected to: ${intUrl}`, s12);
    return;
  }
  logOk('/settings/integrations loaded');

  // Check for Google Calendar connect button
  const gcalConnect = await page.locator('text=/Google Calendar/i').first().isVisible().catch(() => false);
  const connectBtn = await page.locator('button:has-text("Connect")').first().isVisible().catch(() => false);
  logInfo(`Google Calendar listed: ${gcalConnect}, Connect button: ${connectBtn}`);

  if (!gcalConnect) {
    find('P2', 'Settings Integrations', 'Google Calendar not listed in /settings/integrations page', s12);
  } else {
    logOk('Google Calendar listed in settings/integrations');
  }

  // If not connected, test OAuth initiation (without completing it)
  if (!googleCal && connectBtn) {
    // Check what the connect button does — should redirect to OAuth
    const connectBtnHref = await page.locator('button:has-text("Connect")').first().getAttribute('data-href').catch(() => null);
    logInfo(`Connect button data-href: ${connectBtnHref}`);

    // Try API OAuth initiate endpoint
    const oauthResp = await apiFetch('/api/connections/google_calendar/oauth/initiate', token);
    logInfo(`OAuth initiate status: ${oauthResp.status}`);
    if (oauthResp.status === 200 || oauthResp.status === 302) {
      const oauthData = oauthResp.body as Record<string, unknown>;
      logInfo(`OAuth response: ${JSON.stringify(oauthData).slice(0, 100)}`);
      logOk('OAuth initiation endpoint responds');
    } else {
      find('P2', 'OAuth Initiate', `OAuth initiate endpoint returned ${oauthResp.status}`, s12, JSON.stringify(oauthResp.body).slice(0, 200));
    }
  }

  // Check "Connect Calendar" link on calendar header
  await page.goto(`${WEB_URL}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1000);

  const connectCalLink = page.locator('a:has-text("Connect Calendar"), button:has-text("Connect Calendar")').first();
  const connectCalVisible = await connectCalLink.isVisible().catch(() => false);
  logInfo(`"Connect Calendar" link in calendar header: ${connectCalVisible}`);

  if (!googleCal && !connectCalVisible) {
    find('P1', 'Connect CTA', '"Connect Calendar" CTA not visible in calendar header when Google Calendar is not connected', await shot(page, 'no-connect-cta'), 'Source shows it renders when isConnected === false but isConnected may be null (loading) or the API call failed');
  } else if (connectCalVisible) {
    logOk('"Connect Calendar" link visible in header');
    // Click it and check navigation
    await connectCalLink.click();
    await page.waitForTimeout(800);
    const afterConnectUrl = page.url();
    logInfo(`URL after clicking "Connect Calendar": ${afterConnectUrl}`);
    if (!afterConnectUrl.includes('/settings')) {
      find('P1', 'Connect CTA Nav', `"Connect Calendar" link navigated to ${afterConnectUrl} instead of /settings/integrations`, await shot(page, 'connect-cta-nav'));
    } else {
      logOk(`"Connect Calendar" link navigates to settings/integrations`);
    }
  }

  // Sync button (only if connected)
  if (googleCal && googleCal.status === 'connected') {
    await page.goto(`${WEB_URL}/calendar`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(1000);

    const syncBtn = page.locator('button[title="Sync now"]').first();
    const syncBtnVisible = await syncBtn.isVisible().catch(() => false);
    logInfo(`Sync now button visible: ${syncBtnVisible}`);

    if (!syncBtnVisible) {
      find('P2', 'Sync Button', '"Sync now" button not visible in header even though Google Calendar is connected', await shot(page, 'no-sync-btn'));
    } else {
      logOk('Sync button visible');
      await syncBtn.click();
      await page.waitForTimeout(3000);
      const syncToast = await page.locator('text=/Synced \d+ events/').isVisible().catch(() => false);
      logInfo(`Sync toast visible: ${syncToast}`);
      if (!syncToast) {
        const failToast = await page.locator('text="Sync failed"').isVisible().catch(() => false);
        logInfo(`Sync failed toast: ${failToast}`);
        if (failToast) {
          find('P1', 'Sync', 'Sync operation failed (toast shows "Sync failed")', await shot(page, 'sync-failed'));
        }
      } else {
        logOk('Sync completed successfully');
      }
    }
  }

  await shot(page, 'group7-final');
}

// ── Additional checks ─────────────────────────────────────────────────────────

async function testAdditionalChecks(page: Page, token: string) {
  logInfo('=== ADDITIONAL: Timezone, URL, Misc ===');

  // Check timezone handling in API
  const tzResp = await apiFetch<{ tasks: Array<{ due_date: string }>; events: Array<{ timestamp: string }> }>(
    `/api/calendar?from=${new Date().toISOString()}&to=${new Date(Date.now() + 86400000).toISOString()}`,
    token,
  );
  if (tzResp.status === 200) {
    const events = tzResp.body.events || [];
    const tasks = tzResp.body.tasks || [];
    logInfo(`Today's events: ${events.length}, tasks: ${tasks.length}`);

    // Check if any timestamps are in unexpected format
    for (const e of events.slice(0, 5)) {
      if (e.timestamp && !e.timestamp.endsWith('Z') && !e.timestamp.includes('+')) {
        find('P2', 'Timezone', `Event timestamp "${e.timestamp}" is not UTC-normalized (missing Z or offset)`, undefined, 'Could cause wrong-day rendering in non-UTC timezones');
        break;
      }
    }
  }

  // Check that URL does not update on month navigation (by design)
  await page.goto(`${WEB_URL}/calendar`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(800);

  const urlBeforeNav = page.url();
  // Navigate using keyboard (no keyboard shortcut support)
  const kbLeft = await page.keyboard.press('ArrowLeft').catch(() => false);
  await page.waitForTimeout(400);
  const urlAfterKb = page.url();
  logInfo(`URL after ArrowLeft key: ${urlAfterKb} (changed: ${urlBeforeNav !== urlAfterKb})`);

  // Keyboard navigation for calendar date is not implemented — note as gap
  const kbNavWorks = urlBeforeNav !== urlAfterKb || (await page.locator('h1').first().textContent().catch(() => '')) !== '';
  logInfo(`Keyboard arrow navigation: ArrowLeft pressed — monitoring if month changed`);

  // Check the event detail modal for the created test event
  // Navigate to today — click today's date cell
  const todayKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  // Check if newly created event shows in the calendar for today
  const todayCell = await page.evaluate((key) => {
    // Find date cells by looking for today's date number
    const today = new Date();
    const dayNum = today.getDate().toString();
    const spans = Array.from(document.querySelectorAll('span'));
    const todaySpan = spans.find(s =>
      s.textContent?.trim() === dayNum &&
      window.getComputedStyle(s).background.includes('rgb') &&
      s.className.includes('rounded-full')
    );
    return todaySpan ? 'found' : 'not-found';
  }, todayKey);
  logInfo(`Today's date cell marker: ${todayCell}`);

  // Check week/day view slot click to open create modal
  const weekBtn = page.locator('button:has-text("Week")').first();
  if (await weekBtn.isVisible().catch(() => false)) {
    await weekBtn.click();
    await page.waitForTimeout(800);
    const s = await shot(page, 'week-view-slots');

    // Click a time slot in week view
    const weekSlots = await page.locator('[style*="cursor: pointer"], [class*="slot"]').all();
    logInfo(`Week view slot elements: ${weekSlots.length}`);
    if (weekSlots.length > 0) {
      await weekSlots[0].click().catch(() => undefined);
      await page.waitForTimeout(500);
      const modalOpen = await page.locator('h2:has-text("New event")').isVisible().catch(() => false);
      logInfo(`Create modal opens on slot click in week view: ${modalOpen}`);
      if (!modalOpen) {
        find('Nit', 'Week Slot Click', 'Clicking a time slot in week view did not open the create event modal', await shot(page, 'week-slot-no-modal'));
      } else {
        logOk('Time slot click opens create event modal in week view');
        await page.keyboard.press('Escape');
      }
    }
  }

  // Final scan for any P0 console/network errors
  logInfo(`Final scan — console errors: ${consoleErrors.length}, network errors: ${networkErrors.length}, page errors: ${pageErrors.length}`);

  const fatalNetworkErrors = networkErrors.filter(e => e.startsWith('[5'));
  if (fatalNetworkErrors.length > 0) {
    find('P1', 'Network', `${fatalNetworkErrors.length} 5xx response(s) detected during audit`, undefined, fatalNetworkErrors.slice(0, 3).join('\n'));
  }

  await shot(page, 'final-state');
}

// ── Report ────────────────────────────────────────────────────────────────────

function writeReport(duration: number) {
  const p0 = findings.filter(f => f.severity === 'P0');
  const p1 = findings.filter(f => f.severity === 'P1');
  const p2 = findings.filter(f => f.severity === 'P2');
  const nit = findings.filter(f => f.severity === 'Nit');
  const gap = findings.filter(f => f.severity === 'GAP');

  const fmt = (arr: typeof findings) => {
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

  const fence = '```';
  const screenshotsIndex = Array.from({ length: shotCounter }, (_, i) => `- \`${String(i + 1).padStart(2, '0')}-*.png\``).join('\n');

  const report = [
    '# Calendar Deep Audit',
    '',
    `**Date:** ${new Date().toISOString().split('T')[0]}`,
    '**Branch:** feat/phase2-4-mcp-agents-plans',
    `**Duration:** ${(duration / 1000).toFixed(0)}s`,
    `**Findings:** P0=${p0.length} P1=${p1.length} P2=${p2.length} Nit=${nit.length} Gap=${gap.length}`,
    `**Console errors:** ${consoleErrors.length}`,
    `**Network 4xx/5xx:** ${networkErrors.length}`,
    `**Screenshots:** ${shotCounter}`,
    '',
    '---',
    '',
    '## Surfaces observed',
    '',
    '- `/calendar` — Month/Week/Day calendar with task/event overlay and DnD reschedule',
    '- `CalendarHeader` — View toggle (Month/Week/Day), Today button, New Event, Google Calendar connect/sync',
    '- `MonthView` — 6-week grid with event chips, task chips (TaskCardUnified), drag-to-reschedule (@dnd-kit)',
    '- `WeekView` — Hourly time-slot grid with click-to-create',
    '- `DayView` — Single-day hourly time-slot grid with click-to-create',
    '- `DayDetailPanel` — Slide-in side panel on day cell click',
    '- `CreateEventModal` — Title, date, start/end time, location, description, attendees',
    '- `EventDetailModal` — Event detail with brief, attendees (RSVP status), Google Meet link, edit/delete',
    '- `/api/calendar` — Unified endpoint (tasks + events + notes + reminders)',
    '- `/api/calendar/briefs` — Meeting prep briefs endpoint',
    '- `/api/events` — Create/delete native calendar events',
    '- `/api/connections` — OAuth connection status',
    '- `/settings/integrations` — Google Calendar connect/sync UI',
    '',
    '---',
    '',
    '## P0 — Blocks release',
    '',
    fmt(p0),
    '',
    '## P1 — Must fix',
    '',
    fmt(p1),
    '',
    '## P2 — Should fix',
    '',
    fmt(p2),
    '',
    '## Nits',
    '',
    fmt(nit),
    '',
    '## Coverage gaps',
    '',
    fmt(gap),
    '',
    '---',
    '',
    '## Raw logs',
    '',
    '### Console errors/warnings',
    '',
    fence,
    consoleSec,
    fence,
    '',
    '### Network 4xx/5xx',
    '',
    fence,
    networkSec,
    fence,
    '',
    '### Uncaught page errors',
    '',
    fence,
    pageErrors.length > 0 ? pageErrors.slice(0, 20).join('\n') : '_None_',
    fence,
    '',
    '---',
    '',
    '## Screenshots index',
    '',
    screenshotsIndex,
  ].join('\n');

  writeFileSync(REPORT_FILE, report);
  log(`REPORT written to ${REPORT_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileSync(LOG_FILE, `Calendar Deep Audit — ${new Date().toISOString()}\n\n`);

  log(`API: ${API_URL}, Web: ${WEB_URL}`);
  log(`Test user: ${EMAIL}`);

  const t0 = Date.now();
  const auth = await apiLogin();
  log(`Logged in — userId: ${auth.userId}, orgId: ${auth.orgId.slice(0, 8)}`);

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const { ctx, page } = await makePage(browser, auth.accessToken, auth.refreshToken);

  try {
    await testLandingAndViewToggle(page, auth.accessToken);
    log(`Progress: Group 1 done at ${Date.now() - t0}ms`);

    await testEventRendering(page, auth.accessToken);
    log(`Progress: Group 2 done at ${Date.now() - t0}ms`);

    await testCreateEvent(page, auth.accessToken);
    log(`Progress: Group 3 done at ${Date.now() - t0}ms`);

    await testDateNavigation(page);
    log(`Progress: Group 4 done at ${Date.now() - t0}ms`);

    await testTaskEventOverlay(page, auth.accessToken);
    log(`Progress: Group 5 done at ${Date.now() - t0}ms`);

    await testMeetingBriefs(page, auth.accessToken);
    log(`Progress: Group 6 done at ${Date.now() - t0}ms`);

    await testIntegrationConnect(page, auth.accessToken);
    log(`Progress: Group 7 done at ${Date.now() - t0}ms`);

    await testAdditionalChecks(page, auth.accessToken);
    log(`Progress: Additional checks done at ${Date.now() - t0}ms`);

  } catch (err) {
    log(`FATAL ERROR: ${err}`);
    try { await shot(page, 'fatal-error'); } catch {}
    find('P0', 'Script', `Unhandled error terminated audit: ${err}`);
  } finally {
    await ctx.close();
    await browser.close();
  }

  const duration = Date.now() - t0;
  log(`\nTotal duration: ${(duration / 1000).toFixed(1)}s`);
  log(`Findings: P0=${findings.filter(f => f.severity === 'P0').length} P1=${findings.filter(f => f.severity === 'P1').length} P2=${findings.filter(f => f.severity === 'P2').length} Nit=${findings.filter(f => f.severity === 'Nit').length} Gap=${findings.filter(f => f.severity === 'GAP').length}`);
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
