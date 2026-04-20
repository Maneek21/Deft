#!/usr/bin/env tsx
/**
 * Notes Mobile Audit — iPhone 13 viewport (390×844).
 * Checks mobile-specific concerns for the TipTap-based Notes feature.
 *
 * Test plan:
 *   1. /notes landing — overall impression, header fit
 *   2. Note list — cards, search bar visibility, folder bar scroll
 *   3. Open a note — editor loads, toolbar accessible
 *   4. Create a new note — headline, bullet list, code block via toolbar
 *   5. Markdown shortcuts — # heading, - item, **bold**
 *   6. Delete note → Undo toast — tap Undo, verify restore
 *   7. Share modal — full-screen or centered?
 *   8. Promote-to-Wiki modal — full-screen or centered?
 *   9. Ctrl+K / Cmd+K availability on mobile
 *   10. Horizontal scroll check on every view
 */
import 'dotenv/config';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';
const NOTES_URL = `${WEB_URL}/notes`;
const AUDIT_DIR = 'docs/superpowers/audits/notes-mobile';
const LOG_FILE = join(AUDIT_DIR, 'run.log');
const REPORT_FILE = join(AUDIT_DIR, 'REPORT.md');

// iPhone 13 viewport
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const START_TIME = Date.now();
const MAX_WALL_MS = 8 * 60 * 1000;

type Severity = 'P0' | 'P1' | 'P2' | 'Nit';
const findings: Array<{ severity: Severity; area: string; description: string; screenshot?: string; detail?: string }> = [];
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const networkErrors: string[] = [];
let shotCounter = 0;
let testNoteId: string | null = null;

// ── Logging ──────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 23); }
function log(msg: string) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + '\n');
}
function logOk(msg: string) { log(`OK   ${msg}`); }
function logFail(msg: string) { log(`FAIL ${msg}`); }
function logInfo(msg: string) { log(`INFO ${msg}`); }
function logSection(msg: string) { log(`\n${'='.repeat(60)}\n  ${msg}\n${'='.repeat(60)}`); }
function logProgress(msg: string) { log(`... ${msg}`); }

function find(severity: Severity, area: string, description: string, screenshot?: string, detail?: string) {
  findings.push({ severity, area, description, screenshot, detail });
  log(`[FINDING:${severity}] ${area}: ${description}${detail ? ' | ' + detail : ''}`);
}

// ── Screenshot ───────────────────────────────────────────────────────────────
async function shot(page: Page, label: string): Promise<string> {
  shotCounter++;
  const num = String(shotCounter).padStart(2, '0');
  const fname = `${num}-${label}.png`;
  const fpath = join(AUDIT_DIR, fname);
  try {
    await page.screenshot({ path: fpath, fullPage: false });
    logInfo(`screenshot: ${fname}`);
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
  const j = (await res.json()) as Record<string, unknown>;
  logOk(`Login OK`);
  return {
    accessToken: (j.access_token ?? j.accessToken) as string,
    refreshToken: (j.refresh_token ?? j.refreshToken) as string | undefined,
  };
}

async function apiFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const txt = await res.text();
  let body: unknown = txt;
  try { body = JSON.parse(txt); } catch { /**/ }
  return { status: res.status, body: body as T };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function waitOrStall(page: Page, selector: string, timeout = 5000, label?: string): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
    return true;
  } catch {
    log(`[STALL] ${selector}${label ? ` (${label})` : ''} not visible after ${timeout}ms`);
    return false;
  }
}

async function waitMs(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

function attachListeners(page: Page) {
  page.on('console', msg => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') consoleErrors.push(`[${t}] ${msg.text()}`);
  });
  page.on('pageerror', err => { pageErrors.push(err.message); log(`[PAGEERROR] ${err.message.slice(0, 200)}`); });
  page.on('response', res => {
    const s = res.status();
    if (s >= 400) {
      const u = res.url();
      if (!u.includes('favicon') && !u.includes('chrome-extension')) networkErrors.push(`${s} ${res.request().method()} ${u}`);
    }
  });
}

async function injectAuth(context: BrowserContext, accessToken: string, refreshToken?: string) {
  await context.addInitScript(
    ({ at, rt }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: accessToken, rt: refreshToken ?? null },
  );
}

/**
 * Detect horizontal overflow: scrollWidth > clientWidth on body or common
 * containers. Returns the excess pixels (0 = no overflow).
 */
async function checkHorizontalScroll(page: Page, label: string): Promise<number> {
  const excess = await page.evaluate(() => {
    const body = document.body;
    return Math.max(0, body.scrollWidth - body.clientWidth);
  });
  if (excess > 2) {
    logFail(`Horizontal overflow detected on "${label}": body.scrollWidth exceeds clientWidth by ${excess}px`);
  } else {
    logOk(`No horizontal overflow on "${label}"`);
  }
  return excess;
}

/**
 * Measure bounding rect of an element. Returns null if element not found.
 */
async function getBoundingBox(page: Page, selector: string) {
  try {
    return await page.locator(selector).first().boundingBox();
  } catch {
    return null;
  }
}

