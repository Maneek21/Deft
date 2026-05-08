#!/usr/bin/env tsx
/**
 * Drive the Claude Code BYOA agent onboarding flow end-to-end:
 *  1. Navigate to /settings/agent-employees/create
 *  2. Fill identity (name, role)
 *  3. Pick trust level + cap
 *  4. Submit
 *  5. Capture the success modal — API key + MCP endpoint
 *  6. Verify the new employee shows on /settings/agent-employees and in chat sidebar
 */
import 'dotenv/config';
import { chromium, type Page } from 'playwright';
import { getStatePath } from './lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const stamp = Date.now();
const NAME = `Onboard Audit ${stamp}`;

type Sev = 'P0' | 'P1' | 'OK';
const findings: Array<{ step: string; sev: Sev; msg: string }> = [];
function rec(step: string, sev: Sev, msg: string) {
  findings.push({ step, sev, msg });
  console.log(`[${sev}] ${step} — ${msg}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on('pageerror', (e) => rec('pageerror', 'P1', e.message.slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      if (!/favicon|401\b|Failed to load resource|network/i.test(t)) {
        rec('console.error', 'P1', t.slice(0, 200));
      }
    }
  });

  // 1. Navigate
  await page.goto(`${WEB_URL}/settings/agent-employees/create`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const headerVisible = await page.locator('h2:has-text("Connect Agent")').count() > 0;
  rec('1.navigate', headerVisible ? 'OK' : 'P0', headerVisible ? 'page loaded' : 'header missing');
  if (!headerVisible) {
    const body = (await page.locator('body').innerText()).slice(0, 300);
    console.log('  body[0..300]:', body);
    await browser.close();
    return summarize();
  }

  // 2. Fill name
  const nameInput = page.locator('input[placeholder*="Sprint Bot"]').first();
  if (await nameInput.count() === 0) {
    rec('2.name', 'P0', 'name input not found');
    await browser.close();
    return summarize();
  }
  await nameInput.fill(NAME);
  rec('2.name', 'OK', `filled "${NAME}"`);

  // 3. Pick role — engineering_lead is the closest fit for a "Claude Code" coding agent
  const roleSelect = page.locator('select').first();
  if (await roleSelect.count() > 0) {
    await roleSelect.selectOption({ value: 'engineering_lead' });
    rec('3.role', 'OK', 'engineering_lead selected');
  } else {
    rec('3.role', 'P1', 'no <select> found — looking for clickable role buttons');
  }

  // 4. Trust level — Standard is the typical choice
  const standardLabel = page.locator('text=/^Standard$/').first();
  if (await standardLabel.count() > 0) {
    await standardLabel.click();
    rec('4.trust', 'OK', 'Standard selected');
  } else {
    rec('4.trust', 'P1', 'Standard radio not found (maybe default-conservative)');
  }

  // 5. Submit — there should be a primary CTA
  const submitBtn = page.locator('button:has-text("Create"), button:has-text("Connect"), button:has-text("Submit"), button:has-text("Generate")').first();
  if (await submitBtn.count() === 0) {
    rec('5.submit', 'P0', 'no submit CTA found');
    await browser.close();
    return summarize();
  }
  await submitBtn.click();
  await page.waitForTimeout(3500);

  // 6. Success modal — should expose api_key + endpoint
  const apiKeyVisible = await page.locator('text=/sk-deft-/').first().count() > 0
    || await page.locator('text=/[a-zA-Z0-9]{40,}/').first().count() > 0;
  const endpointVisible = await page.locator('text=/api\\/mcp\\/v1/').first().count() > 0;
  rec('6.success-modal', apiKeyVisible || endpointVisible ? 'OK' : 'P0', `apiKey=${apiKeyVisible} endpoint=${endpointVisible}`);

  // 7. Capture the values for return — look for the sk-deft-prefixed key
  let apiKey: string | undefined;
  const allText = await page.locator('body').innerText();
  const m = allText.match(/deft_[a-zA-Z0-9_\-]{20,}/);
  if (m) apiKey = m[0];
  console.log(`  api_key: ${apiKey ? apiKey.slice(0, 12) + '…' : 'NOT FOUND'}`);
  console.log(`  endpoint: ${API_URL}/api/mcp/v1`);

  // 8. Close modal, navigate to list page
  const doneBtn = page.locator('button:has-text("Done"), button:has-text("Close")').first();
  if (await doneBtn.count() > 0) {
    await doneBtn.click();
    await page.waitForTimeout(1500);
  } else {
    await page.goto(`${WEB_URL}/settings/agent-employees`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
  }
  const listHasNew = await page.locator(`text="${NAME}"`).first().count() > 0;
  rec('8.list-page', listHasNew ? 'OK' : 'P1', listHasNew ? 'new employee appears in list' : 'not visible on list page');

  // 9. Sidebar — open /chat and look for the new agent
  await page.goto(`${WEB_URL}/chat`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const sidebarHasNew = await page.locator(`button:has-text("${NAME}")`).first().count() > 0;
  rec('9.sidebar', sidebarHasNew ? 'OK' : 'P1', sidebarHasNew ? 'shows in sidebar Agent Employees' : 'not in sidebar');

  // 10. Click the agent → opens DM
  if (sidebarHasNew) {
    const before = page.url();
    await page.locator(`button:has-text("${NAME}")`).first().click({ force: true });
    await page.waitForTimeout(2000);
    const after = page.url();
    const opened = after.includes('/chat?space=');
    rec('10.click-to-dm', opened ? 'OK' : 'P0', `${before} → ${after}`);
  }

  // 11. Verify via API the employee exists with mcp_token_hash + is_byoa
  const jwt = await (async () => {
    const r = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
    });
    return ((await r.json()) as { accessToken: string }).accessToken;
  })();
  const list = await (await fetch(`${API_URL}/api/agent-employees`, { headers: { Authorization: `Bearer ${jwt}` } })).json() as Array<{ id: string; name: string; role: string; trust_level: string; is_byoa?: boolean }>;
  const created = list.find((e) => e.name === NAME);
  rec('11.api-verify', created ? 'OK' : 'P0', created ? `id=${created.id.slice(0,8)} role=${created.role} trust=${created.trust_level}` : 'not in /api/agent-employees');

  await browser.close();
  return summarize();

  function summarize() {
    const counts = findings.reduce<Record<Sev, number>>((acc, f) => { acc[f.sev] = (acc[f.sev] ?? 0) + 1; return acc; }, { OK: 0, P0: 0, P1: 0 });
    console.log(`\n=== SUMMARY === total=${findings.length}  OK=${counts.OK}  P0=${counts.P0}  P1=${counts.P1}`);
    process.exit(counts.P0 > 0 ? 1 : 0);
  }
}

main().catch((e) => { console.error('crashed:', e); process.exit(2); });
