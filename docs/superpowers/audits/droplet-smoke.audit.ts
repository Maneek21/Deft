#!/usr/bin/env tsx
/**
 * Droplet smoke — confirms the just-deployed instance at 68.183.80.183
 * runs the unified slash menu features that landed in #12.
 */
import 'dotenv/config';
import { chromium } from 'playwright';

const WEB = 'http://68.183.80.183:3000';
const API = 'http://68.183.80.183:3001';
const EMAIL = 'maneek@test.com';
const PASSWORD = 'test1234';

const log: Array<{ ok: boolean; m: string }> = [];
const t = (cond: boolean, m: string) => { log.push({ ok: cond, m }); console.log(cond ? '✔' : '✖', m); };

async function main() {
  // API-level: login works
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  t(r.ok, `POST /api/auth/login → ${r.status}`);

  // Web flow
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => t(false, `pageerror: ${e.message.slice(0, 200)}`));

  try {
    await page.goto(`${WEB}/login`);
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([
      page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 }),
      page.click('button[type="submit"]'),
    ]);
    t(true, `logged in, redirected to ${page.url()}`);

    // Chat composer slash menu
    await page.goto(`${WEB}/chat`);
    await page.waitForTimeout(2000);
    const composer = page.locator('.deft-editor, [contenteditable="true"]').last();
    await composer.waitFor({ state: 'visible', timeout: 10_000 });
    await composer.click();
    await composer.type('/');
    await page.waitForTimeout(800);
    const commandsHeader = await page.locator('text=Commands').isVisible({ timeout: 1500 }).catch(() => false);
    const blocksHeader = await page.locator('text=Blocks').isVisible({ timeout: 500 }).catch(() => false);
    t(commandsHeader, 'chat: Commands section visible on /');
    t(blocksHeader, 'chat: Blocks section visible on /');
    await page.keyboard.press('Escape');

    // Cmd+K palette
    await page.keyboard.press('Control+k');
    const paletteInput = await page.locator('input[placeholder="Search anything..."]').isVisible({ timeout: 2000 }).catch(() => false);
    t(paletteInput, 'Cmd+K opens command palette');
    if (paletteInput) {
      // / prefix triggers commands mode
      await page.fill('input[placeholder="Search anything..."]', '/');
      await page.waitForTimeout(300);
      const ctaskVisible = await page.getByRole('button', { name: /^Create task$/ }).first().isVisible({ timeout: 1500 }).catch(() => false);
      t(ctaskVisible, 'palette: / shows command list (Create task visible)');
      await page.keyboard.press('Escape');
    }
  } catch (e) {
    t(false, `unexpected: ${(e as Error).message.slice(0, 200)}`);
  } finally {
    await browser.close();
  }

  const pass = log.filter((l) => l.ok).length;
  const fail = log.filter((l) => !l.ok).length;
  console.log(`\n── PASS ${pass} / FAIL ${fail} ──`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
