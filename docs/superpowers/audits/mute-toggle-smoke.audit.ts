#!/usr/bin/env tsx
/**
 * Chat slash-menu mute-toggle smoke. Verifies the collapsed
 * "Mute channel" / "Unmute channel" entry:
 *   1. starts as "Mute channel" when the user is not muted
 *   2. picking it actually mutes (space_members.is_muted=true)
 *   3. the label flips to "Unmute channel" on next open
 *   4. picking again unmutes (is_muted=false)
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

function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', 'deft-postgres-local', 'psql', '-U', 'postgres', '-d', 'deft', '-A', '-t', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}

async function login(page: Page) {
  await page.goto(`${WEB_URL}/login`);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await login(page);

    // Force-unmute everything for this user first, then click into the first space.
    psql(`UPDATE space_members SET is_muted=false WHERE user_id=(SELECT id FROM users WHERE email='${EMAIL}');`);

    // Resolve a space id directly from Postgres — the /chat URL doesn't
    // always include ?space= even when a space is visually active.
    const spaceId = psql(`SELECT sm.space_id FROM space_members sm JOIN users u ON u.id=sm.user_id WHERE u.email='${EMAIL}' LIMIT 1;`);
    if (!spaceId) throw new Error('no space membership found for test user');

    await page.goto(`${WEB_URL}/chat?space=${spaceId}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.deft-editor, [contenteditable="true"]').last().waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(800);
    console.log(`  space=${spaceId.slice(0, 8)}…`);

    const composer = page.locator('.deft-editor, [contenteditable="true"]').last();
    await composer.click();
    await page.waitForTimeout(200);

    // Round 1: should show "Mute channel"
    await composer.type('/');
    await page.waitForTimeout(700);
    const muteLabelVisible = await page.getByText('Mute channel', { exact: true }).first().isVisible({ timeout: 1500 }).catch(() => false);
    t(muteLabelVisible, 'Slash menu shows "Mute channel" when not muted');
    // pick the toggle by clicking that label
    await page.getByText('Mute channel', { exact: true }).first().click();
    await page.waitForTimeout(1000);

    let mutedRow = psql(`SELECT is_muted FROM space_members sm JOIN users u ON u.id=sm.user_id WHERE u.email='${EMAIL}' AND sm.space_id='${spaceId}';`);
    t(mutedRow === 't', `is_muted=true after first toggle (got "${mutedRow}")`);

    // Round 2: should show "Unmute channel"
    await composer.click();
    await page.waitForTimeout(200);
    await composer.type('/');
    await page.waitForTimeout(700);
    const unmuteLabelVisible = await page.getByText('Unmute channel', { exact: true }).first().isVisible({ timeout: 1500 }).catch(() => false);
    t(unmuteLabelVisible, 'Slash menu label flips to "Unmute channel" after muting');
    await page.getByText('Unmute channel', { exact: true }).first().click();
    await page.waitForTimeout(1000);

    mutedRow = psql(`SELECT is_muted FROM space_members sm JOIN users u ON u.id=sm.user_id WHERE u.email='${EMAIL}' AND sm.space_id='${spaceId}';`);
    t(mutedRow === 'f', `is_muted=false after second toggle (got "${mutedRow}")`);
  } catch (e) {
    t(false, `unexpected: ${(e as Error).message}`);
  } finally {
    // Cleanup: unmute everything for the test user.
    psql(`UPDATE space_members SET is_muted=false WHERE user_id=(SELECT id FROM users WHERE email='${EMAIL}');`);
    await browser.close();
  }

  const pass = log.filter((l) => l.ok).length;
  const fail = log.filter((l) => !l.ok).length;
  console.log(`\n── PASS ${pass} / FAIL ${fail} ──`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
