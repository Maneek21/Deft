#!/usr/bin/env tsx
/**
 * Settings deep audit — 7 groups across 8 subtabs.
 *
 * Priority: Members → Integrations → Agent → Agent Employees → API Access → General → Groups → Tags
 *
 * Run:  DEFT_TEST_EMAIL=maneek@test.com DEFT_TEST_PASSWORD=test1234 tsx docs/superpowers/audits/settings-deep/audit.ts
 */
import 'dotenv/config';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { assert } from '../lib/assert.js';
import { loginAndSaveState, getStatePath } from '../lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const SCREENSHOT_DIR = 'docs/superpowers/audits/settings-deep';
const LOG_PATH = 'docs/superpowers/audits/settings-deep/run.log';
const VIEWPORT = { width: 1440, height: 900 };

// ── helpers ──────────────────────────────────────────────────────────
let logBuf = '';
function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  logBuf += line + '\n';
}

async function screenshot(page: Page, name: string): Promise<string> {
  const p = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path: p, fullPage: false });
  log(`  screenshot → ${p}`);
  return p;
}

async function screenshotOnFail(page: Page, name: string): Promise<void> {
  try { await screenshot(page, `FAIL-${name}`); } catch { /* ignore */ }
}

// ── console / network listeners ──────────────────────────────────────
function attachListeners(page: Page): { consoleErrors: string[]; failedRequests: string[] } {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      consoleErrors.push(text);
      log(`  [console.error] ${text.slice(0, 120)}`);
    }
  });

  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
    log(`  [pageerror] ${err.message.slice(0, 120)}`);
  });

  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('localhost')) return; // skip external
    const status = res.status();
    if (status >= 400) {
      const entry = `${status} ${res.request().method()} ${url.replace(/https?:\/\/[^/]+/, '')}`;
      failedRequests.push(entry);
      if (status >= 500) log(`  [HTTP ${status}] ${entry}`);
    }
  });

  return { consoleErrors, failedRequests };
}

// ── helpers ──────────────────────────────────────────────────────────
async function goto(page: Page, path: string): Promise<void> {
  await page.goto(`${WEB_URL}${path}`, { waitUntil: 'networkidle', timeout: 30_000 });
}

// ── 1. Landing + subtab inventory ────────────────────────────────────
async function testLanding(page: Page): Promise<string[]> {
  log('\n── 1. Landing /settings ──');
  await goto(page, '/settings');
  await screenshot(page, '01-settings-landing');

  // Check no "Deploy" tab in the sidebar nav
  const navLinks = await page.$$eval(
    'nav a, aside a, [class*="sidebar"] a, [class*="nav"] a',
    (els) => els.map((e) => ({ text: e.textContent?.trim() || '', href: (e as HTMLAnchorElement).href }))
  );
  const settingsLinks = navLinks.filter(l => l.href.includes('/settings'));
  log(`  Nav settings links: ${settingsLinks.map(l => l.text || l.href).join(', ')}`);

  const deployLinks = settingsLinks.filter(l =>
    l.text.toLowerCase().includes('deploy') || l.href.includes('deploy')
  );
  if (deployLinks.length > 0) {
    log(`  WARN [P1] Deploy tab still present: ${JSON.stringify(deployLinks)}`);
  } else {
    log('  OK — no "Deploy" tab found');
  }

  // Count all settings tabs from the source constant
  const EXPECTED_TABS = ['General', 'Members', 'Groups', 'Tags', 'Integrations', 'Agent', 'Agent Employees', 'API Access'];
  log(`  Expected ${EXPECTED_TABS.length} subtabs: ${EXPECTED_TABS.join(', ')}`);

  // Check page content loaded without crash
  const h1 = await page.$eval('h1', (el) => el.textContent?.trim()).catch(() => null);
  log(`  Page h1: "${h1}"`);
  assert(h1?.includes('Settings'), `Expected "Settings" h1, got "${h1}"`);

  return deployLinks.map(l => l.text);
}

