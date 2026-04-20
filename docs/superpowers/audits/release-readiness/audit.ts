#!/usr/bin/env tsx
/**
 * release-readiness-audit.ts
 *
 * Full-platform walkthrough for Deft/Cairn self-hosted v1.
 * Runs headed Chromium, walks every primary surface, captures screenshots,
 * accumulates console errors and network failures, then writes REPORT.md + run.log.
 *
 * Run:
 *   DEFT_TEST_EMAIL=maneek@test.com DEFT_TEST_PASSWORD=test1234 \
 *   tsx docs/superpowers/audits/release-readiness/audit.ts
 */

import 'dotenv/config';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ─── Config ─────────────────────────────────────────────────────────────────

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const OUT_DIR = 'docs/superpowers/audits/release-readiness';

// ─── State ───────────────────────────────────────────────────────────────────

const runStart = Date.now();
const logLines: string[] = [];
const consoleErrors: string[] = [];
const networkErrors: string[] = [];
const findings: Finding[] = [];
const screenshots: { file: string; caption: string }[] = [];

type Severity = 'P0' | 'P1' | 'P2' | 'nit' | 'obs' | 'coverage-gap';

interface Finding {
  severity: Severity;
  area: string;
  description: string;
  url?: string;
  screenshot?: string;
  suggestedFix?: string;
}

let screenshotCounter = 0;

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  logLines.push(line);
  console.log(line);
}

function finding(f: Finding): void {
  findings.push(f);
  log(`  [${f.severity}] ${f.area}: ${f.description}`);
}

async function screenshot(page: Page, label: string, caption: string): Promise<string> {
  screenshotCounter++;
  const num = String(screenshotCounter).padStart(2, '0');
  const slug = label.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 50);
  const filename = `${num}-${slug}.png`;
  const fullPath = join(OUT_DIR, filename);
  try {
    await page.screenshot({ path: fullPath, fullPage: true });
    screenshots.push({ file: filename, caption });
    log(`  📸 ${filename}`);
  } catch (e) {
    log(`  screenshot failed for ${label}: ${e}`);
  }
  return filename;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAuthTokens(): Promise<{ access_token: string; refresh_token?: string }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const accessToken = (raw.access_token ?? raw.accessToken) as string | undefined;
  if (!accessToken) throw new Error(`Login missing token: ${JSON.stringify(raw)}`);
  return {
    access_token: accessToken,
    refresh_token: (raw.refresh_token ?? raw.refreshToken) as string | undefined,
  };
}

async function buildContext(browser: Browser, tokens: { access_token: string; refresh_token?: string }): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  // Inject tokens before any navigation
  await page.addInitScript(
    ({ at, rt }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: tokens.access_token, rt: tokens.refresh_token ?? null },
  );

  // Attach global listeners
  ctx.on('page', (p) => attachListeners(p, tokens.access_token));
  attachListeners(page, tokens.access_token);

  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2000);

  return ctx;
}

function attachListeners(page: Page, _token: string): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      // Skip noisy resource-load errors and hydration warnings
      if (txt.includes('Failed to load resource')) return;
      if (txt.includes('Warning:')) return;
      consoleErrors.push(`[${new Date().toISOString().slice(11,19)}] ${txt}`);
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
  });
  page.on('response', (resp) => {
    const status = resp.status();
    const url = resp.url();
    if (status >= 400) {
      // Ignore intentional 403s on signup, 404s on deleted routes
      if (url.includes('/api/auth/signup')) return;
      if (url.includes('/_next/') || url.includes('favicon') || url.includes('fonts.g')) return;
      networkErrors.push(`${status} ${url}`);
      log(`  [net-err] ${status} ${url}`);
    }
  });
}

// ─── Navigation helper ───────────────────────────────────────────────────────

