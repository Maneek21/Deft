#!/usr/bin/env tsx
/**
 * DM sidebar redesign audit:
 *  1. Sidebar shows DM rows for each existing DM space (not per-org-member)
 *  2. group_dm rows render with cluster avatars + comma names
 *  3. CreateDmModal supports multi-select; 1 recipient -> dm, 2+ -> group_dm
 *  4. group_dm dedup by member set
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import { getStatePath } from './lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';

async function login() {
  const r = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
  });
  return ((await r.json()) as { accessToken: string }).accessToken;
}

async function main() {
  const jwt = await login();
  const auth = { Authorization: `Bearer ${jwt}` };
  const members = await (await fetch(`${API_URL}/api/members`, { headers: auth })).json() as Array<{ id: string; name: string; kind?: string; email?: string }>;
  const humans = members.filter((m) => m.kind === 'human' && m.email !== 'maneek@test.com');
  console.log(`humans: ${humans.length}`);

  if (humans.length < 2) {
    console.log('not enough humans for group DM test — skipping group_dm flow');
  }

  // 4. group_dm dedup test (API only)
  if (humans.length >= 2) {
    const ids = [humans[0]!.id, humans[1]!.id];
    const post = async () => {
      const r = await fetch(`${API_URL}/api/spaces`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ type: 'group_dm', name: 'test-group-dm', user_ids: ids }),
      });
      return await r.json();
    };
    const a = await post();
    const b = await post();
    console.log(`group_dm dedup: a.id=${a.id?.slice(0, 8)}  b.id=${b.id?.slice(0, 8)}  ${a.id === b.id ? '✓ same' : '✗ different'}`);
  }

  // 1+2. UI: open /chat, observe DM list rendering
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // Check: are all org humans showing? (regression — the old design did)
  // After fix, only those with an existing DM space should show.
  const dmSection = page.locator('span:has-text("Direct Messages")').first();
  const sectionEl = dmSection.locator('xpath=ancestor::div[contains(@class,"pt-5")][1]');
  const dmButtonCount = await sectionEl.locator('button').count();
  console.log(`DM section has ${dmButtonCount} buttons (1 is the + button)`);

  // Get spaces from API to verify count matches
  const spaces = await (await fetch(`${API_URL}/api/spaces`, { headers: auth })).json() as Array<{ id: string; type: string }>;
  const dmCount = spaces.filter((s) => s.type === 'dm' || s.type === 'group_dm').length;
  console.log(`API reports ${dmCount} DM/group_dm spaces`);
  // dmButtonCount should be dmCount + 1 (for the + button)
  if (dmButtonCount === dmCount + 1) {
    console.log('✓ sidebar count matches API count');
  } else {
    console.log(`✗ mismatch: sidebar=${dmButtonCount} expected=${dmCount + 1}`);
  }

  // Check: can we click a 1:1 DM and see the right name?
  const dms = spaces.filter((s) => s.type === 'dm');
  if (dms[0]) {
    await page.goto(`${WEB_URL}/chat?space=${dms[0].id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const url = page.url();
    console.log(`opened 1:1 DM: ${url.includes('?space=' + dms[0].id) ? '✓' : '✗'}`);
  }

  // Check: CreateDmModal opens via the + button
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const plusBtn = sectionEl.locator('button[title="New direct message"]');
  if (await plusBtn.count() > 0) {
    await plusBtn.click();
    await page.waitForTimeout(800);
    const modalHeader = page.locator('h2:has-text("New message")').first();
    if (await modalHeader.count() > 0) console.log('✓ CreateDmModal opens');
    else console.log('✗ CreateDmModal not visible');
  }

  await browser.close();
}

main().catch((e) => { console.error('crashed:', e); process.exit(1); });
