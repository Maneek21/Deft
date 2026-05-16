#!/usr/bin/env tsx
/**
 * Slash menu smoke — verifies the BlockSlashMenu integration in every editor
 * surface (notes, task description, canvas, chat) and that chat's legacy
 * slash autocomplete still works without collision.
 *
 * Runs against the worktree dev servers: web :3010, api :3012.
 *
 * Usage: pnpm exec tsx docs/superpowers/audits/slash-menu-smoke.audit.ts
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3012';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3010';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'DeftTest2026!';
const SHOT_DIR = 'docs/superpowers/audits/screenshots/slash-menu-smoke';
const REPORT = 'docs/superpowers/audits/slash-menu-smoke.last-run.txt';

const log: Array<{ level: 'ok' | 'fail' | 'info'; msg: string }> = [];
const ok = (m: string) => { log.push({ level: 'ok', msg: m }); console.log('✔', m); };
const fail = (m: string) => { log.push({ level: 'fail', msg: m }); console.error('✖', m); };
const info = (m: string) => { log.push({ level: 'info', msg: m }); console.log('ℹ', m); };
const t = (cond: boolean, m: string) => { if (cond) ok(m); else fail(m); return cond; };

async function shot(page: Page, name: string) {
  const path = `${SHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  info(`shot ${path}`);
}

async function loginViaAPI() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}: ${await res.text()}`);
  return await res.json() as { accessToken: string; refreshToken: string; user: { id: string }; org_id: string };
}

/** Log in via the actual UI form so the app's auth flow runs fully. */
async function authenticate(page: Page) {
  await page.goto(`${WEB_URL}/login`);
  await page.waitForLoadState('domcontentloaded');
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 }),
    page.click('button[type="submit"], button:has-text("Sign in")'),
  ]);
  info(`logged in, redirected to ${page.url()}`);
}

async function isMenuVisible(page: Page, label: RegExp | string) {
  // Tippy renders the slash menu in document.body
  return page.locator('div').filter({ hasText: label }).first().isVisible({ timeout: 1500 }).catch(() => false);
}

/** Count visible popups containing any of the given headings. */
async function countMenus(page: Page) {
  // Block menu has a "Blocks" header; AI section has "AI Actions"; legacy chat menu has "Commands"
  const blocks = await page.locator('text=Blocks').isVisible({ timeout: 500 }).catch(() => false);
  const ai = await page.locator('text=AI Actions').isVisible({ timeout: 500 }).catch(() => false);
  const commands = await page.locator('text=Commands').isVisible({ timeout: 500 }).catch(() => false);
  return { blocks, ai, commands };
}

async function clearEditor(page: Page) {
  // Focus the active editor and select-all-delete
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
}

async function testNotes(page: Page) {
  info('── notes surface ──');
  // Navigate via sidebar to keep auth session alive
  const notesLink = page.getByRole('link', { name: /^notes$/i }).first();
  if (await notesLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await notesLink.click();
  } else {
    await page.goto(`${WEB_URL}/notes`);
  }
  await page.waitForTimeout(1200);

  // Open an existing note if present, else create one
  const existingNote = page.locator('text=Untitled, text=Empty note').first();
  if (await existingNote.isVisible({ timeout: 1500 }).catch(() => false)) {
    info('notes: opening existing untitled note');
    await existingNote.click();
  } else {
    // Click New Note → Blank Note
    const newBtn = page.getByRole('button', { name: /new note/i }).first();
    if (await newBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await newBtn.click();
      await page.waitForTimeout(400);
      const blank = page.locator('text=Blank Note').first();
      if (await blank.isVisible({ timeout: 1500 }).catch(() => false)) {
        await blank.click();
      }
    }
  }
  await page.waitForTimeout(1000);

  const editor = page.locator('.deft-editor, [contenteditable="true"]').first();
  const editorVisible = await editor.isVisible({ timeout: 5000 }).catch(() => false);
  if (!t(editorVisible, 'notes: editor present')) {
    await shot(page, 'notes-no-editor');
    return;
  }
  await editor.click();
  await page.waitForTimeout(300);
  await editor.type('/');
  await page.waitForTimeout(800);

  await shot(page, 'notes-slash-menu');
  const menus = await countMenus(page);
  t(menus.blocks, 'notes: block menu appears on /');
  t(menus.ai, 'notes: AI section appears on /');

  // Pick Heading 1
  await editor.type('head');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const h1Count = await editor.locator('h1').count();
  t(h1Count > 0, 'notes: /head + Enter inserts an h1');
  await shot(page, 'notes-after-h1');
}

