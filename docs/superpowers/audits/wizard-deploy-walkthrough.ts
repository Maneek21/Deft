#!/usr/bin/env tsx
/**
 * Wizard deploy walkthrough — headed Chrome, human-like pacing.
 * Builds an agent via the 3-step create wizard, captures BYOA api_key if
 * surfaced, writes a findings report.
 *
 * Expects ghcr.io/openclaw/openclaw:latest already running on :18789.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';
const HEADLESS = process.env.HEADLESS === '1';

const SHOT_DIR = 'docs/superpowers/audits/screenshots/wizard-deploy';
const REPORT = 'docs/superpowers/audits/wizard-deploy-findings.md';

type Severity = 'blocker' | 'major' | 'minor' | 'nit' | 'note';
type Finding = { step: string; severity: Severity; issue: string };
const findings: Finding[] = [];
let currentStep = 'init';
function flag(sev: Severity, issue: string) {
  findings.push({ step: currentStep, severity: sev, issue });
  const sym = sev === 'blocker' ? '🛑' : sev === 'major' ? '⚠️' : sev === 'minor' ? '🟡' : sev === 'nit' ? '•' : 'ℹ';
  console.log(`   ${sym}  ${issue}`);
}
async function say(label: string, ms = 900) { console.log(`   → ${label}`); await new Promise((r) => setTimeout(r, ms)); }
async function shot(page: Page, name: string) { await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true }); }
async function type(page: Page, sel: ReturnType<Page['locator']>, text: string) {
  await sel.click();
  for (const ch of text) await page.keyboard.type(ch, { delay: 30 + Math.floor(Math.random() * 40) });
}

async function login() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}`);
  const j = (await res.json()) as Record<string, unknown>;
  return {
    at: (j.access_token ?? j.accessToken) as string,
    rt: (j.refresh_token ?? j.refreshToken) as string | undefined,
  };
}

async function main() {
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });
  const auth = await login();

  // Verify the OpenClaw container is up
  const gwProbe = await fetch('http://localhost:18789/').catch(() => null);
  if (!gwProbe || !gwProbe.ok) {
    console.log('⚠️  OpenClaw container not reachable on :18789 — start it first.');
    process.exit(1);
  }
  console.log('OpenClaw :18789 responding.');

  const browser: Browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 0 : 200 });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(({ at, rt }: { at: string; rt: string | null }) => {
    window.localStorage.setItem('deft-access-token', at);
    if (rt) window.localStorage.setItem('deft-refresh-token', rt);
  }, { at: auth.at, rt: auth.rt ?? null });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);

  // Intercept provider-readiness so the self-hosted mode wizard isn't blocked
  // by the cloud-mode gatekeeper. The real fix is client-side
  // NEXT_PUBLIC_DEFT_SELF_HOSTED=true + web-server restart; this route lets
  // the walkthrough run without waiting for that.
  await page.route('**/api/agent-employees/provider-readiness', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true }),
    });
  });

  // Force is_byoa=true on POST (simulates what the client would send after
  // NEXT_PUBLIC_DEFT_SELF_HOSTED=true + restart). Server rejects otherwise.
  await page.route('**/api/agent-employees', async (route) => {
    if (route.request().method() !== 'POST') {
      return route.continue();
    }
    const body = JSON.parse(route.request().postData() ?? '{}');
    body.is_byoa = true;
    await route.continue({
      headers: { ...route.request().headers(), 'content-type': 'application/json' },
      postData: JSON.stringify(body),
    });
  });

  const consoleErrs: string[] = [];
  page.on('pageerror', (e) => consoleErrs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(`console.error: ${m.text().slice(0, 160)}`); });

  // Trace network so we can see what the submit actually did
  page.on('request', (req) => {
    if (req.url().includes('/api/agent-employees') && req.method() === 'POST') {
      console.log(`   [NET req] POST ${req.url()} body=${req.postData()?.slice(0, 200)}`);
    }
  });
  page.on('response', async (res) => {
    if (res.url().includes('/api/agent-employees') && (res.request().method() === 'POST' || res.status() >= 400)) {
      const body = await res.text().catch(() => '(unreadable)');
      console.log(`   [NET res] ${res.status()} ${res.url()} body=${body.slice(0, 300)}`);
    }
  });

  try {
    // ───────────────────────────────────────────────────────
    currentStep = 'landing';
    console.log(`\n🚪 ${currentStep}`);
    await page.goto(`${WEB_URL}/settings/agent-employees/create`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await say('arrived at wizard', 1500);
    await shot(page, '01-landing');

    // Provider-readiness gate?
    const notReady = await page.getByText(/not ready|configure.*byoa|provider not/i).count();
    if (notReady > 0) {
      flag('note', 'Provider-readiness banner shown (self-hosted mode + no BYOA configured is expected behavior)');
    }

    // Does "Step 1 of 3" display?
    const stepIndicator = await page.getByText(/step 1 of 3/i).count();
    if (stepIndicator === 0) flag('major', 'Wizard step indicator missing');

    // ───────────────────────────────────────────────────────
    currentStep = 'step-1-name-role';
    console.log(`\n📝 ${currentStep}`);
    await shot(page, '02-step1');

    // Name input — wizard places it under a "Name" label with
    // placeholder "e.g. Sprint Bot, Alex PM"
    const nameInput = page.locator('input[placeholder*="Sprint Bot" i], input[type="text"]').first();
    if (await nameInput.count() === 0) {
      flag('blocker', 'No name input visible on step 1');
      return;
    }
    await type(page, nameInput, 'Dogfood PM');
    await say('typed name', 700);

    // Role — wizard uses a native <select>
    const roleSelect = page.locator('select').first();
    if (await roleSelect.count() === 0) {
      flag('blocker', 'No role <select> visible on step 1');
      return;
    }
    await roleSelect.selectOption('project_manager').catch(async () => {
      // Fallback by label
      await roleSelect.selectOption({ label: 'Project Manager' });
    });
    await say('picked project_manager role', 800);
    await shot(page, '03-step1-filled');

    // Next button
    const next1 = page.getByRole('button', { name: /^next$|continue/i }).first();
    if (await next1.count() === 0) {
      flag('blocker', 'No Next button on step 1');
      return;
    }
    if (await next1.isDisabled()) {
      flag('minor', 'Next disabled after filling name + role — required field missed?');
      await shot(page, '03b-next-disabled');
    }
    await next1.click();
    await say('clicked Next', 1500);

    // ───────────────────────────────────────────────────────
    currentStep = 'step-2-behavior';
    console.log(`\n🎭 ${currentStep}`);
    await shot(page, '04-step2');
    const step2 = await page.getByText(/step 2 of 3/i).count();
    if (step2 === 0) flag('minor', 'Step 2 of 3 indicator missing');

    // System prompt
    const promptArea = page.locator('textarea').first();
    if (await promptArea.count() === 0) {
      flag('blocker', 'No system-prompt textarea on step 2');
    } else {
      // Template pre-fills it; augment
      const existing = await promptArea.inputValue();
      if (existing.length === 0) {
        await type(page, promptArea, 'You are the Dogfood PM agent. Coordinate tasks + surface blockers.');
        await say('wrote prompt (was empty)', 1200);
      } else {
        await say(`prompt pre-filled (${existing.length} chars)`, 900);
      }
    }

    // Trust level — pick "standard" if presented
    const trustStd = page.getByText(/^standard$/i).first();
    if (await trustStd.count() > 0) {
      await trustStd.click();
      await say('picked Standard trust', 700);
    }

    await shot(page, '05-step2-filled');

    const next2 = page.getByRole('button', { name: /^next$|continue/i }).first();
    if (await next2.count() === 0) {
      flag('major', 'No Next button on step 2');
    } else {
      await next2.click();
      await say('clicked Next', 1500);
    }

    // ───────────────────────────────────────────────────────
    currentStep = 'step-3-skills';
    console.log(`\n🧩 ${currentStep}`);
    await shot(page, '06-step3');
    const step3 = await page.getByText(/step 3 of 3/i).count();
    if (step3 === 0) flag('minor', 'Step 3 of 3 indicator missing');

    // Skill checkboxes — bundled should be pre-checked for PM
    const checks = page.locator('input[type="checkbox"]');
    const checkCount = await checks.count();
    if (checkCount === 0) {
      flag('major', 'No skill checkboxes on step 3');
    } else {
      let checked = 0;
      for (let i = 0; i < checkCount; i++) {
        if (await checks.nth(i).isChecked()) checked++;
      }
      console.log(`   ${checked}/${checkCount} skills pre-checked`);
      if (checked === 0) flag('note', 'No skills pre-checked — PM role defaults may not have seeded');
    }

    // Look for deft-mcp-client (Block 3.4 skill) — should be bundled + might be auto-picked
    const deftMcpCheck = page.getByText(/deft mcp client/i).first();
    const hasDeftMcp = await deftMcpCheck.count();
    if (hasDeftMcp === 0) {
      flag('minor', 'Block 3.4 "Deft MCP client" skill not visible in wizard catalog');
    } else {
      flag('note', 'Block 3.4 "Deft MCP client" present in catalog');
      // Try to check it if it's a clickable label
      await deftMcpCheck.click().catch(() => undefined);
      await say('clicked Deft MCP client row', 700);
    }

    await shot(page, '07-step3-skills-picked');

    // Final submit — exact "Create" label (not "Create Agent Employee" h2)
    const submitBtn = page.getByRole('button', { name: /^create$|^creating/i });
    const submitCount = await submitBtn.count();
    if (submitCount === 0) {
      flag('blocker', 'No "Create" submit button on step 3');
    } else {
      const disabled = await submitBtn.first().isDisabled();
      if (disabled) flag('minor', 'Create button disabled on step 3 — something required still missing');
      await submitBtn.first().click();
      await say('clicked Create — waiting for API', 4000);
    }
    await shot(page, '08-after-submit');

    // ───────────────────────────────────────────────────────
    currentStep = 'post-submit';
    console.log(`\n✅ ${currentStep}`);

    // Did we get an api_key modal (BYOA) or redirect?
    const apiKeyText = await page.getByText(/api key|mcp token|save.*key.*now/i).count();
    if (apiKeyText > 0) {
      await shot(page, '09-api-key-modal');
      flag('note', 'BYOA api_key modal rendered — self-hosted path active');
      // Try to copy it
      const copyBtn = page.getByRole('button', { name: /copy/i }).first();
      if (await copyBtn.count() > 0) {
        await copyBtn.click();
        await say('clicked Copy on api_key', 800);
      }
    } else {
      // Probably cloud-mode redirect — what URL are we on?
      await say('observing post-submit state', 1500);
      const url = page.url();
      console.log(`   post-submit URL: ${url}`);
      if (url.includes('/settings/agent-employees')) {
        flag('note', 'Wizard redirected to employee list — cloud-mode create path');
      } else if (url.includes('/settings/agent-employees/create')) {
        flag('major', 'Wizard still on create page after submit — create failed silently or error not visible');
        const errVis = await page.getByText(/failed|error|could not/i).count();
        if (errVis > 0) flag('major', 'Create returned an error — check network tab / screenshot');
      }
    }

    // ───────────────────────────────────────────────────────
    currentStep = 'verify-row';
    console.log(`\n🔍 ${currentStep}`);
    const empsRes = await fetch(`${API_URL}/api/agent-employees`, {
      headers: { authorization: `Bearer ${auth.at}` },
    });
    const emps = (await empsRes.json()) as Array<{ id: string; name: string; slug: string; kind: string; connection_status?: string }>;
    const match = emps.find((e) => e.name === 'Dogfood PM');
    if (!match) {
      flag('major', 'No "Dogfood PM" row in /api/agent-employees — wizard did not persist');
    } else {
      console.log(`   employee id: ${match.id.slice(0, 8)}… kind=${match.kind} status=${match.connection_status ?? 'n/a'}`);
      flag('note', `Row persisted — kind=${match.kind}, connection=${match.connection_status ?? 'n/a'}`);
    }

    if (consoleErrs.length > 0) {
      flag('minor', `${consoleErrs.length} console errors during walkthrough — ${consoleErrs.slice(0, 2).join(' | ')}`);
    }
  } finally {
    if (!HEADLESS) {
      console.log('\n⏸  Browser open 15s. Ctrl-C to exit sooner.');
      await new Promise((r) => setTimeout(r, 15_000));
    }
    await browser.close();
  }

  // Report
  const bySev = (s: Severity) => findings.filter((f) => f.severity === s);
  const out: string[] = [
    '# Wizard-deploy walkthrough findings',
    '',
    `Run: ${new Date().toISOString()}`,
    `Mode: ${HEADLESS ? 'headless' : 'headed'}`,
    '',
    '## Summary',
    '| Severity | Count |',
    '| --- | --- |',
    `| 🛑 Blocker | ${bySev('blocker').length} |`,
    `| ⚠️ Major | ${bySev('major').length} |`,
    `| 🟡 Minor | ${bySev('minor').length} |`,
    `| • Nit | ${bySev('nit').length} |`,
    `| ℹ Note | ${bySev('note').length} |`,
  ];
  for (const sev of ['blocker', 'major', 'minor', 'nit', 'note'] as Severity[]) {
    const items = bySev(sev);
    if (items.length === 0) continue;
    out.push(`\n## ${sev.charAt(0).toUpperCase()}${sev.slice(1)}${items.length > 1 ? 's' : ''}`);
    for (const f of items) out.push(`\n- **[${f.step}]** ${f.issue}`);
  }
  writeFileSync(REPORT, out.join('\n') + '\n');
  console.log(`\n${findings.length} findings → ${REPORT}`);
}

main().catch((e) => { console.error(e); writeFileSync(REPORT, `FATAL: ${(e as Error).stack}\n`); process.exit(1); });