// ── 2. Members ───────────────────────────────────────────────────────
async function testMembers(page: Page): Promise<void> {
  log('\n── 2. Members ──');
  await goto(page, '/settings/members');
  await screenshot(page, '02-members-list');

  // Count members
  const memberCount = await page.$$eval(
    '[class*="card-bg"], [class*="surface-container"]',
    (els) => els.filter(e => e.querySelector('[class*="truncate"]')).length
  );
  log(`  Approximate member rows: ${memberCount}`);

  // Check for Invite button (admin view)
  const inviteBtn = await page.$('button:has-text("Invite")');
  if (!inviteBtn) {
    log('  WARN [P2] Invite button not found (may be non-admin user)');
  } else {
    log('  OK — Invite button found');
    await inviteBtn.click();
    await page.waitForTimeout(500);
    const inviteForm = await page.$('form, [class*="card-bg"] input[type="email"]');
    if (inviteForm) {
      log('  OK — Invite form appeared');
      await screenshot(page, '02-members-invite-form');

      // Fill email + role
      const emailInput = await page.$('input[type="email"]');
      if (emailInput) {
        await emailInput.fill('test-invite@example.com');
      }
      // Check role selector
      const roleSelect = await page.$('select');
      if (roleSelect) {
        const roleOptions = await roleSelect.$$eval('option', (opts) => opts.map(o => o.value));
        log(`  Role options: ${roleOptions.join(', ')}`);
        assert(roleOptions.length >= 2, `Expected at least 2 role options, got ${roleOptions.length}`);
      }

      // Cancel instead of submitting for real
      const cancelBtn = await page.$('button:has-text("Cancel"), button:has-text("✕"), button[type="button"]');
      if (cancelBtn) {
        // Just close via the invite button toggle
        await inviteBtn.click();
        await page.waitForTimeout(300);
        log('  OK — Invite form dismissed');
      }
    } else {
      log('  WARN [P1] Invite button clicked but no form appeared');
      await screenshot(page, 'FAIL-02-members-invite-no-form');
    }
  }

  // Check for member rows and role controls
  const roleButtons = await page.$$('button:has-text("admin"), button:has-text("member"), button:has-text("guest")');
  log(`  Role change buttons found: ${roleButtons.length}`);

  // Check for remove buttons
  const removeButtons = await page.$$('[title="Remove member"]');
  log(`  Remove buttons found: ${removeButtons.length}`);

  // Verify the logged-in user row has "(you)" label
  const youLabel = await page.$('span:has-text("(you)")');
  log(`  "(you)" label visible: ${!!youLabel}`);
}