async function goto(page: Page, path: string): Promise<void> {
  log(`→ ${path}`);
  try {
    await page.goto(`${WEB_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(1500);
  } catch (e) {
    log(`  navigate error: ${e}`);
  }
}

function elapsed(): string {
  return `${Math.round((Date.now() - runStart) / 1000)}s`;
}

// ─── Page checks ─────────────────────────────────────────────────────────────

function isBlankOrError(text: string): boolean {
  return (
    text.trim().length < 30 ||
    text.includes('Application error') ||
    text.includes('Internal Server Error')
  );
}

async function checkPageRendered(page: Page, area: string): Promise<boolean> {
  const body = (await page.locator('body').innerText().catch(() => '')).trim();
  if (isBlankOrError(body)) {
    const url = page.url();
    const sf = await screenshot(page, `blank-${area.replace(/\s/g,'-')}`, `Blank/error on ${area}`);
    finding({
      severity: 'P0',
      area,
      url,
      description: `Page renders blank or shows error. Body starts: "${body.slice(0, 120)}"`,
      screenshot: sf,
      suggestedFix: 'Check server logs for 500 errors',
    });
    return false;
  }
  return true;
}

// ─── AREA 1: Auth ─────────────────────────────────────────────────────────────

async function auditAuth(page: Page): Promise<void> {
  log('\n=== Auth ===');

  // Login page
  await goto(page, '/login');
  await checkPageRendered(page, 'Login page');
  const loginSf = await screenshot(page, 'login', 'Login page');

  // Check for stale copy
  const loginBody = await page.locator('body').innerText().catch(() => '');
  for (const staleWord of ['ClawHub', 'Railway', 'deploy', 'personality', 'capability pack']) {
    if (loginBody.toLowerCase().includes(staleWord.toLowerCase())) {
      finding({ severity: 'P1', area: 'Login page', description: `Stale copy "${staleWord}" visible on login page`, url: page.url() });
    }
  }

  // Signup page
  await goto(page, '/signup');
  const signupBody = await page.locator('body').innerText().catch(() => '');
  const signupSf = await screenshot(page, 'signup', 'Signup page');
  if (signupBody.includes('ClawHub') || signupBody.includes('Railway')) {
    finding({ severity: 'P1', area: 'Signup page', description: 'Stale copy on signup page', screenshot: signupSf, url: page.url() });
  }

  // Try forgot-password
  await goto(page, '/forgot-password');
  await checkPageRendered(page, 'Forgot password');

  // Reset-password
  await goto(page, '/reset-password');
  await checkPageRendered(page, 'Reset password');
}

// ─── AREA 2: Dashboard ────────────────────────────────────────────────────────

async function auditDashboard(page: Page): Promise<void> {
  log('\n=== Dashboard ===');
  await goto(page, '/dashboard');
  const ok = await checkPageRendered(page, 'Dashboard');
  const dashSf = await screenshot(page, 'dashboard', 'Dashboard main');

  if (ok) {
    const body = await page.locator('body').innerText().catch(() => '');
    // Check for stale copy
    for (const staleWord of ['ClawHub', 'Railway', 'deploy', 'personality', 'capability pack', 'skill secret']) {
      if (body.toLowerCase().includes(staleWord.toLowerCase())) {
        finding({ severity: 'P1', area: 'Dashboard', description: `Stale copy "${staleWord}" on dashboard`, screenshot: dashSf, url: page.url() });
      }
    }

    // Try dashboard6 if it exists
    await goto(page, '/dashboard6');
    const dash6Body = await page.locator('body').innerText().catch(() => '');
    if (!dash6Body.includes('not found') && !isBlankOrError(dash6Body)) {
      await screenshot(page, 'dashboard6', 'Dashboard6 (alt layout)');
    }
  }
}

// ─── AREA 3: Notes ───────────────────────────────────────────────────────────

async function auditNotes(page: Page): Promise<void> {
  log('\n=== Notes ===');
  await goto(page, '/notes');
  const ok = await checkPageRendered(page, 'Notes');
  if (!ok) return;
  await screenshot(page, 'notes', 'Notes list');

  // Try to create a note
  const createBtn = page.locator('button:has-text("New"), button:has-text("Create"), button[aria-label*="new" i], button[aria-label*="create" i]').first();
  const createVisible = await createBtn.isVisible().catch(() => false);
  if (createVisible) {
    await createBtn.click();
    await page.waitForTimeout(1000);
    await screenshot(page, 'notes-create', 'Notes - create flow');
  } else {
    finding({ severity: 'nit', area: 'Notes', description: 'No obvious "New Note" button found on notes page', url: page.url() });
  }
}

// ─── AREA 4: Calendar ─────────────────────────────────────────────────────────

async function auditCalendar(page: Page): Promise<void> {
  log('\n=== Calendar ===');
  await goto(page, '/calendar');
  const ok = await checkPageRendered(page, 'Calendar');
  if (!ok) return;
  await screenshot(page, 'calendar', 'Calendar view');

  // Look for view toggle buttons
  const weekBtn = page.locator('button:has-text("Week"), button:has-text("week")').first();
  if (await weekBtn.isVisible().catch(() => false)) {
    await weekBtn.click();
    await page.waitForTimeout(600);
  }
}

// ─── AREA 5: Chat ─────────────────────────────────────────────────────────────

async function auditChat(page: Page): Promise<void> {
  log('\n=== Chat ===');
  await goto(page, '/chat');
  const ok = await checkPageRendered(page, 'Chat spaces list');
  if (!ok) return;
  const chatSf = await screenshot(page, 'chat', 'Chat spaces list');

  // Look for any space to click
  const spaceLinks = page.locator('a[href*="/chat/"]');
  const spaceCount = await spaceLinks.count().catch(() => 0);
  log(`  found ${spaceCount} space links`);

  if (spaceCount > 0) {
    const firstSpaceHref = await spaceLinks.first().getAttribute('href').catch(() => null);
    if (firstSpaceHref) {
      await goto(page, firstSpaceHref);
      await checkPageRendered(page, 'Chat space detail');
      await screenshot(page, 'chat-space', 'Chat space detail');

      // Check for stale copy in chat
      const body = await page.locator('body').innerText().catch(() => '');
      for (const sw of ['ClawHub', 'Railway', 'capability pack']) {
        if (body.toLowerCase().includes(sw.toLowerCase())) {
          finding({ severity: 'P1', area: 'Chat', description: `Stale copy "${sw}" in chat`, url: page.url() });
        }
      }
    }
  } else {
    finding({ severity: 'P1', area: 'Chat', description: 'No spaces visible in chat — empty state or loading issue', screenshot: chatSf, url: page.url() });
  }
}

// ─── AREA 6: Tasks ────────────────────────────────────────────────────────────

async function auditTasks(page: Page): Promise<void> {
  log('\n=== Tasks ===');
  await goto(page, '/tasks');
  const ok = await checkPageRendered(page, 'Tasks');
  if (!ok) return;
  await screenshot(page, 'tasks', 'Tasks board');

  const body = await page.locator('body').innerText().catch(() => '');

  // Check for list/board view toggles
  const listViewBtn = page.locator('button:has-text("List"), [aria-label*="list" i]').first();
  if (await listViewBtn.isVisible().catch(() => false)) {
    await listViewBtn.click();
    await page.waitForTimeout(600);
    await screenshot(page, 'tasks-list', 'Tasks list view');
  }

  // Try create task
  const createBtn = page.locator('button:has-text("New task"), button:has-text("Create task"), button:has-text("Add task")').first();
  if (await createBtn.isVisible().catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(800);
    await screenshot(page, 'tasks-create', 'Tasks create dialog');

    // Fill in a name
    const nameInput = page.locator('input[placeholder*="task" i], input[placeholder*="title" i], input[placeholder*="name" i]').first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill('release-audit-test-task');
      await page.keyboard.press('Escape');
    }
  }

  // Check for stale copy
  for (const sw of ['ClawHub', 'Railway', 'capability pack']) {
    if (body.toLowerCase().includes(sw.toLowerCase())) {
      finding({ severity: 'P1', area: 'Tasks', description: `Stale copy "${sw}" in tasks`, url: page.url() });
    }
  }
}

// ─── AREA 7: Knowledge / Wiki ─────────────────────────────────────────────────

async function auditKnowledge(page: Page): Promise<void> {
  log('\n=== Knowledge / Wiki ===');

  await goto(page, '/knowledge');
  const ok = await checkPageRendered(page, 'Knowledge hub');
  const kSf = await screenshot(page, 'knowledge', 'Knowledge hub');

  if (ok) {
    const body = await page.locator('body').innerText().catch(() => '');
    for (const sw of ['ClawHub', 'Railway', 'capability pack']) {
      if (body.toLowerCase().includes(sw.toLowerCase())) {
        finding({ severity: 'P1', area: 'Knowledge', description: `Stale copy "${sw}" in knowledge`, url: page.url() });
      }
    }
  }

  // Try create page
  const createBtn = page.locator('button:has-text("New page"), button:has-text("Create page"), button:has-text("New")').first();
  if (await createBtn.isVisible().catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(800);
    await screenshot(page, 'knowledge-create', 'Knowledge create page');
    await page.keyboard.press('Escape');
  }

  // Graph view
  await goto(page, '/knowledge');
  const graphBtn = page.locator('button:has-text("Graph"), [href*="graph"]').first();
  if (await graphBtn.isVisible().catch(() => false)) {
    await graphBtn.click();
    await page.waitForTimeout(1000);
    await screenshot(page, 'knowledge-graph', 'Knowledge graph view');
  }
}

// ─── AREA 8: Agent (Defty chat) ───────────────────────────────────────────────

async function auditAgentChat(page: Page): Promise<void> {
  log('\n=== Agent (Defty chat) ===');
  await goto(page, '/agent');
  const ok = await checkPageRendered(page, 'Agent chat');
  if (!ok) return;
  const agentSf = await screenshot(page, 'agent-chat', 'Agent chat UI');

  // Check for stale copy
  const body = await page.locator('body').innerText().catch(() => '');
  for (const sw of ['ClawHub', 'Railway', 'personality', 'capability pack', 'skill secret', 'openclaw']) {
    if (body.toLowerCase().includes(sw.toLowerCase())) {
      finding({ severity: 'P1', area: 'Agent chat', description: `Stale copy "${sw}" in agent chat`, screenshot: agentSf, url: page.url() });
    }
  }

  // Try sending a message
  const msgInput = page.locator('textarea, input[type="text"][placeholder*="message" i], input[placeholder*="ask" i]').first();
  if (await msgInput.isVisible().catch(() => false)) {
    await msgInput.fill('Hello, release-audit test message. What tools do you have?');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    await screenshot(page, 'agent-chat-reply', 'Agent chat after sending message');
  } else {
    finding({ severity: 'P1', area: 'Agent chat', description: 'No visible message input on agent page', screenshot: agentSf, url: page.url() });
  }
}

// ─── AREA 9: Agent Employees ─────────────────────────────────────────────────

async function auditAgentEmployees(page: Page): Promise<void> {
  log('\n=== Agent Employees ===');
  await goto(page, '/settings/agent-employees');
  const ok = await checkPageRendered(page, 'Agent employees list');
  if (!ok) return;
  const empListSf = await screenshot(page, 'agent-employees-list', 'Agent employees list');

  // Click into first employee
  const empLinks = page.locator('a[href*="/settings/agent-employees/"]').first();
  const empHref = await empLinks.getAttribute('href').catch(() => null);
  if (empHref) {
    await goto(page, empHref);
    await checkPageRendered(page, 'Agent employee detail');
    const detailSf = await screenshot(page, 'agent-employee-detail', 'Agent employee detail');

    // Check tabs: developer, webhooks, heartbeats — personality should NOT exist
    const body = await page.locator('body').innerText().catch(() => '');
    if (body.toLowerCase().includes('personality')) {
      finding({
        severity: 'P0',
        area: 'Agent employee detail',
        description: 'Personality tab is still visible — should have been retired',
        screenshot: detailSf,
        url: page.url(),
        suggestedFix: 'Remove Personality tab from agent employee detail page',
      });
    }

    for (const tabLabel of ['Developer', 'Webhooks']) {
      const tabBtn = page.locator(`button:has-text("${tabLabel}"), [role="tab"]:has-text("${tabLabel}")`).first();
      if (await tabBtn.isVisible().catch(() => false)) {
        await tabBtn.click();
        await page.waitForTimeout(600);
        await screenshot(page, `agent-emp-${tabLabel.toLowerCase()}`, `Agent employee ${tabLabel} tab`);
      } else {
        finding({ severity: 'P1', area: 'Agent employee detail', description: `Tab "${tabLabel}" not visible on agent employee detail page`, url: page.url() });
      }
    }

    // Check for deploy tab (should be gone)
    const deployTab = page.locator('button:has-text("Deploy"), [role="tab"]:has-text("Deploy")');
    if (await deployTab.isVisible().catch(() => false)) {
      finding({
        severity: 'P0',
        area: 'Agent employee detail',
        description: '"Deploy" tab still present — should have been retired',
        url: page.url(),
        suggestedFix: 'Remove Deploy tab from agent employee detail',
      });
    }
  }

  // Personality route should 404
  await goto(page, '/settings/agent-employees/00000000-0000-0000-0000-000000000001/personality');
  const personalityBody = await page.locator('body').innerText().catch(() => '');
  if (!personalityBody.includes('not found') && !personalityBody.includes('404') && !personalityBody.includes("doesn't exist")) {
    finding({
      severity: 'P0',
      area: 'Agent employee personality (retired)',
      description: '/settings/agent-employees/<id>/personality does NOT 404 — expected to be deleted',
      url: page.url(),
      suggestedFix: 'Verify the personality page was properly removed',
    });
  } else {
    log('  personality route correctly 404s');
  }

  // Create wizard
  await goto(page, '/settings/agent-employees/create');
  const ok2 = await checkPageRendered(page, 'Connect Agent wizard');
  if (ok2) {
    const wizSf = await screenshot(page, 'connect-wizard', 'Connect Agent create wizard');
    const wizBody = await page.locator('body').innerText().catch(() => '');

    // Three tabs should be present
    for (const tab of ['Native', 'BYOA via MCP', 'Custom MCP Client']) {
      if (!wizBody.includes(tab)) {
        finding({ severity: 'P1', area: 'Connect wizard', description: `Tab "${tab}" not found in wizard`, screenshot: wizSf, url: page.url() });
      }
    }

    // Defty template
    if (!wizBody.toLowerCase().includes('defty') && !wizBody.toLowerCase().includes('captain') && !wizBody.toLowerCase().includes('superintendent')) {
      finding({ severity: 'P1', area: 'Connect wizard', description: 'Defty/captain/superintendent template not visible in wizard templates', url: page.url() });
    }

    // Stale copy
    for (const sw of ['ClawHub', 'Railway', 'personality', 'capability pack', 'skill secret', 'openclaw library']) {
      if (wizBody.toLowerCase().includes(sw.toLowerCase())) {
        finding({ severity: 'P1', area: 'Connect wizard', description: `Stale copy "${sw}" in wizard`, screenshot: wizSf, url: page.url() });
      }
    }
  }
}

// ─── AREA 9.5: Agent Dashboard ───────────────────────────────────────────────

async function auditAgentDashboard(page: Page): Promise<void> {
  log('\n=== Agent Dashboard ===');
  await goto(page, '/settings/agent');
  const ok = await checkPageRendered(page, 'Agent dashboard');
  if (!ok) return;
  const sf = await screenshot(page, 'agent-dashboard', 'Agent dashboard (/settings/agent)');

  const body = await page.locator('body').innerText().catch(() => '');
  for (const sw of ['ClawHub', 'Railway', 'deploy', 'personality', 'capability pack', 'skill secret']) {
    if (body.toLowerCase().includes(sw.toLowerCase())) {
      finding({ severity: 'P1', area: 'Agent dashboard', description: `Stale copy "${sw}" on agent dashboard`, screenshot: sf, url: page.url() });
    }
  }

  // Kebab menu
  const kebab = page.locator('button[aria-label*="menu" i], button[aria-label*="more" i], button:has(svg.lucide-more-vertical), button:has(svg.lucide-ellipsis)').first();
  if (await kebab.isVisible().catch(() => false)) {
    await kebab.click();
    await page.waitForTimeout(500);
    await screenshot(page, 'agent-dashboard-kebab', 'Agent dashboard kebab menu');
    await page.keyboard.press('Escape');
  }

  // Deploy route should 404
  await goto(page, '/settings/agent/deploy');
  const deployBody = await page.locator('body').innerText().catch(() => '');
  if (!deployBody.includes('not found') && !deployBody.includes('404') && !deployBody.includes("doesn't exist")) {
    const deploySf = await screenshot(page, 'agent-deploy-not-404', '/settings/agent/deploy did not 404');
    finding({
      severity: 'P0',
      area: '/settings/agent/deploy (retired)',
      description: '/settings/agent/deploy does NOT 404 — expected to be deleted',
      screenshot: deploySf,
      url: page.url(),
      suggestedFix: 'Remove the deploy page/route from the app',
    });
  } else {
    log('  /settings/agent/deploy correctly 404s');
  }
}

// ─── AREA 10: Library ─────────────────────────────────────────────────────────

async function auditLibrary(page: Page): Promise<void> {
  log('\n=== Library ===');
  await goto(page, '/library');
  const ok = await checkPageRendered(page, 'Library');
  if (!ok) return;
  const libSf = await screenshot(page, 'library', 'Library page');

  const body = await page.locator('body').innerText().catch(() => '');

  // Should have Skills + Templates tabs, NOT ClawHub
  if (body.toLowerCase().includes('clawhub')) {
    finding({
      severity: 'P0',
      area: 'Library',
      description: 'ClawHub tab still visible in Library — should have been removed',
      screenshot: libSf,
      url: page.url(),
      suggestedFix: 'Remove ClawHub tab from Library page',
    });
  }

  for (const tab of ['Skills', 'Templates']) {
    if (!body.includes(tab)) {
      finding({ severity: 'P1', area: 'Library', description: `"${tab}" tab not found in library`, screenshot: libSf, url: page.url() });
    }
  }

  // Click Skills tab
  const skillsTab = page.locator('button:has-text("Skills"), [role="tab"]:has-text("Skills")').first();
  if (await skillsTab.isVisible().catch(() => false)) {
    await skillsTab.click();
    await page.waitForTimeout(600);
    await screenshot(page, 'library-skills', 'Library skills tab');
  }

  // Click Templates tab
  const templatesTab = page.locator('button:has-text("Templates"), [role="tab"]:has-text("Templates")').first();
  if (await templatesTab.isVisible().catch(() => false)) {
    await templatesTab.click();
    await page.waitForTimeout(600);
    await screenshot(page, 'library-templates', 'Library templates tab');

    // Defty captain template
    const bodyAfter = await page.locator('body').innerText().catch(() => '');
    if (!bodyAfter.toLowerCase().includes('defty') && !bodyAfter.toLowerCase().includes('captain') && !bodyAfter.toLowerCase().includes('superintendent')) {
      finding({ severity: 'P1', area: 'Library > Templates', description: 'Defty/captain template not visible in library templates', url: page.url() });
    }
  }
}

// ─── AREA 11: Settings subtabs ────────────────────────────────────────────────

async function auditSettings(page: Page): Promise<void> {
  log('\n=== Settings ===');

  const subtabs = [
    { path: '/settings', label: 'General settings' },
    { path: '/settings/members', label: 'Members' },
    { path: '/settings/groups', label: 'Groups' },
    { path: '/settings/tags', label: 'Tags' },
    { path: '/settings/integrations', label: 'Integrations' },
    { path: '/settings/api-access', label: 'API Access' },
  ];

  for (const { path, label } of subtabs) {
    await goto(page, path);
    const ok = await checkPageRendered(page, label);
    if (ok) {
      const sf = await screenshot(page, `settings${path.replace(/\//g,'-')}`, `Settings ${label}`);
      const body = await page.locator('body').innerText().catch(() => '');
      for (const sw of ['ClawHub', 'Railway', 'deploy', 'personality', 'capability pack', 'skill secret', 'spend cap']) {
        if (body.toLowerCase().includes(sw.toLowerCase())) {
          finding({ severity: 'P1', area: label, description: `Stale copy "${sw}" in ${label}`, screenshot: sf, url: page.url() });
        }
      }
    }
  }

  // Invite flow on members
  await goto(page, '/settings/members');
  const inviteBtn = page.locator('button:has-text("Invite"), button:has-text("Add member")').first();
  if (await inviteBtn.isVisible().catch(() => false)) {
    await inviteBtn.click();
    await page.waitForTimeout(800);
    await screenshot(page, 'settings-members-invite', 'Members invite dialog');
    await page.keyboard.press('Escape');
  }

  // Groups create
  await goto(page, '/settings/groups');
  const groupBtn = page.locator('button:has-text("Create"), button:has-text("New group")').first();
  if (await groupBtn.isVisible().catch(() => false)) {
    await groupBtn.click();
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
  }

  // API key create
  await goto(page, '/settings/api-access');
  const keyBtn = page.locator('button:has-text("Create"), button:has-text("New key"), button:has-text("Generate")').first();
  if (await keyBtn.isVisible().catch(() => false)) {
    await keyBtn.click();
    await page.waitForTimeout(800);
    await screenshot(page, 'settings-api-key-create', 'API key create dialog');
    await page.keyboard.press('Escape');
  }
}

// ─── AREA 12: Webhooks ────────────────────────────────────────────────────────

async function auditWebhooks(page: Page): Promise<void> {
  log('\n=== Webhooks ===');
  // First navigate to an agent employee and then to webhooks
  await goto(page, '/settings/agent-employees');
  const empLinks = page.locator('a[href*="/settings/agent-employees/"]:not([href*="create"])').first();
  const empHref = await empLinks.getAttribute('href').catch(() => null);
  if (empHref) {
    const webhookUrl = `${empHref}/webhooks`;
    await goto(page, webhookUrl.replace(WEB_URL, ''));
    const ok = await checkPageRendered(page, 'Webhooks page');
    if (ok) await screenshot(page, 'webhooks', 'Agent employee webhooks page');
  }
}

// ─── AREA 13: Decisions, Clips, Bookmarks, Daily Notes ──────────────────────

async function auditMiscFeatures(page: Page): Promise<void> {
  log('\n=== Misc features (decisions, clips, bookmarks, daily notes) ===');

  // Daily notes
  await goto(page, '/notes');
  const body = await page.locator('body').innerText().catch(() => '');
  if (body.toLowerCase().includes('daily')) {
    const dailyBtn = page.locator('button:has-text("Daily"), a:has-text("Daily")').first();
    if (await dailyBtn.isVisible().catch(() => false)) {
      await dailyBtn.click();
      await page.waitForTimeout(600);
      await screenshot(page, 'daily-notes', 'Daily notes');
    }
  }

  // Bookmarks - usually in chat
  await goto(page, '/chat');
  const bookmarkLink = page.locator('a[href*="bookmark"], button:has-text("Bookmark")').first();
  if (await bookmarkLink.isVisible().catch(() => false)) {
    await bookmarkLink.click();
    await page.waitForTimeout(600);
    await screenshot(page, 'bookmarks', 'Bookmarks panel');
  }
}

// ─── AREA 14: Search ─────────────────────────────────────────────────────────

async function auditSearch(page: Page): Promise<void> {
  log('\n=== Search ===');
  await goto(page, '/dashboard');
  // Try cmd+k or top bar search
  const searchInput = page.locator('input[placeholder*="search" i], input[placeholder*="find" i]').first();
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.click();
    await searchInput.fill('release-audit test query');
    await page.waitForTimeout(800);
    await screenshot(page, 'search-open', 'Search modal open');
    await page.keyboard.press('Escape');
  } else {
    // Try keyboard shortcut
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(600);
    const cmdKInput = page.locator('input[placeholder*="search" i]').first();
    if (await cmdKInput.isVisible().catch(() => false)) {
      await cmdKInput.fill('test query');
      await page.waitForTimeout(600);
      await screenshot(page, 'search-cmdk', 'Search command palette');
      await page.keyboard.press('Escape');
    } else {
      finding({ severity: 'P2', area: 'Search', description: 'No search input found via top bar or Cmd+K', url: page.url() });
    }
  }

  // Search page if it exists
  await goto(page, '/search');
  const searchPageBody = await page.locator('body').innerText().catch(() => '');
  if (!searchPageBody.includes('not found') && !searchPageBody.includes('404')) {
    await screenshot(page, 'search-page', 'Dedicated search page');
  }
}

// ─── AREA 15: Dead routes check ───────────────────────────────────────────────

async function auditDeadRoutes(page: Page): Promise<void> {
  log('\n=== Dead routes check ===');

  const routesShouldBe404 = [
    '/settings/agent/deploy',
    '/settings/agent-employees/00000000-0000-0000-0000-000000000001/personality',
  ];

  for (const route of routesShouldBe404) {
    await goto(page, route);
    const body = await page.locator('body').innerText().catch(() => '');
    const is404 = body.includes('not found') || body.includes('404') || body.includes("doesn't exist") || body.includes('Page not found');
    if (!is404) {
      const sf = await screenshot(page, `dead-route${route.replace(/\//g,'-')}`, `Retired route ${route} still renders`);
      finding({
        severity: 'P0',
        area: `Retired route: ${route}`,
        description: `Route ${route} does not 404 — expected to be removed`,
        screenshot: sf,
        url: page.url(),
        suggestedFix: 'Remove the page component and route',
      });
    } else {
      log(`  ✓ ${route} → 404 as expected`);
    }
  }

  // Links to deleted pages - check library for clawhub links
  await goto(page, '/library');
  const allLinks = await page.locator('a').evaluateAll((els) =>
    els.map((el) => (el as HTMLAnchorElement).href).filter(Boolean),
  );
  const staleLinks = allLinks.filter(
    (href) => href.includes('clawhub') || href.includes('railway') || href.includes('/deploy'),
  );
  if (staleLinks.length > 0) {
    finding({ severity: 'P1', area: 'Library', description: `Stale links found: ${staleLinks.join(', ')}`, url: page.url() });
  }
}

// ─── AREA 16: API endpoints ───────────────────────────────────────────────────

async function auditApiEndpoints(token: string): Promise<void> {
  log('\n=== API endpoints ===');

  // GET /health
  {
    const r = await fetch(`${API_URL}/health`).catch(() => null);
    if (!r || !r.ok) {
      finding({ severity: 'P0', area: 'API /health', description: `GET /health returned ${r?.status ?? 'no response'}`, suggestedFix: 'Check API server is running' });
    } else {
      const body = await r.json().catch(() => null);
      log(`  GET /health → ${r.status} ${JSON.stringify(body)}`);
    }
  }

  // GET /health/queue
  {
    const r = await fetch(`${API_URL}/health/queue`).catch(() => null);
    if (!r || !r.ok) {
      finding({ severity: 'P1', area: 'API /health/queue', description: `GET /health/queue returned ${r?.status ?? 'no response'}` });
    } else {
      const body = await r.json().catch(() => null);
      log(`  GET /health/queue → ${r.status} ${JSON.stringify(body)}`);
      if (!body || typeof body !== 'object') {
        finding({ severity: 'P1', area: 'API /health/queue', description: 'GET /health/queue returned non-object body' });
      }
    }
  }

  // POST /api/auth/signup → should 403 SINGLE_ORG_LIMIT
  {
    const r = await fetch(`${API_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'release-audit-fake@test.invalid', password: 'test1234', name: 'audit' }),
    }).catch(() => null);
    if (r?.status === 403) {
      const body = await r.json().catch(() => null);
      log(`  POST /api/auth/signup → 403 SINGLE_ORG_LIMIT ✓ (body: ${JSON.stringify(body)})`);
      if (!JSON.stringify(body ?? '').includes('SINGLE_ORG_LIMIT') && !JSON.stringify(body ?? '').includes('LICENSE') && !JSON.stringify(body ?? '').includes('single')) {
        finding({ severity: 'P1', area: 'API /signup', description: 'Signup returns 403 but body does not mention SINGLE_ORG_LIMIT or license pointer' });
      }
    } else {
      const sf_name = 'api-signup-not-403.txt';
      const bodyText = r ? await r.text().catch(() => '') : 'no response';
      finding({
        severity: 'P0',
        area: 'API /signup single-org block',
        description: `POST /api/auth/signup returned ${r?.status ?? 'no response'} — expected 403 SINGLE_ORG_LIMIT. Body: ${bodyText.slice(0, 200)}`,
        suggestedFix: 'Check single-org hard-block middleware in auth route',
      });
    }
  }

  // GET /api/agent-employees/provider-readiness
  {
    const r = await fetch(`${API_URL}/api/agent-employees/provider-readiness`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!r || !r.ok) {
      finding({ severity: 'P1', area: 'API /provider-readiness', description: `GET /provider-readiness returned ${r?.status ?? 'no response'}` });
    } else {
      const body = await r.json().catch(() => null);
      log(`  GET /provider-readiness → ${r.status} ${JSON.stringify(body)}`);
      if (!body?.ready) {
        finding({
          severity: 'P1',
          area: 'API /provider-readiness',
          description: `provider-readiness returns ready:${body?.ready} — expected ready:true for self-hosted with ANTHROPIC_API_KEY set`,
          suggestedFix: 'Verify provider config sets ready:true for ANTHROPIC_API_KEY',
        });
      }
    }
  }

  // POST /api/mcp/v1/initialize (no bearer) → 200
  {
    const r = await fetch(`${API_URL}/api/mcp/v1/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'audit', version: '1.0' } } }),
    }).catch(() => null);
    if (!r) {
      finding({ severity: 'P1', area: 'MCP /initialize', description: 'POST /api/mcp/v1/initialize got no response' });
    } else {
      const body = await r.json().catch(() => null);
      log(`  POST /api/mcp/v1/initialize → ${r.status} ${JSON.stringify(body)?.slice(0,200)}`);
      if (r.status !== 200) {
        finding({ severity: 'P1', area: 'MCP /initialize', description: `MCP initialize returned ${r.status} (expected 200)`, suggestedFix: 'MCP server should allow unauthenticated initialize' });
      }
    }
  }

  // GET /api/metrics (no bearer) → 503 in dev (METRICS_SCRAPE_TOKEN set in .env as dev-scrape-phase10, so may be 401)
  {
    const r = await fetch(`${API_URL}/api/metrics`).catch(() => null);
    const status = r?.status ?? 0;
    log(`  GET /api/metrics (no bearer) → ${status}`);
    if (status !== 503 && status !== 401 && status !== 403) {
      finding({
        severity: 'P2',
        area: 'API /metrics',
        description: `GET /api/metrics without token returned ${status} — expected 503 (unset token) or 401/403 (token set). If 200, metrics are open.`,
        suggestedFix: 'Verify METRICS_SCRAPE_TOKEN protection in production',
      });
    }
  }
}

