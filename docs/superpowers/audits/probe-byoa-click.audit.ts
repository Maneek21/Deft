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

  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 200)}`); });

  const calls: Array<{ method: string; url: string; status: number; reqBody?: string }> = [];
  page.on('request', (req) => {
    if (/api\//.test(req.url())) {
      calls.push({ method: req.method(), url: req.url(), status: 0, reqBody: req.postData() || undefined });
    }
  });
  page.on('response', (res) => {
    const c = calls.find((x) => x.url === res.url() && x.status === 0);
    if (c) c.status = res.status();
  });

  // Get all org members and find BYOA agents
  const jwt = await (async () => {
    const r = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
    });
    return ((await r.json()) as { accessToken: string }).accessToken;
  })();
  const orgMembersRes = await fetch(`${API_URL}/api/members`, { headers: { Authorization: `Bearer ${jwt}` } });
  const orgMembers = await orgMembersRes.json() as Array<{ id: string; name: string; kind?: string; email?: string }>;
  const byoaAgents = orgMembers.filter((m) => m.kind === 'agent' && m.email !== 'deft-agent@system.local');
  console.log(`BYOA agents: ${byoaAgents.map((a) => a.name).join(', ')}`);
  console.log(`Defty: ${orgMembers.find((m) => m.email === 'deft-agent@system.local')?.name}`);

  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  // Try clicking each BYOA agent in turn
  for (const agent of byoaAgents.slice(0, 3)) {
    console.log(`\n=== Clicking '${agent.name}' ===`);
    calls.length = 0;
    const before = page.url();
    const btn = page.locator(`button:has-text("${agent.name}")`).first();
    if (await btn.count() === 0) {
      console.log(`  no button found`);
      continue;
    }
    await btn.click({ force: true });
    await page.waitForTimeout(3000);
    const after = page.url();
    const bodyText = (await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | ');
    console.log(`  before: ${before}`);
    console.log(`  after:  ${after}`);
    console.log(`  body[0..300]: ${bodyText}`);
    console.log(`  api calls during click:`);
    for (const c of calls) {
      if (c.status >= 400 || c.method === 'POST') {
        console.log(`    ${c.method} ${c.url.replace(API_URL, '')} → ${c.status}${c.reqBody ? ` body=${c.reqBody.slice(0, 100)}` : ''}`);
      }
    }
    // Reset to /chat for next iteration
    await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
