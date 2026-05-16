#!/usr/bin/env tsx
/**
 * Focused smoke: type /status from the chat slash menu → ensure the user's
 * status row actually changes on the server.
 */
import 'dotenv/config';
import { chromium } from 'playwright';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3012';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3010';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'DeftTest2026!';

async function loginToken() {
  const r = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await r.json() as { accessToken: string };
  return j.accessToken;
}

async function getStatus(_token: string) {
  // /api/auth/me doesn't include status fields — shell out to psql in docker.
  const { spawnSync } = await import('node:child_process');
  const sql = `SELECT COALESCE(status_emoji,'') || '|' || COALESCE(status_text,'') FROM users WHERE email='${EMAIL}';`;
  const r = spawnSync(
    'docker',
    ['exec', 'deft-postgres-local', 'psql', '-U', 'postgres', '-d', 'deft', '-A', '-t', '-c', sql],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  const [emoji, text] = r.stdout.trim().split('|');
  return { emoji: emoji || null, text: text || null };
}

async function clearStatus(token: string) {
  await fetch(`${API_URL}/api/users/status`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
}

async function main() {
  const token = await loginToken();
  await clearStatus(token);
  const before = await getStatus(token);
  console.log('before:', before);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  await page.goto(`${WEB_URL}/login`);
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);

  await page.goto(`${WEB_URL}/chat`);
  await page.waitForTimeout(1500);

  const firstSpace = page.locator('a[href*="/chat?space"]').first();
  if (await firstSpace.isVisible({ timeout: 3000 }).catch(() => false)) {
    await firstSpace.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  const composer = page.locator('.deft-editor, [contenteditable="true"]').last();
  await composer.click();
  await page.waitForTimeout(300);

  // Type /status, pick from menu (Enter on first match), then type args + Enter.
  await composer.type('/status');
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await composer.type('🍕 Lunch');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  await browser.close();

  const after = await getStatus(token);
  console.log('after :', after);

  const ok = after.emoji === '🍕' && after.text === 'Lunch';
  if (ok) {
    console.log('PASS — /status set the user status correctly');
  } else {
    console.error('FAIL — expected { emoji: "🍕", text: "Lunch" }, got', after);
  }
  // Clean up: clear status so we don't leave state behind.
  await clearStatus(token);
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