// ── 3. Integrations ──────────────────────────────────────────────────
async function testIntegrations(page: Page): Promise<void> {
  log('\n── 3. Integrations ──');
  await goto(page, '/settings/integrations');
  await screenshot(page, '03-integrations');

  // Count OAuth provider rows — each is a flex row with an emoji icon span
  const providerRows = await page.$$eval(
    'div.flex.items-start.gap-4 span:first-child',
    (spans) => spans.map(s => s.textContent?.trim())
  );
  log(`  OAuth providers rendered: ${providerRows.length} — ${providerRows.join(', ')}`);
  assert(providerRows.length >= 2, `Expected ≥2 provider rows, got ${providerRows.length}`);

  // Check for "Coming soon" labels on Slack + Gmail
  const comingSoon = await page.$$eval(
    'span',
    (spans) => spans.filter(s => s.textContent?.includes('Coming soon')).length
  );
  log(`  "Coming soon" labels: ${comingSoon}`);

  // Check for MCP Connections section
  const mcpHeading = await page.$('h2:has-text("MCP Connections")');
  assert(!!mcpHeading, 'Expected "MCP Connections" heading');
  log('  OK — MCP Connections section found');

  // "Add MCP Server" button
  const addMcpBtn = await page.$('button:has-text("Add MCP Server")');
  assert(!!addMcpBtn, 'Expected "Add MCP Server" button');
  log('  OK — Add MCP Server button found');

  // Click "Add MCP Server" — modal should open
  await addMcpBtn!.click();
  await page.waitForTimeout(800);
  const mcpForm = await page.$('[class*="McpConnectionForm"], dialog, [class*="fixed inset"]');
  if (mcpForm) {
    log('  OK — MCP form/modal opened');
    await screenshot(page, '03-integrations-mcp-form');

    // Look for close button
    // Close via Escape — the Cancel button is inside a fixed modal whose
    // full-screen overlay div intercepts pointer events and blocks clicks
    // on elements underneath it.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const stillOpen = await page.$('[class*="fixed inset-0"][class*="z-50"]');
    if (!stillOpen) {
      log('  OK — MCP form closed via Escape');
    } else {
      // Try clicking outside
      await page.mouse.click(50, 50);
      await page.waitForTimeout(300);
      log('  MCP form: attempted close via click-outside');
    }
  } else {
    log('  WARN [P1] Add MCP Server clicked but no modal appeared');
    await screenshot(page, 'FAIL-03-mcp-no-modal');
  }

  // Quick-connect buttons
  const zapierBtn = await page.$('button:has-text("Connect Zapier")');
  const n8nBtn = await page.$('button:has-text("Connect n8n")');
  const playwrightBtn = await page.$('button:has-text("Connect Playwright")');
  log(`  Quick-connect buttons: Zapier=${!!zapierBtn} n8n=${!!n8nBtn} Playwright=${!!playwrightBtn}`);

  // Verify NO "Railway" or "deployment provider" copy
  const pageText = await page.innerText('body');
  const hasRailway = pageText.toLowerCase().includes('railway');
  const hasDeploymentProvider = pageText.toLowerCase().includes('deployment provider');
  if (hasRailway) log('  WARN [P1] Page still mentions "Railway" — dead feature reference');
  else log('  OK — no "Railway" reference');
  if (hasDeploymentProvider) log('  WARN [P1] Page mentions "deployment provider" — dead feature reference');
  else log('  OK — no "deployment provider" reference');

  // Count MCP connections currently configured
  const mcpRows = await page.$$('[class*="rounded-lg"] [class*="rounded-full"]');
  log(`  MCP connection status dots: ${mcpRows.length}`);
}

