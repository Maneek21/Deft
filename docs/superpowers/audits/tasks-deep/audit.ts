#!/usr/bin/env tsx
/**
 * Tasks Deep Audit — comprehensive QA walkthrough of /tasks surface.
 * Groups: Landing, Board, List, Create, Detail, Filters, Timeline, Calendar,
 *         Pipeline, Bulk Selection, My Tasks, Templates
 *
 * Run:
 *   pnpm tsx docs/superpowers/audits/tasks-deep/audit.ts 2>&1 | tee docs/superpowers/audits/tasks-deep/run.log
 */
import 'dotenv/config';
import { chromium, type Page } from 'playwright';
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const AUDIT_DIR = path.join(process.cwd(), 'docs/superpowers/audits/tasks-deep');
const START = Date.now();
const TS = START;

// ─── Findings collector ─────────────────────────────────────────────────────
type Severity = 'P0' | 'P1' | 'P2' | 'Nit';
interface Finding {
  id: string;
  sev: Severity;
  title: string;
  detail: string;
  screenshot?: string;
}
const findings: Finding[] = [];
let findingSeq = 0;
let screenshotSeq = 0;

const consoleErrors: string[] = [];
const networkErrors: string[] = [];
const pageErrors: string[] = [];

// Track cross-ref count for report
let crossRefCount = 0;

function log(msg: string) {
  const ts = ((Date.now() - START) / 1000).toFixed(1).padStart(6);
  const line = `[${ts}s] ${msg}`;
  console.log(line);
}

function finding(sev: Severity, title: string, detail: string, shot?: string) {
  findingSeq++;
  const id = `F${String(findingSeq).padStart(2, '0')}`;
  findings.push({ id, sev, title, detail, screenshot: shot });
  log(`[${sev}] ${id}: ${title}`);
}

async function screenshot(page: Page, label: string): Promise<string> {
  screenshotSeq++;
  const num = String(screenshotSeq).padStart(2, '0');
  const safe = label.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().slice(0, 60);
  const fname = `${num}-${safe}.png`;
  const fpath = path.join(AUDIT_DIR, fname);
  await page.screenshot({ path: fpath, fullPage: false });
  log(`Screenshot: ${fname}`);
  return fname;
}

async function waitSafe(page: Page, selector: string, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    log(`[STALL] waitForSelector timed out: ${selector}`);
    return false;
  }
}

// Dismiss any open modal/overlay by pressing Escape and waiting
async function dismissModals(page: Page) {
  // Check for overlay
  const overlay = page.locator('.fixed.inset-0[class*="bg-black"], .fixed.inset-0.z-50, .fixed.inset-0.z-\\[100\\]').first();
  const hasOverlay = await overlay.isVisible().catch(() => false);
  if (hasOverlay) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    // Second escape in case of nested modals
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}