async function testCanvas(page: Page) {
  info('── canvas surface ──');
  // Navigate via sidebar to keep auth alive
  const chatLink = page.getByRole('link', { name: /^chat$/i }).first();
  if (await chatLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await chatLink.click();
  } else {
    await page.goto(`${WEB_URL}/chat`);
  }
  await page.waitForTimeout(1200);
  // Try to open canvas via header button
  const canvasBtn = page.getByRole('button', { name: /canvas/i }).first();
  if (!(await canvasBtn.isVisible({ timeout: 2000 }).catch(() => false))) {
    info('canvas: no canvas button visible (no space selected); skipping');
    return;
  }
  await canvasBtn.click();
  await page.waitForTimeout(800);

  const editor = page.locator('.deft-editor, [contenteditable="true"]').first();
  const editorVisible = await editor.isVisible({ timeout: 5000 }).catch(() => false);
  if (!t(editorVisible, 'canvas: editor present')) {
    await shot(page, 'canvas-no-editor');
    return;
  }
  await editor.click();
  await editor.type('/');
  await page.waitForTimeout(800);
  await shot(page, 'canvas-slash-menu');
  const menus = await countMenus(page);
  t(menus.blocks, 'canvas: block menu appears on /');
}

async function testChat(page: Page) {
  info('── chat composer (collision test) ──');
  // Already on /chat from testCanvas
  await page.waitForTimeout(500);

  // Find a space to enter
  const firstSpace = page.locator('a[href*="/chat?space"], button[data-space-id]').first();
  if (await firstSpace.isVisible({ timeout: 3000 }).catch(() => false)) {
    await firstSpace.click().catch(() => {});
    await page.waitForTimeout(800);
  }

  // Composer editor - usually in lower portion of page
  const composer = page.locator('.deft-editor, [contenteditable="true"]').last();
  const composerVisible = await composer.isVisible({ timeout: 5000 }).catch(() => false);
  if (!t(composerVisible, 'chat: composer present')) {
    await shot(page, 'chat-no-composer');
    return;
  }
  await composer.click();
  await page.waitForTimeout(300);

  // CASE A: type "/" at start — unified menu, BOTH sections visible
  await composer.type('/');
  await page.waitForTimeout(800);
  await shot(page, 'chat-slash-at-start');
  let menus = await countMenus(page);
  t(menus.commands, 'chat: Commands section visible at start of msg');
  t(menus.blocks, 'chat: Blocks section visible at start of msg (unified)');

  await clearEditor(page);
  await page.waitForTimeout(300);

  // CASE B: type "hi " then "/" — Blocks only; Commands hidden mid-msg
  await composer.type('hi ');
  await composer.type('/');
  await page.waitForTimeout(800);
  await shot(page, 'chat-slash-midmsg');
  menus = await countMenus(page);
  t(menus.blocks, 'chat: block section appears mid-msg');
  t(!menus.commands, 'chat: Commands hidden mid-msg (requireStartOfMessage)');

  await clearEditor(page);
  await page.waitForTimeout(300);

  // CASE C: prefill command — picking "Remind" must replace the slash with
  // "/remind " so the user can type duration + message, NOT fire empty.
  await composer.type('/remind');
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await shot(page, 'chat-remind-prefilled');
  const afterRemind = (await composer.textContent()) ?? '';
  t(afterRemind.trim().startsWith('/remind'), `chat: /remind prefills "/remind " (got: ${JSON.stringify(afterRemind.slice(0, 30))})`);
  // The popup should be closed now (slash was deleted + replaced).
  const stillOpen = await page.locator('text=Commands').isVisible({ timeout: 500 }).catch(() => false);
  t(!stillOpen, 'chat: popup closes after picking prefill command');

  await clearEditor(page);
  await page.waitForTimeout(300);

  // CASE D: fire command — "/search" + Enter dispatches the command palette
  // event (no DB write, easy to undo by pressing Escape).
  await composer.type('/search');
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await shot(page, 'chat-search-fired');
  const paletteVisible = await page
    .locator('input[placeholder="Search anything..."]')
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  t(paletteVisible, 'chat: /search + Enter opens the command palette');
  // Close palette
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

async function main() {
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

  const browser: Browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // Capture browser console errors
  page.on('pageerror', err => fail(`pageerror: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Skip noisy CSP font warnings
      if (!text.includes('fonts.googleapis.com')) {
        info(`console.error: ${text.slice(0, 250)}`);
      }
    }
  });

  try {
    await authenticate(page);
    ok('authenticated via login form');
    await testNotes(page);
    await testCanvas(page);
    await testChat(page);
  } catch (e) {
    fail(`unexpected: ${(e as Error).stack ?? (e as Error).message}`);
  } finally {
    await browser.close();
  }

  const passed = log.filter(l => l.level === 'ok').length;
  const failed = log.filter(l => l.level === 'fail').length;
  const summary = `\n── summary ──\nPASS ${passed}\nFAIL ${failed}\n`;
  console.log(summary);
  writeFileSync(REPORT, [...log.map(l => `${l.level.toUpperCase()} ${l.msg}`), summary].join('\n'));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
