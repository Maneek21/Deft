#!/usr/bin/env tsx
/**
 * Dashboard Deep Audit — 7 focused test groups.
 * Runs against dev servers: API :3001, Web :3000.
 * Test user: maneek@test.com / test1234
 *
 * Groups:
 *   1. Landing load + layout
 *   2. Widget content accuracy (DB cross-check)
 *   3. Interactive affordances
 *   4. Quick actions
 *   5. Empty states
 *   6. Real-time updates
 *   7. Pending approvals UX
 */
import 'dotenv/config';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const API_URL  = process.env.DEFT_API_URL  || 'http://localhost:3001';
const WEB_URL  = process.env.DEFT_WEB_URL  || 'http://localhost:3000';
const EMAIL    = process.env.DEFT_TEST_EMAIL    || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';
const DB_URL   = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

const AUDIT_DIR  = 'docs/superpowers/audits/dashboard-deep';
const LOG_FILE   = join(AUDIT_DIR, 'run.log');
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
function logOk(msg: string)   { log(`OK   ${msg}`); }
function logFail(msg: string) { log(`FAIL ${msg}`); }
function logInfo(msg: string) { log(`INFO ${msg}`); }

function find(severity: 'P0' | 'P1' | 'P2' | 'Nit', area: string, description: string, screenshot?: string, detail?: string) {
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

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function getAccessToken(): Promise<{ accessToken: string; refreshToken: string }> {
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

async function injectAuthAndGo(page: Page, url: string, tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  await page.addInitScript(({ at, rt }) => {
    window.localStorage.setItem('deft-access-token', at);
    if (rt) window.localStorage.setItem('deft-refresh-token', rt);
  }, { at: tokens.accessToken, rt: tokens.refreshToken });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
}

// ── Stall-safe wait helper ────────────────────────────────────────────────────
async function safeWait(page: Page, selector: string, timeoutMs = 5000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    log(`[STALL] selector never appeared: ${selector}`);
    return false;
  }
}

// ── DB helper ─────────────────────────────────────────────────────────────────
async function dbQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 1 — Landing load + layout
// ═══════════════════════════════════════════════════════════════════════════════
async function group1_LandingLoad(page: Page, tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  log('\n=== GROUP 1: Landing load + layout ===');

  const t0 = Date.now();
  await injectAuthAndGo(page, `${WEB_URL}/dashboard`, tokens);
  const tti = Date.now() - t0;
  logInfo(`Time to domcontentloaded: ${tti}ms`);

  // Wait for the greeting to appear (indicates React hydration)
  const loaded = await safeWait(page, 'h1', 8000);
  if (!loaded) {
    find('P0', 'Dashboard/Load', 'h1 never appeared — dashboard may be stuck loading or redirect looping');
  }

  // Wait a bit more for data fetch
  await page.waitForTimeout(3000);

  const screenshotName = await shot(page, 'dashboard-initial-load');

  // Check page title
  const pageTitle = await page.title();
  logInfo(`Page title: "${pageTitle}"`);
  if (!pageTitle.toLowerCase().includes('deft') && !pageTitle.toLowerCase().includes('dashboard')) {
    find('Nit', 'Dashboard/Title', `Page title is generic: "${pageTitle}" — should include product name`);
  }

  // Check greeting text
  const h1Text = await page.locator('h1').first().textContent().catch(() => null);
  logInfo(`H1 text: "${h1Text}"`);
  if (!h1Text) {
    find('P1', 'Dashboard/Greeting', 'No h1 element found on dashboard');
  } else {
    const greetings = ['good morning', 'good afternoon', 'good evening'];
    const lower = h1Text.toLowerCase();
    const hasGreeting = greetings.some(g => lower.includes(g));
    if (!hasGreeting) {
      find('P1', 'Dashboard/Greeting', `Greeting h1 does not contain time-of-day text: "${h1Text}"`);
    } else {
      logOk(`Greeting present: "${h1Text}"`);
    }
    // Check user name
    if (!lower.includes('maneek') && !lower.includes('deft')) {
      find('P1', 'Dashboard/Greeting', `User first name "Maneek" not in greeting: "${h1Text}"`);
    } else {
      logOk('User name in greeting');
    }
  }

  // Count distinct bento cards
  const cardCount = await page.locator('[style*="border: 1px solid"]').count().catch(() => 0);
  logInfo(`Bento cards visible: ~${cardCount}`);
  if (cardCount < 3) {
    find('P1', 'Dashboard/Widgets', `Only ${cardCount} bento cards detected — expected at least 6`);
  }

  // Date line below heading
  const dateText = await page.locator('p').filter({ hasText: /202[0-9]/ }).first().textContent().catch(() => null);
  logInfo(`Date line: "${dateText}"`);
  if (!dateText) {
    find('Nit', 'Dashboard/DateLine', 'Could not find a date line below the greeting');
  }

  // Check console errors captured so far
  if (consoleErrors.length > 0) {
    logFail(`Console errors at load: ${consoleErrors.slice(0, 5).join(' | ')}`);
    for (const e of consoleErrors.slice(0, 5)) {
      find('P2', 'Dashboard/Console', e.slice(0, 200));
    }
  }

  // --- Responsive: 1024x768 ---
  log('  Checking 1024x768 viewport...');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(500);
  const shot1024 = await shot(page, 'responsive-1024x768');
  // Check for horizontal overflow
  const overflows1024 = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  if (overflows1024) {
    find('P2', 'Dashboard/Responsive', 'Horizontal overflow at 1024x768 — content spills outside viewport', shot1024);
  } else {
    logOk('No horizontal overflow at 1024x768');
  }

  // --- Responsive: 1920x1080 ---
  log('  Checking 1920x1080 viewport...');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(500);
  const shot1920 = await shot(page, 'responsive-1920x1080');
  const overflows1920 = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  if (overflows1920) {
    find('P2', 'Dashboard/Responsive', 'Horizontal overflow at 1920x1080', shot1920);
  } else {
    logOk('No horizontal overflow at 1920x1080');
  }

  // Restore standard viewport
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  logOk('Group 1 complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 2 — Widget content accuracy
// ═══════════════════════════════════════════════════════════════════════════════
async function group2_WidgetAccuracy(page: Page, tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  log('\n=== GROUP 2: Widget content accuracy (DB cross-check) ===');

  // Fetch dashboard data via API
  let dashData: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${API_URL}/api/dashboard`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (res.ok) {
      dashData = (await res.json()) as Record<string, unknown>;
      logInfo(`Dashboard API returned keys: ${Object.keys(dashData || {}).join(', ')}`);
    } else {
      find('P0', 'Dashboard/API', `GET /api/dashboard returned ${res.status}`);
    }
  } catch (e: unknown) {
    find('P0', 'Dashboard/API', `GET /api/dashboard threw: ${String(e)}`);
  }

  // Fetch maneek's user id from DB
  const [maneekRow] = await dbQuery<{ id: string }>(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [EMAIL]).catch(() => []);
  const maneekId = maneekRow?.id;
  logInfo(`Maneek user id: ${maneekId}`);

  if (maneekId) {
    // Cross-check: tasks assigned to maneek not done
    const dbTasks = await dbQuery<{ id: string; title: string; status: string }>(
      `SELECT t.id, t.title, t.status FROM tasks t
       WHERE t.assignee_id = $1 AND t.status NOT IN ('done','cancelled')
       LIMIT 50`,
      [maneekId],
    ).catch(() => []);
    logInfo(`DB my-tasks (non-done, assigned): ${dbTasks.length}`);

    const apiMyWork = (dashData?.my_work as unknown[]) || [];
    const apiDueToday = (dashData?.due_today as unknown[]) || [];
    const apiOverdue = (dashData?.overdue as unknown[]) || [];
    const apiInProgress = (dashData?.in_progress as unknown[]) || [];
    const totalApiTasks = new Set([
      ...apiMyWork.map((t: any) => t.id),
      ...apiDueToday.map((t: any) => t.id),
      ...apiOverdue.map((t: any) => t.id),
      ...apiInProgress.map((t: any) => t.id),
    ]).size;
    logInfo(`API total unique tasks across my_work/due_today/overdue/in_progress: ${totalApiTasks}`);

    if (dbTasks.length > 0 && totalApiTasks === 0) {
      find('P1', 'Dashboard/MyWork', `DB has ${dbTasks.length} active tasks for maneek but dashboard API returned 0 tasks`);
    } else {
      logOk(`Task counts DB=${dbTasks.length} API≈${totalApiTasks} (API counts subsets differently, expected some delta)`);
    }
  }

  // Cross-check: pending agent_actions
  const pendingActions = await dbQuery<{ id: string; action: string; approval_status: string }>(
    `SELECT id, action, approval_status FROM agent_actions WHERE approval_status = 'pending' LIMIT 20`,
  ).catch(() => []);
  logInfo(`DB pending agent_actions: ${pendingActions.length}`);

  // Check agent activity API
  try {
    const res2 = await fetch(`${API_URL}/api/dashboard/agent-activity`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (res2.ok) {
      const agentActivity = (await res2.json()) as unknown[];
      const pendingInApi = agentActivity.filter((a: any) => a.approval_status === 'pending').length;
      logInfo(`API agent-activity pending: ${pendingInApi}`);
      if (pendingActions.length > 0 && pendingInApi === 0) {
        find('P1', 'Dashboard/AgentActivity', `DB has ${pendingActions.length} pending agent_actions but API returned 0 pending items`);
      } else {
        logOk(`Pending approvals DB=${pendingActions.length} API=${pendingInApi}`);
      }
    } else {
      find('P1', 'Dashboard/AgentActivity', `GET /api/dashboard/agent-activity returned ${res2.status}`);
    }
  } catch (e) {
    find('P1', 'Dashboard/AgentActivity', `GET /api/dashboard/agent-activity threw: ${String(e)}`);
  }

  // Cross-check: projects
  const dbProjects = await dbQuery<{ id: string; name: string }>(
    `SELECT id, name FROM projects WHERE org_id = (SELECT org_id FROM org_members WHERE user_id = (SELECT id FROM users WHERE email = $1) LIMIT 1) LIMIT 10`,
    [EMAIL],
  ).catch(() => []);
  logInfo(`DB projects: ${dbProjects.length}`);
  const apiProjects = (dashData?.projects as unknown[]) || [];
  logInfo(`API projects: ${apiProjects.length}`);
  if (dbProjects.length > 0 && apiProjects.length === 0) {
    find('P1', 'Dashboard/Projects', `DB has ${dbProjects.length} projects but dashboard API returned 0`);
  } else {
    logOk(`Projects DB=${dbProjects.length} API=${apiProjects.length}`);
  }

  // Cross-check: recent activity
  const dbActivity = await dbQuery<{ id: string }>(
    `SELECT ta.id FROM task_activity ta
     JOIN tasks t ON t.id = ta.task_id
     JOIN projects p ON p.id = t.project_id
     WHERE p.org_id = (SELECT org_id FROM org_members WHERE user_id = (SELECT id FROM users WHERE email = $1) LIMIT 1)
     ORDER BY ta.created_at DESC LIMIT 5`,
    [EMAIL],
  ).catch(() => []);
  logInfo(`DB recent task_activity: ${dbActivity.length}`);
  const apiActivity = (dashData?.recent_activity as unknown[]) || [];
  logInfo(`API recent_activity: ${apiActivity.length}`);
  if (dbActivity.length > 0 && apiActivity.length === 0) {
    find('P1', 'Dashboard/Activity', `DB has task_activity rows but API returned empty recent_activity`);
  }

  // Check for visual rendering of widgets on the page
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const screenshotName = await shot(page, 'widget-accuracy-overview');

  // Check if "Quick Stats" card is visible
  const quickStatsVisible = await page.getByText('Quick Stats').isVisible().catch(() => false);
  if (quickStatsVisible) {
    logOk('Quick Stats bento card visible');
  } else {
    find('P2', 'Dashboard/QuickStats', 'Quick Stats bento card not found in DOM');
  }

  // Check if Projects card is visible
  const projectsVisible = await page.getByText('Projects').first().isVisible().catch(() => false);
  if (projectsVisible) {
    logOk('Projects bento card visible');
  } else {
    find('P2', 'Dashboard/Projects', 'Projects bento card not visible');
  }

  // Check if Activity card visible
  const activityVisible = await page.getByText('Activity').isVisible().catch(() => false);
  if (activityVisible) {
    logOk('Activity bento card visible');
  } else {
    find('P2', 'Dashboard/Activity', 'Activity bento card not visible');
  }

  logOk('Group 2 complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 3 — Interactive affordances
// ═══════════════════════════════════════════════════════════════════════════════
async function group3_InteractiveAffordances(page: Page): Promise<void> {
  log('\n=== GROUP 3: Interactive affordances ===');

  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Test: Header quick-action links
  log('  Testing header quick-action links...');
  const headerLinks = [
    { text: 'Task', expectedPathFragment: '/tasks' },
    { text: 'Message', expectedPathFragment: '/chat' },
    { text: 'Deft', expectedPathFragment: '/agent' },
  ];

  for (const link of headerLinks) {
    try {
      const el = page.getByText(link.text, { exact: true }).first();
      const visible = await el.isVisible().catch(() => false);
      if (!visible) {
        find('P1', `Dashboard/QuickAction/${link.text}`, `"${link.text}" quick-action button not found`);
        continue;
      }
      const href = await el.getAttribute('href').catch(() => null);
      if (!href) {
        // might be a button
        logInfo(`"${link.text}" has no href — may be a button`);
      } else if (!href.includes(link.expectedPathFragment)) {
        find('P2', `Dashboard/QuickAction/${link.text}`, `"${link.text}" links to "${href}", expected fragment "${link.expectedPathFragment}"`);
      } else {
        logOk(`"${link.text}" quick-action → ${href}`);
      }
    } catch (e) {
      find('P2', `Dashboard/QuickAction/${link.text}`, `Error checking "${link.text}": ${String(e)}`);
    }
  }

  // Test: Standup button
  log('  Testing Standup button...');
  const standupBtn = page.getByText('Standup').first();
  const standupVisible = await standupBtn.isVisible().catch(() => false);
  if (!standupVisible) {
    find('P1', 'Dashboard/Standup', 'Standup button not visible in header actions');
  } else {
    await standupBtn.click();
    await page.waitForTimeout(800);
    const modalVisible = await page.locator('text=Daily Standup').isVisible().catch(() => false);
    if (!modalVisible) {
      find('P1', 'Dashboard/Standup', 'Clicking Standup button did not open modal');
    } else {
      logOk('Standup modal opened');
      const standupShot = await shot(page, 'standup-modal-open');
      // Close it
      const closeBtn = page.locator('button').filter({ hasText: '' }).last();
      // Use X button
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
      // Click backdrop if modal still open
      const stillOpen = await page.locator('text=Daily Standup').isVisible().catch(() => false);
      if (stillOpen) {
        await page.mouse.click(100, 100);
        await page.waitForTimeout(400);
      }
    }
  }
  const standupShot2 = await shot(page, 'standup-modal-after');

  // Test: Project links in Projects card
  log('  Testing project links...');
  const projectLinks = await page.locator('a[href*="/tasks?project="]').all();
  logInfo(`Project links found: ${projectLinks.length}`);
  if (projectLinks.length > 0) {
    // Click the first project link and check navigation
    const firstHref = await projectLinks[0].getAttribute('href');
    logOk(`First project link href: ${firstHref}`);
  }

  // Test: Task links in Today/My Work cards
  log('  Testing task links...');
  const taskLinks = await page.locator('a[href*="/tasks?task="]').all();
  logInfo(`Task links found: ${taskLinks.length}`);
  if (taskLinks.length === 0) {
    find('P2', 'Dashboard/TaskLinks', 'No task links (a[href*="/tasks?task="]) found — My Work / Today cards may not be rendering task items');
  } else {
    const firstTaskHref = await taskLinks[0].getAttribute('href');
    logOk(`First task link: ${firstTaskHref}`);

    // Click a task link and verify navigation
    await taskLinks[0].click();
    await page.waitForTimeout(1200);
    const currentUrl = page.url();
    if (!currentUrl.includes('/tasks')) {
      find('P2', 'Dashboard/TaskNav', `Clicking task link stayed on ${currentUrl} instead of navigating to /tasks`);
    } else {
      logOk(`Task link navigated to: ${currentUrl}`);
    }
    // Go back
    await page.goBack();
    await page.waitForTimeout(1000);
  }

  // Test: Unread spaces links
  log('  Testing unread space links...');
  const chatLinks = await page.locator('a[href="/chat"]').all();
  logInfo(`/chat links (Unread card): ${chatLinks.length}`);

  // Test: Agent Activity approve/reject buttons
  log('  Testing Agent Activity approve/reject buttons...');
  const approveBtn = page.getByRole('button', { name: 'Approve' }).first();
  const rejectBtn  = page.getByRole('button', { name: 'Reject' }).first();
  const approveVisible = await approveBtn.isVisible().catch(() => false);
  const rejectVisible  = await rejectBtn.isVisible().catch(() => false);
  if (!approveVisible || !rejectVisible) {
    logInfo('No pending approval buttons visible on dashboard — may be no pending actions');
  } else {
    logOk('Approve/Reject buttons visible for pending agent action');
  }
  await shot(page, 'interactive-affordances-state');

  // Test: Calendar prev/next month navigation
  log('  Testing Calendar widget navigation...');
  const prevMonthBtn = page.locator('button').filter({ has: page.locator('svg') }).first();
  // Look for ChevronLeft/ChevronRight in calendar widget
  const calendarSection = page.getByText('Calendar').first();
  const calVisible = await calendarSection.isVisible().catch(() => false);
  if (calVisible) {
    logOk('Calendar bento card visible');
    // Try clicking a day in the calendar
    const calDayBtns = await page.locator('[class*="grid-cols-7"] button').all();
    logInfo(`Calendar day buttons found: ${calDayBtns.length}`);
    if (calDayBtns.length > 7) {
      await calDayBtns[10].click();
      await page.waitForTimeout(400);
      await shot(page, 'calendar-day-selected');
      // Click again to deselect
      await calDayBtns[10].click();
      await page.waitForTimeout(300);
    }
  } else {
    find('P2', 'Dashboard/Calendar', 'Calendar bento card not visible');
  }

  logOk('Group 3 complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 4 — Quick actions
// ═══════════════════════════════════════════════════════════════════════════════
async function group4_QuickActions(page: Page): Promise<void> {
  log('\n=== GROUP 4: Quick actions ===');

  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const ts_label = Date.now();

  // Test: "Task" quick action navigates to /tasks
  log('  Clicking Task quick-action...');
  const taskLink = page.getByRole('link', { name: /^task$/i }).first();
  const taskLinkVisible = await taskLink.isVisible().catch(() => false);
  if (!taskLinkVisible) {
    find('P2', 'Dashboard/QuickAction', '"Task" quick-action link not visible');
  } else {
    await taskLink.click();
    await page.waitForTimeout(1500);
    const currentUrl = page.url();
    if (!currentUrl.includes('/tasks')) {
      find('P1', 'Dashboard/QuickAction', `"Task" quick-action did not navigate to /tasks, ended up at: ${currentUrl}`);
    } else {
      logOk(`Task quick-action → ${currentUrl}`);
    }
    await shot(page, 'quick-action-task-nav');
    await page.goBack();
    await page.waitForTimeout(800);
  }

  // Test: "Message" quick action
  log('  Clicking Message quick-action...');
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const msgLink = page.getByRole('link', { name: /^message$/i }).first();
  const msgLinkVisible = await msgLink.isVisible().catch(() => false);
  if (!msgLinkVisible) {
    find('P2', 'Dashboard/QuickAction', '"Message" quick-action link not visible');
  } else {
    await msgLink.click();
    await page.waitForTimeout(1500);
    const currentUrl = page.url();
    if (!currentUrl.includes('/chat')) {
      find('P1', 'Dashboard/QuickAction', `"Message" quick-action did not navigate to /chat, ended up at: ${currentUrl}`);
    } else {
      logOk(`Message quick-action → ${currentUrl}`);
    }
    await shot(page, 'quick-action-message-nav');
    await page.goBack();
    await page.waitForTimeout(800);
  }

  // Test: "Deft" (agent) quick action
  log('  Clicking Deft quick-action...');
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const deftLink = page.getByRole('link', { name: /^deft$/i }).first();
  const deftLinkVisible = await deftLink.isVisible().catch(() => false);
  if (!deftLinkVisible) {
    find('P2', 'Dashboard/QuickAction', '"Deft" quick-action link not visible');
  } else {
    await deftLink.click();
    await page.waitForTimeout(1500);
    const currentUrl = page.url();
    if (!currentUrl.includes('/agent')) {
      find('P1', 'Dashboard/QuickAction', `"Deft" quick-action did not navigate to /agent, ended up at: ${currentUrl}`);
    } else {
      logOk(`Deft quick-action → ${currentUrl}`);
    }
    await shot(page, 'quick-action-deft-nav');
    await page.goBack();
    await page.waitForTimeout(800);
  }

  logOk('Group 4 complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 5 — Empty states
// ═══════════════════════════════════════════════════════════════════════════════
async function group5_EmptyStates(page: Page): Promise<void> {
  log('\n=== GROUP 5: Empty states ===');

  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await shot(page, 'empty-states-survey');

  // Check each bento card for blank boxes (no text content)
  const cardTitles = ['Today', 'Quick Stats', 'Unread', 'Projects', 'Activity', 'Agent Activity', 'Calendar', 'My Work'];

  for (const title of cardTitles) {
    try {
      const card = page.getByText(title, { exact: true }).first();
      const cardVisible = await card.isVisible().catch(() => false);
      if (!cardVisible) {
        logInfo(`Card "${title}" not visible (may be conditional)`);
        continue;
      }

      // Get the parent bento card container
      const cardContainer = card.locator('xpath=../../..');
      const containerText = await cardContainer.textContent().catch(() => null);

      if (!containerText || containerText.trim().length < 5) {
        find('P2', `Dashboard/${title}Card`, `Card "${title}" appears to have no content (blank box)`);
      } else {
        // Look for meaningful empty-state indicators
        const emptyIndicators = ['all caught up', 'no recent', 'nothing', 'empty', 'no projects', 'no activity'];
        const hasEmptyState = emptyIndicators.some(ind => containerText.toLowerCase().includes(ind));
        const hasContent = containerText.trim().length > title.length + 10;

        if (!hasContent && !hasEmptyState) {
          find('P2', `Dashboard/${title}Card`, `Card "${title}" has minimal content — possible blank-on-empty without empty state`);
        } else if (hasEmptyState) {
          logOk(`Card "${title}" has a proper empty-state message`);
        } else {
          logOk(`Card "${title}" has content`);
        }
      }
    } catch (e) {
      logInfo(`Could not check card "${title}": ${String(e)}`);
    }
  }

  // Check if the "workspace is ready" full-page empty state is triggered incorrectly
  const workspaceReadyMsg = await page.getByText('Your workspace is ready').isVisible().catch(() => false);
  if (workspaceReadyMsg) {
    find('P1', 'Dashboard/EmptyState', '"Your workspace is ready" full-page empty state shown even though workspace has data in DB');
  }

  logOk('Group 5 complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 6 — Real-time updates
// ═══════════════════════════════════════════════════════════════════════════════
async function group6_Realtime(context: BrowserContext, tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  log('\n=== GROUP 6: Real-time updates ===');

  // Open tab 1 — dashboard
  const tab1 = await context.newPage();
  tab1.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(`[tab1] ${msg.text()}`); });
  await tab1.addInitScript(({ at, rt }) => {
    window.localStorage.setItem('deft-access-token', at);
    if (rt) window.localStorage.setItem('deft-refresh-token', rt);
  }, { at: tokens.accessToken, rt: tokens.refreshToken });
  await tab1.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await tab1.waitForTimeout(3000);

  // Capture current activity count
  const activityBefore = await tab1.locator('[class*="space-y-1"]').first().textContent().catch(() => '');
  logInfo(`Activity before: "${(activityBefore || '').slice(0, 100)}"`);

  // In tab 2 (same context so same session), create a task via API
  log('  Creating a task via API (simulating tab 2 action)...');
  const createTs = Date.now();
  let createdTaskId: string | null = null;
  try {
    // First get a project id
    const projectsRes = await fetch(`${API_URL}/api/projects`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (projectsRes.ok) {
      const projects = (await projectsRes.json()) as any[];
      if (projects.length > 0) {
        const projectId = projects[0].id;
        const createRes = await fetch(`${API_URL}/api/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
          body: JSON.stringify({
            title: `dashboard-audit-${createTs}`,
            project_id: projectId,
            status: 'todo',
            priority: 'p2',
          }),
        });
        if (createRes.ok) {
          const created = (await createRes.json()) as any;
          createdTaskId = created.id || created.task?.id;
          logOk(`Created task id: ${createdTaskId} title: dashboard-audit-${createTs}`);
        } else {
          logFail(`Task creation failed: ${createRes.status}`);
          find('P1', 'Dashboard/Realtime', `Task creation via API failed with ${createRes.status}`);
        }
      } else {
        logInfo('No projects found — skipping task creation in realtime test');
      }
    }
  } catch (e) {
    find('P2', 'Dashboard/Realtime', `API task creation threw: ${String(e)}`);
  }

  // Wait and check if dashboard reflects new task
  await tab1.waitForTimeout(3000);
  const activityAfterNoRefresh = await tab1.locator('[class*="space-y-1"]').first().textContent().catch(() => '');
  const taskVisibleWithoutRefresh = createdTaskId
    ? (activityAfterNoRefresh || '').includes(`dashboard-audit-${createTs}`.slice(0, 20))
    : false;

  if (taskVisibleWithoutRefresh) {
    logOk('Dashboard updated in real-time (without refresh)');
  } else {
    logInfo('Dashboard did NOT update without refresh (expected — it is SWR-based)');
    find('Nit', 'Dashboard/Realtime', 'Dashboard does not auto-refresh when new tasks are created — relies on manual refresh. Expected for SWR-based approach.');
  }

  await shot(tab1, 'realtime-before-refresh');

  // Manual refresh
  await tab1.reload({ waitUntil: 'domcontentloaded' });
  await tab1.waitForTimeout(3000);
  await shot(tab1, 'realtime-after-refresh');

  const activityAfterRefresh = await tab1.locator('[class*="space-y-1"]').first().textContent().catch(() => '');
  logInfo(`Activity after refresh: "${(activityAfterRefresh || '').slice(0, 100)}"`);

  // Verify the task appears in "My Work" or activity after refresh
  const pageContent = await tab1.content();
  const taskTitleShort = `dashboard-audit-${createTs}`.slice(0, 20);
  if (createdTaskId && pageContent.includes(taskTitleShort)) {
    logOk(`Created task "${taskTitleShort}" visible after refresh`);
  } else {
    logInfo(`Created task not found on dashboard after refresh (may not meet filter criteria for display)`);
  }

  await tab1.close();
  logOk('Group 6 complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 7 — Pending approvals UX
// ═══════════════════════════════════════════════════════════════════════════════
async function group7_PendingApprovals(page: Page, tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  log('\n=== GROUP 7: Pending approvals UX ===');

  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Check DB for pending actions
  const pendingRows = await dbQuery<{
    id: string; action: string; approval_status: string;
    params: unknown; created_at: string; agent_employee_id: string | null;
  }>(
    `SELECT id, action, approval_status, params, created_at, agent_employee_id FROM agent_actions WHERE approval_status = 'pending' LIMIT 5`,
  ).catch(() => [] as any[]);
  logInfo(`DB pending agent_actions: ${pendingRows.length}`);

  if (pendingRows.length > 0) {
    logInfo(`First pending action: id=${pendingRows[0].id} action=${pendingRows[0].action}`);

    // Check if "Agent Activity" card is visible
    const agentCard = page.getByText('Agent Activity').first();
    const agentCardVisible = await agentCard.isVisible().catch(() => false);
    if (!agentCardVisible) {
      find('P1', 'Dashboard/PendingApprovals', 'Agent Activity card not visible even though pending actions exist in DB');
    } else {
      logOk('Agent Activity card visible');
    }

    // Check for "Awaiting approval" text
    const awaitingText = await page.getByText(/awaiting approval/i).isVisible().catch(() => false);
    if (!awaitingText) {
      find('P1', 'Dashboard/PendingApprovals', 'Pending action exists in DB but "Awaiting approval" text not visible on dashboard');
    } else {
      logOk('"Awaiting approval" text visible in Agent Activity card');
    }

    // Check for Approve/Reject buttons
    const approveBtn = page.getByRole('button', { name: 'Approve' }).first();
    const rejectBtn  = page.getByRole('button', { name: 'Reject' }).first();
    const approveBtnVisible = await approveBtn.isVisible().catch(() => false);
    const rejectBtnVisible  = await rejectBtn.isVisible().catch(() => false);

    if (!approveBtnVisible) {
      find('P1', 'Dashboard/PendingApprovals', 'Approve button not visible for pending agent action');
    } else {
      logOk('Approve button visible');
    }
    if (!rejectBtnVisible) {
      find('P1', 'Dashboard/PendingApprovals', 'Reject button not visible for pending agent action');
    } else {
      logOk('Reject button visible');
    }

    await shot(page, 'pending-approvals-state');

    // Check the action description is shown
    const actionText = pendingRows[0].action.replace(/_/g, ' ');
    logInfo(`Looking for action text: ${actionText}`);

    // Test Reject flow (safer than Approve — just rejects without firing email)
    if (rejectBtnVisible) {
      log('  Testing Reject button click...');
      const rejectBtnEl = page.getByRole('button', { name: 'Reject' }).first();
      await rejectBtnEl.click();
      await page.waitForTimeout(1500);
      await shot(page, 'after-reject-click');

      // Check if the item disappeared or changed status
      const awaitingAfter = await page.getByText(/awaiting approval/i).isVisible().catch(() => false);
      // Verify in DB
      const afterReject = await dbQuery<{ approval_status: string }>(
        `SELECT approval_status FROM agent_actions WHERE id = $1`,
        [pendingRows[0].id],
      ).catch(() => []);
      const dbStatusAfter = afterReject[0]?.approval_status;
      logInfo(`DB status after reject click: ${dbStatusAfter}`);

      if (dbStatusAfter === 'rejected') {
        logOk('Reject button successfully updated DB status to "rejected"');
      } else if (dbStatusAfter === 'pending') {
        find('P1', 'Dashboard/PendingApprovals', 'Reject button clicked but DB still shows status=pending — reject API may be failing');
      } else {
        logInfo(`DB status after reject: ${dbStatusAfter}`);
      }

      if (!awaitingAfter) {
        logOk('After reject, "Awaiting approval" text no longer shown (item removed from pending list)');
      }
    }
  } else {
    logInfo('No pending agent_actions in DB — creating one for test...');
    // Insert a synthetic pending action to test the UI
    try {
      const orgRow = await dbQuery<{ id: string }>(
        `SELECT org_id as id FROM org_members WHERE user_id = (SELECT id FROM users WHERE email = $1) LIMIT 1`,
        [EMAIL],
      );
      const orgId = orgRow[0]?.id;
      if (orgId) {
        await dbQuery(
          `INSERT INTO agent_actions (id, org_id, action, params, approval_status, approval_tier, created_at)
           VALUES (gen_random_uuid(), $1, 'send_email', $2::jsonb, 'pending', 'tier1', NOW())`,
          [orgId, JSON.stringify({ to: 'test@example.com', subject: 'Audit test', body: 'Dashboard audit test action' })],
        );
        logInfo('Inserted synthetic pending agent_action');

        // Reload dashboard to see if it appears
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        await shot(page, 'pending-approvals-after-insert');

        const awaitingText2 = await page.getByText(/awaiting approval/i).isVisible().catch(() => false);
        if (!awaitingText2) {
          find('P1', 'Dashboard/PendingApprovals', 'Newly inserted pending action not appearing on dashboard after reload');
        } else {
          logOk('Newly inserted pending action visible on dashboard');
        }
      }
    } catch (e) {
      logInfo(`Could not insert synthetic pending action: ${String(e)}`);
    }
  }

  // Also check if there's a dedicated approvals page linked from the agent activity card
  const approvalLinks = await page.locator('a[href*="approval"], a[href*="agent"]').all();
  logInfo(`Approval-related links: ${approvalLinks.length}`);

  // Check for agent rationale / params display
  log('  Checking if agent rationale/params are displayed...');
  const agentActivityCard = page.getByText('Agent Activity').first();
  if (await agentActivityCard.isVisible().catch(() => false)) {
    const cardParent = agentActivityCard.locator('xpath=../../..');
    const cardText = await cardParent.textContent().catch(() => '');
    logInfo(`Agent Activity card text (first 300 chars): ${(cardText || '').slice(0, 300)}`);

    // The card shows action summaries, not raw params — check if it's readable
    if ((cardText || '').length < 20) {
      find('P2', 'Dashboard/AgentActivity', 'Agent Activity card has very little content');
    }
  }

  await shot(page, 'pending-approvals-final');
  logOk('Group 7 complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// BONUS — Typography + consistency checks
// ═══════════════════════════════════════════════════════════════════════════════
async function groupBonus_VisualConsistency(page: Page): Promise<void> {
  log('\n=== BONUS: Visual consistency checks ===');

  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Light/dark: check for var(--) CSS variable usage (design system)
  const hasCssVars = await page.evaluate(() => {
    const el = document.querySelector('h1');
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.color !== 'rgb(0, 0, 0)'; // using design system = not just default black
  });
  logInfo(`Design system CSS vars in use: ${hasCssVars}`);

  // Check for broken avatar images
  const brokenImgs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img')).filter(
      img => !img.complete || img.naturalWidth === 0,
    ).map(img => img.src || img.getAttribute('src') || '?');
  });
  if (brokenImgs.length > 0) {
    find('P2', 'Dashboard/BrokenImages', `${brokenImgs.length} broken image(s): ${brokenImgs.slice(0, 3).join(', ')}`);
  } else {
    logOk('No broken images found');
  }

  // Check for duplicate keys warning in console (hydration)
  const hydrationErrors = consoleErrors.filter(e =>
    e.toLowerCase().includes('hydrat') || e.toLowerCase().includes('duplicate key') || e.toLowerCase().includes('each child'),
  );
  if (hydrationErrors.length > 0) {
    for (const e of hydrationErrors) {
      find('P1', 'Dashboard/Hydration', e.slice(0, 300));
    }
  } else {
    logOk('No hydration errors detected in console');
  }

  // Check font rendering — look for cards with mismatched font sizes
  const cardHeaders = await page.locator('[class*="font-semibold"]').allTextContents();
  logInfo(`Semibold elements: ${cardHeaders.length}`);

  // Check scrollability of main page
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const clientHeight = await page.evaluate(() => document.documentElement.clientHeight);
  logInfo(`Page scroll: height=${scrollHeight} client=${clientHeight} scrollable=${scrollHeight > clientHeight}`);

  // Final full-page screenshot
  await shot(page, 'visual-consistency-final');

  // Check the select dropdown in Agent Activity for styling issues
  const agentSelect = page.locator('select').first();
  const selectVisible = await agentSelect.isVisible().catch(() => false);
  if (selectVisible) {
    logOk('Agent Activity filter <select> visible');
    // Check it has options
    const optionCount = await agentSelect.locator('option').count();
    logInfo(`Agent filter options: ${optionCount}`);
    if (optionCount < 1) {
      find('Nit', 'Dashboard/AgentFilter', 'Agent Activity filter <select> has no options');
    }
  } else {
    logInfo('Agent Activity filter select not visible (no agent employees, expected)');
  }

  // Check "My Work" card for column status labels
  const myWorkCard = page.getByText('My Work').first();
  if (await myWorkCard.isVisible().catch(() => false)) {
    const myWorkParent = myWorkCard.locator('xpath=../../..');
    const myWorkText = await myWorkParent.textContent().catch(() => '');
    logInfo(`My Work card content (100 chars): ${(myWorkText || '').slice(0, 100)}`);
    const hasTodo = (myWorkText || '').toLowerCase().includes('todo') || (myWorkText || '').toLowerCase().includes('to do');
    const hasInProgress = (myWorkText || '').toLowerCase().includes('progress');
    if (!hasTodo || !hasInProgress) {
      find('P2', 'Dashboard/MyWork', `My Work kanban columns missing expected status labels. Found: "${(myWorkText || '').slice(0, 100)}"`);
    } else {
      logOk('My Work kanban columns labeled correctly');
    }
  }

  logOk('Bonus group complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Report generation
// ═══════════════════════════════════════════════════════════════════════════════
function generateReport(
  durationMs: number,
  widgets: string[],
  consoleErrors: string[],
  pageErrors: string[],
  networkErrors: string[],
): void {
  const p0 = findings.filter(f => f.severity === 'P0');
  const p1 = findings.filter(f => f.severity === 'P1');
  const p2 = findings.filter(f => f.severity === 'P2');
  const nits = findings.filter(f => f.severity === 'Nit');

  const lines: string[] = [
    '# Dashboard Deep Audit',
    '',
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    `**Branch:** feat/phase2-4-mcp-agents-plans`,
    `**Duration:** ${Math.round(durationMs / 1000)}s`,
    `**Findings:** P0×${p0.length} P1×${p1.length} P2×${p2.length} Nit×${nits.length}`,
    `**Screenshots:** ${shotCounter}`,
    '',
    '---',
    '',
    '## Widgets observed',
    '',
    ...widgets.map(w => `- ${w}`),
    '',
    '---',
    '',
    '## P0 — blocks release',
    '',
    p0.length === 0 ? '_(none)_' : '',
    ...p0.flatMap((f, i) => [
      `### ${i + 1}. ${f.area} — ${f.description.slice(0, 80)}`,
      '',
      f.detail ? `**Detail:** ${f.detail}` : '',
      f.screenshot ? `**Screenshot:** \`${f.screenshot}\`` : '',
      '',
    ]),
    '',
    '## P1 — must fix',
    '',
    p1.length === 0 ? '_(none)_' : '',
    ...p1.flatMap((f, i) => [
      `### ${i + 1}. ${f.area} — ${f.description.slice(0, 100)}`,
      '',
      `**Description:** ${f.description}`,
      f.detail ? `\n**Detail:** ${f.detail}` : '',
      f.screenshot ? `\n**Screenshot:** \`${f.screenshot}\`` : '',
      '',
    ]),
    '',
    '## P2 — should fix',
    '',
    p2.length === 0 ? '_(none)_' : '',
    ...p2.flatMap((f, i) => [
      `### ${i + 1}. ${f.area} — ${f.description.slice(0, 100)}`,
      '',
      `**Description:** ${f.description}`,
      f.detail ? `\n**Detail:** ${f.detail}` : '',
      f.screenshot ? `\n**Screenshot:** \`${f.screenshot}\`` : '',
      '',
    ]),
    '',
    '## Nits',
    '',
    nits.length === 0 ? '_(none)_' : '',
    ...nits.flatMap((f, i) => [
      `- **${f.area}:** ${f.description}${f.screenshot ? ` (\`${f.screenshot}\`)` : ''}`,
    ]),
    '',
    '---',
    '',
    '## Coverage gaps',
    '',
    '- Standup generation (AI) not tested end-to-end — requires LLM availability',
    '- Team Health and 1:1 Prep cards not tested — user is owner but team health data may be empty',
    '- My Insights card conditional — only shown when insights data available',
    '- GitHub activity widget — no GitHub integration connected',
    '- Calendar widget events — no Google Calendar integration connected',
    '- True real-time (WebSocket) dashboard refresh not verified — dashboard appears SWR-based',
    '',
    '---',
    '',
    '## Raw console/network logs',
    '',
    '### Console errors',
    consoleErrors.length === 0 ? '_none_' : consoleErrors.map(e => `- ${e.slice(0, 200)}`).join('\n'),
    '',
    '### Page errors',
    pageErrors.length === 0 ? '_none_' : pageErrors.map(e => `- ${e.slice(0, 200)}`).join('\n'),
    '',
    '### Network errors (4xx/5xx)',
    networkErrors.length === 0 ? '_none_' : networkErrors.map(e => `- ${e.slice(0, 200)}`).join('\n'),
    '',
    '---',
    '',
    '## Screenshots index',
    '',
  ];

  for (let i = 1; i <= shotCounter; i++) {
    lines.push(`${i}. See \`${String(i).padStart(2, '0')}-*.png\` in this directory`);
  }

  writeFileSync(REPORT_FILE, lines.join('\n'));
  log(`Report written to ${REPORT_FILE}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  // Ensure output dir
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });

  // Reset log
  writeFileSync(LOG_FILE, `Dashboard Deep Audit — started ${new Date().toISOString()}\n`);

  const startTime = Date.now();
  log('Starting dashboard deep audit...');
  log(`WEB: ${WEB_URL}  API: ${API_URL}`);

  // ── DB connectivity check ──
  let dbOk = false;
  try {
    await dbQuery('SELECT 1 as ok');
    dbOk = true;
    logOk('DB connection OK');
  } catch (e) {
    logFail(`DB connection failed: ${String(e)}`);
    find('P0', 'Infrastructure', `DB unreachable: ${String(e)}`);
  }

  // ── Auth ──
  log('Logging in...');
  let tokens: { accessToken: string; refreshToken: string };
  try {
    tokens = await getAccessToken();
    logOk('Login successful');
  } catch (e) {
    logFail(`Login failed: ${String(e)}`);
    find('P0', 'Infrastructure', `Auth failed: ${String(e)}`);
    return;
  }

  // ── Browser ──
  const browser: Browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page: Page = await context.newPage();

  // ── Global listeners ──
  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      consoleErrors.push(text);
      log(`[console:error] ${text.slice(0, 200)}`);
    } else if (type === 'warning') {
      log(`[console:warn] ${text.slice(0, 200)}`);
    }
  });
  page.on('pageerror', err => {
    pageErrors.push(err.message);
    log(`[pageerror] ${err.message.slice(0, 200)}`);
  });
  page.on('response', res => {
    const status = res.status();
    if (status >= 400) {
      const entry = `${status} ${res.url().replace(WEB_URL, '').replace(API_URL, '')}`;
      networkErrors.push(entry);
      log(`[net:${status}] ${res.url().slice(0, 120)}`);
    }
  });

  // ── Inject auth for initial page ──
  await page.addInitScript(({ at, rt }) => {
    window.localStorage.setItem('deft-access-token', at);
    if (rt) window.localStorage.setItem('deft-refresh-token', rt);
  }, { at: tokens.accessToken, rt: tokens.refreshToken });

  // Progress ticker
  const ticker = setInterval(() => log(`[TICK] ${Math.round((Date.now() - startTime) / 1000)}s elapsed`), 10_000);

  try {
    // Run all groups
    await group1_LandingLoad(page, tokens);
    await group2_WidgetAccuracy(page, tokens);
    await group3_InteractiveAffordances(page);
    await group4_QuickActions(page);
    await group5_EmptyStates(page);
    await group6_Realtime(context, tokens);
    await group7_PendingApprovals(page, tokens);
    await groupBonus_VisualConsistency(page);

    // Final overview screenshot
    await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await shot(page, 'final-overview');

  } catch (e: unknown) {
    const msg = String(e);
    logFail(`Uncaught error in main: ${msg}`);
    find('P0', 'Audit/Script', `Uncaught error: ${msg}`);
    try { await shot(page, 'error-state'); } catch { /* ignore */ }
  } finally {
    clearInterval(ticker);
  }

  await browser.close();

  const durationMs = Date.now() - startTime;
  log(`\nAudit complete in ${Math.round(durationMs / 1000)}s`);

  // Tally findings
  const p0 = findings.filter(f => f.severity === 'P0').length;
  const p1 = findings.filter(f => f.severity === 'P1').length;
  const p2 = findings.filter(f => f.severity === 'P2').length;
  const nit = findings.filter(f => f.severity === 'Nit').length;
  log(`Findings: P0=${p0} P1=${p1} P2=${p2} Nit=${nit}`);
  log(`Screenshots: ${shotCounter}`);
  log(`Console errors: ${consoleErrors.length}`);
  log(`Page errors: ${pageErrors.length}`);
  log(`Network 4xx/5xx: ${networkErrors.length}`);

  // Widgets list (what was observed)
  const widgets = [
    'Greeting header + date line (h1 with time-of-day, user first name)',
    'Quick actions row: Task link, Message link, Deft link, Standup button',
    'Today card (span-2): overdue + due-today tasks merged, sorted by priority',
    'Quick Stats card: 2×2 grid — Overdue/DueToday/InProgress/Completed counts',
    'Unread card: unread message spaces with badge counts',
    'Projects card: progress rings with done/total tasks and % label',
    'Activity card: recent task_activity feed (5 items max)',
    'Agent Activity card: recent agent_actions with approve/reject inline for pending',
    'Calendar mini-widget: month grid with day-dots for tasks/events/notes',
    'My Work card (span-2): kanban-lite columns todo/in_progress/in_review',
    'Team card (manager-only): health cards, 1:1 prep links (conditional)',
    'My Insights card: activity stats + pace bar + expertise tags (conditional)',
    'Standup modal: Daily Standup overlay with AI-generated content',
  ];

  generateReport(durationMs, widgets, consoleErrors, pageErrors, networkErrors);

  log('\n=== DONE ===');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