// ── 4. Agent dashboard ───────────────────────────────────────────────
async function testAgentDashboard(page: Page): Promise<void> {
  log('\n── 4. Agent dashboard /settings/agent ──');
  await goto(page, '/settings/agent');
  await screenshot(page, '04-agent-dashboard');

  // Check heading
  const heading = await page.$('h2:has-text("Agent Settings")');
  assert(!!heading, 'Expected "Agent Settings" h2');
  log('  OK — "Agent Settings" heading found');

  // Trust level section
  const trustButtons = await page.$$('button.p-4');
  log(`  Trust level buttons: ${trustButtons.length}`);
  assert(trustButtons.length === 3, `Expected 3 trust level buttons, got ${trustButtons.length}`);

  // Employee rows
  await page.waitForTimeout(2000); // wait for fetch
  const employeeRows = await page.$$('[data-testid*="employee-row-"]');
  log(`  Employee rows: ${employeeRows.length}`);

  if (employeeRows.length > 0) {
    const firstRow = employeeRows[0];
    // Get the employee slug from data-testid
    const testId = await firstRow.getAttribute('data-testid') || '';
    const slug = testId.replace('employee-row-', '');
    log(`  First employee slug: "${slug}"`);

    // Kebab menu
    const kebabBtn = await page.$(`[data-testid="employee-menu-${slug}"]`);
    assert(!!kebabBtn, `Expected kebab button for employee "${slug}"`);
    log(`  OK — kebab menu button found for "${slug}"`);

    await kebabBtn!.click();
    await page.waitForTimeout(400);
    await screenshot(page, '04-agent-kebab-open');

    // Check menu items
    const menuLinks = await page.$$eval(
      '[class*="w-56"] a, [class*="w-56"] button',
      (els) => els.map(e => e.textContent?.trim())
    );
    log(`  Kebab menu items: ${JSON.stringify(menuLinks)}`);

    // Verify "Personality" is NOT in menu (was removed)
    const hasPersonality = menuLinks.some(t => t?.toLowerCase().includes('personality'));
    if (hasPersonality) {
      log('  WARN [P1] "Personality" link still in kebab menu — should have been removed');
    } else {
      log('  OK — no "Personality" link in kebab menu');
    }

    // Verify "Developer" link is present
    const hasDeveloper = menuLinks.some(t => t?.toLowerCase().includes('developer'));
    assert(hasDeveloper, `Expected "Developer" in kebab menu, got: ${JSON.stringify(menuLinks)}`);
    log('  OK — Developer link present in kebab menu');

    // Check "Developer" link href
    const devLink = await page.$('[class*="w-56"] a:has-text("Developer")');
    const devHref = await devLink?.getAttribute('href');
    log(`  Developer href: ${devHref}`);
    assert(
      devHref?.includes('/settings/agent-employees/') && devHref?.includes('/developer'),
      `Expected Developer href to include /settings/agent-employees/<id>/developer, got "${devHref}"`
    );

    // Close menu via Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    log('  OK — kebab menu closed');

    // Click employee row (not the kebab) — should open drawer
    const rowButton = await firstRow.$('button[aria-label*="Open drawer"]');
    if (rowButton) {
      await rowButton.click();
      await page.waitForTimeout(800);
      const drawer = await page.$('[data-testid="employee-drawer"]');
      if (drawer) {
        log('  OK — employee drawer opened on row click');
        await screenshot(page, '04-agent-drawer-open');

        // Verify drawer has close button
        const closeBtn = await page.$('[data-testid="drawer-close"]');
        assert(!!closeBtn, 'Expected drawer close button (data-testid="drawer-close")');
        log('  OK — drawer close button found');

        await closeBtn!.click();
        await page.waitForTimeout(400);
        log('  OK — drawer closed');
      } else {
        log('  WARN [P1] Row click did not open drawer');
        await screenshot(page, 'FAIL-04-no-drawer');
      }
    } else {
      log('  WARN [P2] Could not find "Open drawer" button on row');
    }
  } else {
    log('  NOTE — no employee rows found (empty state). Skipping kebab/drawer tests.');
  }

  // Pending approvals section
  const pendingSection = await page.$('#pending-approvals-section');
  assert(!!pendingSection, 'Expected pending-approvals-section anchor');
  log('  OK — Pending Approvals section present');

  // Action log section
  const actionLogH3 = await page.$('h3:has-text("Action Log")');
  assert(!!actionLogH3, 'Expected "Action Log" section');
  log('  OK — Action Log section present');

  // Verify no "ClawHub" reference
  const pageText = await page.innerText('body');
  if (pageText.toLowerCase().includes('clawhub')) {
    log('  WARN [P1] "ClawHub" reference found on Agent page — dead feature');
  } else {
    log('  OK — no ClawHub reference');
  }

  // "Regenerate token" button should be disabled (Phase 8 placeholder)
  const regenBtn = await page.$('button:has-text("Regenerate token")');
  if (regenBtn) {
    const disabled = await regenBtn.getAttribute('disabled');
    if (disabled !== null) {
      log('  OK — Regenerate token button is disabled (Phase 8 placeholder)');
    } else {
      log('  WARN [P2] Regenerate token button is NOT disabled — may confuse users');
    }
  }
}

