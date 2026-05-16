#!/usr/bin/env tsx
/**
 * Command-palette commands smoke — verifies each of the unified commands
 * does what its label says.
 *
 * Covers:
 *   - Toggle dark mode (theme actually flips in localStorage)
 *   - Toggle DND      (status_text becomes "Do Not Disturb" in Postgres)
 *   - Set status      (sub-mode → args → status row updated)
 *   - Set reminder    (sub-mode → args → reminders row created)
 *   - Open settings   (URL changes to /settings)
 *   - New note        (POST /api/daily-notes → navigate to /notes?id=)
 *   - Ask Defty       (opens a DM with the Defty user)
 *   - Create task     (event dispatched → /tasks page opens TaskQuickCreate)
 *   - New space       (event dispatched → CreateSpaceModal visible)
 */
import 'dotenv/config';
import { chromium, type Page } from 'playwright';
import { spawnSync } from 'node:child_process';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3012';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3010';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'DeftTest2026!';

const log: Array<{ ok: boolean; m: string }> = [];
const t = (cond: boolean, m: string) => { log.push({ ok: cond, m }); console.log(cond ? '✔' : '✖', m); };

async function login(page: Page) {
  await page.goto(`${WEB_URL}/login`);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function openPalette(page: Page) {
  // If palette is already open (e.g. after a slow submit didn't finish closing
  // before we got here), close it deterministically first via Escape, then open.
  const alreadyOpen = await page.locator('input[placeholder*="Search anything"], input[placeholder*="e.g."]').first().isVisible({ timeout: 200 }).catch(() => false);
  if (alreadyOpen) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape'); // double-escape: first clears prompt, second closes
    await page.waitForTimeout(300);
  }
  // Use the open-command-palette custom event — it deterministically sets
  // open=true, while Cmd+K toggles (and would close if already-open state
  // hasn't reset yet).
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('deft:open-command-palette')));
  await page.waitForSelector('input[placeholder="Search anything..."]', { timeout: 4000 });
}