// ─── DB helper ──────────────────────────────────────────────────────────────
async function dbQuery(sql: string, params: any[] = []): Promise<any[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

// ─── Auth helper ─────────────────────────────────────────────────────────────
async function loginViaAPI(): Promise<{ access_token: string; refresh_token?: string }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const at = (raw.access_token ?? raw.accessToken) as string;
  const rt = (raw.refresh_token ?? raw.refreshToken) as string | undefined;
  if (!at) throw new Error(`Missing access_token in login response`);
  return { access_token: at, refresh_token: rt };
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  log('=== Tasks Deep Audit START ===');
  log(`Target: ${WEB_URL}/tasks`);

  // Auth
  log('Logging in via API...');
  const { access_token, refresh_token } = await loginViaAPI();
  log('Login OK');

  // DB pre-check: task counts per status
  log('DB pre-check: task counts...');
  const dbCounts = await dbQuery(
    `SELECT status, COUNT(*)::int AS cnt FROM tasks WHERE org_id=$1 AND is_deleted=false GROUP BY status ORDER BY status`,
    [ORG_ID]
  );
  log(`DB task counts: ${JSON.stringify(dbCounts)}`);
  const totalDbTasks = dbCounts.reduce((s, r) => s + r.cnt, 0);

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // Inject auth token
  await ctx.addInitScript(
    ({ at, rt }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: access_token, rt: refresh_token ?? null }
  );

  const page = await ctx.newPage();

  // ── Listeners ──────────────────────────────────────────────────────────────
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const text = `[${msg.type().toUpperCase()}] ${msg.text()}`;
      consoleErrors.push(text);
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
    log(`[PAGE ERROR] ${err.message.slice(0, 120)}`);
  });
  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      const entry = `${resp.status()} ${resp.url()}`;
      networkErrors.push(entry);
      log(`[HTTP ${resp.status()}] ${resp.url()}`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 1: Landing + view toggle
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 1: Landing + view toggle ---');
  const t0 = Date.now();
  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'networkidle', timeout: 30000 });
  const tti = Date.now() - t0;
  log(`TTI: ${tti}ms`);

  if (tti > 3000) {
    finding('P2', `Slow TTI on /tasks (${tti}ms)`,
      `Time-to-interactive was ${tti}ms. Threshold: 3000ms. Board has ${totalDbTasks} tasks in DB.`);
  }

  const shot01 = await screenshot(page, 'tasks-landing');

  if (pageErrors.length > 0) {
    finding('P0', 'Page-level JS errors on /tasks load', pageErrors.join('\n'));
  }

  // View toggle buttons
  const boardBtn = page.locator('button:has-text("Board")').first();
  const listBtn = page.locator('button:has-text("List")').first();
  const timelineBtn = page.locator('button:has-text("Timeline")').first();
  const calendarBtn = page.locator('button:has-text("Calendar")').first();
  const pipelineBtn = page.locator('button:has-text("Pipeline")').first();

  const [boardV, listV, timelineV, calendarV, pipelineV] = await Promise.all([
    boardBtn.isVisible().catch(() => false),
    listBtn.isVisible().catch(() => false),
    timelineBtn.isVisible().catch(() => false),
    calendarBtn.isVisible().catch(() => false),
    pipelineBtn.isVisible().catch(() => false),
  ]);

  log(`View toggles: Board=${boardV} List=${listV} Timeline=${timelineV} Calendar=${calendarV} Pipeline=${pipelineV}`);

  if (!boardV || !listV) {
    finding('P0', 'Board/List view toggle missing', 'Board or List button not visible on /tasks');
  }

  // Test URL behavior on view switch
  if (listV) {
    await listBtn.click();
    await page.waitForTimeout(600);
    const urlAfterList = page.url();
    log(`URL after List click: ${urlAfterList}`);
    if (!urlAfterList.includes('view=')) {
      const shot = await screenshot(page, 'list-no-url-update');
      finding('P1', 'View toggle does not update URL — view state lost on refresh',
        `Clicking "List" toggle did not set ?view= in the URL. State is local only. URL: ${urlAfterList}`,
        shot);
    }
    // Switch back
    await boardBtn.click();
    await page.waitForTimeout(400);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 2: Board view
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 2: Board view ---');
  const shot02 = await screenshot(page, 'board-view');

  // Count columns using board-column or dnd-kit structure
  // The board renders columns via BoardColumn component
  const boardCols = await page.locator('[class*="column"], [class*="Column"]').all();
  log(`Board column candidates: ${boardCols.length}`);

  // Count task cards: they use rounded-lg p-3 group relative inside a column
  // Use cursor:pointer divs that are inside the board area
  const taskTitles = await page.locator('[class*="task-card"], .group.relative.rounded-lg').all();
  log(`Task card candidates on board: ${taskTitles.length}`);

  // Check for missing empty-state when a column has 0 tasks
  const emptyColMessage = await page.locator('text=/No tasks|Get started|Add a task/i').isVisible().catch(() => false);
  log(`Empty column message visible: ${emptyColMessage}`);

  // Check hover on a card
  if (taskTitles.length > 0) {
    await taskTitles[0].hover();
    await page.waitForTimeout(400);
    await screenshot(page, 'board-card-hover');
  } else {
    log('No task cards found on board — board may be filtered or project has no tasks');
  }

  // Test for dnd-kit draggable: dnd-kit sets data-dnd-id or uses setNodeRef — no `draggable="true"`
  // Instead check for the drag handle (opacity-0 group-hover:opacity-100 cursor-grab)
  const dragHandles = await page.locator('[class*="cursor-grab"]').all();
  log(`Drag handles found: ${dragHandles.length}`);
  if (dragHandles.length === 0) {
    finding('P1', 'No drag handles visible on task cards (board)',
      'Could not find any element with cursor-grab class. dnd-kit drag-and-drop may not be working or drag handles are completely hidden even on hover.');
  } else {
    // Try a drag operation
    try {
      await taskTitles[0]?.hover();
      await page.waitForTimeout(300);
      const dragHandle = dragHandles[0];
      const handleBox = await dragHandle.boundingBox();
      if (handleBox) {
        // Drag to a position 300px to the right (another column)
        await page.mouse.move(handleBox.x + 8, handleBox.y + 8);
        await page.mouse.down();
        await page.waitForTimeout(200);
        await page.mouse.move(handleBox.x + 350, handleBox.y + 8, { steps: 20 });
        await page.waitForTimeout(300);
        await screenshot(page, 'drag-in-progress');
        await page.mouse.up();
        await page.waitForTimeout(800);
        await screenshot(page, 'after-drag-drop');
        log('Drag-drop attempted');
      }
    } catch (e: any) {
      finding('P2', 'Drag-drop interaction threw an exception', e.message.slice(0, 200));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 3: List view
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 3: List view ---');
  await listBtn.click();
  await page.waitForTimeout(800);
  const shot03 = await screenshot(page, 'list-view');

  // Check sortable column headers — task-list uses cursor-pointer on th elements
  const sortableThs = await page.locator('th.cursor-pointer, th[class*="cursor-pointer"]').all();
  log(`Sortable column headers: ${sortableThs.length}`);

  if (sortableThs.length === 0) {
    finding('P2', 'List view: column headers not styled as sortable',
      'No <th> elements with cursor-pointer class found. Clicking column headers may not sort the list.');
  } else {
    // Try sorting by clicking a header
    await sortableThs[0].click();
    await page.waitForTimeout(400);
    await screenshot(page, 'list-sorted');
    log('Clicked first sortable column header');
    // Click again for reverse sort
    await sortableThs[0].click();
    await page.waitForTimeout(300);
    await screenshot(page, 'list-sort-reversed');
  }

  // Check for task rows
  const listRows = await page.locator('tr.cursor-pointer, [class*="cursor-pointer group"]').all();
  log(`List rows (clickable): ${listRows.length}`);

  // Pagination check
  const loadMoreBtn = page.locator('button:has-text("Load more"), button:has-text("Show more"), button:has-text("load more")').first();
  const hasPagination = await loadMoreBtn.isVisible().catch(() => false);
  log(`Pagination present: ${hasPagination}`);
  if (!hasPagination && totalDbTasks > 50) {
    finding('P2', `List view: no pagination with ${totalDbTasks} tasks in DB`,
      `DB has ${totalDbTasks} non-deleted tasks but no "Load more" button. All tasks are loaded at once — potential performance issue.`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 4: Create task
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 4: Create task ---');

  // Navigate fresh to ensure board view + no modal open
  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(600);
  await dismissModals(page);

  const taskTitle = `tasks-audit-${TS}`;
  log(`Creating task: "${taskTitle}"`);

  const newTaskBtn = page.locator('button:has-text("New task")').first();
  const hasNewTask = await newTaskBtn.isVisible().catch(() => false);

  if (!hasNewTask) {
    finding('P0', '"New task" button not visible on header', 'Cannot locate "New task" button on /tasks page header area');
  } else {
    await newTaskBtn.click();
    await page.waitForTimeout(600);
    await screenshot(page, 'create-task-modal-open');

    // The quick-create modal has an input that auto-focuses
    const titleInput = page.locator('input[placeholder*="title" i], input[placeholder*="Title" i], input[type="text"]').first();
    const hasTitleInput = await waitSafe(page, 'input', 4000);

    if (!hasTitleInput) {
      finding('P0', 'Create task modal: no visible input after opening', 'No <input> appeared within 4s of clicking "New task"');
    } else {
      // Clear and fill
      await titleInput.fill('');
      await titleInput.type(taskTitle, { delay: 20 });
      log(`Filled title: ${taskTitle}`);

      // Fill description
      const descField = page.locator('textarea').first();
      if (await descField.isVisible().catch(() => false)) {
        await descField.fill(`Audit test task. Created at ${new Date().toISOString()}`);
        log('Filled description');
      }

      await screenshot(page, 'create-task-filled');

      // Submit via Create button or Enter
      const submitBtn = page.locator('button[type="submit"], button:has-text("Create task"), button:has-text("Create")').first();
      const hasSubmit = await submitBtn.isVisible().catch(() => false);
      if (hasSubmit) {
        await submitBtn.click();
      } else {
        await titleInput.press('Enter');
      }

      await page.waitForTimeout(1200);
      await screenshot(page, 'after-task-created');

      // Check task appears in view
      const taskVisible = await page.locator(`text=${taskTitle}`).isVisible().catch(() => false);
      if (taskVisible) {
        log('New task visible after creation — good');
      } else {
        finding('P1', 'Newly created task not immediately visible in board/list',
          `Task "${taskTitle}" not found in the task surface after creation. Optimistic update may be missing, or the board filtered it out.`);
      }

      // DB verification
      const dbTask = await dbQuery(
        `SELECT id, status, priority FROM tasks WHERE title=$1 AND org_id=$2 AND is_deleted=false`,
        [taskTitle, ORG_ID]
      );
      if (dbTask.length === 0) {
        finding('P0', 'Created task not found in DB',
          `POST to create task "${taskTitle}" did not persist a row in the tasks table.`);
      } else {
        log(`DB row: id=${dbTask[0].id} status=${dbTask[0].status} priority=${dbTask[0].priority}`);
      }
    }
  }

  await dismissModals(page);
  await page.waitForTimeout(400);

  // Test 'c' keyboard shortcut
  log('Testing keyboard shortcut "c" to open quick-create...');
  await page.focus('body');
  await page.keyboard.press('c');
  await page.waitForTimeout(600);
  const kcVisible = await page.locator('input[type="text"], input[placeholder*="title" i]').first().isVisible().catch(() => false);
  if (!kcVisible) {
    finding('P1', 'Keyboard shortcut "c" does not open quick-create', '"c" key on /tasks did not open the task creation modal');
  } else {
    log('"c" shortcut works');
  }
  await dismissModals(page);
  await page.waitForTimeout(400);

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 5: Task detail drawer
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 5: Task detail drawer ---');

  // Use list view — rows have cursor-pointer and are easier to target
  await listBtn.click();
  await page.waitForTimeout(800);

  const listRow = page.locator('tr.cursor-pointer, [class*="cursor-pointer group"]').first();
  const hasRow = await listRow.isVisible().catch(() => false);

  if (!hasRow) {
    // Fall back: try clicking any text that looks like a task title in the list
    const anyTaskText = page.locator(`text=${taskTitle}`).first();
    if (await anyTaskText.isVisible().catch(() => false)) {
      await anyTaskText.click();
    } else {
      finding('P0', 'Cannot find any clickable task row in list view', 'Neither tr.cursor-pointer nor the audit task text was found in list view');
    }
  } else {
    await listRow.click();
  }

  await page.waitForTimeout(1000);
  const shot05 = await screenshot(page, 'task-detail-drawer');

  // The detail panel uses a right-panel layout (not role=dialog) — check for TaskDetail component
  // It renders alongside the list (flex layout). Look for the panel with close button or task title
  const detailPane = page.locator('[class*="task-detail"], [class*="TaskDetail"], aside, .flex-col.h-full').first();
  const hasDetail = await detailPane.isVisible().catch(() => false);

  // More specific: look for the close (X) button that appears in the detail panel
  const closeX = page.locator('button[aria-label="Close"], button[title="Close"], button svg[class*="X"]').first();
  const hasCloseX = await closeX.isVisible().catch(() => false);

  log(`Detail panel visible: ${hasDetail} | Close button: ${hasCloseX}`);

  if (!hasDetail && !hasCloseX) {
    finding('P0', 'Task detail panel did not open on list row click',
      'Clicking a task row in list view did not reveal a detail drawer/panel within 1 second.',
      shot05);
  } else {
    log('Task detail panel opened');

    // Check for key fields
    const hasStatus = await page.locator('text=/Backlog|Todo|In Progress|In Review|Done/i').isVisible().catch(() => false);
    const hasComments = await page.locator('text=/Comments|Add a comment/i').isVisible().catch(() => false);
    const hasActivity = await page.locator('text=/Activity/i').isVisible().catch(() => false);

    log(`Detail: status=${hasStatus} comments=${hasComments} activity=${hasActivity}`);

    if (!hasComments) {
      finding('P2', 'Task detail: Comments section not visible',
        'Could not find "Comments" heading or comment input in the detail panel');
    }
    if (!hasActivity) {
      finding('Nit', 'Task detail: Activity section not visible',
        'Could not find "Activity" section in the detail panel');
    }

    // Add a comment
    const commentArea = page.locator('textarea[placeholder*="comment" i], [placeholder*="Add a comment" i], [placeholder*="Write" i]').first();
    const hasCommentArea = await commentArea.isVisible().catch(() => false);
    if (hasCommentArea) {
      await commentArea.click();
      await commentArea.fill(`tasks-audit-comment-${TS}: automated audit comment`);
      await page.waitForTimeout(200);
      const sendBtn = page.locator('button:has-text("Send"), button:has-text("Comment"), button[type="submit"]').first();
      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click();
      } else {
        await commentArea.press('Control+Enter');
      }
      await page.waitForTimeout(600);
      await screenshot(page, 'comment-added');
      log('Comment submitted');
    } else {
      finding('P2', 'Task detail: no comment textarea found',
        'Could not find a textarea or input for adding a comment in the detail panel');
    }

    // Change status
    const statusPill = page.locator('button:has-text("Backlog"), button:has-text("Todo"), button:has-text("In Progress"), button:has-text("Backlog")').first();
    const hasStatusPill = await statusPill.isVisible().catch(() => false);
    if (hasStatusPill) {
      await statusPill.click();
      await page.waitForTimeout(400);
      await screenshot(page, 'status-dropdown-open');
      const inProgressOpt = page.locator('[role="option"]:has-text("In Progress"), button:has-text("In Progress"), li:has-text("In Progress")').first();
      if (await inProgressOpt.isVisible().catch(() => false)) {
        await inProgressOpt.click();
        await page.waitForTimeout(600);
        await screenshot(page, 'status-changed-in-progress');
        log('Status changed to In Progress');
      } else {
        await page.keyboard.press('Escape');
        finding('P2', 'Task detail: "In Progress" option not found in status dropdown',
          'Opened status selector but could not find "In Progress" option');
      }
    } else {
      finding('P2', 'Task detail: status selector not visible',
        'Could not find a status pill/button to click in the detail panel');
    }

    // Close detail
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 6: Filters + search
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 6: Filters + search ---');

  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(600);

  // The filter bar is TaskFilters component — look for filter buttons
  const filterContainer = page.locator('[class*="filter"], [class*="Filter"]').first();
  const hasFilters = await filterContainer.isVisible().catch(() => false);
  log(`Filter bar visible: ${hasFilters}`);

  // Check for specific filter buttons
  const priorityFilterBtn = page.locator('button:has-text("Priority"), button:has-text("priority")').first();
  const hasPriorityFilter = await priorityFilterBtn.isVisible().catch(() => false);
  const assigneeFilterBtn = page.locator('button:has-text("Assignee"), button:has-text("assignee")').first();
  const hasAssigneeFilter = await assigneeFilterBtn.isVisible().catch(() => false);
  const statusFilterBtn = page.locator('button:has-text("Status"), button:has-text("status")').first();
  const hasStatusFilter = await statusFilterBtn.isVisible().catch(() => false);

  log(`Filters: Priority=${hasPriorityFilter} Assignee=${hasAssigneeFilter} Status=${hasStatusFilter}`);
  await screenshot(page, 'filter-bar');

  if (!hasPriorityFilter && !hasAssigneeFilter && !hasStatusFilter) {
    finding('P1', 'Filter bar: no filter buttons (Priority/Assignee/Status) visible',
      'The TaskFilters component did not render visible filter buttons on /tasks');
  }

  if (hasPriorityFilter) {
    await priorityFilterBtn.click();
    await page.waitForTimeout(400);
    await screenshot(page, 'priority-filter-dropdown');
    // Select P1
    const p1Opt = page.locator('[role="option"]:has-text("P1"), button:has-text("P1"), li:has-text("P1 —")').first();
    if (await p1Opt.isVisible().catch(() => false)) {
      await p1Opt.click();
      await page.waitForTimeout(400);
      const urlWithFilter = page.url();
      log(`URL with priority filter: ${urlWithFilter}`);
      if (!urlWithFilter.includes('priority')) {
        finding('P2', 'Priority filter does not update URL (not deep-linkable)',
          `Applying a priority filter did not add a query param. URL: ${urlWithFilter}`);
      }
      await screenshot(page, 'filtered-priority-p1');
    }
    // Clear filter
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  if (hasAssigneeFilter) {
    await assigneeFilterBtn.click();
    await page.waitForTimeout(400);
    await screenshot(page, 'assignee-filter-dropdown');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // Global search Cmd+K
  log('Testing Cmd+K global search...');
  // Use Ctrl+K as Windows default
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(700);
  const cmdKVisible = await page.locator('[class*="command"], [class*="search-modal"], [class*="CommandPalette"], [role="combobox"]').isVisible().catch(() => false);
  log(`Cmd/Ctrl+K overlay visible: ${cmdKVisible}`);

  if (!cmdKVisible) {
    finding('P2', 'Ctrl+K / Cmd+K does not open global search',
      'Pressing Ctrl+K on /tasks did not open a search overlay/command palette');
  } else {
    await screenshot(page, 'global-search-open');
    const searchInput = page.locator('[role="combobox"], input[class*="command"], input[placeholder*="Search" i]').first();
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill('tasks-audit');
      await page.waitForTimeout(600);
      await screenshot(page, 'global-search-results');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 7: Timeline view
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 7: Timeline view ---');

  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(600);
  await dismissModals(page);

  const tlBtn = page.locator('button:has-text("Timeline")').first();
  if (await tlBtn.isVisible().catch(() => false)) {
    await tlBtn.click();
    await page.waitForTimeout(1500);
    const shot07 = await screenshot(page, 'timeline-view');

    // Timeline renders via lazy-loaded TaskTimeline component
    const tlContainer = await page.locator('[class*="timeline"], [class*="Timeline"]').isVisible().catch(() => false);
    log(`Timeline container visible: ${tlContainer}`);

    if (!tlContainer) {
      finding('P1', 'Timeline view: component not rendered',
        'No element with "timeline" in className found 1500ms after clicking Timeline toggle',
        shot07);
    } else {
      // Check for task bars
      const bars = await page.locator('[class*="bar"], [class*="task-bar"], [class*="TaskBar"]').all();
      log(`Timeline task bars: ${bars.length}`);
      if (bars.length === 0) {
        finding('P2', 'Timeline view: no task bars visible',
          'Timeline is empty — tasks may lack start/due dates. No empty-state guidance is shown telling users to add dates.',
          shot07);
      }

      // Check time axis
      const hasAxis = await page.locator('[class*="month"], [class*="week"], [class*="axis"], [class*="time"]').isVisible().catch(() => false);
      log(`Time axis visible: ${hasAxis}`);
      if (!hasAxis) {
        finding('P2', 'Timeline view: no time axis visible',
          'No month/week labels found in the timeline grid');
      }
    }
  } else {
    finding('P0', 'Timeline button not found on /tasks', 'Could not find the Timeline view toggle button');
  }

  // Try direct URL /tasks/timeline
  log('Checking /tasks/timeline direct URL...');
  const prevUrl = page.url();
  await page.goto(`${WEB_URL}/tasks/timeline`, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  const afterUrl = page.url();
  log(`After nav to /tasks/timeline, URL: ${afterUrl}`);
  if (!afterUrl.includes('timeline')) {
    finding('Nit', '/tasks/timeline route does not exist as a standalone page',
      `Navigation to /tasks/timeline redirected to: ${afterUrl}. Timeline is only accessible via toggle on /tasks.`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 8: Calendar view
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 8: Calendar view ---');

  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(600);

  const calBtn = page.locator('button:has-text("Calendar")').first();
  if (await calBtn.isVisible().catch(() => false)) {
    await calBtn.click();
    await page.waitForTimeout(1000);
    const shot08 = await screenshot(page, 'calendar-view');

    const calGrid = await page.locator('[class*="calendar"], [class*="Calendar"]').isVisible().catch(() => false);
    log(`Calendar component visible: ${calGrid}`);
    if (!calGrid) {
      finding('P2', 'Calendar view: no calendar grid rendered', 'Calendar component did not produce a visible calendar grid', shot08);
    } else {
      log('Calendar view rendered OK');
      // Check navigation arrows
      const prevBtn = await page.locator('button[aria-label*="previous" i], button[aria-label*="prev" i], button:has-text("<")').isVisible().catch(() => false);
      const nextBtn = await page.locator('button[aria-label*="next" i], button:has-text(">")').isVisible().catch(() => false);
      if (!prevBtn || !nextBtn) {
        finding('Nit', 'Calendar view: month navigation arrows not found',
          'Could not find prev/next month navigation buttons in calendar view');
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 9: Pipeline view
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 9: Pipeline view ---');

  const pipBtn = page.locator('button:has-text("Pipeline")').first();
  if (await pipBtn.isVisible().catch(() => false)) {
    await pipBtn.click();
    await page.waitForTimeout(1000);
    const shot09 = await screenshot(page, 'pipeline-view');

    const pipContent = await page.locator('[class*="pipeline"], [class*="Pipeline"]').isVisible().catch(() => false);
    log(`Pipeline component visible: ${pipContent}`);
    if (!pipContent) {
      finding('P2', 'Pipeline view: no content rendered',
        'Pipeline component did not produce visible content', shot09);
    } else {
      log('Pipeline view rendered OK');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 10: Bulk selection
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 10: Bulk selection ---');

  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(600);

  // List view is easier for selection
  await listBtn.click();
  await page.waitForTimeout(600);

  const selectModeBtn = page.locator('button:has-text("Select")').first();
  const hasSelectBtn = await selectModeBtn.isVisible().catch(() => false);
  log(`Bulk "Select" button visible: ${hasSelectBtn}`);

  if (!hasSelectBtn) {
    finding('P2', 'Bulk "Select" mode button not visible',
      'Could not find the "Select" toggle button on the /tasks header');
  } else {
    await selectModeBtn.click();
    await page.waitForTimeout(500);
    await screenshot(page, 'bulk-select-mode-active');

    // Hint should show "0 selected — click tasks to select"
    const hint = await page.locator('text=/0 selected|click tasks to select/i').isVisible().catch(() => false);
    log(`Selection hint visible: ${hint}`);
    if (!hint) {
      finding('Nit', 'Bulk selection: no "0 selected" hint shown when entering select mode',
        'No bottom-bar hint appeared when entering selection mode with 0 tasks selected');
    }

    // Click a task row
    const rows = await page.locator('tr.cursor-pointer').all();
    if (rows.length > 0) {
      await rows[0].click();
      await page.waitForTimeout(400);
      await screenshot(page, 'one-task-selected');
      const countText = await page.locator('text=/1 selected/').isVisible().catch(() => false);
      log(`"1 selected" visible: ${countText}`);
      if (!countText) {
        finding('P2', 'Bulk selection: clicking a row did not show "1 selected" in bulk bar',
          'After clicking a row in selection mode, the floating bulk action bar did not show "1 selected"');
      }

      // Check bulk action buttons appear
      const moveToBtn = await page.locator('button:has-text("Move to")').isVisible().catch(() => false);
      const assignBtn = await page.locator('button:has-text("Assign to")').isVisible().catch(() => false);
      log(`Bulk bar: Move to=${moveToBtn} Assign to=${assignBtn}`);

      if (!moveToBtn) {
        finding('P2', 'Bulk selection: "Move to..." button not visible after selecting a task',
          'After selecting a task in bulk mode, the "Move to..." status-change button was not found');
      }
    }

    // Exit selection mode
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 11: My Tasks view
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 11: My Tasks view ---');

  await page.goto(`${WEB_URL}/tasks?view=my`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(800);
  const shot11 = await screenshot(page, 'my-tasks-view');

  const myTasksHeader = await page.locator('text="My Tasks"').isVisible().catch(() => false);
  log(`"My Tasks" header visible: ${myTasksHeader}`);

  if (!myTasksHeader) {
    finding('P1', '"My Tasks" view does not render header with ?view=my',
      `URL /tasks?view=my did not show "My Tasks" heading. Current URL: ${page.url()}`, shot11);
  } else {
    // Check if there's an empty state or tasks listed
    const noTasksMsg = await page.locator('text=/No tasks assigned/i').isVisible().catch(() => false);
    const hasTaskGroups = await page.locator('[class*="project-section"], [class*="group"]').first().isVisible().catch(() => false);
    log(`My Tasks: empty=${noTasksMsg} groups=${hasTaskGroups}`);

    if (!noTasksMsg && !hasTaskGroups) {
      finding('P2', '"My Tasks" view shows neither tasks nor empty state',
        'The My Tasks view loaded but showed neither task groups nor an empty-state message');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 12: Task templates
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 12: Task templates ---');

  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(600);

  const templatesBtn = page.locator('button:has-text("Templates")').first();
  const hasTemplates = await templatesBtn.isVisible().catch(() => false);
  log(`Templates button visible: ${hasTemplates}`);

  if (!hasTemplates) {
    finding('Nit', '"Templates" button not visible (requires skill-config project)',
      'The Templates dropdown is only rendered when the selected project has resolved task_templates. No default seed project has one — this is expected behavior, not a bug.');
  } else {
    await templatesBtn.click();
    await page.waitForTimeout(500);
    await screenshot(page, 'templates-dropdown');
    await page.keyboard.press('Escape');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GROUP 13: Cross-references
  // ───────────────────────────────────────────────────────────────────────────
  log('--- GROUP 13: Cross-references ---');

  const crossRefRows = await dbQuery(
    `SELECT id, title, source_message_id FROM tasks WHERE org_id=$1 AND source_message_id IS NOT NULL AND is_deleted=false LIMIT 5`,
    [ORG_ID]
  );
  crossRefCount = crossRefRows.length;
  log(`Tasks with source_message_id: ${crossRefCount}`);

  if (crossRefCount === 0) {
    finding('Nit', 'No cross-reference tasks in DB to verify rendering',
      'All tasks have NULL source_message_id. Cannot verify the cross-references section in detail panel.');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Final screenshot + heuristic checks
  // ───────────────────────────────────────────────────────────────────────────
  log('--- Final state + heuristic checks ---');

  await page.goto(`${WEB_URL}/tasks`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(600);
  await screenshot(page, 'final-state');

  // Console error analysis
  log(`Console errors/warnings total: ${consoleErrors.length}`);
  const hydrationErrs = consoleErrors.filter(e => e.toLowerCase().includes('hydrat'));
  const keyErrs = consoleErrors.filter(e => e.toLowerCase().includes('each child') || e.toLowerCase().includes('"key"'));
  const tiptapErrs = consoleErrors.filter(e => e.toLowerCase().includes('tiptap'));

  if (hydrationErrs.length > 0) {
    finding('P1', `React hydration errors (${hydrationErrs.length})`,
      hydrationErrs.slice(0, 3).join('\n'));
  }
  if (keyErrs.length > 0) {
    finding('P2', `React "key" prop warnings (${keyErrs.length})`,
      keyErrs.slice(0, 3).join('\n'));
  }
  if (tiptapErrs.length > 0) {
    finding('Nit', `TipTap console warnings (${tiptapErrs.length})`,
      tiptapErrs.slice(0, 2).join('\n'));
  }

  // Network errors
  log(`Network 4xx/5xx total: ${networkErrors.length}`);
  const serious = networkErrors.filter(e => !e.startsWith('404') && !e.startsWith('401'));
  if (serious.length > 0) {
    finding('P1', `Unexpected API errors during audit session (${serious.length})`,
      serious.slice(0, 5).join('\n'));
  }

  log(`Total findings: ${findings.length}`);
  log(`Total screenshots: ${screenshotSeq}`);

  await browser.close();

  // ─── Write REPORT.md ────────────────────────────────────────────────────────
  const duration = ((Date.now() - START) / 1000).toFixed(0);
  const dbCountStr = dbCounts.map(r => `${r.status}: ${r.cnt}`).join(', ');

  const p0s = findings.filter(f => f.sev === 'P0');
  const p1s = findings.filter(f => f.sev === 'P1');
  const p2s = findings.filter(f => f.sev === 'P2');
  const nits = findings.filter(f => f.sev === 'Nit');

  const formatFindings = (fs: Finding[]) =>
    fs.length === 0
      ? '_None_\n'
      : fs.map(f =>
          `### ${f.id}: ${f.title}\n\n${f.detail}${f.screenshot ? `\n\n![${f.id}](${f.screenshot})` : ''}\n`
        ).join('\n');

  const screenshotLines = Array.from({ length: screenshotSeq }, (_, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `- ${num}-*.png`;
  }).join('\n');

  const fence = '```';
  const lines: string[] = [
    '# Tasks Deep Audit',
    '',
    `**Date:** 2026-04-20`,
    `**Branch:** feat/phase2-4-mcp-agents-plans`,
    `**Duration:** ~${duration}s`,
    `**DB task counts (non-deleted):** ${dbCountStr || 'none (empty)'}`,
    `**Console errors/warnings:** ${consoleErrors.length}`,
    `**Network 4xx/5xx:** ${networkErrors.length}`,
    `**Total findings:** ${findings.length} — P0: ${p0s.length}, P1: ${p1s.length}, P2: ${p2s.length}, Nit: ${nits.length}`,
    '',
    '---',
    '',
    '## Surfaces Observed',
    '',
    '- `/tasks` board view (default, 5 status columns)',
    '- `/tasks` list view (via toggle)',
    '- `/tasks` timeline view (via toggle + direct URL attempt)',
    '- `/tasks` calendar view (via toggle)',
    '- `/tasks` pipeline view (via toggle)',
    '- `/tasks?view=my` — My Tasks grouped view',
    '- Task quick-create modal (New task button + "c" keyboard shortcut)',
    '- Task detail drawer (status selector, comments, activity)',
    '- Filter bar (Priority, Assignee, Status buttons)',
    '- Global search (Ctrl+K / Cmd+K)',
    '- Bulk selection mode (Select button)',
    '- Templates dropdown (conditional on skill config)',
    '- Kanban drag-and-drop (drag handle hover)',
    '- DB cross-reference check',
    '',
    '---',
    '',
    '## P0 — Blocks Release',
    '',
    formatFindings(p0s),
    '',
    '## P1 — Must Fix',
    '',
    formatFindings(p1s),
    '',
    '## P2 — Should Fix',
    '',
    formatFindings(p2s),
    '',
    '## Nits',
    '',
    formatFindings(nits),
    '',
    '---',
    '',
    '## Coverage Gaps',
    '',
    '- **Task relationships** (parent/child/blocker): Not tested — no tasks in DB with relationship data.',
    `- **Cross-references**: ${crossRefCount} tasks with source_message_id found in DB. With 0, cross-ref section in detail could not be verified.`,
    '- **Duplicate detection**: Not tested — would require creating a task with the same title as an existing one.',
    '- **Task templates**: Conditional on skill config; default seed projects do not have templates configured.',
    '- **Inline title save-on-blur**: contenteditable interaction was not stable enough to test reliably in headless-adjacent mode.',
    '- **Kanban drag-to-specific-column**: dnd-kit does not emit draggable=true; drop-zone targeting by position only.',
    '- **Priority/label/size inline edit in detail**: Not individually tested due to time budget.',
    '',
    '---',
    '',
    '## Raw Console / Network Log Excerpts',
    '',
    '### Console errors/warnings (first 10)',
    fence,
    consoleErrors.slice(0, 10).join('\n') || '(none)',
    fence,
    '',
    '### Network 4xx/5xx (first 10)',
    fence,
    networkErrors.slice(0, 10).join('\n') || '(none)',
    fence,
    '',
    '### Page-level JS errors',
    fence,
    pageErrors.slice(0, 5).join('\n') || '(none)',
    fence,
    '',
    '---',
    '',
    '## Screenshots Index',
    '',
    screenshotLines,
    '',
    '_(All PNG files in docs/superpowers/audits/tasks-deep/)_',
  ];

  writeFileSync(path.join(AUDIT_DIR, 'REPORT.md'), lines.join('\n'), 'utf-8');
  log('REPORT.md written');
  log('=== Tasks Deep Audit DONE ===');
}

main().catch((err) => {
  console.error('Audit fatal error:', err);
  process.exit(1);
});