// ── 5. Agent Employees ───────────────────────────────────────────────
async function testAgentEmployees(page: Page): Promise<void> {
  log('\n── 5. Agent Employees /settings/agent-employees ──');
  await goto(page, '/settings/agent-employees');
  await screenshot(page, '05-agent-employees');

  const heading = await page.$eval('h1, h2', el => el.textContent?.trim()).catch(() => null);
  log(`  Page heading: "${heading}"`);

  // Check if it's the same as /settings/agent or a separate surface
  const currentUrl = page.url();
  log(`  Current URL: ${currentUrl}`);

  // Look for "Create" or "Connect agent" button
  const createBtn = await page.$('a[href*="/create"], button:has-text("Create"), a:has-text("Connect agent"), a:has-text("Add")');
  if (createBtn) {
    const btnText = await createBtn.textContent();
    const btnHref = await createBtn.getAttribute('href');
    log(`  Create/Connect button: "${btnText?.trim()}" href="${btnHref}"`);
    log('  OK — Create/Connect button found');
    await screenshot(page, '05-agent-employees-list');
  } else {
    log('  WARN [P2] No "Create" or "Connect agent" button found on /settings/agent-employees');
    await screenshot(page, 'FAIL-05-no-create-btn');
  }

  // Navigate to /create — three-tab wizard
  log('  Navigating to /settings/agent-employees/create...');
  await goto(page, '/settings/agent-employees/create');
  await screenshot(page, '05-agent-employees-create-wizard');

  const wizardUrl = page.url();
  log(`  Wizard URL: ${wizardUrl}`);
  const wizardHeading = await page.$eval('h1, h2, h3', el => el.textContent?.trim()).catch(() => null);
  log(`  Wizard heading: "${wizardHeading}"`);

  // Check for three-tab pattern (Native / BYOA / Custom MCP)
  const tabs = await page.$$eval(
    'button[role="tab"], [class*="tab"] button, button',
    (btns) => btns.map(b => b.textContent?.trim()).filter(Boolean)
  );
  const wizardTabs = tabs.filter(t =>
    ['Native', 'BYOA', 'Custom MCP', 'Connect Agent'].some(kw => t!.includes(kw))
  );
  log(`  Wizard tabs found: ${JSON.stringify(wizardTabs)}`);
  if (wizardTabs.length >= 2) {
    log('  OK — Three-tab Connect Agent wizard present');
  } else {
    log(`  NOTE — Tab labels may differ. Page text (first 300 chars): ${(await page.innerText('body')).slice(0, 300)}`);
  }
}

// ── 6. API Access ────────────────────────────────────────────────────
async function testApiAccess(page: Page): Promise<void> {
  log('\n── 6. API Access /settings/api-access ──');
  await goto(page, '/settings/api-access');
  await screenshot(page, '06-api-access');

  // Check heading
  const heading = await page.$('h2:has-text("API Access")');
  assert(!!heading, 'Expected "API Access" h2');
  log('  OK — "API Access" heading found');

  // Count existing keys
  const keyRows = await page.$$('[class*="card-bg"] [class*="truncate"]');
  log(`  Approximate API key rows: ${keyRows.length}`);

  // Check "Create API Key" button
  const createBtn = await page.$('button:has-text("Create API Key")');
  assert(!!createBtn, 'Expected "Create API Key" button');
  log('  OK — Create API Key button found');

  // Click to open create form
  await createBtn!.click();
  await page.waitForTimeout(500);
  const form = await page.$('form');
  if (form) {
    log('  OK — Create API Key form appeared');
    await screenshot(page, '06-api-access-create-form');

    // Check form fields
    const nameInput = await page.$('input[placeholder*="Production MCP Key"], input[placeholder*="key name"], input[type="text"]');
    assert(!!nameInput, 'Expected a name input in the create form');

    // Check for employee link dropdown
    const employeeSelect = await page.$('select');
    log(`  Employee link dropdown: ${!!employeeSelect}`);

    // Check permission scoping — permissions are hardcoded to mcp:full, no UI for it
    // That's fine, just note it
    log('  NOTE — Permissions are hardcoded to mcp:full (no UI scope selector)');

    // Check rate limit fields
    const rateInputs = await page.$$('input[type="number"]');
    log(`  Rate limit inputs: ${rateInputs.length}`);

    // Check for /mcp vs /api/mcp/v1 copy in the page
    const pageText = await page.innerText('body');
    const mentionsOldMcp = pageText.includes('/mcp') && !pageText.includes('/api/mcp');
    const mentionsNewMcp = pageText.includes('/api/mcp');
    log(`  Copy references /mcp: ${pageText.includes('/mcp')}, /api/mcp: ${mentionsNewMcp}`);

    // Cancel
    const cancelBtn = await page.$('button:has-text("Cancel")');
    if (cancelBtn) {
      await cancelBtn.click();
      await page.waitForTimeout(300);
      log('  OK — Create form cancelled');
    }
  } else {
    log('  WARN [P1] Create API Key button clicked but no form appeared');
    await screenshot(page, 'FAIL-06-no-create-form');
  }

  // Check if any key exists and has the toggle + delete controls
  const toggleBtns = await page.$$('[class*="rounded-full"][class*="transition-colors"]');
  log(`  Key toggle buttons: ${toggleBtns.length}`);

  // Empty state check
  const emptyState = await page.$('[class*="card-bg"] [class*="text-center"]');
  if (emptyState) {
    const emptyText = await emptyState.textContent();
    log(`  Empty state message: "${emptyText?.trim()}"`);
  }
}

