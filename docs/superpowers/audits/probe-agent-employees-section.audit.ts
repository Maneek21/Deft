#!/usr/bin/env tsx
import 'dotenv/config';
import { chromium } from 'playwright';
import { getStatePath } from './lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Find the "Agent Employees" header, then click each button after it.
  const header = page.locator('span:has-text("Agent Employees")').first();
  if ((await header.count()) === 0) {
    console.log('Agent Employees header not found — section may be hidden when no agent_employees rows exist');
    await browser.close();
    return;
  }
  // Get the section container — the parent .px-3.pt-5 of the header
  const section = header.locator('xpath=ancestor::div[contains(@class,"pt-5")][1]');
  const buttons = section.locator('button');
  const count = await buttons.count();
  console.log(`Agent Employees section has ${count} buttons`);
  for (let i = 0; i < count; i++) {
    const name = (await buttons.nth(i).innerText()).replace(/\s+/g, ' ').slice(0, 40);
    const before = page.url();
    await buttons.nth(i).click({ force: true });
    await page.waitForTimeout(2000);
    const after = page.url();
    const body = (await page.locator('body').innerText()).slice(0, 80).replace(/\n/g, ' ');
    const is404 = /Page not found|404/.test(body);
    console.log(`  [${i}] ${name} :: ${before.slice(WEB_URL.length)} → ${after.slice(WEB_URL.length)} ${is404 ? '✗ 404' : '✓'}`);
    await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }

  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