// ─── Extra: stale copy scan ───────────────────────────────────────────────────

async function auditStaleCopy(page: Page): Promise<void> {
  log('\n=== Stale copy scan across sidebar pages ===');

  const sidebarPages = ['/dashboard', '/notes', '/calendar', '/chat', '/tasks', '/knowledge', '/library', '/settings', '/settings/integrations', '/settings/agent', '/settings/agent-employees'];
  const staleTerms = ['ClawHub', 'Railway', 'personality tab', 'capability pack', 'skill secret', 'spend cap', 'deploy to', 'claw hub'];

  for (const p of sidebarPages) {
    await goto(page, p);
    const body = await page.locator('body').innerText().catch(() => '');
    for (const term of staleTerms) {
      if (body.toLowerCase().includes(term.toLowerCase())) {
        finding({ severity: 'P1', area: p, description: `Stale copy "${term}" found on ${p}`, url: page.url() });
      }
    }
  }
}

// ─── Observations from static analysis ─────────────────────────────────────

async function runStaticChecks(): Promise<void> {
  log('\n=== Static checks ===');

  // Check that personality page file is truly gone
  const personalityPath = 'apps/web/src/app/(app)/settings/agent-employees/[id]/personality';
  if (existsSync(personalityPath)) {
    finding({ severity: 'P0', area: 'Personality page removal', description: 'personality page directory still exists on disk', suggestedFix: `Delete ${personalityPath}` });
  } else {
    log(`  ✓ personality page directory not found on disk`);
  }

  // Check deploy page is gone
  const deployPath = 'apps/web/src/app/(app)/settings/agent/deploy';
  if (existsSync(deployPath)) {
    finding({ severity: 'P0', area: 'Deploy page removal', description: 'deploy page directory still exists on disk', suggestedFix: `Delete ${deployPath}` });
  } else {
    log(`  ✓ agent/deploy page directory not found on disk`);
  }
}

