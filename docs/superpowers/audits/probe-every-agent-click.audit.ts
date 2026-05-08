#!/usr/bin/env tsx
import 'dotenv/config';
import { chromium } from 'playwright';
import { getStatePath } from './lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const jwt = await (async () => {
    const r = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
    });
    return ((await r.json()) as { accessToken: string }).accessToken;
  })();
  const orgMembersRes = await fetch(`${API_URL}/api/members`, { headers: { Authorization: `Bearer ${jwt}` } });
  const orgMembers = await orgMembersRes.json() as Array<{ id: string; name: string; kind?: string; email?: string }>;
  const agents = orgMembers.filter((m) => m.kind === 'agent' || m.kind === 'system');
  console.log(`agents to test: ${agents.map((a) => a.name).join(', ')}\n`);

  // Open a public space first so we have agent message context
  const spacesRes = await fetch(`${API_URL}/api/spaces`, { headers: { Authorization: `Bearer ${jwt}` } });
  const spaces = await spacesRes.json() as Array<{ id: string; type: string; name: string }>;
  const general = spaces.find((s) => s.name === 'general')!;

  // Test 1: click each agent in sidebar DM list
  console.log('=== Test 1: click each agent in sidebar ===');
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (const agent of agents) {
    const btn = page.locator(`button:has-text("${agent.name}")`).first();
    if (await btn.count() === 0) {
      console.log(`  ${agent.name}: button not found in sidebar`);
      continue;
    }
    const before = page.url();
    await btn.click({ force: true });
    await page.waitForTimeout(2000);
    const after = page.url();
    const bodyText = (await page.locator('body').innerText()).slice(0, 100).replace(/\n/g, ' ');
    const is404 = /Page not found|404/.test(bodyText);
    console.log(`  ${agent.name}: ${before.slice(WEB_URL.length)} → ${after.slice(WEB_URL.length)} ${is404 ? '✗ 404' : '✓'}`);
    await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }

  // Test 2: click agent avatar in a chat message
  console.log('\n=== Test 2: click agent avatar in chat message ===');
  await page.goto(`${WEB_URL}/chat?space=${general.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  // Find any agent-authored message bubble — agent author rows have BOT badge
  const botMessages = page.locator('span:has-text("BOT")');
  const botCount = await botMessages.count();
  console.log(`  agent messages in ${general.name}: ${botCount}`);
  if (botCount > 0) {
    // Click avatar (parent's parent's first child)
    const avatar = botMessages.first().locator('xpath=../../..').locator('div.cursor-pointer').first();
    if (await avatar.count() > 0) {
      await avatar.click({ force: true });
      await page.waitForTimeout(1500);
      const popover = await page.locator('[class*="profile"], [class*="card"], [role="dialog"]').count();
      console.log(`  avatar click → popover count: ${popover} (${popover > 0 ? '✓ popover opened' : '✗ no popover'})`);
    } else {
      console.log(`  no clickable avatar found`);
    }
  }

  // Test 3: click on every link/button in the open agent_conversation
  console.log('\n=== Test 3: scan agent_conversation page for links ===');
  const agentConvo = spaces.find((s) => s.type === 'agent_conversation');
  if (agentConvo) {
    await page.goto(`${WEB_URL}/chat?space=${agentConvo.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const links = await page.locator('a[href]').all();
    const seen = new Set<string>();
    for (const link of links) {
      const href = await link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('http')) continue;
      if (seen.has(href)) continue;
      seen.add(href);
    }
    console.log(`  unique internal hrefs: ${seen.size}`);
    for (const href of Array.from(seen).slice(0, 30)) {
      const r = await page.context().request.get(`${WEB_URL}${href}`);
      const status = r.status();
      if (status >= 400) console.log(`  ✗ ${status} ${href}`);
    }
    console.log('  (other hrefs returned 200)');
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