async function closePalette(page: Page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

async function pickCommand(page: Page, label: string) {
  await openPalette(page);
  // Filter by typing the full label so only this command remains.
  await page.fill('input[placeholder="Search anything..."]', `/${label}`);
  await page.waitForTimeout(250);
  // Anchored regex — matches the exact label, not substrings like "New note"
  // when we asked for "New space".
  const btn = page.getByRole('button', { name: new RegExp(`^${label}(\\s+↵.*)?$`, 'i') }).first();
  await btn.click();
  await page.waitForTimeout(400);
}

async function getUserStatus(): Promise<{ emoji: string | null; text: string | null }> {
  const r = spawnSync('docker', ['exec', 'deft-postgres-local', 'psql', '-U', 'postgres', '-d', 'deft', '-A', '-t', '-c',
    `SELECT COALESCE(status_emoji,'') || '|' || COALESCE(status_text,'') FROM users WHERE email='${EMAIL}';`],
    { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  const [emoji, text] = r.stdout.trim().split('|');
  return { emoji: emoji || null, text: text || null };
}

async function clearUserStatus() {
  spawnSync('docker', ['exec', 'deft-postgres-local', 'psql', '-U', 'postgres', '-d', 'deft', '-c',
    `UPDATE users SET status_emoji=NULL, status_text=NULL, status_expires_at=NULL WHERE email='${EMAIL}';`]);
}

async function getLatestReminder(): Promise<{ content: string; remind_at: string } | null> {
  const r = spawnSync('docker', ['exec', 'deft-postgres-local', 'psql', '-U', 'postgres', '-d', 'deft', '-A', '-t', '-c',
    `SELECT message || '|' || remind_at FROM reminders r JOIN users u ON u.id=r.user_id WHERE u.email='${EMAIL}' ORDER BY r.created_at DESC LIMIT 1;`],
    { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const line = r.stdout.trim();
  if (!line) return null;
  const [content, remind_at] = line.split('|');
  return { content: content!, remind_at: remind_at! };
}

async function deleteAllReminders() {
  spawnSync('docker', ['exec', 'deft-postgres-local', 'psql', '-U', 'postgres', '-d', 'deft', '-c',
    `DELETE FROM reminders WHERE user_id = (SELECT id FROM users WHERE email='${EMAIL}');`]);
}

async function main() {
  await clearUserStatus();
  await deleteAllReminders();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  page.on('pageerror', (e) => t(false, `pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Skip noisy CSP font warnings + Next dev chunk reloads
      if (!text.includes('fonts.googleapis.com') && !text.includes('Failed to load chunk')) {
        console.log(`[browser err] ${text.slice(0, 200)}`);
      }
    }
  });

  try {
    await login(page);
    await page.goto(`${WEB_URL}/dashboard`);
    await page.waitForTimeout(1200);

    // ── Toggle dark mode
    const themeBefore = await page.evaluate(() => localStorage.getItem('deft-theme'));
    await pickCommand(page, 'Toggle dark mode');
    await page.waitForTimeout(300);
    const themeAfter = await page.evaluate(() => localStorage.getItem('deft-theme'));
    t(themeBefore !== themeAfter && themeAfter !== null, `Toggle dark mode flips theme (${themeBefore} → ${themeAfter})`);
    // flip back
    await pickCommand(page, 'Toggle dark mode');
    await page.waitForTimeout(200);

    // ── Toggle Do Not Disturb
    await pickCommand(page, 'Toggle Do Not Disturb');
    await page.waitForTimeout(500);
    let s = await getUserStatus();
    t(s.text === 'Do Not Disturb', `Toggle DND sets status_text="Do Not Disturb" (got "${s.text}")`);
    // toggle off
    await pickCommand(page, 'Toggle Do Not Disturb');
    await page.waitForTimeout(500);
    s = await getUserStatus();
    t(s.text === null, `Toggle DND a second time clears status (got "${s.text}")`);

    // ── Set status (sub-mode)
    await openPalette(page);
    await page.fill('input[placeholder="Search anything..."]', '/set status');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const inPromptMode = await page.locator('input[placeholder="e.g. 🍕 Lunch"]').isVisible({ timeout: 1000 }).catch(() => false);
    t(inPromptMode, 'Set status enters args sub-mode (placeholder swaps)');
    await page.keyboard.type('🍕 Lunch');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    s = await getUserStatus();
    t(s.emoji === '🍕' && s.text === 'Lunch', `Set status sets status (got ${JSON.stringify(s)})`);
    await clearUserStatus();

    // ── Set reminder (sub-mode)
    await openPalette(page);
    await page.fill('input[placeholder="Search anything..."]', '/set rem');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const reminderPromptVisible = await page.locator('input[placeholder*="check email"]').isVisible({ timeout: 1000 }).catch(() => false);
    t(reminderPromptVisible, 'Set reminder enters args sub-mode');
    await page.keyboard.type('30m check email');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    const r = await getLatestReminder();
    t(r?.content === 'check email', `Set reminder creates row (content="${r?.content}")`);
    await deleteAllReminders();

    // Navigation tests rely on the palette navigating us via router.push, which
    // preserves auth state. page.goto causes a hard reload that races
    // AuthProvider.fetchMe and intermittently ends up at /login.

    // ── New note → /notes?id=<new>
    await pickCommand(page, 'New note');
    await page.waitForTimeout(1800);
    t(page.url().includes('/notes?id='), `New note creates + navigates (url=${page.url()})`);

    // ── Ask Defty → /chat?space=<dm>
    await pickCommand(page, 'Ask Defty');
    await page.waitForTimeout(1800);
    t(page.url().includes('/chat?space='), `Ask Defty opens DM (url=${page.url()})`);

    // ── Create task → navigates to /tasks?new=1 → page opens dialog from URL
    await pickCommand(page, 'Create task');
    await page.waitForTimeout(2000);
    const quickCreateVisible = await page
      .locator('input[placeholder="Task title"]')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    t(quickCreateVisible, 'Create task opens TaskQuickCreate dialog');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // ── New space → invokes registered callback in sidebar
    await pickCommand(page, 'New space');
    await page.waitForTimeout(800);
    const newSpaceVisible = await page.getByText(/create a space/i).first().isVisible({ timeout: 2000 }).catch(() => false);
    t(newSpaceVisible, 'New space opens CreateSpaceModal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // ── Open settings (last because it's a nav, frees us to bail)
    await pickCommand(page, 'Open settings');
    await page.waitForTimeout(1200);
    t(page.url().includes('/settings'), `Open settings navigates (url=${page.url()})`);
  } catch (e) {
    t(false, `unexpected: ${(e as Error).message}`);
  } finally {
    await browser.close();
  }

  const pass = log.filter((l) => l.ok).length;
  const fail = log.filter((l) => !l.ok).length;
  console.log(`\n── PASS ${pass} / FAIL ${fail} ──`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