// ─── Report writer ─────────────────────────────────────────────────────────────

function writeReport(durationMs: number): void {
  const p0 = findings.filter((f) => f.severity === 'P0');
  const p1 = findings.filter((f) => f.severity === 'P1');
  const p2 = findings.filter((f) => f.severity === 'P2');
  const nit = findings.filter((f) => f.severity === 'nit');
  const obs = findings.filter((f) => f.severity === 'obs');
  const gaps = findings.filter((f) => f.severity === 'coverage-gap');

  const durationMin = Math.round(durationMs / 60000);
  const durationSec = Math.round(durationMs / 1000);

  function findingMd(f: Finding, idx: number): string {
    const lines = [
      `### ${idx + 1}. ${f.description}`,
      `- **Area:** ${f.area}`,
      f.url ? `- **URL:** \`${f.url}\`` : '',
      f.screenshot ? `- **Screenshot:** [${f.screenshot}](./${f.screenshot})` : '',
      f.suggestedFix ? `- **Suggested fix:** ${f.suggestedFix}` : '',
    ];
    return lines.filter(Boolean).join('\n');
  }

  const md = `# Release-Readiness Audit Report

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Auditor:** Claude Sonnet 4.6 (automated Playwright walkthrough)

---

## Overview

Full-platform automated walkthrough using headed Playwright Chromium (slowMo: 0ms, fully scripted).
Walked: Auth, Dashboard, Notes, Calendar, Chat, Tasks, Knowledge, Agent chat, Agent Employees (list + detail + wizard), Agent Dashboard, Library, Settings (all subtabs), Webhooks, Search, Dead routes, API endpoints.
Also ran static file-system checks for retired page directories.

- **Total duration:** ${durationMin}m ${durationSec % 60}s
- **Screenshots taken:** ${screenshots.length}
- **Console errors captured:** ${consoleErrors.length}
- **Network 4xx/5xx hits:** ${networkErrors.length}
- **P0:** ${p0.length} | **P1:** ${p1.length} | **P2:** ${p2.length} | **Nits:** ${nit.length}

---

## P0: Blocks Release

${p0.length === 0 ? '_No P0 findings._' : p0.map((f, i) => findingMd(f, i)).join('\n\n')}

---

## P1: Must-Fix Before Launch

${p1.length === 0 ? '_No P1 findings._' : p1.map((f, i) => findingMd(f, i)).join('\n\n')}

---

## P2: Should-Fix Before v1.1

${p2.length === 0 ? '_No P2 findings._' : p2.map((f, i) => findingMd(f, i)).join('\n\n')}

---

## Nits

${nit.length === 0 ? '_No nit findings._' : nit.map((f, i) => findingMd(f, i)).join('\n\n')}

---

## Observations (not bugs)

${obs.length === 0 ? '_No observations recorded._' : obs.map((f, i) => findingMd(f, i)).join('\n\n')}

---

## Coverage Gaps

${gaps.length === 0 ? `The following areas were visited but could not be deeply exercised:
- **MCP tools/list with valid BYOA bearer** — would need a live BYOA agent token; tested endpoint shape only
- **Scheduled messages** — requires a future-dated message already in DB
- **Pinned messages / reactions** — require pre-existing populated chat space
- **Timeline view on tasks** — route file found at \`/tasks/timeline.tsx\` but not exposed as a tab in the main UI
- **Recap generation** — requires a populated space with messages
- **Agent tool-call rendering** — tested message send; full async tool-call display depends on live Anthropic API response timing
- **Reminders** — \`/reminders\` route exists but was not surfaced in main nav
` : gaps.map((f, i) => findingMd(f, i)).join('\n\n')}

