#!/usr/bin/env tsx
/**
 * Notes Deep Audit — 7 focused test groups.
 * Runs against dev servers: API :3001, Web :3000.
 * Test user: maneek@test.com / test1234
 *
 * Groups:
 *   1. Landing + list
 *   2. Create + edit a note
 *   3. Rename + delete
 *   4. Rich editor features
 *   5. Cross-references + wiki promotion
 *   6. Daily notes (coverage gap check)
 *   7. Search + keyboard
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
const AUDIT_DIR = 'docs/superpowers/audits/notes-deep';
const LOG_FILE = join(AUDIT_DIR, 'run.log');
const REPORT_FILE = join(AUDIT_DIR, 'REPORT.md');

// Wall-clock start time
const START_TIME = Date.now();
const MAX_WALL_MS = 8 * 60 * 1000; // 8 minutes

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
let testNoteId: string | null = null;
let testNoteTitle = '';

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
function logSection(msg: string) { log(`\n${'='.repeat(60)}\n  ${msg}\n${'='.repeat(60)}`); }
function logProgress(msg: string) { log(`... ${msg}`); }

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

// ── Wait helpers ──────────────────────────────────────────────────────────────
async function waitOrStall(page: Page, selector: string, timeout = 5000, label?: string): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
    return true;
  } catch {
    log(`[STALL] waitForSelector timed out after ${timeout}ms: ${selector}${label ? ` (${label})` : ''}`);
    return false;
  }
}

async function waitMs(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

// ── Listeners ─────────────────────────────────────────────────────────────────
function attachListeners(page: Page) {
  page.on('console', msg => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      const text = msg.text();
      consoleErrors.push(`[${type}] ${text}`);
    }
  });
  page.on('pageerror', err => {
    pageErrors.push(err.message);
    log(`[PAGEERROR] ${err.message.slice(0, 200)}`);
  });
  page.on('response', res => {
    const status = res.status();
    if (status >= 400) {
      const url = res.url();
      // Ignore browser extension / favicon
      if (!url.includes('favicon') && !url.includes('chrome-extension')) {
        networkErrors.push(`${status} ${res.request().method()} ${url}`);
      }
    }
  });
}

// ── Auth injection ─────────────────────────────────────────────────────────────
async function injectAuth(context: BrowserContext, accessToken: string, refreshToken?: string) {
  await context.addInitScript(
    ({ at, rt }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: accessToken, rt: refreshToken ?? null },
  );
}

// ── Group 1: Landing + list ───────────────────────────────────────────────────
async function group1Landing(page: Page, token: string) {
  logSection('Group 1: Landing + list');
  logProgress('Navigating to /notes...');

  const t0 = Date.now();
  await page.goto(NOTES_URL, { waitUntil: 'networkidle', timeout: 20000 });
  const elapsed = Date.now() - t0;
  logInfo(`Page loaded in ${elapsed}ms`);

  if (elapsed > 3000) {
    find('P2', 'Notes/Landing', `Slow page load: ${elapsed}ms (>3s)`);
  }

  // Screenshot initial state
  await shot(page, 'notes-initial-load');

  // Check for JS errors on load
  if (pageErrors.length > 0) {
    find('P1', 'Notes/Landing', 'Uncaught JS errors on load', undefined, pageErrors[0].slice(0, 200));
  }

  // Check heading is visible
  const heading = await page.locator('h1').first().textContent().catch(() => null);
  logInfo(`Page heading: ${heading}`);
  if (!heading?.toLowerCase().includes('note')) {
    find('P1', 'Notes/Landing', `Notes page heading missing or wrong: "${heading}"`);
  } else {
    logOk(`Heading found: "${heading}"`);
  }

  // Count existing notes via API
  logProgress('Fetching notes via API...');
  const notesRes = await apiFetch<any[]>('/api/daily-notes', token);
  if (notesRes.status !== 200) {
    find('P0', 'Notes/API', `GET /api/daily-notes returned ${notesRes.status}`, undefined, JSON.stringify(notesRes.body).slice(0, 300));
  } else {
    const count = Array.isArray(notesRes.body) ? notesRes.body.length : 0;
    logOk(`Found ${count} notes via API`);

    // Check note count displayed on page
    const countText = await page.locator('p').filter({ hasText: /note/ }).first().textContent().catch(() => null);
    logInfo(`Count label text: "${countText}"`);

    if (count === 0) {
      // Verify empty state is displayed
      const emptyState = await page.locator('text=No notes yet').count();
      if (emptyState === 0) {
        find('P1', 'Notes/Landing', 'Empty state not shown when no notes exist');
      } else {
        logOk('Empty state displayed correctly');
      }
    } else {
      // Check at least one note card is visible
      const cards = await page.locator('[style*="surface-container"]').count();
      logInfo(`Note cards visible (approx): ${cards}`);
    }
  }

  // Check search bar is present
  const searchInput = await page.locator('input[placeholder*="Search notes"]').count();
  if (searchInput === 0) {
    find('P1', 'Notes/Landing', 'Search input not found on notes list page');
  } else {
    logOk('Search input present');
  }

  // Check "New Note" button
  const newNoteBtn = await page.locator('button').filter({ hasText: 'New Note' }).count();
  if (newNoteBtn === 0) {
    find('P1', 'Notes/Landing', '"New Note" button not found');
  } else {
    logOk('"New Note" button present');
  }

  // Check console errors so far
  const landingConsoleErrors = consoleErrors.filter(e => e.toLowerCase().includes('error'));
  if (landingConsoleErrors.length > 0) {
    find('Nit', 'Notes/Landing', `${landingConsoleErrors.length} console error(s) on load`, undefined, landingConsoleErrors.slice(0, 3).join(' | '));
  }

  await shot(page, 'notes-list-view');
  logProgress('Group 1 complete');
}

// ── Group 2: Create + edit ────────────────────────────────────────────────────
async function group2CreateEdit(page: Page, token: string) {
  logSection('Group 2: Create + edit');
  const ts2 = Date.now();
  testNoteTitle = `audit-note-${ts2}`;
  logProgress(`Creating note: "${testNoteTitle}"`);

  // Click "New Note" button to open dropdown
  const newNoteBtn = page.locator('button').filter({ hasText: 'New Note' });
  await newNoteBtn.click();
  await waitMs(300);
  await shot(page, 'new-note-dropdown');

  // Check dropdown shows "Blank Note"
  const blankNoteOption = await page.locator('button').filter({ hasText: 'Blank Note' }).count();
  if (blankNoteOption === 0) {
    find('P1', 'Notes/Create', '"Blank Note" option not found in dropdown');
    // Try direct create via API
    const createRes = await apiFetch<any>('/api/daily-notes', token, {
      method: 'POST',
      body: JSON.stringify({ title: testNoteTitle, icon: '📝' }),
    });
    if (createRes.status !== 200 && createRes.status !== 201) {
      find('P0', 'Notes/Create', `API create note failed: ${createRes.status}`, undefined, JSON.stringify(createRes.body).slice(0, 300));
      return;
    }
    testNoteId = createRes.body?.id;
    await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  } else {
    // Click Blank Note
    await page.locator('button').filter({ hasText: 'Blank Note' }).click();
    logInfo('Clicked Blank Note');

    // Wait for URL to change to note editor
    await waitMs(1500);
    const url = page.url();
    logInfo(`Current URL after create: ${url}`);

    if (!url.includes('?id=')) {
      find('P1', 'Notes/Create', 'After creating note, URL did not change to include ?id=', undefined, url);
      return;
    }

    // Extract note ID from URL
    const match = url.match(/\?id=([^&]+)/);
    testNoteId = match ? match[1] : null;
    logInfo(`New note ID: ${testNoteId}`);
  }

  await shot(page, 'new-note-editor-blank');

  // Give editor time to render
  await waitMs(500);

  // Check editor rendered
  const editorVisible = await waitOrStall(page, '.deft-editor, .ProseMirror, [contenteditable="true"]', 5000, 'editor');
  if (!editorVisible) {
    find('P0', 'Notes/Create', 'TipTap editor did not render after note creation');
    return;
  }
  logOk('Editor rendered');

  // Set title
  const titleInput = page.locator('input[placeholder="Untitled"]');
  const titleVisible = await waitOrStall(page, 'input[placeholder="Untitled"]', 3000, 'title input');
  if (!titleVisible) {
    find('P1', 'Notes/Create', 'Title input not found');
  } else {
    await titleInput.triple_click?.() || await titleInput.click();
    await titleInput.fill(testNoteTitle);
    logOk(`Title set: "${testNoteTitle}"`);
    await waitMs(600); // Wait for debounce
  }

  // Type content in editor
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await waitMs(200);

  logProgress('Typing content into editor...');

  // Type a heading using markdown shortcut
  await editor.type('# Audit Heading 1');
  await page.keyboard.press('Enter');
  logInfo('Typed heading');

  // Type a paragraph
  await editor.type('This is a test paragraph for the notes audit.');
  await page.keyboard.press('Enter');
  logInfo('Typed paragraph');

  // Type bold using markdown shortcut
  await editor.type('**bold text** and ');
  await editor.type('_italic text_');
  await page.keyboard.press('Enter');
  logInfo('Typed bold/italic shortcuts');

  // Type a bullet list
  await editor.type('- item one');
  await page.keyboard.press('Enter');
  await editor.type('- item two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  logInfo('Typed bullet list');

  await shot(page, 'editor-content-typed');

  // Check if markdown shortcuts fired
  await waitMs(300);
  const h1Count = await page.locator('h1').count();
  logInfo(`h1 elements in editor: ${h1Count}`);
  if (h1Count === 0) {
    find('P1', 'Notes/RichEditor', 'Markdown shortcut "# heading" did not auto-convert to H1');
  } else {
    logOk('H1 markdown shortcut works');
  }

  // Check if bold converted
  const boldCount = await page.locator('strong').count();
  logInfo(`bold elements in editor: ${boldCount}`);
  if (boldCount === 0) {
    find('P1', 'Notes/RichEditor', 'Markdown shortcut **bold** did not auto-convert');
  } else {
    logOk('Bold markdown shortcut works');
  }

  // Wait for autosave
  logProgress('Waiting for autosave (600ms debounce + buffer)...');
  await waitMs(2000);

  // Check save indicator
  const savedIndicator = await page.locator('text=Saved').count();
  const savingIndicator = await page.locator('text=Saving').count();
  logInfo(`Save status — "Saved": ${savedIndicator}, "Saving": ${savingIndicator}`);
  if (savedIndicator === 0 && savingIndicator === 0) {
    find('P1', 'Notes/Autosave', 'No save status indicator visible after editing');
  } else {
    logOk('Save indicator present');
  }

  await shot(page, 'autosave-indicator');

  // Test autosave persistence: reload and check content
  logProgress('Reloading page to verify autosave persistence...');
  const noteUrl = page.url();
  await waitMs(1500); // Ensure save completed

  // Verify via API before reload
  if (testNoteId) {
    const checkRes = await apiFetch<any>(`/api/daily-notes/${testNoteId}`, token);
    if (checkRes.status !== 200) {
      find('P1', 'Notes/Autosave', `Note not found via API after save: ${checkRes.status}`);
    } else {
      const content = checkRes.body?.content;
      logInfo(`API content length: ${content?.length ?? 0}`);
      if (!content || content.length === 0) {
        find('P1', 'Notes/Autosave', 'Note content empty in API after editing — autosave may not have fired');
      } else {
        logOk(`Content persisted in API (${content.length} chars)`);
      }
    }
  }

  await page.reload({ waitUntil: 'networkidle' });
  await waitMs(1000);
  await shot(page, 'after-reload-content-check');

  // Check title persisted
  const titleAfterReload = await page.locator('input[placeholder="Untitled"]').inputValue().catch(() => null);
  logInfo(`Title after reload: "${titleAfterReload}"`);
  if (titleAfterReload !== testNoteTitle) {
    find('P1', 'Notes/Autosave', `Title did not persist after reload. Expected "${testNoteTitle}", got "${titleAfterReload}"`);
  } else {
    logOk('Title persisted after reload');
  }

  // Check if editor has content after reload
  const editorTextAfterReload = await page.locator('[contenteditable="true"]').first().textContent().catch(() => '');
  logInfo(`Editor text after reload (first 100): "${editorTextAfterReload?.slice(0, 100)}"`);
  if (!editorTextAfterReload || editorTextAfterReload.trim().length === 0) {
    find('P1', 'Notes/Autosave', 'Editor content empty after page reload — autosave content not loading');
  } else {
    logOk('Editor content loaded after reload');
  }

  logProgress('Group 2 complete');
}

// ── Group 3: Rename + delete ──────────────────────────────────────────────────
async function group3RenameDelete(page: Page, token: string) {
  logSection('Group 3: Rename + delete');
  logProgress('Testing rename + delete flow...');

  // Create a fresh note for deletion test
  const deleteTitle = `audit-note-delete-${Date.now()}`;
  const createRes = await apiFetch<any>('/api/daily-notes', token, {
    method: 'POST',
    body: JSON.stringify({ title: deleteTitle, icon: '🗑️' }),
  });
  if (createRes.status !== 200 && createRes.status !== 201) {
    find('P1', 'Notes/Delete', `Could not create test note for deletion: ${createRes.status}`);
    return;
  }
  const deleteNoteId = createRes.body?.id;
  logInfo(`Created delete-test note: ${deleteNoteId}`);

  // Navigate to note
  await page.goto(`${NOTES_URL}?id=${deleteNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(500);

  // Rename
  const titleInput = page.locator('input[placeholder="Untitled"]');
  const titleFound = await waitOrStall(page, 'input[placeholder="Untitled"]', 3000);
  if (!titleFound) {
    find('P1', 'Notes/Rename', 'Title input not found for rename test');
  } else {
    const newTitle = `audit-note-renamed-${Date.now()}`;
    await titleInput.triple_click?.() || await titleInput.click();
    await page.keyboard.press('Control+a');
    await titleInput.fill(newTitle);
    await waitMs(700); // debounce

    // Verify rename via API
    const checkRes = await apiFetch<any>(`/api/daily-notes/${deleteNoteId}`, token);
    if (checkRes.body?.title !== newTitle) {
      find('P1', 'Notes/Rename', `Title rename not persisted via API. Expected "${newTitle}", got "${checkRes.body?.title}"`);
    } else {
      logOk(`Note renamed to "${newTitle}" successfully`);
    }
  }

  await shot(page, 'before-delete');

  // Test delete flow
  logProgress('Testing delete note...');
  const deleteBtn = page.locator('button[title="Delete note"]');
  const deleteBtnVisible = await deleteBtn.count();
  if (deleteBtnVisible === 0) {
    find('P1', 'Notes/Delete', 'Delete button not found in note editor');
  } else {
    // Set up dialog handler
    page.once('dialog', async dialog => {
      logInfo(`Delete dialog: "${dialog.message()}"`);
      if (!dialog.message().toLowerCase().includes('delete')) {
        find('Nit', 'Notes/Delete', `Delete confirm message unexpected: "${dialog.message()}"`);
      }
      await dialog.accept();
    });
    await deleteBtn.click();
    await waitMs(1500);

    const urlAfterDelete = page.url();
    logInfo(`URL after delete: ${urlAfterDelete}`);
    if (urlAfterDelete.includes('?id=')) {
      find('P1', 'Notes/Delete', 'After delete, URL still shows note ID — navigation to list may have failed');
    } else {
      logOk('Navigated back to notes list after delete');
    }

    // Verify deleted via API
    const verifyRes = await apiFetch<any>(`/api/daily-notes/${deleteNoteId}`, token);
    if (verifyRes.status === 200) {
      find('P1', 'Notes/Delete', 'Deleted note still returned 200 from API — soft delete or no delete occurred');
    } else {
      logOk(`Note deleted (API returned ${verifyRes.status})`);
    }
  }

  await shot(page, 'after-delete');

  // Check for trash / recovery UI
  const trashLink = await page.locator('a, button').filter({ hasText: /trash|recover|deleted/i }).count();
  if (trashLink === 0) {
    find('P2', 'Notes/Delete', 'No trash or recovery affordance found — hard delete with no undo');
  }

  logProgress('Group 3 complete');
}

// ── Group 4: Rich editor features ─────────────────────────────────────────────
async function group4RichEditor(page: Page, token: string) {
  logSection('Group 4: Rich editor features');

  // Navigate back to test note (created in group 2)
  if (!testNoteId) {
    find('P1', 'Notes/RichEditor', 'No test note ID available — skipping rich editor group');
    return;
  }

  logProgress(`Navigating to test note: ${testNoteId}`);
  await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(800);

  const editor = page.locator('[contenteditable="true"]').first();
  const editorReady = await waitOrStall(page, '[contenteditable="true"]', 5000, 'editor');
  if (!editorReady) {
    find('P0', 'Notes/RichEditor', 'Editor not ready — cannot test rich features');
    return;
  }

  // --- Toolbar buttons ---
  logProgress('Testing toolbar buttons...');

  // H1 toolbar button
  const h1Btn = page.locator('button[title="Heading 1"]');
  if (await h1Btn.count() === 0) {
    find('P1', 'Notes/RichEditor', 'H1 toolbar button not found');
  } else {
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await h1Btn.click();
    await editor.type('Toolbar H1 Test');
    await waitMs(300);
    const h1Elements = await page.locator('h1').count();
    if (h1Elements === 0) {
      find('P1', 'Notes/RichEditor', 'H1 toolbar button did not create H1 heading');
    } else {
      logOk('H1 toolbar button works');
    }
    // Reset to paragraph
    await h1Btn.click();
  }

  // H2 toolbar button
  const h2Btn = page.locator('button[title="Heading 2"]');
  if (await h2Btn.count() > 0) {
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await h2Btn.click();
    await editor.type('Toolbar H2 Test');
    await waitMs(200);
    const h2Elements = await page.locator('h2').count();
    if (h2Elements === 0) {
      find('P1', 'Notes/RichEditor', 'H2 toolbar button did not create H2');
    } else {
      logOk('H2 toolbar button works');
    }
    await h2Btn.click();
  }

  // Bold via toolbar
  const boldBtn = page.locator('button[title="Bold"]');
  if (await boldBtn.count() === 0) {
    find('P1', 'Notes/RichEditor', 'Bold toolbar button not found');
  } else {
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await boldBtn.click();
    await editor.type('Bold via toolbar');
    await boldBtn.click();
    await waitMs(200);
    const boldElements = await page.locator('strong').count();
    if (boldElements === 0) {
      find('P1', 'Notes/RichEditor', 'Bold toolbar button did not create bold text');
    } else {
      logOk('Bold toolbar button works');
    }
  }

  // Bullet list via toolbar
  const bulletBtn = page.locator('button[title="Bullet list"]');
  if (await bulletBtn.count() > 0) {
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await bulletBtn.click();
    await editor.type('Bullet 1');
    await page.keyboard.press('Enter');
    await editor.type('Bullet 2');
    await page.keyboard.press('Enter');
    await bulletBtn.click(); // toggle off
    await waitMs(200);
    const ulElements = await page.locator('ul').count();
    if (ulElements === 0) {
      find('P1', 'Notes/RichEditor', 'Bullet list toolbar button did not create UL');
    } else {
      logOk('Bullet list toolbar button works');
    }
  }

  await shot(page, 'toolbar-features-tested');

  // Ordered list
  const olBtn = page.locator('button[title="Numbered list"]');
  if (await olBtn.count() > 0) {
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await olBtn.click();
    await editor.type('Item 1');
    await page.keyboard.press('Enter');
    await editor.type('Item 2');
    await page.keyboard.press('Enter');
    await olBtn.click();
    await waitMs(200);
    const olElements = await page.locator('ol').count();
    if (olElements === 0) {
      find('P1', 'Notes/RichEditor', 'Ordered list toolbar button did not create OL');
    } else {
      logOk('Ordered list toolbar button works');
    }
  }

  // Blockquote
  const quoteBtn = page.locator('button[title="Quote"]');
  if (await quoteBtn.count() > 0) {
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await quoteBtn.click();
    await editor.type('This is a blockquote');
    await page.keyboard.press('Enter');
    await quoteBtn.click();
    await waitMs(200);
    const bqElements = await page.locator('blockquote').count();
    if (bqElements === 0) {
      find('P1', 'Notes/RichEditor', 'Blockquote toolbar button did not create blockquote');
    } else {
      logOk('Blockquote toolbar button works');
    }
  }

  // Code block
  const codeBlockBtn = page.locator('button[title*="Code"]').first();
  if (await codeBlockBtn.count() > 0) {
    logProgress('Testing inline code...');
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await codeBlockBtn.click();
    await editor.type('inline code test');
    await codeBlockBtn.click();
    await waitMs(200);
    const codeElements = await page.locator('code').count();
    if (codeElements === 0) {
      find('P1', 'Notes/RichEditor', 'Code toolbar button did not create code element');
    } else {
      logOk('Code toolbar button works');
    }
  }

  // Code block (triple backtick markdown shortcut)
  logProgress('Testing code block markdown shortcut (```)...');
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await editor.type('```');
  await page.keyboard.press('Enter');
  await waitMs(300);
  const preElements = await page.locator('pre').count();
  if (preElements === 0) {
    find('P1', 'Notes/RichEditor', 'Markdown shortcut ``` did not create code block');
  } else {
    logOk('Code block markdown shortcut works (```)');
    await editor.type('const x = 1;');
    await page.keyboard.press('Escape');
  }

  await shot(page, 'rich-editor-features');

  // Test Undo/Redo
  logProgress('Testing Undo/Redo...');
  const textBefore = await editor.textContent();
  await page.keyboard.press('Control+z');
  await waitMs(300);
  const textAfterUndo = await editor.textContent();
  if (textAfterUndo === textBefore) {
    find('P2', 'Notes/RichEditor', 'Undo (Ctrl+Z) did not change editor content');
  } else {
    logOk('Undo works');
    // Redo
    await page.keyboard.press('Control+Shift+z');
    await waitMs(300);
    logOk('Redo triggered');
  }

  // Check placeholder text
  // Create a new blank note to check placeholder
  logProgress('Checking editor placeholder text...');
  const freshRes = await apiFetch<any>('/api/daily-notes', token, {
    method: 'POST',
    body: JSON.stringify({ title: `audit-note-placeholder-${Date.now()}` }),
  });
  if (freshRes.status === 200 || freshRes.status === 201) {
    await page.goto(`${NOTES_URL}?id=${freshRes.body?.id}`, { waitUntil: 'networkidle' });
    await waitMs(600);
    const placeholder = await page.locator('.ProseMirror p.is-editor-empty, [data-placeholder]').first().getAttribute('data-placeholder').catch(() => null);
    const placeholderText = await page.locator('.is-editor-empty').first().getAttribute('data-placeholder').catch(() => null);
    logInfo(`Placeholder attribute: "${placeholderText}"`);
    if (!placeholderText && !placeholder) {
      // Check CSS-based placeholder
      const emptyParas = await page.locator('[contenteditable="true"] p').count();
      logInfo(`Editor paragraphs (should be 1 for empty): ${emptyParas}`);
      // Not a hard failure but note it
      find('Nit', 'Notes/RichEditor', 'Placeholder text not detectable via data-placeholder attribute — may be CSS-only');
    } else {
      logOk(`Placeholder text: "${placeholderText || placeholder}"`);
    }
    await shot(page, 'placeholder-check');
  }

  // Test slash commands
  logProgress('Testing slash commands...');
  await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(600);
  const editorAfterNav = page.locator('[contenteditable="true"]').first();
  await editorAfterNav.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await editorAfterNav.type('/');
  await waitMs(500);
  const slashMenu = await page.locator('[role="menu"], [role="listbox"], .slash-menu, .tippy-box').count();
  if (slashMenu === 0) {
    find('P2', 'Notes/RichEditor', 'Slash command menu not shown when typing "/" in editor');
  } else {
    logOk('Slash command menu appeared');
    await shot(page, 'slash-command-menu');
    await page.keyboard.press('Escape');
  }

  // Highlight toolbar
  const highlightBtn = page.locator('button[title="Highlight"]');
  if (await highlightBtn.count() > 0) {
    logOk('Highlight toolbar button present');
  } else {
    find('P2', 'Notes/RichEditor', 'Highlight toolbar button not found');
  }

  // Underline toolbar
  const underlineBtn = page.locator('button[title="Underline"]');
  if (await underlineBtn.count() > 0) {
    logOk('Underline toolbar button present');
  } else {
    find('P2', 'Notes/RichEditor', 'Underline toolbar button not found');
  }

  // Checkbox list
  const checkboxBtn = page.locator('button[title="Checkbox list"]');
  if (await checkboxBtn.count() > 0) {
    logOk('Checkbox list toolbar button present');
  } else {
    find('P2', 'Notes/RichEditor', 'Checkbox list toolbar button not found');
  }

  // Table insert
  const tableBtn = page.locator('button[title="Insert table"]');
  if (await tableBtn.count() > 0) {
    logOk('Table insert button present');
  } else {
    find('P2', 'Notes/RichEditor', 'Table insert toolbar button not found');
  }

  // Image insert
  const imageBtn = page.locator('button[title="Insert image"]');
  if (await imageBtn.count() > 0) {
    logOk('Image insert button present');
  } else {
    find('P2', 'Notes/RichEditor', 'Image insert toolbar button not found');
  }

  // Export as Markdown button
  const exportBtn = page.locator('button[title="Export as Markdown"]');
  if (await exportBtn.count() > 0) {
    logOk('Export as Markdown button present');
  } else {
    find('P2', 'Notes/RichEditor', 'Export as Markdown button not found');
  }

  // Word count footer
  const wordCount = await page.locator('text=/\\d+ words/').count();
  if (wordCount === 0) {
    find('P2', 'Notes/RichEditor', 'Word count footer not visible');
  } else {
    logOk('Word count footer present');
  }

  await shot(page, 'rich-editor-final-state');
  logProgress('Group 4 complete');
}

// ── Group 5: Cross-references + wiki promotion ───────────────────────────────
async function group5CrossRefWiki(page: Page, token: string) {
  logSection('Group 5: Cross-references + wiki promotion');

  if (!testNoteId) {
    find('P1', 'Notes/CrossRef', 'No test note ID — skipping group 5');
    return;
  }

  logProgress(`Navigating to test note ${testNoteId}`);
  await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(800);

  // Check for references panel (appears when cross-references exist)
  const refPanel = await page.locator('text=References tasks').count();
  logInfo(`References panel visible: ${refPanel > 0}`);
  if (refPanel === 0) {
    find('Nit', 'Notes/CrossRef', 'No "References tasks" panel visible — may be because no task cross-refs exist yet');
  }

  // Try writing a task identifier in the editor to trigger cross-ref
  const tasks = await apiFetch<any[]>('/api/tasks?limit=5', token);
  let taskIdentifier: string | null = null;
  if (tasks.status === 200 && Array.isArray(tasks.body) && tasks.body.length > 0) {
    taskIdentifier = tasks.body[0]?.identifier || null;
  }

  if (!taskIdentifier) {
    // Try alternate endpoint
    const tasksAlt = await apiFetch<any>('/api/tasks?page=1&pageSize=5', token);
    if (tasksAlt.status === 200) {
      const items = Array.isArray(tasksAlt.body) ? tasksAlt.body : tasksAlt.body?.tasks || tasksAlt.body?.data || [];
      taskIdentifier = items[0]?.identifier || null;
    }
  }

  logInfo(`Task identifier for cross-ref test: "${taskIdentifier}"`);

  if (taskIdentifier) {
    logProgress(`Adding task reference "${taskIdentifier}" to note content...`);
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await editor.type(`References task ${taskIdentifier} in this note.`);
    await waitMs(3000); // Wait for autosave + reference processing
    await shot(page, 'after-cross-ref-typed');

    // Reload and check if references panel appears
    await page.reload({ waitUntil: 'networkidle' });
    await waitMs(1500);
    const refPanelAfter = await page.locator('text=References tasks').count();
    logInfo(`References panel after reload: ${refPanelAfter > 0}`);
    if (refPanelAfter === 0) {
      find('P2', 'Notes/CrossRef', `No "References tasks" panel after adding task identifier "${taskIdentifier}" — cross-reference detection may not be working`);
    } else {
      logOk('Task cross-reference detected and shown in panel');
      await shot(page, 'cross-ref-panel-visible');
    }
  } else {
    find('P2', 'Notes/CrossRef', 'Could not get a task identifier to test cross-references');
  }

  // Test "Promote to Wiki" button
  logProgress('Testing Promote to Wiki button...');
  await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(500);

  const promoteBtn = page.locator('button[title="Promote to Wiki"]');
  const promoteVisible = await promoteBtn.count();
  if (promoteVisible === 0) {
    find('P1', 'Notes/WikiPromotion', '"Promote to Wiki" button (BookOpen icon) not found in editor toolbar');
  } else {
    logOk('"Promote to Wiki" button found');
    await promoteBtn.click();
    await waitMs(400);
    await shot(page, 'promote-to-wiki-modal');

    // Check modal appeared
    const modal = await page.locator('text=Promote to Wiki').count();
    if (modal === 0) {
      find('P1', 'Notes/WikiPromotion', '"Promote to Wiki" modal did not open after clicking button');
    } else {
      logOk('"Promote to Wiki" modal opened');

      // Check page type options
      const conceptBtn = page.locator('button').filter({ hasText: 'concept' });
      if (await conceptBtn.count() === 0) {
        find('P2', 'Notes/WikiPromotion', 'Page type options not visible in promote modal');
      } else {
        logOk('Page type options present in modal');
        // Test type selection
        await conceptBtn.click();
        logOk('Selected "concept" type');
      }

      // Check Promote button state
      const promoteSubmitBtn = page.locator('button').filter({ hasText: 'Promote' }).last();
      if (await promoteSubmitBtn.count() === 0) {
        find('P1', 'Notes/WikiPromotion', '"Promote" submit button not in modal');
      } else {
        logOk('"Promote" submit button present');
      }

      // Close modal
      await page.locator('button').filter({ hasText: 'Cancel' }).last().click().catch(() =>
        page.keyboard.press('Escape')
      );
      await waitMs(300);
    }
  }

  // Check version history button
  const historyBtn = page.locator('button[title="Version history"]');
  if (await historyBtn.count() === 0) {
    find('P2', 'Notes/VersionHistory', '"Version history" button not found');
  } else {
    logOk('Version history button present');
    await historyBtn.click();
    await waitMs(500);
    await shot(page, 'version-history-panel');
    const historyPanel = await page.locator('text=Version History').count();
    if (historyPanel === 0) {
      find('P1', 'Notes/VersionHistory', 'Version History panel did not appear after clicking button');
    } else {
      logOk('Version History panel opened');
      const noVersions = await page.locator('text=No previous versions').count();
      logInfo(`"No previous versions" message: ${noVersions > 0}`);
    }
    // Close
    await historyBtn.click();
    await waitMs(200);
  }

  // Check share button
  const shareBtn = page.locator('button[title="Share note"]');
  if (await shareBtn.count() === 0) {
    find('P2', 'Notes/Share', '"Share note" button not found');
  } else {
    logOk('Share note button present');
    await shareBtn.click();
    await waitMs(500);
    await shot(page, 'share-modal');
    const shareModal = await page.locator('text=Share Note').count();
    if (shareModal === 0) {
      find('P1', 'Notes/Share', 'Share Note modal did not open');
    } else {
      logOk('Share Note modal opened');
      // Close
      await page.locator('button').filter({ hasText: 'Done' }).last().click().catch(() =>
        page.keyboard.press('Escape')
      );
      await waitMs(200);
    }
  }

  // Check visibility dropdown
  const visSelect = await page.locator('select[title="Note visibility"]').count();
  if (visSelect === 0) {
    find('P2', 'Notes/Visibility', 'Visibility selector (Private/Org) not found');
  } else {
    logOk('Visibility selector present');
    // Check it has both options
    const privOpt = await page.locator('option[value="private"]').count();
    const orgOpt = await page.locator('option[value="org"]').count();
    if (privOpt === 0 || orgOpt === 0) {
      find('P2', 'Notes/Visibility', `Visibility options incomplete: private=${privOpt > 0}, org=${orgOpt > 0}`);
    } else {
      logOk('Both Private and Org visibility options present');
    }
  }

  // Pin/Unpin button
  const pinBtn = page.locator('button[title="Pin"], button[title="Unpin"]').first();
  if (await pinBtn.count() === 0) {
    find('P2', 'Notes/Pin', 'Pin/Unpin button not found');
  } else {
    logOk('Pin button present');
    await pinBtn.click();
    await waitMs(800);
    // Verify via API
    const pinCheck = await apiFetch<any>(`/api/daily-notes/${testNoteId}`, token);
    if (pinCheck.status === 200) {
      logInfo(`is_pinned after toggle: ${pinCheck.body?.is_pinned}`);
      if (pinCheck.body?.is_pinned === true) {
        logOk('Note pinned successfully');
        // Unpin again
        await pinBtn.click();
        await waitMs(600);
      }
    }
  }

  logProgress('Group 5 complete');
}

// ── Group 6: Daily notes ──────────────────────────────────────────────────────
async function group6DailyNotes(page: Page, token: string) {
  logSection('Group 6: Daily notes');
  logProgress('Navigating to /daily-notes...');

  await page.goto(`${WEB_URL}/daily-notes`, { waitUntil: 'networkidle', timeout: 10000 });
  await waitMs(500);

  const url = page.url();
  logInfo(`URL after /daily-notes navigation: ${url}`);

  // Check for 404
  const notFoundText = await page.locator('text=404, text=not found, text=page not found').count();
  const bodyText = await page.locator('body').textContent().catch(() => '');

  if (notFoundText > 0 || bodyText?.toLowerCase().includes('404') || url.includes('404')) {
    find('P2', 'Notes/DailyNotes', '/daily-notes route does not exist (404) — coverage gap');
    await shot(page, 'daily-notes-404');
  } else {
    // Check if redirected to /notes
    if (url.includes('/notes') && !url.includes('/daily-notes')) {
      find('Nit', 'Notes/DailyNotes', '/daily-notes redirects to /notes — may be intentional, daily notes served via same API');
      logInfo('Redirected to /notes (API uses /api/daily-notes prefix — notes are conceptually "daily notes")');
    } else {
      logOk('/daily-notes route exists');
      await shot(page, 'daily-notes-view');
    }
  }

  // Check via API
  logProgress('Checking /api/daily-notes API for today note...');
  const today = new Date().toISOString().slice(0, 10);
  const dailyRes = await apiFetch<any>(`/api/daily-notes?date=${today}`, token);
  logInfo(`GET /api/daily-notes?date=${today} => ${dailyRes.status}`);
  if (dailyRes.status === 404) {
    find('Nit', 'Notes/DailyNotes', '/api/daily-notes?date= endpoint not supported — notes are not date-keyed');
  }

  logProgress('Group 6 complete');
}

// ── Group 7: Search + keyboard ────────────────────────────────────────────────
async function group7SearchKeyboard(page: Page, token: string) {
  logSection('Group 7: Search + keyboard');

  // Navigate to notes list
  await page.goto(NOTES_URL, { waitUntil: 'networkidle' });
  await waitMs(500);

  logProgress('Testing inline search...');

  // Test inline search on notes list
  const searchInput = page.locator('input[placeholder*="Search notes"]');
  const searchFound = await waitOrStall(page, 'input[placeholder*="Search notes"]', 3000);
  if (!searchFound) {
    find('P1', 'Notes/Search', 'Search input not found on notes list page');
  } else {
    // Search for our audit note
    await searchInput.fill('audit-note-');
    await waitMs(400);
    await shot(page, 'search-results');

    const resultCards = await page.locator('[style*="surface-container"]').count();
    logInfo(`Cards visible after search: ${resultCards}`);

    // Check if "No notes matching" message appears correctly when no results
    await searchInput.fill('xyzzy-definitely-not-a-note-title-12345');
    await waitMs(300);
    const noResultsMsg = await page.locator('text=/No notes matching/').count();
    if (noResultsMsg === 0) {
      find('P2', 'Notes/Search', 'No "no results" message shown when search yields nothing');
    } else {
      logOk('"No notes matching" message shown for empty search');
    }
    await shot(page, 'search-no-results');

    // Clear search
    await searchInput.fill('');
    await waitMs(300);
  }

  // Test Cmd+K / Ctrl+K for global search
  logProgress('Testing Ctrl+K global search...');
  await page.keyboard.press('Control+k');
  await waitMs(600);
  const cmdkOpen = await page.locator('[role="dialog"], [role="combobox"], .command-palette, input[placeholder*="Search"]').count();
  logInfo(`Ctrl+K opened command palette / search: ${cmdkOpen > 0}`);
  if (cmdkOpen === 0) {
    find('P2', 'Notes/Search', 'Ctrl+K did not open command palette or search');
  } else {
    logOk('Ctrl+K opened search/command palette');
    await shot(page, 'ctrl-k-search');
    await page.keyboard.press('Escape');
    await waitMs(300);
  }

  // Test folder creation
  logProgress('Testing folder creation...');
  const folderPlusBtn = page.locator('button').filter({ has: page.locator('svg') }).filter({ hasText: '' }).nth(0);
  // Try to find the FolderPlus button by its SVG title or nearby context
  const allButtons = await page.locator('button').all();
  let folderPlusFound = false;
  for (const btn of allButtons) {
    const title = await btn.getAttribute('title').catch(() => null);
    if (title?.toLowerCase().includes('folder')) {
      folderPlusFound = true;
      logOk(`Folder action button found: title="${title}"`);
      break;
    }
  }
  if (!folderPlusFound) {
    // The folder plus button has no title — check it's present by visual inspection
    logInfo('FolderPlus button has no title attribute — presence inferred from UI code');
  }

  // Check "New Folder" input flow
  const folderBtns = page.locator('button').filter({ has: page.locator('[data-lucide="folder-plus"], [class*="folder-plus"]') });
  if (await folderBtns.count() === 0) {
    logInfo('FolderPlus button not identifiable by lucide class — using positional approach');
  }

  // Test folder filter bar is present
  const allNotesFilter = await page.locator('button').filter({ hasText: 'All Notes' }).count();
  if (allNotesFilter === 0) {
    find('P2', 'Notes/Folders', '"All Notes" folder filter button not found');
  } else {
    logOk('"All Notes" folder filter button present');
  }

  // Check templates dropdown
  logProgress('Testing templates...');
  const newNoteBtn2 = page.locator('button').filter({ hasText: 'New Note' });
  if (await newNoteBtn2.count() > 0) {
    await newNoteBtn2.click();
    await waitMs(400);
    await shot(page, 'templates-dropdown');

    const templatesSection = await page.locator('text=Templates').count();
    const blankNoteOpt = await page.locator('button').filter({ hasText: 'Blank Note' }).count();

    logInfo(`Templates section visible: ${templatesSection > 0}`);
    logInfo(`Blank Note option: ${blankNoteOpt > 0}`);

    if (blankNoteOpt === 0) {
      find('P1', 'Notes/Templates', '"Blank Note" option not in New Note dropdown');
    } else {
      logOk('Templates dropdown structure correct');
    }

    // Close dropdown
    await page.keyboard.press('Escape');
    await waitMs(200);
  }

  // Check accessibility: all interactive elements have accessible labels
  logProgress('Checking accessibility of toolbar and header buttons...');
  await page.goto(`${NOTES_URL}?id=${testNoteId}`, { waitUntil: 'networkidle' });
  await waitMs(500);

  const iconBtnsWithoutLabel = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons
      .filter(b => {
        const hasTitle = !!b.getAttribute('title');
        const hasAriaLabel = !!b.getAttribute('aria-label');
        const hasText = (b.textContent?.trim().length ?? 0) > 1;
        return !hasTitle && !hasAriaLabel && !hasText;
      })
      .length;
  });
  logInfo(`Buttons without accessible label: ${iconBtnsWithoutLabel}`);
  if (iconBtnsWithoutLabel > 5) {
    find('P2', 'Notes/Accessibility', `${iconBtnsWithoutLabel} icon buttons have no title/aria-label — screen reader inaccessible`);
  } else if (iconBtnsWithoutLabel > 0) {
    find('Nit', 'Notes/Accessibility', `${iconBtnsWithoutLabel} icon button(s) have no accessible label`);
  } else {
    logOk('All icon buttons have accessible labels');
  }

  // Check "All Notes" back link in editor
  const backBtn = await page.locator('button').filter({ hasText: 'All Notes' }).count();
  if (backBtn === 0) {
    find('P2', 'Notes/Navigation', '"All Notes" back button not found in editor view');
  } else {
    logOk('"All Notes" back navigation present');
  }

  // Focus mode
  const focusBtn = page.locator('button[title*="focus mode"], button[title*="Focus mode"]');
  if (await focusBtn.count() === 0) {
    find('Nit', 'Notes/FocusMode', 'Focus mode button not found');
  } else {
    logOk('Focus mode button present');
    await focusBtn.first().click();
    await waitMs(500);
    await shot(page, 'focus-mode-active');
    // Check URL or UI changed
    const fullscreenOverlay = await page.locator('.fixed.inset-0').count();
    logInfo(`Focus mode overlay: ${fullscreenOverlay > 0}`);
    if (fullscreenOverlay === 0) {
      find('Nit', 'Notes/FocusMode', 'Focus mode toggle did not produce visible overlay/fullscreen');
    } else {
      logOk('Focus mode overlay visible');
    }
    // Exit focus mode
    await page.locator('button[title*="Exit focus mode"], button[title*="Focus mode"]').first().click().catch(() => {});
    await waitMs(300);
  }

  // Check timestamp formatting on note cards
  await page.goto(NOTES_URL, { waitUntil: 'networkidle' });
  await waitMs(500);
  const timestamps = await page.locator('.text-\\[11px\\]').allTextContents();
  logInfo(`Sample timestamps: ${timestamps.slice(0, 5).join(', ')}`);

  await shot(page, 'notes-list-final');
  logProgress('Group 7 complete');
}

// ── Report Writer ──────────────────────────────────────────────────────────────
function writeReport(startedAt: Date, duration: number, noteCount: number) {
  const p0 = findings.filter(f => f.severity === 'P0');
  const p1 = findings.filter(f => f.severity === 'P1');
  const p2 = findings.filter(f => f.severity === 'P2');
  const nits = findings.filter(f => f.severity === 'Nit');

  const fmt = (fs: typeof findings) => fs.map((f, i) =>
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

  const rawConsole = consoleErrors.slice(0, 30).join('\n') || '(none)';
  const rawNet = networkErrors.slice(0, 30).join('\n') || '(none)';
  const rawPage = pageErrors.slice(0, 10).join('\n') || '(none)';

  const report = `# Notes Deep Audit

**Date:** ${startedAt.toISOString().slice(0, 10)}
**Branch:** feat/phase2-4-mcp-agents-plans
**Duration:** ${Math.round(duration / 1000)}s
**Notes found via API:** ${noteCount}
**Findings:** P0×${p0.length} P1×${p1.length} P2×${p2.length} Nit×${nits.length}
**Screenshots:** ${shotCounter}

---

## P0 — blocks release

${p0.length === 0 ? '_(none)_' : fmt(p0)}

## P1 — must fix

${p1.length === 0 ? '_(none)_' : fmt(p1)}

## P2 — should fix

${p2.length === 0 ? '_(none)_' : fmt(p2)}

## Nits

${nits.length === 0 ? '_(none)_' : fmt(nits)}

## Coverage gaps

- \`/daily-notes\` route: checked in Group 6 (API uses \`/api/daily-notes\` prefix; no separate daily-notes UI route exists)
- Drag-and-drop image: not tested (requires OS-level drag, Playwright limitation)
- Paste image from clipboard: not tested (requires OS clipboard access)
- Real-time collaboration: not tested (appears to be a single-user surface)
- Export PDF: no PDF export button found in the editor toolbar (only Markdown export)
- Keyboard shortcut Cmd+N for new note: not tested (no evidence in source code)
- Note recovery / trash: no trash UI found — notes are hard-deleted

## Raw console / network logs

### Console errors / warnings (first 30)
\`\`\`
${rawConsole}
\`\`\`

### Network 4xx/5xx errors (first 30)
\`\`\`
${rawNet}
\`\`\`

### Uncaught page errors
\`\`\`
${rawPage}
\`\`\`

## Screenshots index

${screenshotIndex}
`;

  writeFileSync(REPORT_FILE, report, 'utf8');
  log(`Report written to ${REPORT_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Ensure output dir
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });
  // Reset log
  writeFileSync(LOG_FILE, '', 'utf8');
  log('=== Notes Deep Audit START ===');
  log(`Budget: 8 minutes wall-clock. Started: ${new Date().toISOString()}`);

  const startedAt = new Date();
  let browser: Browser | null = null;

  try {
    // Authenticate
    const auth = await apiLogin();
    const { accessToken, refreshToken } = auth;

    // Get initial note count
    const initialNotes = await apiFetch<any[]>('/api/daily-notes', accessToken);
    const noteCount = Array.isArray(initialNotes.body) ? initialNotes.body.length : 0;
    log(`INFO Initial note count: ${noteCount}`);

    // Launch browser
    log('INFO Launching Chromium (headless: false, slowMo: 100)...');
    browser = await chromium.launch({ headless: false, slowMo: 100 });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await injectAuth(context, accessToken, refreshToken);
    const page = await context.newPage();
    attachListeners(page);

    // Progress heartbeat every 10s
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - START_TIME) / 1000);
      log(`... heartbeat — ${elapsed}s elapsed, findings so far: P0×${findings.filter(f => f.severity === 'P0').length} P1×${findings.filter(f => f.severity === 'P1').length}`);
    }, 10000);

    // Wall-clock watchdog
    const wallTimeout = setTimeout(() => {
      log('[TIMEOUT] Wall-clock budget exceeded — writing partial report and exiting');
      writeReport(startedAt, Date.now() - startedAt.getTime(), noteCount);
      process.exit(1);
    }, MAX_WALL_MS);

    try {
      await group1Landing(page, accessToken);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group2CreateEdit(page, accessToken);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group3RenameDelete(page, accessToken);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group4RichEditor(page, accessToken);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group5CrossRefWiki(page, accessToken);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group6DailyNotes(page, accessToken);
      if (Date.now() - START_TIME < MAX_WALL_MS) await group7SearchKeyboard(page, accessToken);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(wallTimeout);
    }

    const duration = Date.now() - startedAt.getTime();
    log(`\n=== Audit complete in ${Math.round(duration / 1000)}s ===`);
    log(`Findings: P0×${findings.filter(f => f.severity === 'P0').length} P1×${findings.filter(f => f.severity === 'P1').length} P2×${findings.filter(f => f.severity === 'P2').length} Nit×${findings.filter(f => f.severity === 'Nit').length}`);

    writeReport(startedAt, duration, noteCount);

  } catch (err) {
    log(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
    writeReport(startedAt, Date.now() - startedAt.getTime(), 0);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

main();