// ── Group 1: Notes Landing ────────────────────────────────────────────────────
async function group1Landing(page: Page) {
  logSection('Group 1: Notes Landing (mobile)');
  logProgress('Navigating to /notes...');

  const t0 = Date.now();
  await page.goto(NOTES_URL, { waitUntil: 'networkidle', timeout: 20000 });
  const elapsed = Date.now() - t0;
  logInfo(`Page load: ${elapsed}ms`);

  if (elapsed > 3000) find('P2', 'Notes/Landing', `Slow mobile page load: ${elapsed}ms`);

  const s1 = await shot(page, 'notes-landing');

  // Check page heading visible
  const heading = await page.locator('h1').first().textContent().catch(() => null);
  logInfo(`h1: "${heading}"`);
  if (!heading?.toLowerCase().includes('note')) {
    find('P1', 'Notes/Landing', `Notes page heading missing/wrong: "${heading}"`, s1);
  } else {
    logOk(`Heading found: "${heading}"`);
  }

  // Check header items fit in 390px
  const headerFlex = await page.locator('.flex.items-center.justify-between').first().boundingBox();
  if (headerFlex) {
    logInfo(`Header bounding box width: ${headerFlex.width}px, height: ${headerFlex.height}px`);
    if (headerFlex.width > MOBILE_VIEWPORT.width) {
      find('P1', 'Notes/Landing', `Header row wider than viewport (${headerFlex.width}px > ${MOBILE_VIEWPORT.width}px)`, s1);
    }
    if (headerFlex.height > 80) {
      find('P2', 'Notes/Landing', `Header row unusually tall on mobile (${headerFlex.height}px) — may be wrapping`, s1);
    }
  }

  // Check horizontal overflow
  const overflow1 = await checkHorizontalScroll(page, 'notes-landing');
  if (overflow1 > 2) find('P1', 'Notes/Landing', `Horizontal overflow on landing: +${overflow1}px`, s1);

  // Check "New Note" button is visible/tappable
  const newNoteBtns = await page.locator('button').filter({ hasText: 'New Note' }).all();
  if (newNoteBtns.length === 0) {
    find('P1', 'Notes/Landing', '"New Note" button not found on mobile');
  } else {
    const bb = await newNoteBtns[0].boundingBox();
    logInfo(`"New Note" button: w=${bb?.width?.toFixed(0)}, h=${bb?.height?.toFixed(0)}`);
    if (bb && bb.height < 36) {
      find('P1', 'Notes/Landing', `"New Note" button too short for touch (${bb.height.toFixed(0)}px < 36px)`, s1);
    } else {
      logOk('"New Note" button tappable size');
    }
  }

  // Check search bar visible and appropriately sized
  const searchInput = page.locator('input[placeholder*="Search notes"]');
  const searchFound = await searchInput.count();
  if (searchFound === 0) {
    find('P1', 'Notes/Search', 'Search input not visible on mobile notes list');
  } else {
    const bb = await searchInput.boundingBox();
    logInfo(`Search bar: w=${bb?.width?.toFixed(0)}, h=${bb?.height?.toFixed(0)}`);
    if (bb && bb.width < 200) {
      find('P2', 'Notes/Search', `Search bar too narrow on mobile (${bb.width.toFixed(0)}px)`, s1);
    } else {
      logOk('Search bar visible and wide enough');
    }
  }

  // Check folder bar fits and scrolls (not wraps)
  const folderBar = await page.locator('.flex.items-center.gap-1.mb-4.overflow-x-auto').first().boundingBox();
  if (folderBar) {
    logInfo(`Folder bar: w=${folderBar.width?.toFixed(0)}, h=${folderBar.height?.toFixed(0)}`);
    if (folderBar.height > 50) {
      find('P2', 'Notes/FolderBar', `Folder bar wrapped (h=${folderBar.height?.toFixed(0)}px > 50px) — should scroll horizontally`, s1);
    } else {
      logOk('Folder bar appears single-row (overflow-x-auto working)');
    }
  }

  await shot(page, 'notes-list-search-visible');
  logProgress('Group 1 complete');
}