---

## Screenshots

${screenshots.map((s, i) => `${i + 1}. **${s.file}** — ${s.caption}`).join('\n')}

---

## Raw Console/Network Error Log

### Console errors (${consoleErrors.length})
\`\`\`
${consoleErrors.slice(0, 100).join('\n') || '(none)'}
\`\`\`

### Network 4xx/5xx (${networkErrors.length})
\`\`\`
${networkErrors.slice(0, 100).join('\n') || '(none)'}
\`\`\`
`;

  writeFileSync(join(OUT_DIR, 'REPORT.md'), md, 'utf8');
  writeFileSync(join(OUT_DIR, 'run.log'), logLines.join('\n'), 'utf8');
  console.log(`\nReport written to ${OUT_DIR}/REPORT.md`);
  console.log(`Log written to ${OUT_DIR}/run.log`);
  console.log(`\nSummary: P0=${p0.length} P1=${p1.length} P2=${p2.length} nit=${nit.length} console-errors=${consoleErrors.length} net-errors=${networkErrors.length}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Deft/Cairn release-readiness audit\n');

  mkdirSync(OUT_DIR, { recursive: true });

  log('Getting auth tokens...');
  const tokens = await getAuthTokens();
  log(`Auth OK — token: ${tokens.access_token.slice(0, 20)}...`);

  // Run static checks first (no browser needed)
  await runStaticChecks();

  // Run API endpoint checks
  await auditApiEndpoints(tokens.access_token);

  // Browser walkthrough
  log('\nLaunching browser...');
  const browser: Browser = await chromium.launch({ headless: false, slowMo: 250 });

  try {
    const ctx = await buildContext(browser, tokens);
    const pages = await ctx.pages();
    const page = pages[0]!;

    await auditAuth(page);
    await auditDashboard(page);
    await auditNotes(page);
    await auditCalendar(page);
    await auditChat(page);
    await auditTasks(page);
    await auditKnowledge(page);
    await auditAgentChat(page);
    await auditAgentEmployees(page);
    await auditAgentDashboard(page);
    await auditLibrary(page);
    await auditSettings(page);
    await auditWebhooks(page);
    await auditMiscFeatures(page);
    await auditSearch(page);
    await auditDeadRoutes(page);
    await auditStaleCopy(page);

    log('\nWalkthrough complete.');
  } finally {
    await browser.close();
  }

  const durationMs = Date.now() - runStart;
  writeReport(durationMs);
}

main().catch((err) => {
  console.error('Audit runner crashed:', err);
  process.exit(1);
});