// ── 7. General ───────────────────────────────────────────────────────
async function testGeneral(page: Page): Promise<void> {
  log('\n── 7a. General /settings ──');
  await goto(page, '/settings');
  await screenshot(page, '07a-general');

  // Check profile section
  const profileHeading = await page.$('h2:has-text("Profile")');
  log(`  Profile section: ${!!profileHeading}`);

  // Check appearance/theme section
  const appearanceHeading = await page.$('h2:has-text("Appearance")');
  log(`  Appearance section: ${!!appearanceHeading}`);

  // Check theme buttons
  const themeButtons = await page.$$eval(
    'button',
    (btns) => btns.filter(b => b.textContent?.includes('Light') || b.textContent?.includes('Dark')).map(b => b.textContent?.trim())
  );
  log(`  Theme buttons: ${JSON.stringify(themeButtons)}`);
  assert(themeButtons.length >= 2, `Expected Light + Dark buttons, got ${JSON.stringify(themeButtons)}`);

  // Check page does not crash
  const status = page.url().includes('/settings');
  assert(status, 'Expected to still be on /settings');
  log('  OK — General page loaded without crash');

  // Check for "workspace name" / "timezone" / "branding" fields
  const pageText = await page.innerText('body');
  const hasWorkspaceName = pageText.toLowerCase().includes('workspace') || pageText.toLowerCase().includes('organization');
  log(`  Workspace/org name section: ${hasWorkspaceName}`);
  if (!hasWorkspaceName) {
    log('  NOTE [P2] No workspace name field on General page — may be intentional for MVP');
  }
}

// ── 7b. Groups ───────────────────────────────────────────────────────
async function testGroups(page: Page): Promise<void> {
  log('\n── 7b. Groups /settings/groups ──');
  await goto(page, '/settings/groups');
  await screenshot(page, '07b-groups');

  const h2 = await page.$eval('h2', el => el.textContent?.trim()).catch(() => null);
  log(`  Groups heading: "${h2}"`);

  const currentUrl = page.url();
  if (currentUrl.includes('404') || currentUrl.includes('error')) {
    log('  ERROR [P0] Groups page is 404');
    return;
  }

  // Check for create group affordance
  const createBtn = await page.$('button:has-text("New Group"), button:has-text("Create"), button[title*="create"]');
  log(`  Create group button: ${!!createBtn}`);

  // Group list
  const groupRows = await page.$$('[class*="card-bg"], [class*="surface-container"]');
  log(`  Approximate group rows: ${groupRows.length}`);

  log('  OK — Groups page loaded without crash');
}