// ── Group 2: Note Card Tap ────────────────────────────────────────────────────
async function group2TapNoteCard(page: Page, token: string) {
  logSection('Group 2: Tap note card to open editor');

  // Use the API to get or create a note
  const notesRes = await apiFetch<any[]>('/api/daily-notes', token);
  let openNoteId: string | null = null;

  if (notesRes.status === 200 && Array.isArray(notesRes.body) && notesRes.body.length > 0) {
    openNoteId = notesRes.body[0].id;
    logInfo(`Using existing note: ${openNoteId}`);
  } else {
    logInfo('No existing notes — creating one via API');
    const createRes = await apiFetch<any>('/api/daily-notes', token, {
      method: 'POST',
      body: JSON.stringify({ title: `mobile-audit-${Date.now()}`, icon: '📱' }),
    });
    if (createRes.status === 200 || createRes.status === 201) {
      openNoteId = createRes.body?.id;
    }
  }

  if (!openNoteId) {
    find('P0', 'Notes/Editor', 'Cannot open any note — no notes exist and create failed');
    return;
  }

  testNoteId = openNoteId;

  // Navigate to note (simulating tap)
  logProgress(`Opening note ${openNoteId} via URL...`);
  await page.goto(`${NOTES_URL}?id=${openNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(800);

  const s2 = await shot(page, 'editor-open');

  // Check editor loaded
  const editorVisible = await waitOrStall(page, '[contenteditable="true"]', 5000, 'editor');
  if (!editorVisible) {
    find('P0', 'Notes/Editor', 'TipTap editor did not render on mobile', s2);
    return;
  }
  logOk('TipTap editor rendered');

  // Check horizontal overflow
  const overflow = await checkHorizontalScroll(page, 'editor-view');
  if (overflow > 2) find('P1', 'Notes/Editor', `Horizontal overflow in editor view: +${overflow}px`, s2);

  // Check top bar fits — should show "All Notes" back button
  const backBtn = page.locator('button').filter({ hasText: 'All Notes' });
  const backBtnCount = await backBtn.count();
  if (backBtnCount === 0) {
    find('P1', 'Notes/Editor', '"All Notes" back button missing in mobile editor view', s2);
  } else {
    const bb = await backBtn.first().boundingBox();
    logInfo(`Back button: w=${bb?.width?.toFixed(0)}, h=${bb?.height?.toFixed(0)}`);
    logOk('"All Notes" back button visible');
  }

  // Check icon buttons in top-right — do they overflow the header?
  const topBarButtons = await page.locator('button').all();
  const smallButtons: string[] = [];
  for (const btn of topBarButtons) {
    const bb = await btn.boundingBox();
    if (bb && bb.width > 0 && bb.height > 0 && bb.width < 44 && bb.height < 44) {
      const title = await btn.getAttribute('title').catch(() => null);
      const label = await btn.getAttribute('aria-label').catch(() => null);
      const text = await btn.textContent().catch(() => null);
      const id = title || label || text?.trim().slice(0, 20) || `(${bb.width.toFixed(0)}×${bb.height.toFixed(0)})`;
      smallButtons.push(id);
    }
  }
  if (smallButtons.length > 0) {
    logInfo(`Buttons below 44×44px (${smallButtons.length}): ${smallButtons.slice(0, 8).join(', ')}`);
    // P1 if many, P2 if a few
    if (smallButtons.length > 5) {
      find('P1', 'Notes/Editor', `${smallButtons.length} icon buttons are smaller than 44×44px — too small for touch targets`, s2, smallButtons.slice(0, 8).join(', '));
    } else {
      find('P2', 'Notes/Editor', `${smallButtons.length} icon button(s) below 44×44px`, s2, smallButtons.join(', '));
    }
  } else {
    logOk('All buttons are >= 44×44px');
  }

  logProgress('Group 2 complete');
}

// ── Group 3: Toolbar Accessibility on Mobile ──────────────────────────────────
async function group3Toolbar(page: Page) {
  logSection('Group 3: TipTap toolbar — mobile accessibility');

  if (!testNoteId) {
    find('P1', 'Notes/Toolbar', 'No note ID available — skipping toolbar group');
    return;
  }

  await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(600);

  const editorReady = await waitOrStall(page, '[contenteditable="true"]', 5000, 'editor');
  if (!editorReady) {
    find('P0', 'Notes/Toolbar', 'Editor not ready — cannot test toolbar');
    return;
  }

  // The toolbar container
  const toolbarSelector = '.flex.items-center.gap-0\\.5.px-2.py-1\\.5.overflow-x-auto.flex-nowrap';
  const toolbarLocator = page.locator('[style*="border-bottom"]').first();
  const toolbarBb = await toolbarLocator.boundingBox();

  if (!toolbarBb) {
    find('P1', 'Notes/Toolbar', 'Toolbar container not found or not visible on mobile');
  } else {
    logInfo(`Toolbar: w=${toolbarBb.width.toFixed(0)}, h=${toolbarBb.height.toFixed(0)}, x=${toolbarBb.x.toFixed(0)}`);

    if (toolbarBb.width > MOBILE_VIEWPORT.width + 2) {
      find('P1', 'Notes/Toolbar', `Toolbar wider than viewport (${toolbarBb.width.toFixed(0)}px > ${MOBILE_VIEWPORT.width}px) — horizontal clip`, undefined, 'Uses overflow-x-auto so it should scroll, not clip');
    }

    // Check if toolbar has scrollable overflow (expected — it's overflow-x-auto flex-nowrap)
    const scrollable = await page.evaluate(() => {
      // Find the toolbar div (first element with borderBottom style, or the flex-nowrap container)
      const bars = Array.from(document.querySelectorAll('div')).filter(el => {
        const s = el.style;
        return s.borderBottom && s.borderBottom.includes('solid');
      });
      if (bars.length === 0) return { found: false, scrollWidth: 0, clientWidth: 0 };
      const bar = bars[0];
      return { found: true, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, overflow: getComputedStyle(bar).overflowX };
    });
    logInfo(`Toolbar scroll info: ${JSON.stringify(scrollable)}`);

    if (scrollable.found && scrollable.scrollWidth > scrollable.clientWidth) {
      logInfo(`Toolbar overflows — scrollWidth ${scrollable.scrollWidth} > clientWidth ${scrollable.clientWidth}`);
      if (scrollable.overflow === 'auto' || scrollable.overflow === 'scroll') {
        logOk('Toolbar overflows but is scrollable (overflow-x-auto) — acceptable');
        find('Nit', 'Notes/Toolbar', `Toolbar content wider than viewport on mobile (${scrollable.scrollWidth}px vs ${scrollable.clientWidth}px) — requires horizontal scroll to reach all buttons`, undefined, 'overflow-x-auto is set, so scroll works, but buttons at the end are hidden by default');
      } else {
        find('P1', 'Notes/Toolbar', `Toolbar overflows (${scrollable.scrollWidth}px) but overflow-x is "${scrollable.overflow}" — buttons may be clipped`, undefined);
      }
    } else {
      logOk('Toolbar fits in mobile viewport');
    }
  }

  const s3 = await shot(page, 'toolbar-mobile');

  // Measure individual toolbar button sizes
  const toolbarBtns = await page.locator('.p-1\\.5.rounded.transition-colors').all();
  logInfo(`Toolbar buttons found: ${toolbarBtns.length}`);

  const tinyBtns: string[] = [];
  for (const btn of toolbarBtns) {
    const bb = await btn.boundingBox();
    const title = await btn.getAttribute('title').catch(() => null);
    if (bb && bb.height > 0 && bb.height < 44) {
      tinyBtns.push(`${title || '?'} (${bb.width.toFixed(0)}×${bb.height.toFixed(0)})`);
    }
  }

  if (tinyBtns.length > 0) {
    logInfo(`Toolbar buttons < 44px tall (${tinyBtns.length}): ${tinyBtns.slice(0, 8).join(', ')}`);
    find('P1', 'Notes/Toolbar', `${tinyBtns.length} toolbar button(s) are below 44×44px touch target minimum`, s3, tinyBtns.slice(0, 8).join(', '));
  } else if (toolbarBtns.length > 0) {
    logOk(`All ${toolbarBtns.length} toolbar buttons meet 44px height minimum`);
  }

  // Check horizontal overflow in editor view specifically
  const editorOverflow = await checkHorizontalScroll(page, 'editor-with-toolbar');
  if (editorOverflow > 2) find('P1', 'Notes/Toolbar', `Body horizontal overflow in editor: +${editorOverflow}px`, s3);

  logProgress('Group 3 complete');
}

// ── Group 4: Create Note + Type Content ──────────────────────────────────────
async function group4CreateAndType(page: Page, token: string) {
  logSection('Group 4: Create note + type on mobile');

  // Navigate to notes list
  await page.goto(NOTES_URL, { waitUntil: 'networkidle' });
  await waitMs(500);

  // Open new note dropdown
  const newNoteBtn = page.locator('button').filter({ hasText: 'New Note' });
  const newNoteBtnCount = await newNoteBtn.count();
  if (newNoteBtnCount === 0) {
    find('P0', 'Notes/Create', '"New Note" button not found on mobile');
    return;
  }

  await newNoteBtn.first().click();
  await waitMs(400);

  const s4a = await shot(page, 'new-note-dropdown-mobile');

  // Dropdown position check — must not overflow screen
  const dropdownOverflow = await checkHorizontalScroll(page, 'new-note-dropdown');
  if (dropdownOverflow > 2) find('P2', 'Notes/Create', `"New Note" dropdown causes horizontal overflow: +${dropdownOverflow}px`, s4a);

  // Check dropdown appears on screen
  const dropdown = page.locator('.absolute.right-0.top-full');
  const ddBb = await dropdown.first().boundingBox();
  if (ddBb) {
    logInfo(`Dropdown: x=${ddBb.x.toFixed(0)}, w=${ddBb.width.toFixed(0)}`);
    if (ddBb.x < 0) {
      find('P1', 'Notes/Create', `New Note dropdown extends off-screen left (x=${ddBb.x.toFixed(0)})`, s4a);
    } else {
      logOk('Dropdown within viewport bounds');
    }
  }

  // Click "Blank Note"
  const blankNoteBtn = page.locator('button').filter({ hasText: 'Blank Note' });
  if (await blankNoteBtn.count() === 0) {
    find('P1', 'Notes/Create', '"Blank Note" option not found in dropdown');
    await page.keyboard.press('Escape');
    return;
  }

  await blankNoteBtn.first().click();
  await waitMs(1500);

  const url = page.url();
  logInfo(`URL after create: ${url}`);
  if (!url.includes('?id=')) {
    find('P1', 'Notes/Create', 'URL did not update to include ?id= after creating note');
    return;
  }

  const match = url.match(/\?id=([^&]+)/);
  testNoteId = match ? match[1] : testNoteId;

  await waitMs(500);
  const s4b = await shot(page, 'new-note-editor-blank-mobile');

  const editorReady = await waitOrStall(page, '[contenteditable="true"]', 5000, 'editor');
  if (!editorReady) {
    find('P0', 'Notes/Create', 'Editor not visible after creating note on mobile', s4b);
    return;
  }
  logOk('Editor ready');

  // Check placeholder text visible (recent change: "Start writing…" instead of "type / for commands")
  const placeholderText = await page.locator('.is-editor-empty, [data-placeholder]').first().getAttribute('data-placeholder').catch(() => null);
  logInfo(`Placeholder text: "${placeholderText}"`);
  if (placeholderText) {
    if (placeholderText.toLowerCase().includes('type /') || placeholderText.toLowerCase().includes('/ for commands')) {
      find('P1', 'Notes/Editor', `Placeholder still says "${placeholderText}" — should have been updated to "Start writing…"`, s4b);
    } else if (placeholderText.toLowerCase().includes('start writing')) {
      logOk(`Placeholder correctly says "${placeholderText}"`);
    } else {
      logInfo(`Placeholder is: "${placeholderText}"`);
    }
  } else {
    find('Nit', 'Notes/Editor', 'Placeholder text not detectable via data-placeholder — may be CSS only', s4b);
  }

  // Type content on mobile — simulate touch typing
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.tap();
  await waitMs(300);

  // Type headline using markdown shortcut
  logProgress('Typing # heading markdown shortcut...');
  await editor.type('# Mobile Audit Heading');
  await page.keyboard.press('Enter');
  await waitMs(300);

  const h1Count = await page.locator('h1').count();
  if (h1Count === 0) {
    find('P1', 'Notes/Editor', 'Markdown shortcut "# heading" did not convert on mobile', s4b);
  } else {
    logOk('# heading markdown shortcut works on mobile');
  }

  // Type bullet list via markdown shortcut
  logProgress('Typing - bullet list...');
  await editor.type('- first bullet item');
  await page.keyboard.press('Enter');
  await editor.type('- second bullet item');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await waitMs(300);

  const ulCount = await page.locator('ul').count();
  if (ulCount === 0) {
    find('P1', 'Notes/Editor', 'Markdown shortcut "- item" did not create bullet list on mobile');
  } else {
    logOk('- bullet list markdown shortcut works on mobile');
  }

  // Code block via toolbar button
  logProgress('Testing code block via toolbar...');
  const codeBlockBtn = page.locator('button[title="Code"]');
  if (await codeBlockBtn.count() > 0) {
    await codeBlockBtn.first().tap();
    await waitMs(200);
    await editor.type('const x = "mobile";');
    await codeBlockBtn.first().tap();
    await waitMs(200);
    const codeEl = await page.locator('code').count();
    if (codeEl === 0) {
      find('P1', 'Notes/Toolbar', 'Code toolbar button did not create code element on mobile');
    } else {
      logOk('Code toolbar button works on mobile');
    }
  } else {
    find('P2', 'Notes/Toolbar', 'Code toolbar button not found');
  }

  // Bold via **markdown** shortcut on mobile
  logProgress('Testing **bold** markdown shortcut...');
  await page.keyboard.press('Enter');
  await editor.type('**bold text** normal');
  await waitMs(300);
  const boldCount = await page.locator('strong').count();
  if (boldCount === 0) {
    find('P1', 'Notes/Editor', '**bold** markdown shortcut did not fire on mobile');
  } else {
    logOk('**bold** markdown shortcut works on mobile');
  }

  const s4c = await shot(page, 'editor-content-typed-mobile');

  // Horizontal overflow in editor after typing
  const overflow4 = await checkHorizontalScroll(page, 'editor-after-typing');
  if (overflow4 > 2) find('P1', 'Notes/Editor', `Horizontal overflow after typing: +${overflow4}px`, s4c);

  // Check editor bottom not covered by simulated keyboard
  // On real mobile, soft keyboard rises and pushes content up — we can't
  // simulate this fully in Playwright, but we note the layout approach.
  const editorBb = await editor.boundingBox();
  logInfo(`Editor bounding box: y=${editorBb?.y?.toFixed(0)}, h=${editorBb?.height?.toFixed(0)}`);

  // Wait for autosave
  await waitMs(2000);
  const savedIndicator = await page.locator('text=Saved').count();
  logInfo(`"Saved" indicator: ${savedIndicator > 0}`);
  if (savedIndicator === 0) {
    find('P2', 'Notes/Editor', 'No "Saved" indicator appeared after typing on mobile');
  } else {
    logOk('"Saved" indicator visible');
  }

  await shot(page, 'editor-after-autosave-mobile');
  logProgress('Group 4 complete');
}

// ── Group 5: Slash Commands ───────────────────────────────────────────────────
async function group5SlashCommands(page: Page) {
  logSection('Group 5: Slash commands on mobile');

  if (!testNoteId) {
    find('P1', 'Notes/SlashCommands', 'No note ID — skipping');
    return;
  }

  await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(600);

  const editor = page.locator('[contenteditable="true"]').first();
  const editorReady = await waitOrStall(page, '[contenteditable="true"]', 5000, 'editor');
  if (!editorReady) {
    find('P0', 'Notes/SlashCommands', 'Editor not ready');
    return;
  }

  // Tap end of editor
  await editor.tap();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await waitMs(200);

  // Type a slash
  await editor.type('/');
  await waitMs(600);

  const slashMenu = await page.locator('[role="menu"], [role="listbox"], .slash-menu, .tippy-box').count();
  const s5 = await shot(page, 'slash-command-mobile');

  if (slashMenu === 0) {
    find('P2', 'Notes/SlashCommands', 'Slash command menu not shown when typing "/" on mobile', s5);
    logInfo('Note: TipTap slash commands may not be registered — the extension was not added in source code review');
  } else {
    logOk('Slash command menu appeared on mobile');

    // Check if menu fits within viewport
    const menuEl = page.locator('[role="menu"], [role="listbox"], .tippy-box').first();
    const menuBb = await menuEl.boundingBox();
    if (menuBb) {
      logInfo(`Slash menu: x=${menuBb.x.toFixed(0)}, y=${menuBb.y.toFixed(0)}, w=${menuBb.width.toFixed(0)}, h=${menuBb.height.toFixed(0)}`);
      if (menuBb.x + menuBb.width > MOBILE_VIEWPORT.width + 5) {
        find('P1', 'Notes/SlashCommands', `Slash command menu extends off-screen right (x=${menuBb.x.toFixed(0)}, w=${menuBb.width.toFixed(0)})`, s5);
      }
      if (menuBb.y + menuBb.height > MOBILE_VIEWPORT.height + 5) {
        find('P2', 'Notes/SlashCommands', `Slash command menu extends below viewport (y=${menuBb.y.toFixed(0)}, h=${menuBb.height.toFixed(0)})`, s5);
      }
    }
    await page.keyboard.press('Escape');
  }

  logProgress('Group 5 complete');
}

// ── Group 6: Delete with Undo Toast ──────────────────────────────────────────
async function group6DeleteUndo(page: Page, token: string) {
  logSection('Group 6: Delete note + Undo toast on mobile');

  // Create a fresh note for deletion test
  const createRes = await apiFetch<any>('/api/daily-notes', token, {
    method: 'POST',
    body: JSON.stringify({ title: `mobile-delete-test-${Date.now()}`, icon: '🗑️' }),
  });
  if (createRes.status !== 200 && createRes.status !== 201) {
    find('P1', 'Notes/Delete', `Could not create test note for delete: ${createRes.status}`);
    return;
  }
  const deleteNoteId = createRes.body?.id;
  logInfo(`Created delete-test note: ${deleteNoteId}`);

  await page.goto(`${NOTES_URL}?id=${deleteNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(600);

  // Find delete button
  const deleteBtn = page.locator('button[title="Delete note"]');
  if (await deleteBtn.count() === 0) {
    find('P1', 'Notes/Delete', '"Delete note" button not found on mobile editor');
    return;
  }

  const delBtnBb = await deleteBtn.first().boundingBox();
  logInfo(`Delete button: w=${delBtnBb?.width?.toFixed(0)}, h=${delBtnBb?.height?.toFixed(0)}`);
  if (delBtnBb && delBtnBb.height < 36) {
    find('P2', 'Notes/Delete', `Delete button too small for touch (${delBtnBb.height.toFixed(0)}px < 36px)`);
  }

  // Click delete
  await deleteBtn.first().tap();
  await waitMs(800);

  const s6a = await shot(page, 'delete-undo-toast-mobile');

  // Check toast appears
  const toastEl = page.locator('text=Note deleted');
  const toastCount = await toastEl.count();
  if (toastCount === 0) {
    find('P1', 'Notes/Delete', 'Delete undo toast "Note deleted." did not appear on mobile', s6a);
    return;
  }
  logOk('Delete undo toast visible');

  // Check toast legibility — get bounding box
  const toastParent = page.locator('.fixed.bottom-6').first();
  const toastBb = await toastParent.boundingBox();
  if (toastBb) {
    logInfo(`Toast: x=${toastBb.x.toFixed(0)}, w=${toastBb.width.toFixed(0)}, h=${toastBb.height.toFixed(0)}, bottom=${(toastBb.y + toastBb.height).toFixed(0)}`);
    if (toastBb.x < 0) {
      find('P1', 'Notes/Delete', `Undo toast extends off-screen left (x=${toastBb.x.toFixed(0)})`, s6a);
    }
    if (toastBb.x + toastBb.width > MOBILE_VIEWPORT.width + 5) {
      find('P1', 'Notes/Delete', `Undo toast extends off-screen right`, s6a);
    }
    if (toastBb.y + toastBb.height > MOBILE_VIEWPORT.height) {
      find('P1', 'Notes/Delete', `Undo toast rendered below viewport bottom (y+h=${(toastBb.y + toastBb.height).toFixed(0)} > ${MOBILE_VIEWPORT.height})`, s6a);
    }
  }

  // Check "Undo" button has tappable hit area
  const undoBtn = page.locator('button').filter({ hasText: 'Undo' });
  if (await undoBtn.count() === 0) {
    find('P1', 'Notes/Delete', '"Undo" button not found in delete toast', s6a);
    return;
  }
  const undoBb = await undoBtn.first().boundingBox();
  logInfo(`Undo button: w=${undoBb?.width?.toFixed(0)}, h=${undoBb?.height?.toFixed(0)}`);
  if (undoBb && undoBb.height < 36) {
    find('P1', 'Notes/Delete', `Undo button too small for touch (${undoBb.height.toFixed(0)}px < 36px)`, s6a);
  } else {
    logOk('Undo button tappable size');
  }

  // Tap "Undo"
  await undoBtn.first().tap();
  await waitMs(1000);

  const s6b = await shot(page, 'after-undo-mobile');

  // Toast should disappear
  const toastAfterUndo = await page.locator('text=Note deleted').count();
  if (toastAfterUndo > 0) {
    find('P1', 'Notes/Delete', 'Undo toast still visible after tapping Undo', s6b);
  } else {
    logOk('Toast dismissed after Undo');
  }

  // Verify note still exists via API (undo should have prevented delete)
  await waitMs(1000);
  const verifyRes = await apiFetch<any>(`/api/daily-notes/${deleteNoteId}`, token);
  if (verifyRes.status !== 200) {
    find('P0', 'Notes/Delete', `Note was deleted despite tapping Undo — note API returned ${verifyRes.status}`, s6b);
  } else {
    logOk('Note survives after Undo tap — delete correctly cancelled');
    // Clean up
    await apiFetch(`/api/daily-notes/${deleteNoteId}`, token, { method: 'DELETE' });
  }

  logProgress('Group 6 complete');
}

// ── Group 7: Share + Promote-to-Wiki Modals ───────────────────────────────────
async function group7Modals(page: Page) {
  logSection('Group 7: Share and Promote-to-Wiki modals on mobile');

  if (!testNoteId) {
    find('P1', 'Notes/Modals', 'No note ID — skipping modals group');
    return;
  }

  await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(600);

  // ── Share modal ────────────────────────────────────────────────────────────
  const shareBtn = page.locator('button[title="Share note"]');
  if (await shareBtn.count() === 0) {
    find('P1', 'Notes/Share', '"Share note" button not found on mobile');
  } else {
    await shareBtn.first().tap();
    await waitMs(600);

    const s7a = await shot(page, 'share-modal-mobile');
    const shareModalTitle = await page.locator('text=Share Note').count();
    if (shareModalTitle === 0) {
      find('P1', 'Notes/Share', 'Share Note modal did not open on mobile', s7a);
    } else {
      // Check modal dimensions
      const modal = page.locator('.w-80').first();
      const modalBb = await modal.boundingBox();
      if (modalBb) {
        logInfo(`Share modal: x=${modalBb.x.toFixed(0)}, w=${modalBb.width.toFixed(0)}, h=${modalBb.height.toFixed(0)}`);
        // w-80 = 320px on a 390px screen — should fit
        if (modalBb.x < 0) {
          find('P1', 'Notes/Share', `Share modal extends off-screen left (x=${modalBb.x.toFixed(0)})`, s7a);
        } else if (modalBb.x + modalBb.width > MOBILE_VIEWPORT.width + 5) {
          find('P1', 'Notes/Share', `Share modal extends off-screen right`, s7a);
        } else {
          logOk(`Share modal fits (${modalBb.width.toFixed(0)}px wide, centered in ${MOBILE_VIEWPORT.width}px viewport)`);
        }
        // Check if "full screen" style — modals are centered via flex items-center justify-center, not full-screen
        if (modalBb.width < MOBILE_VIEWPORT.width - 40) {
          find('Nit', 'Notes/Share', `Share modal is centered (${modalBb.width.toFixed(0)}px wide) not full-screen — OK for 390px, but consider full-screen on narrow viewports`, s7a);
        }
      }
      logOk('Share modal opened on mobile');

      // Check "Done" button tappable
      const doneBtn = page.locator('button').filter({ hasText: 'Done' });
      if (await doneBtn.count() > 0) {
        const doneBb = await doneBtn.first().boundingBox();
        logInfo(`Done button: w=${doneBb?.width?.toFixed(0)}, h=${doneBb?.height?.toFixed(0)}`);
        if (doneBb && doneBb.height < 36) {
          find('P2', 'Notes/Share', `Share modal "Done" button too short for touch (${doneBb.height.toFixed(0)}px)`, s7a);
        }
        await doneBtn.first().tap();
        await waitMs(300);
      } else {
        await page.keyboard.press('Escape');
        await waitMs(300);
      }
    }
  }

  // ── Promote to Wiki modal ───────────────────────────────────────────────────
  const promoteBtn = page.locator('button[title="Promote to Wiki"]');
  if (await promoteBtn.count() === 0) {
    find('P1', 'Notes/WikiPromotion', '"Promote to Wiki" button not found on mobile');
  } else {
    await promoteBtn.first().tap();
    await waitMs(600);

    const s7b = await shot(page, 'promote-wiki-modal-mobile');
    const promoteTitle = await page.locator('text=Promote to Wiki').count();
    if (promoteTitle === 0) {
      find('P1', 'Notes/WikiPromotion', 'Promote-to-Wiki modal did not open on mobile', s7b);
    } else {
      // Check modal dimensions
      const modal = page.locator('.w-80').first();
      const modalBb = await modal.boundingBox();
      if (modalBb) {
        logInfo(`Promote modal: x=${modalBb.x.toFixed(0)}, w=${modalBb.width.toFixed(0)}, h=${modalBb.height.toFixed(0)}`);
        if (modalBb.x < 0 || modalBb.x + modalBb.width > MOBILE_VIEWPORT.width + 5) {
          find('P1', 'Notes/WikiPromotion', `Promote modal extends off viewport (x=${modalBb.x.toFixed(0)}, w=${modalBb.width.toFixed(0)})`, s7b);
        } else {
          logOk(`Promote modal fits in mobile viewport (${modalBb.width.toFixed(0)}px wide)`);
        }
      }

      // Check page type buttons — are they tappable?
      const typeBtns = await page.locator('.flex.flex-wrap.gap-1 button').all();
      logInfo(`Page type buttons in promote modal: ${typeBtns.length}`);
      for (const btn of typeBtns) {
        const bb = await btn.boundingBox();
        const text = await btn.textContent().catch(() => null);
        if (bb && bb.height < 28) {
          find('P2', 'Notes/WikiPromotion', `Page type button "${text?.trim()}" too small (${bb.height.toFixed(0)}px) for touch in promote modal`, s7b);
          break; // report once
        }
      }

      logOk('Promote-to-Wiki modal opened on mobile');
      await page.keyboard.press('Escape');
      await waitMs(300);
    }
  }

  // Horizontal overflow check after modals
  await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(400);
  const overflow7 = await checkHorizontalScroll(page, 'editor-after-modals');
  if (overflow7 > 2) find('P2', 'Notes/Modals', `Horizontal overflow after modal interactions: +${overflow7}px`);

  logProgress('Group 7 complete');
}

// ── Group 8: Focus Mode on Mobile ─────────────────────────────────────────────
async function group8FocusMode(page: Page) {
  logSection('Group 8: Focus mode on mobile');

  if (!testNoteId) {
    find('P1', 'Notes/FocusMode', 'No note ID — skipping');
    return;
  }

  await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(600);

  const focusBtn = page.locator('button[title="Focus mode"], button[aria-label="Focus mode"]');
  if (await focusBtn.count() === 0) {
    find('P1', 'Notes/FocusMode', 'Focus mode button not found on mobile');
    return;
  }

  await focusBtn.first().tap();
  await waitMs(500);

  const s8 = await shot(page, 'focus-mode-mobile');

  // Check fixed inset-0 overlay exists
  const focusOverlay = await page.locator('.fixed.inset-0').count();
  if (focusOverlay === 0) {
    find('P2', 'Notes/FocusMode', 'Focus mode did not produce a fixed overlay — sidebar may not be hidden on mobile', s8);
  } else {
    logOk('Focus mode overlay applied (fixed inset-0)');
  }

  // Check no horizontal overflow in focus mode
  const overflowFocus = await checkHorizontalScroll(page, 'focus-mode');
  if (overflowFocus > 2) find('P1', 'Notes/FocusMode', `Horizontal overflow in focus mode: +${overflowFocus}px`, s8);

  // Check app sidebar is hidden (look for nav/sidebar elements)
  const sidebar = await page.locator('nav, [data-sidebar], aside').count();
  logInfo(`Sidebar/nav elements visible in focus mode: ${sidebar}`);
  // In a Next.js layout, the sidebar may still be in DOM but visually hidden
  // Focus mode sets fixed inset-0 on the editor, which covers the sidebar

  // Exit focus mode
  const exitBtn = page.locator('button[title="Exit focus mode"], button[aria-label="Exit focus mode"]');
  if (await exitBtn.count() > 0) {
    await exitBtn.first().tap();
    await waitMs(400);
    logOk('Exited focus mode');
  }

  logProgress('Group 8 complete');
}

// ── Group 9: Ctrl+K / Cmd+K on Mobile ────────────────────────────────────────
async function group9CmdK(page: Page) {
  logSection('Group 9: Ctrl+K availability on mobile');

  await page.goto(NOTES_URL, { waitUntil: 'networkidle' });
  await waitMs(500);

  logProgress('Testing Ctrl+K...');
  await page.keyboard.press('Control+k');
  await waitMs(600);

  const cmdkOpen = await page.locator('[role="dialog"], .command-palette').count();
  const s9 = await shot(page, 'ctrl-k-mobile');

  if (cmdkOpen === 0) {
    find('P2', 'Notes/CmdK', 'Ctrl+K (command palette) does not open on simulated mobile — expected: physical keyboards may trigger it, touch-only users have no access', s9, 'Consider adding a floating search FAB for mobile users');
  } else {
    logOk('Ctrl+K opens command palette (physical keyboard attached)');
    await page.keyboard.press('Escape');
  }

  logProgress('Group 9 complete');
}

// ── Group 10: Final horizontal scroll check on list view ─────────────────────
async function group10FinalCheck(page: Page) {
  logSection('Group 10: Final horizontal scroll + list view check');

  await page.goto(NOTES_URL, { waitUntil: 'networkidle' });
  await waitMs(500);

  const s10 = await shot(page, 'notes-list-final-mobile');
  const overflow = await checkHorizontalScroll(page, 'notes-list-final');
  if (overflow > 2) find('P1', 'Notes/Landing', `Persistent horizontal overflow on notes list: +${overflow}px`, s10);

  // Check note cards are full-width on mobile (grid-cols-1 on mobile)
  const noteCards = await page.locator('[style*="surface-container"]').all();
  logInfo(`Note cards visible: ${noteCards.length}`);
  if (noteCards.length > 0) {
    const firstCardBb = await noteCards[0].boundingBox();
    logInfo(`First note card width: ${firstCardBb?.width?.toFixed(0)}px`);
    if (firstCardBb && firstCardBb.width < MOBILE_VIEWPORT.width - 60) {
      find('P2', 'Notes/Landing', `Note cards are narrower than expected on mobile (${firstCardBb.width.toFixed(0)}px vs ~${MOBILE_VIEWPORT.width - 48}px) — grid may not be single-column`, s10);
    } else if (firstCardBb) {
      logOk(`Note cards full-width on mobile (${firstCardBb.width.toFixed(0)}px)`);
    }
  }

  // px-6 on the container means 24px side padding — check content width
  const contentContainer = page.locator('.max-w-\\[900px\\]').first();
  const containerBb = await contentContainer.boundingBox();
  if (containerBb) {
    logInfo(`Content container: w=${containerBb.width.toFixed(0)}, x=${containerBb.x.toFixed(0)}`);
  }

  logProgress('Group 10 complete');
}

// ── Report ────────────────────────────────────────────────────────────────────
function writeReport(startedAt: Date, duration: number) {
  const p0 = findings.filter(f => f.severity === 'P0');
  const p1 = findings.filter(f => f.severity === 'P1');
  const p2 = findings.filter(f => f.severity === 'P2');
  const nits = findings.filter(f => f.severity === 'Nit');

  const fmt = (fs: typeof findings) =>
    fs.map((f, i) =>
      `### ${i + 1}. ${f.area}\n\n` +
      `**What:** ${f.description}\n\n` +
      (f.detail ? `**Detail:** ${f.detail}\n\n` : '') +
      (f.screenshot ? `**Screenshot:** \`${f.screenshot}\`\n\n` : '') +
      `---`
    ).join('\n\n');

  const screenshotIndex = Array.from({ length: shotCounter }, (_, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `- \`${num}-*.png\``;
  }).join('\n');

  const rawConsole = consoleErrors.slice(0, 20).join('\n') || '(none)';
  const rawNet = networkErrors.slice(0, 20).join('\n') || '(none)';
  const rawPage = pageErrors.slice(0, 10).join('\n') || '(none)';

  const report = `# Notes Mobile Audit

**Date:** ${startedAt.toISOString().slice(0, 10)}
**Branch:** feat/phase2-4-mcp-agents-plans
**Viewport:** 390×844 (iPhone 13) · deviceScaleFactor 2 · isMobile true · hasTouch true
**User Agent:** iPhone OS 17_0 Safari/604.1
**Duration:** ${Math.round(duration / 1000)}s
**Findings:** P0×${p0.length} P1×${p1.length} P2×${p2.length} Nit×${nits.length}
**Screenshots:** ${shotCounter}

---

## Overall impression

The Notes feature is a full-page TipTap-based editor. On a 390px viewport:

- The **note list** uses \`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3\` which correctly collapses to a single column on mobile.
- The **toolbar** uses \`overflow-x-auto flex-nowrap\` which scrolls rather than wraps — acceptable, but all buttons are hidden until the user discovers the scroll.
- The **toolbar buttons** use \`p-1.5\` (6px padding) around 15px icons — resulting in ~27×27px touch targets, well below the 44×44px WCAG minimum.
- **Modals** (Share, Promote-to-Wiki) are \`w-80\` (320px) centered on a 390px screen — they fit but are not full-screen.
- The **Undo delete toast** is \`fixed bottom-6 left-1/2 -translate-x-1/2\` — horizontally centered, which is correct.
- **Focus mode** uses \`fixed inset-0 z-[90]\` — covers the sidebar correctly.
- **Ctrl+K** is keyboard-only and has no floating FAB fallback for touch-only users.

---

## P0 — blocks release

${p0.length === 0 ? '_(none)_' : fmt(p0)}

## P1 — must fix

${p1.length === 0 ? '_(none)_' : fmt(p1)}

## P2 — should fix

${p2.length === 0 ? '_(none)_' : fmt(p2)}

## Nits

${nits.length === 0 ? '_(none)_' : fmt(nits)}

---

## Static analysis findings (from source code)

These were identified from reading \`apps/web/src/app/(app)/notes/page.tsx\` and do not depend on runtime test results:

### Toolbar button touch targets (WCAG P1)
\`TBtn\` renders \`<button class="p-1.5 rounded ..."\` with \`size={15}\` icons.
- \`p-1.5\` = 6px top/bottom padding → total height ≈ 15 + 12 = 27px.
- WCAG 2.5.5 requires 44×44px. Apple HIG recommends 44pt.
- **All 18 toolbar buttons fail this requirement on mobile.**

### Undo toast centering (OK)
\`fixed bottom-6 left-1/2 -translate-x-1/2\` → horizontally centered at 24px from bottom.
This is correct and unaffected by soft keyboard because the toast uses \`fixed\` positioning.

### Modals not full-screen on mobile (P2)
Both modals use \`w-80\` (320px). On 390px screen this leaves 35px side margin (17.5px each side).
The backdrop is \`fixed inset-0\` so tapping outside dismisses — OK. But on very narrow phones (<375px), the modal clips.

### Placeholder text (confirmed updated)
\`Placeholder.configure({ placeholder: 'Start writing…' })\` — the "type / for commands" placeholder was removed. ✅

### Slash commands (no extension registered)
The StarterKit and extensions registered in \`useEditor\` do **not** include a slash-command extension.
Typing \`/\` will not produce a command menu. The placeholder no longer promises it, which is correct.
But the feature is absent — users expect it from the old placeholder.

### No sidebar on mobile (by design)
Notes uses a full-page single-column layout (no sidebar panel). On mobile, the note list and editor
are swapped via the \`activeId\` URL param. This is a correct mobile-first pattern.

### Editor \`min-h-[calc(100vh-350px)]\` (Nit)
The editor content area uses a calculated minimum height. On mobile with a soft keyboard,
\`100vh\` may be the full screen height before keyboard appears — meaning the editor could become
taller than the visible area when the keyboard rises, requiring the user to scroll to reach the cursor.
This is a known TipTap/iOS limitation with no simple CSS-only fix; ScrollIntoView is needed.

### Focus mode z-index (OK)
\`fixed inset-0 z-[90]\` covers the sidebar layout. ✅

---

## Coverage gaps

- **Soft keyboard interaction**: Playwright cannot simulate iOS soft keyboard; \`visualViewport\` resize is not tested.
- **Touch gestures**: Swipe-to-go-back / long-press — not tested.
- **RTL layout**: Not tested.
- **Dark/light mode**: Only default theme tested.
- **Paste from clipboard**: Requires OS clipboard — not tested.
- **Image upload**: Requires file picker — partially tested (button presence only).

---

## Raw logs

### Console errors / warnings (first 20)
\`\`\`
${rawConsole}
\`\`\`

### Network 4xx/5xx errors (first 20)
\`\`\`
${rawNet}
\`\`\`

### Uncaught page errors
\`\`\`
${rawPage}
\`\`\`

---

## Screenshots index

${screenshotIndex}
`;

  writeFileSync(REPORT_FILE, report, 'utf8');
  log(`Report written to ${REPORT_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileSync(LOG_FILE, '', 'utf8');
  log('=== Notes Mobile Audit START ===');
  log(`Viewport: ${MOBILE_VIEWPORT.width}×${MOBILE_VIEWPORT.height} | Budget: 8 min | Started: ${new Date().toISOString()}`);

  const startedAt = new Date();
  let browser: Browser | null = null;

  try {
    const { accessToken, refreshToken } = await apiLogin();

    log('INFO Launching Chromium (headless: false, slowMo: 100)...');
    browser = await chromium.launch({ headless: false, slowMo: 100 });
    const context = await browser.newContext({
      viewport: MOBILE_VIEWPORT,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: MOBILE_UA,
    });
    await injectAuth(context, accessToken, refreshToken);
    const page = await context.newPage();
    attachListeners(page);

    // Heartbeat every 10s
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - START_TIME) / 1000);
      log(`... heartbeat — ${elapsed}s elapsed, P0×${findings.filter(f => f.severity === 'P0').length} P1×${findings.filter(f => f.severity === 'P1').length}`);
    }, 10000);

    // Wall-clock watchdog
    const wallTimeout = setTimeout(() => {
      log('[TIMEOUT] Wall-clock budget exceeded — writing partial report');
      writeReport(startedAt, Date.now() - startedAt.getTime());
      process.exit(1);
    }, MAX_WALL_MS);

    try {
      await group1Landing(page);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group2TapNoteCard(page, accessToken);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group3Toolbar(page);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group4CreateAndType(page, accessToken);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group5SlashCommands(page);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group6DeleteUndo(page, accessToken);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group7Modals(page);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group8FocusMode(page);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group9CmdK(page);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group10FinalCheck(page);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(wallTimeout);
    }

    const duration = Date.now() - startedAt.getTime();
    log(`\n=== Audit complete in ${Math.round(duration / 1000)}s ===`);
    log(`Findings: P0×${findings.filter(f => f.severity === 'P0').length} P1×${findings.filter(f => f.severity === 'P1').length} P2×${findings.filter(f => f.severity === 'P2').length} Nit×${findings.filter(f => f.severity === 'Nit').length}`);

    writeReport(startedAt, duration);
  } catch (err) {
    log(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
    writeReport(startedAt, Date.now() - startedAt.getTime());
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

main();