// ── 7c. Tags ─────────────────────────────────────────────────────────
async function testTags(page: Page): Promise<void> {
  log('\n── 7c. Tags /settings/tags ──');
  await goto(page, '/settings/tags');
  await screenshot(page, '07c-tags');

  const currentUrl = page.url();
  if (currentUrl.includes('404') || currentUrl.includes('error')) {
    log('  ERROR [P0] Tags page is 404');
    return;
  }

  const h2 = await page.$eval('h1, h2', el => el.textContent?.trim()).catch(() => null);
  log(`  Tags heading: "${h2}"`);

  // Tag list
  const tagItems = await page.$$('[class*="tag"], [class*="badge"], [class*="pill"]');
  log(`  Tag-styled elements: ${tagItems.length}`);

  log('  OK — Tags page loaded without crash');
}

// ── Runner ───────────────────────────────────────────────────────────
type TestResult = { name: string; status: 'pass' | 'fail'; error?: string };

async function main() {
  const startTime = Date.now();
  log('Settings deep audit — started');
  log(`Date: ${new Date().toISOString()}`);
  log(`Branch: feat/phase2-4-mcp-agents-plans`);
  log(`WEB_URL: ${WEB_URL}`);
  log(`API_URL: ${API_URL}`);

  // Ensure output dir exists
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  // Login
  log('\nLogging in...');
  process.env.DEFT_TEST_EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
  process.env.DEFT_TEST_PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';
  await loginAndSaveState();
  log('Login OK');

  const browser: Browser = await chromium.launch({ headless: false, slowMo: 100 });
  const ctx: BrowserContext = await browser.newContext({
    storageState: getStatePath(),
    viewport: VIEWPORT,
  });
  const page = await ctx.newPage();
  const { consoleErrors, failedRequests } = attachListeners(page);

  const results: TestResult[] = [];

  const tests: Array<{ name: string; fn: (p: Page) => Promise<unknown> }> = [
    { name: '1.landing', fn: testLanding },
    { name: '2.members', fn: testMembers },
    { name: '3.integrations', fn: testIntegrations },
    { name: '4.agent-dashboard', fn: testAgentDashboard },
    { name: '5.agent-employees', fn: testAgentEmployees },
    { name: '6.api-access', fn: testApiAccess },
    { name: '7a.general', fn: testGeneral },
    { name: '7b.groups', fn: testGroups },
    { name: '7c.tags', fn: testTags },
  ];

  let budget = 8 * 60 * 1000; // 8 minutes
  for (const t of tests) {
    const remaining = budget - (Date.now() - startTime);
    if (remaining < 20_000) {
      log(`\nWARN — Budget nearly exhausted (<20s). Skipping remaining tests.`);
      results.push({ name: t.name, status: 'fail', error: 'SKIPPED — budget exhausted' });
      continue;
    }
    try {
      await t.fn(page);
      results.push({ name: t.name, status: 'pass' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR in ${t.name}: ${msg}`);
      await screenshotOnFail(page, t.name);
      results.push({ name: t.name, status: 'fail', error: msg });
    }
  }

  await browser.close();

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;

  log(`\n══ Summary ══`);
  log(`Duration: ${durationSec}s`);
  log(`Tests: ${passed} passed, ${failed} failed`);
  log(`Console errors: ${consoleErrors.length}`);
  log(`HTTP 4xx/5xx: ${failedRequests.length}`);
  if (failedRequests.length > 0) {
    log(`Failed requests:\n  ${failedRequests.join('\n  ')}`);
  }

  // Write log
  writeFileSync(LOG_PATH, logBuf);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Audit runner crashed:', e);
  appendFileSync(LOG_PATH, `\nCRASH: ${e}\n`);
  process.exit(1);
});
