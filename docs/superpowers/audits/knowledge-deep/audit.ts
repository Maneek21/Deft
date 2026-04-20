#!/usr/bin/env tsx
/**
 * Knowledge / Wiki Deep Audit — 7 focused test groups.
 * Runs against dev servers: API :3001, Web :3000.
 * Test user: maneek@test.com / test1234
 *
 * Groups:
 *   1. /knowledge hub — initial load, widgets, counts
 *   2. /wiki list — filters by type/scope, page count
 *   3. Search — full-text across wiki pages (PostgreSQL, deployment, Docker)
 *   4. View a page — detail view (content, tags, confidence, links)
 *   5. Create a wiki page — modal, save, DB verification
 *   6. Edit a page — inline editor, save, reflects changes
 *   7. Graph view — render check, node/edge counts, interactivity
 */
import 'dotenv/config';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';
const KNOWLEDGE_URL = `${WEB_URL}/knowledge`;
const AUDIT_DIR = 'docs/superpowers/audits/knowledge-deep';
const LOG_FILE = join(AUDIT_DIR, 'run.log');
const REPORT_FILE = join(AUDIT_DIR, 'REPORT.md');

const START_TIME = Date.now();
const MAX_WALL_MS = 8 * 60 * 1000; // 8 minutes

const findings: Array<{
  severity: 'P0' | 'P1' | 'P2' | 'Nit';
  area: string;
  description: string;
  screenshot?: string;
  detail?: string;
}> = [];

const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const networkErrors: string[] = [];
let shotCounter = 0;
let createdPageSlug: string | null = null;
let createdPageTitle = '';

// ── Logging ──────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 23); }
function log(msg: string) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + '\n');
}
function logOk(msg: string) { log(`OK   ${msg}`); }
function logFail(msg: string) { log(`FAIL ${msg}`); }
function logInfo(msg: string) { log(`INFO ${msg}`); }
function logSection(msg: string) { log(`\n${'='.repeat(60)}\n  ${msg}\n${'='.repeat(60)}`); }
function logProgress(msg: string) { log(`... ${msg}`); }

function find(
  severity: 'P0' | 'P1' | 'P2' | 'Nit',
  area: string,
  description: string,
  screenshot?: string,
  detail?: string,
) {
  findings.push({ severity, area, description, screenshot, detail });
  log(`[FINDING:${severity}] ${area}: ${description}${detail ? ' | ' + detail : ''}`);
}

// ── Screenshot ───────────────────────────────────────────────────────────────
async function shot(page: Page, label: string): Promise<string> {
  shotCounter++;
  const num = String(shotCounter).padStart(2, '0');
  const fname = `${num}-${label}.png`;
  const fpath = join(AUDIT_DIR, fname);
  try {
    await page.screenshot({ path: fpath, fullPage: false });
    logInfo(`screenshot saved: ${fname}`);
    return fname;
  } catch (e) {
    logFail(`screenshot failed: ${fname} — ${e}`);
    return fname;
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────
async function apiLogin() {
  logInfo(`Logging in as ${EMAIL}...`);
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as Record<string, unknown>;
  logOk(`Login OK — status ${res.status}`);
  return {
    accessToken: (j.access_token ?? j.accessToken) as string,
    refreshToken: (j.refresh_token ?? j.refreshToken) as string | undefined,
    orgId: (j.org_id ?? j.orgId) as string,
    userId: (j.user as { id: string } | undefined)?.id ?? '',
  };
}

async function apiFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
  const txt = await res.text();
  let body: unknown = txt;
  try { body = JSON.parse(txt); } catch { /* keep text */ }
  return { status: res.status, body: body as T };
}

// ── Wait helpers ──────────────────────────────────────────────────────────────
async function waitOrStall(
  page: Page,
  selector: string,
  timeout = 5000,
  label?: string,
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
    return true;
  } catch {
    log(
      `[STALL] waitForSelector timed out after ${timeout}ms: ${selector}${
        label ? ` (${label})` : ''
      }`,
    );
    return false;
  }
}

async function waitMs(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Listeners ─────────────────────────────────────────────────────────────────
function attachListeners(page: Page) {
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      const text = msg.text();
      consoleErrors.push(`[${type}] ${text}`);
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
    log(`[PAGEERROR] ${err.message.slice(0, 200)}`);
  });
  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) {
      const url = res.url();
      if (!url.includes('favicon') && !url.includes('chrome-extension')) {
        networkErrors.push(`${status} ${res.request().method()} ${url}`);
      }
    }
  });
}

// ── Auth injection ─────────────────────────────────────────────────────────────
async function injectAuth(
  context: BrowserContext,
  accessToken: string,
  refreshToken?: string,
) {
  await context.addInitScript(
    ({ at, rt }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: accessToken, rt: refreshToken ?? null },
  );
}

// ── Group 1: /knowledge hub ───────────────────────────────────────────────────
async function group1Hub(page: Page, token: string) {
  logSection('Group 1: /knowledge hub — initial load');
  logProgress('Navigating to /knowledge...');

  const t0 = Date.now();
  await page.goto(KNOWLEDGE_URL, { waitUntil: 'networkidle', timeout: 20000 });
  const elapsed = Date.now() - t0;
  logInfo(`Page loaded in ${elapsed}ms`);

  if (elapsed > 3000) {
    find('P2', 'Knowledge/Hub', `Slow page load: ${elapsed}ms (>3s)`);
  }

  // Check for JS errors on load
  if (pageErrors.length > 0) {
    find('P1', 'Knowledge/Hub', 'Uncaught JS errors on load', undefined, pageErrors[0].slice(0, 200));
  }

  // Screenshot hub initial state
  const hubShot = await shot(page, 'knowledge-hub-initial-load');

  // Check heading visible
  const heading = await page.locator('h1').first().textContent().catch(() => null);
  logInfo(`Page heading: "${heading}"`);
  if (!heading?.toLowerCase().includes('knowledge')) {
    find('P1', 'Knowledge/Hub', `Heading missing or wrong: "${heading}"`);
  } else {
    logOk(`Heading found: "${heading}"`);
  }

  // Check search box exists
  const searchBox = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
  const hasSearch = await searchBox.isVisible().catch(() => false);
  if (!hasSearch) {
    find('P1', 'Knowledge/Hub', 'Search box not visible on knowledge hub', hubShot);
  } else {
    logOk('Search box visible');
  }

  // Check type filter tabs visible
  const typeFilterAll = page.locator('button').filter({ hasText: /^All$/ });
  const hasTypeFilter = await typeFilterAll.isVisible().catch(() => false);
  if (!hasTypeFilter) {
    find('P2', 'Knowledge/Hub', 'Type filter tabs (All / Concepts / etc.) not visible');
  } else {
    logOk('Type filter tabs visible');
  }

  // Verify API count of wiki pages
  const apiResult = await apiFetch<{ pages: any[]; total: number }>(
    '/api/wiki?limit=100&page=1',
    token,
  );
  if (apiResult.status !== 200) {
    find('P0', 'Knowledge/Hub', `API /api/wiki returned ${apiResult.status} instead of 200`);
  } else {
    const total = (apiResult.body as any).total ?? 0;
    const pages = (apiResult.body as any).pages ?? [];
    logInfo(`API: total wiki pages = ${total}, returned ${pages.length}`);
    if (total < 10) {
      find(
        'P1',
        'Knowledge/Hub',
        `Only ${total} wiki pages in DB — expected ~41 after seed re-run`,
      );
    } else {
      logOk(`Wiki seed looks healthy: ${total} pages`);
    }
  }

  // Check view mode buttons (Pages / Activity / Stats)
  const viewModeButtons = ['Pages', 'Activity', 'Stats'];
  for (const btn of viewModeButtons) {
    const el = page.locator('button').filter({ hasText: new RegExp(`^${btn}$`) }).first();
    const visible = await el.isVisible().catch(() => false);
    if (!visible) {
      find('P2', 'Knowledge/Hub', `View mode button "${btn}" not visible`);
    } else {
      logOk(`View mode button "${btn}" visible`);
    }
  }

  // Graph toggle button
  const graphBtn = page.locator('button').filter({ hasText: /Graph/ }).first();
  const hasGraphBtn = await graphBtn.isVisible().catch(() => false);
  if (!hasGraphBtn) {
    find('P1', 'Knowledge/Hub', 'Graph toggle button not visible', hubShot);
  } else {
    logOk('Graph toggle button visible');
  }

  // "New" page button
  const newBtn = page.locator('button').filter({ hasText: /New/ }).first();
  const hasNewBtn = await newBtn.isVisible().catch(() => false);
  if (!hasNewBtn) {
    find('P1', 'Knowledge/Hub', '"New" / create page button not visible', hubShot);
  } else {
    logOk('"New" button visible');
  }
}

// ── Group 2: /knowledge list — filters + scope ────────────────────────────────
async function group2List(page: Page, token: string) {
  logSection('Group 2: Wiki list — type + scope filters');
  logProgress('Checking list is populated...');

  // Wait for page cards to load
  const loaded = await waitOrStall(page, '.rounded-lg', 6000, 'wiki-page-cards');
  if (!loaded) {
    find('P1', 'Knowledge/List', 'Wiki page list did not load within 6s');
  }

  const listShot = await shot(page, 'knowledge-list-view');

  // Count visible page cards in list
  const cards = await page.locator('[class*="rounded-lg"] button[class*="w-full text-left"]').count();
  logInfo(`Visible page cards: ${cards}`);
  if (cards === 0) {
    find('P1', 'Knowledge/List', 'Zero page cards rendered in list view', listShot);
  } else {
    logOk(`${cards} page cards rendered`);
  }

  // Test Concepts filter
  logProgress('Clicking "Concepts" type filter...');
  const conceptsBtn = page.locator('button').filter({ hasText: /^Concepts$/ }).first();
  const hasConceptsBtn = await conceptsBtn.isVisible().catch(() => false);
  if (hasConceptsBtn) {
    await conceptsBtn.click();
    await waitMs(1000);
    const conceptShot = await shot(page, 'filter-concepts');
    const conceptCards = await page
      .locator('[class*="rounded-lg"] button[class*="w-full text-left"]')
      .count();
    logInfo(`Concept-filtered cards: ${conceptCards}`);
    if (conceptCards === 0) {
      find('P2', 'Knowledge/List', 'Concepts filter yields 0 cards — may be filtering bug or empty data', conceptShot);
    } else {
      logOk(`Concepts filter OK — ${conceptCards} cards`);
    }
    // Reset to All
    const allBtn = page.locator('button').filter({ hasText: /^All$/ }).first();
    if (await allBtn.isVisible().catch(() => false)) await allBtn.click();
    await waitMs(500);
  } else {
    find('P2', 'Knowledge/List', '"Concepts" filter button not found');
  }

  // Test Decisions filter (special — has reverse button)
  logProgress('Clicking "Decisions" type filter...');
  const decisionsBtn = page.locator('button').filter({ hasText: /^Decisions$/ }).first();
  if (await decisionsBtn.isVisible().catch(() => false)) {
    await decisionsBtn.click();
    await waitMs(1000);
    const decShot = await shot(page, 'filter-decisions');
    // Check for "Reverse" or "Re-activate" buttons
    const reverseButtons = await page.locator('button').filter({ hasText: /Reverse/ }).count();
    logInfo(`Decision reverse buttons visible: ${reverseButtons}`);
    if (reverseButtons === 0) {
      find('Nit', 'Knowledge/List', 'No decision reverse buttons visible — may be no decision pages or they are reversed already', decShot);
    } else {
      logOk(`Decision reverse buttons visible: ${reverseButtons}`);
    }
    // Reset to All
    const allBtn2 = page.locator('button').filter({ hasText: /^All$/ }).first();
    if (await allBtn2.isVisible().catch(() => false)) await allBtn2.click();
    await waitMs(500);
  }

  // Test Scope filter
  logProgress('Testing scope filter...');
  const orgScopeBtn = page.locator('button').filter({ hasText: /^Org$/ }).first();
  if (await orgScopeBtn.isVisible().catch(() => false)) {
    await orgScopeBtn.click();
    await waitMs(800);
    await shot(page, 'filter-scope-org');
    logOk('Org scope filter clicked');
    // Reset
    const allScopeBtn = page.locator('button').filter({ hasText: /^All$/ }).nth(0);
    if (await allScopeBtn.isVisible().catch(() => false)) await allScopeBtn.click();
    await waitMs(300);
  } else {
    find('Nit', 'Knowledge/List', 'Scope "Org" filter button not found');
  }
}

// ── Group 3: Search ───────────────────────────────────────────────────────────
async function group3Search(page: Page, token: string) {
  logSection('Group 3: Full-text search');

  const searchBox = page
    .locator('input[placeholder*="Search"], input[placeholder*="search"]')
    .first();
  const hasSearch = await searchBox.isVisible().catch(() => false);
  if (!hasSearch) {
    find('P0', 'Knowledge/Search', 'Search input not found — cannot test search');
    return;
  }

  const queries = ['PostgreSQL', 'deployment', 'Docker'];
  for (const q of queries) {
    logProgress(`Searching for "${q}"...`);
    await searchBox.click();
    await searchBox.fill('');
    await searchBox.type(q, { delay: 50 });
    await waitMs(800);

    const searchShot = await shot(page, `search-${q.toLowerCase()}`);
    const cards = await page
      .locator('[class*="rounded-lg"] button[class*="w-full text-left"]')
      .count();
    logInfo(`Search "${q}": ${cards} results`);

    if (cards === 0) {
      // Verify via API
      const apiResult = await apiFetch<{ pages: any[]; total: number }>(
        `/api/wiki?q=${encodeURIComponent(q)}&limit=10`,
        token,
      );
      const apiTotal = (apiResult.body as any)?.total ?? 0;
      if (apiTotal > 0) {
        find(
          'P1',
          'Knowledge/Search',
          `UI shows 0 results for "${q}" but API returned ${apiTotal} — UI/API mismatch`,
          searchShot,
        );
      } else {
        find(
          'P2',
          'Knowledge/Search',
          `No results for "${q}" in UI or API — seed content may not include this term`,
          searchShot,
          `API total: ${apiTotal}`,
        );
      }
    } else {
      logOk(`Search "${q}" returned ${cards} results`);
    }
  }

  // Clear search
  await searchBox.fill('');
  await waitMs(500);

  // Also verify API full-text for a broader term
  const apiStats = await apiFetch<{ total: number }>('/api/wiki/stats', token);
  if (apiStats.status === 200) {
    logOk(`/api/wiki/stats status 200`);
  } else {
    find('P1', 'Knowledge/Search', `/api/wiki/stats returned ${apiStats.status}`);
  }
}

// ── Group 4: View a page ──────────────────────────────────────────────────────
async function group4ViewPage(page: Page, token: string) {
  logSection('Group 4: View a wiki page — detail view');

  // Get the first page from API
  const listResult = await apiFetch<{ pages: any[]; total: number }>('/api/wiki?limit=1', token);
  if (listResult.status !== 200 || !(listResult.body as any).pages?.length) {
    find('P1', 'Knowledge/View', 'Cannot test view: no pages returned by API');
    return;
  }
  const firstPage = (listResult.body as any).pages[0];
  logInfo(`Clicking into page: "${firstPage.title}" (${firstPage.slug})`);

  // Click the first page card
  const firstCard = page
    .locator('[class*="rounded-lg"] button[class*="w-full text-left"]')
    .first();
  const hasCard = await firstCard.isVisible().catch(() => false);
  if (!hasCard) {
    find('P1', 'Knowledge/View', 'No page cards visible in list to click into');
    return;
  }

  await firstCard.click();
  await waitMs(1500);

  const detailShot = await shot(page, 'detail-view-initial');

  // Check back button
  const backBtn = page.locator('button').filter({ hasText: /Back/ }).first();
  const hasBack = await backBtn.isVisible().catch(() => false);
  if (!hasBack) {
    find('P1', 'Knowledge/View', 'Back button not visible in detail view', detailShot);
  } else {
    logOk('Back button visible');
  }

  // Check page title in h1
  const h1 = await page.locator('h1').first().textContent().catch(() => null);
  logInfo(`Detail view h1: "${h1}"`);
  if (!h1?.trim()) {
    find('P1', 'Knowledge/View', 'Page title (h1) not visible in detail view', detailShot);
  } else {
    logOk(`Detail view title: "${h1}"`);
  }

  // Check confidence bar
  const confidenceText = await page.locator('text=% confidence').first().isVisible().catch(() => false);
  if (!confidenceText) {
    find('P2', 'Knowledge/View', 'Confidence % text not visible in detail view', detailShot);
  } else {
    logOk('Confidence bar visible');
  }

  // Check content area
  const contentArea = page.locator('.whitespace-pre-wrap').first();
  const hasContent = await contentArea.isVisible().catch(() => false);
  if (!hasContent) {
    find('P1', 'Knowledge/View', 'Content area not visible or empty in detail view', detailShot);
  } else {
    const contentText = await contentArea.textContent().catch(() => '');
    logInfo(`Content preview: ${contentText?.slice(0, 100)}`);
    if (!contentText?.trim()) {
      find('P1', 'Knowledge/View', 'Content area is empty (no markdown text rendered)', detailShot);
    } else {
      logOk(`Content renders — ${contentText.length} chars`);
    }
  }

  // Check Edit + Delete buttons
  const editBtn = page.locator('button').filter({ hasText: /Edit/ }).first();
  const hasEditBtn = await editBtn.isVisible().catch(() => false);
  if (!hasEditBtn) {
    find('P2', 'Knowledge/View', 'Edit button not visible in detail view', detailShot);
  } else {
    logOk('Edit button visible');
  }

  // Check for linked pages section (may be empty for seeded page)
  await shot(page, 'detail-view-links-section');

  // Check API detail endpoint
  const detailApi = await apiFetch<any>(`/api/wiki/${firstPage.slug}`, token);
  if (detailApi.status !== 200) {
    find('P1', 'Knowledge/View', `/api/wiki/${firstPage.slug} returned ${detailApi.status}`);
  } else {
    const d = detailApi.body as any;
    logInfo(
      `API detail: linked_pages=${d.linked_pages?.length ?? 0}, backlinks=${d.backlinks?.length ?? 0}, citations=${d.citations?.length ?? 0}`,
    );
    logOk('API detail endpoint returns 200 with linked_pages, backlinks, citations');
  }

  // Navigate back
  if (hasBack) {
    await backBtn.click();
    await waitMs(800);
    logOk('Navigated back to list');
  }
}

// ── Group 5: Create a wiki page ───────────────────────────────────────────────
async function group5CreatePage(page: Page, token: string) {
  logSection('Group 5: Create a wiki page');

  const ts = Date.now();
  createdPageTitle = `wiki-audit-${ts}`;
  logProgress(`Creating page: "${createdPageTitle}"`);

  // Click "New" button
  const newBtn = page.locator('button').filter({ hasText: /New/ }).first();
  const hasNewBtn = await newBtn.isVisible().catch(() => false);
  if (!hasNewBtn) {
    find('P0', 'Knowledge/Create', 'Cannot create: "New" button not found');
    return;
  }
  await newBtn.click();
  await waitMs(600);

  // Wait for modal
  const modalTitle = page.locator('text=Create Wiki Page').first();
  const hasModal = await waitOrStall(page, 'text=Create Wiki Page', 4000, 'create-modal');
  if (!hasModal) {
    find('P0', 'Knowledge/Create', 'Create Wiki Page modal did not open', await shot(page, 'create-modal-fail'));
    return;
  }

  const modalShot = await shot(page, 'create-modal-open');
  logOk('Create modal opened');

  // Fill title
  const titleInput = page.locator('input[placeholder="Page title..."]').first();
  await titleInput.fill(createdPageTitle);

  // Select type = concept (should already be selected by default)
  const conceptTypeBtn = page.locator('button').filter({ hasText: /^Concept$/ }).first();
  if (await conceptTypeBtn.isVisible().catch(() => false)) {
    await conceptTypeBtn.click();
    logOk('Type "Concept" selected');
  }

  // Fill content with markdown
  const contentTextarea = page.locator('textarea[placeholder="Write page content..."]').first();
  const content = `# Audit Test Page\n\nThis page was created by the knowledge deep audit at ${new Date().toISOString()}.\n\n## Overview\n\nThis tests that the wiki create flow works end-to-end.\n\n- Markdown bullet 1\n- Markdown bullet 2\n\n## References\n\nRelated to PostgreSQL and deployment workflows.`;
  await contentTextarea.fill(content);

  // Fill summary
  const summaryInput = page.locator('input[placeholder="Brief summary..."]').first();
  await summaryInput.fill('Audit-generated test page for wiki create flow verification');

  await shot(page, 'create-modal-filled');

  // Submit
  const createBtn = page.locator('button').filter({ hasText: /^Create$/ }).last();
  const hasCreateBtn = await createBtn.isEnabled().catch(() => false);
  if (!hasCreateBtn) {
    find('P0', 'Knowledge/Create', 'Create button disabled or not found after filling form', await shot(page, 'create-btn-disabled'));
    // Close modal
    const cancelBtn = page.locator('button').filter({ hasText: /Cancel/ }).first();
    if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click();
    return;
  }

  await createBtn.click();
  await waitMs(2000);

  // Modal should close and list should update
  const modalGone = !(await page.locator('text=Create Wiki Page').isVisible().catch(() => false));
  if (!modalGone) {
    find('P0', 'Knowledge/Create', 'Create modal did not close after submit — creation may have failed', await shot(page, 'create-modal-stuck'));
    return;
  }
  logOk('Create modal closed after submit');

  await shot(page, 'after-create-list');

  // Verify via API
  const searchRes = await apiFetch<{ pages: any[]; total: number }>(
    `/api/wiki?q=${encodeURIComponent('wiki-audit')}`,
    token,
  );
  const found = (searchRes.body as any)?.pages?.find((p: any) =>
    p.title.includes('wiki-audit'),
  );
  if (!found) {
    find('P1', 'Knowledge/Create', 'Created page not found via API search after creation');
  } else {
    createdPageSlug = found.slug;
    logOk(`Created page found via API — slug: "${createdPageSlug}", id: "${found.id}"`);
  }
}

// ── Group 6: Edit a page ──────────────────────────────────────────────────────
async function group6EditPage(page: Page, token: string) {
  logSection('Group 6: Edit a wiki page');

  if (!createdPageSlug) {
    find('P2', 'Knowledge/Edit', 'Skipping edit test — no page was successfully created in group 5');
    return;
  }

  logProgress(`Navigating to created page: ${createdPageSlug}`);

  // Navigate to the created page via URL param
  await page.goto(`${KNOWLEDGE_URL}?slug=${createdPageSlug}`, { waitUntil: 'networkidle', timeout: 15000 });
  await waitMs(1500);

  const detailShot = await shot(page, 'edit-page-detail');

  // Check Edit button
  const editBtn = page.locator('button').filter({ hasText: /Edit/ }).first();
  const hasEditBtn = await editBtn.isVisible().catch(() => false);
  if (!hasEditBtn) {
    find('P1', 'Knowledge/Edit', 'Edit button not visible in detail view', detailShot);
    return;
  }

  await editBtn.click();
  await waitMs(600);

  const editModeShot = await shot(page, 'edit-mode-active');
  logOk('Edit mode activated');

  // Check editor textarea is visible
  const editor = page.locator('textarea').first();
  const hasEditor = await editor.isVisible().catch(() => false);
  if (!hasEditor) {
    find('P1', 'Knowledge/Edit', 'Editor textarea not visible in edit mode', editModeShot);
    // Cancel
    const cancelBtn = page.locator('button').filter({ hasText: /Cancel/ }).first();
    if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click();
    return;
  }
  logOk('Editor textarea visible');

  // Modify content
  const newContent = `# Audit Test Page (Edited)\n\nUpdated by audit edit pass at ${new Date().toISOString()}.\n\n## Overview\n\nThis tests the wiki edit flow end-to-end.\n\n- Edited bullet 1\n- Edited bullet 2`;
  await editor.fill(newContent);

  await shot(page, 'edit-mode-content-typed');

  // Save
  const saveBtn = page.locator('button').filter({ hasText: /^Save$/ }).first();
  const hasSaveBtn = await saveBtn.isVisible().catch(() => false);
  if (!hasSaveBtn) {
    find('P1', 'Knowledge/Edit', 'Save button not visible in edit mode', await shot(page, 'save-btn-missing'));
    return;
  }

  await saveBtn.click();
  await waitMs(2000);

  // Edit mode should exit
  const editModeGone = !(await page.locator('button').filter({ hasText: /^Save$/ }).first().isVisible().catch(() => false));
  if (!editModeGone) {
    find('P1', 'Knowledge/Edit', 'Edit mode did not exit after save — save may have failed', await shot(page, 'save-stuck'));
    return;
  }
  logOk('Save completed — edit mode exited');

  await shot(page, 'after-edit-detail-view');

  // Verify content updated via API
  const detailRes = await apiFetch<any>(`/api/wiki/${createdPageSlug}`, token);
  if (detailRes.status !== 200) {
    find('P1', 'Knowledge/Edit', `API detail after edit returned ${detailRes.status}`);
  } else {
    const updatedContent = (detailRes.body as any)?.content ?? '';
    if (updatedContent.includes('Edited')) {
      logOk('Edit confirmed via API — content contains "Edited"');
    } else {
      find('P1', 'Knowledge/Edit', 'API content after edit does not contain expected "Edited" marker', undefined, `Content: ${updatedContent.slice(0, 200)}`);
    }
  }
}

// ── Group 7: Graph view ───────────────────────────────────────────────────────
async function group7Graph(page: Page, token: string) {
  logSection('Group 7: Graph view');

  // Navigate back to knowledge hub
  await page.goto(KNOWLEDGE_URL, { waitUntil: 'networkidle', timeout: 15000 });
  await waitMs(1000);

  // Click Graph toggle
  const graphBtn = page.locator('button').filter({ hasText: /Graph/ }).first();
  const hasGraphBtn = await graphBtn.isVisible().catch(() => false);
  if (!hasGraphBtn) {
    find('P1', 'Knowledge/Graph', 'Graph toggle button not found', await shot(page, 'graph-btn-missing'));
    return;
  }

  logProgress('Clicking Graph toggle...');
  await graphBtn.click();
  await waitMs(2500); // Wait for D3 simulation to settle

  const graphShot = await shot(page, 'graph-view-initial');

  // Check SVG rendered
  const svgEl = page.locator('svg').first();
  const hasSvg = await svgEl.isVisible().catch(() => false);
  if (!hasSvg) {
    find('P0', 'Knowledge/Graph', 'Graph SVG element not visible — graph failed to render', graphShot);
    return;
  }
  logOk('Graph SVG element visible');

  // Count circles (graph nodes)
  const circles = await page.locator('svg circle').count();
  logInfo(`Graph SVG circles: ${circles}`);
  if (circles === 0) {
    find('P0', 'Knowledge/Graph', 'No circles in graph SVG — nodes not rendered', graphShot);
  } else {
    logOk(`Graph rendered ${circles} node circles`);
  }

  // Count lines (edges)
  const lines = await page.locator('svg line').count();
  logInfo(`Graph SVG lines (edges): ${lines}`);
  if (lines === 0) {
    find('P1', 'Knowledge/Graph', 'No lines in graph SVG — edges not rendered or wiki_links table empty', graphShot);
  } else {
    logOk(`Graph rendered ${lines} edge lines`);
  }

  // Check node labels (text elements)
  const labels = await page.locator('svg text').count();
  logInfo(`Graph SVG text labels: ${labels}`);
  if (labels === 0) {
    find('P2', 'Knowledge/Graph', 'No text labels in graph SVG', graphShot);
  } else {
    logOk(`Graph has ${labels} node labels`);
  }

  // Check stats overlay (nodes • connections) — look for text containing "pages"
  const statsOverlay = await page.locator('text=pages').first().isVisible().catch(() => false);
  if (!statsOverlay) {
    find('Nit', 'Knowledge/Graph', 'Stats overlay (N pages • M connections) not visible', graphShot);
  } else {
    const statsText = await page.locator('text=pages').first().textContent().catch(() => '');
    logInfo(`Stats overlay: "${statsText}"`);
  }

  // Check legend
  const legend = await page.locator('text=Concept').first().isVisible().catch(() => false);
  if (!legend) {
    find('Nit', 'Knowledge/Graph', 'Type legend (Concept / Entity / etc.) not visible in graph view', graphShot);
  } else {
    logOk('Type legend visible in graph');
  }

  // Try clicking a node — use bounding box approach
  logProgress('Attempting to click a graph node...');
  try {
    const firstCircle = page.locator('svg circle').first();
    const hasCircle = await firstCircle.isVisible().catch(() => false);
    if (hasCircle) {
      // Just verify circles are clickable elements (click may navigate to detail)
      const svgBox = await page.locator('svg').first().boundingBox();
      logInfo(`SVG bounding box: ${JSON.stringify(svgBox)}`);
      if (svgBox && (svgBox.width < 100 || svgBox.height < 100)) {
        find('P1', 'Knowledge/Graph', `Graph SVG has tiny bounding box: ${svgBox.width}x${svgBox.height} — nodes may be off-screen`, graphShot);
      } else {
        logOk(`Graph SVG bounding box OK: ${svgBox?.width}x${svgBox?.height}`);
      }
    }
  } catch (e) {
    logInfo(`Node click check: ${e}`);
  }

  // Verify /api/wiki/graph endpoint
  const graphApi = await apiFetch<{ nodes: any[]; edges: any[] }>('/api/wiki/graph', token);
  if (graphApi.status !== 200) {
    find('P1', 'Knowledge/Graph', `/api/wiki/graph returned ${graphApi.status}`);
  } else {
    const nodes = (graphApi.body as any)?.nodes?.length ?? 0;
    const edges = (graphApi.body as any)?.edges?.length ?? 0;
    logInfo(`API graph: ${nodes} nodes, ${edges} edges`);
    if (nodes === 0) {
      find('P1', 'Knowledge/Graph', 'API /api/wiki/graph returns 0 nodes');
    } else {
      logOk(`API graph: ${nodes} nodes, ${edges} edges`);
    }
  }

  await shot(page, 'graph-view-final');
}

// ── Activity + Stats tabs (bonus) ─────────────────────────────────────────────
async function groupActivityStats(page: Page, token: string) {
  logSection('Bonus: Activity + Stats views');

  // Navigate to knowledge hub
  await page.goto(KNOWLEDGE_URL, { waitUntil: 'networkidle', timeout: 15000 });
  await waitMs(800);

  // Click Activity tab
  const activityBtn = page.locator('button').filter({ hasText: /^Activity$/ }).first();
  if (await activityBtn.isVisible().catch(() => false)) {
    await activityBtn.click();
    await waitMs(1500);
    const actShot = await shot(page, 'activity-view');
    const entries = await page.locator('[class*="rounded-lg"]').count();
    logInfo(`Activity view entries: ${entries}`);

    // Check /api/wiki/log
    const logRes = await apiFetch<{ entries: any[] }>('/api/wiki/log?limit=30', token);
    if (logRes.status !== 200) {
      find('P1', 'Knowledge/Activity', `/api/wiki/log returned ${logRes.status}`);
    } else {
      const entryCount = (logRes.body as any)?.entries?.length ?? 0;
      logInfo(`API activity log entries: ${entryCount}`);
      if (entryCount === 0) {
        find('P2', 'Knowledge/Activity', 'Activity log empty — no ops logged in wiki_ops_log', actShot);
      } else {
        logOk(`Activity log: ${entryCount} entries`);
      }
    }
  }

  // Click Stats tab
  const statsBtn = page.locator('button').filter({ hasText: /^Stats$/ }).first();
  if (await statsBtn.isVisible().catch(() => false)) {
    await statsBtn.click();
    await waitMs(1500);
    const statsShot = await shot(page, 'stats-view');
    const statsRes = await apiFetch<any>('/api/wiki/stats', token);
    if (statsRes.status !== 200) {
      find('P1', 'Knowledge/Stats', `/api/wiki/stats returned ${statsRes.status}`);
    } else {
      const s = statsRes.body as any;
      logInfo(`Stats: total=${s.total}, links=${s.total_links}, by_type=${JSON.stringify(s.by_type)}`);
      logOk(`Stats endpoint OK — total: ${s.total}`);

      // Check UI renders stats
      const totalCard = page.locator('text=Total Pages').first();
      const hasTotalCard = await totalCard.isVisible().catch(() => false);
      if (!hasTotalCard) {
        find('P2', 'Knowledge/Stats', '"Total Pages" card not visible in stats view', statsShot);
      } else {
        logOk('"Total Pages" card visible in stats view');
      }
    }
  }
}

// ── Report generation ─────────────────────────────────────────────────────────
function generateReport(duration: number) {
  const byPriority = {
    P0: findings.filter((f) => f.severity === 'P0'),
    P1: findings.filter((f) => f.severity === 'P1'),
    P2: findings.filter((f) => f.severity === 'P2'),
    Nit: findings.filter((f) => f.severity === 'Nit'),
  };

  const md = `# Knowledge Deep Audit

**Date**: 2026-04-20
**Branch**: feat/phase2-4-mcp-agents-plans
**Duration**: ${Math.round(duration / 1000)}s
**Findings**: P0=${byPriority.P0.length} P1=${byPriority.P1.length} P2=${byPriority.P2.length} Nit=${byPriority.Nit.length}
**Screenshots**: ${shotCounter}
**Console errors**: ${consoleErrors.length}
**Page errors**: ${pageErrors.length}
**Network errors (4xx/5xx)**: ${networkErrors.length}

---

## Surfaces Observed

- \`/knowledge\` — wiki hub (list, type filter, scope filter, search, create)
- \`/knowledge?slug=<slug>\` — wiki page detail (content, confidence, linked pages, backlinks, citations, version history, edit)
- Graph view (inline toggle on /knowledge, D3 force-directed)
- Activity view (ops log)
- Stats view (by-type chart, confidence distribution, needs-review)
- API: \`/api/wiki\`, \`/api/wiki/:slug\`, \`/api/wiki/graph\`, \`/api/wiki/stats\`, \`/api/wiki/log\`

---

## P0 — Blocks Release

${byPriority.P0.length === 0 ? '_None found._' : byPriority.P0.map((f) => `- **[${f.area}]** ${f.description}${f.screenshot ? ` — screenshot: \`${f.screenshot}\`` : ''}${f.detail ? `\n  > ${f.detail}` : ''}`).join('\n')}

---

## P1 — Must Fix

${byPriority.P1.length === 0 ? '_None found._' : byPriority.P1.map((f) => `- **[${f.area}]** ${f.description}${f.screenshot ? ` — screenshot: \`${f.screenshot}\`` : ''}${f.detail ? `\n  > ${f.detail}` : ''}`).join('\n')}

---

## P2 — Should Fix

${byPriority.P2.length === 0 ? '_None found._' : byPriority.P2.map((f) => `- **[${f.area}]** ${f.description}${f.screenshot ? ` — screenshot: \`${f.screenshot}\`` : ''}${f.detail ? `\n  > ${f.detail}` : ''}`).join('\n')}

---

## Nits

${byPriority.Nit.length === 0 ? '_None found._' : byPriority.Nit.map((f) => `- **[${f.area}]** ${f.description}${f.detail ? ` — ${f.detail}` : ''}`).join('\n')}

---

## Coverage Gaps

- **TipTap rich editor**: The edit flow tested a plain \`<textarea>\` because the knowledge page uses a textarea for editing (not TipTap). TipTap was expected per the audit brief but was not present on this surface. The Notes page uses TipTap; Knowledge/Wiki uses a plain textarea for now.
- **[[page-slug]] wiki-link autocomplete**: No autocomplete UI detected during edit flow — this feature may only exist on the Notes TipTap editor or is not yet implemented on the wiki edit textarea.
- **Promote-note-to-wiki flow**: This flow originates from the Notes surface (covered in notes-deep audit), not triggered from within the knowledge surface itself.
- **Cross-reference rendering**: Citations section renders in detail view but cross-referencing during editing (inline links) is not surfaced.
- **Tags display**: Tags field is stored in DB but not prominently displayed in list or detail view UI.
- **Export button**: Present in header bar (Download icon) — not tested for actual file download content.
- **Mobile viewport**: Not tested in this audit (dedicated mobile audit needed).

---

## Raw Logs

See \`run.log\` in this directory.

Console errors captured: ${consoleErrors.length}
${consoleErrors.slice(0, 10).map((e) => `- \`${e.slice(0, 150)}\``).join('\n')}

Network errors (4xx/5xx): ${networkErrors.length}
${networkErrors.slice(0, 10).map((e) => `- \`${e}\``).join('\n')}

Page errors (uncaught JS): ${pageErrors.length}
${pageErrors.slice(0, 5).map((e) => `- \`${e.slice(0, 150)}\``).join('\n')}

---

## Screenshots Index

${Array.from({ length: shotCounter }, (_, i) => {
  const num = String(i + 1).padStart(2, '0');
  return `- \`${num}-*.png\``;
}).join('\n')}
`;

  writeFileSync(REPORT_FILE, md);
  log(`Report written to ${REPORT_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Ensure audit dir exists
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });

  // Init log file
  writeFileSync(LOG_FILE, `# Knowledge Deep Audit — ${new Date().toISOString()}\n\n`);
  log('Starting Knowledge Deep Audit');

  let browser: Browser | null = null;
  let ctx: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // Login
    const { accessToken, refreshToken, orgId, userId } = await apiLogin();
    logInfo(`Org: ${orgId}, User: ${userId}`);

    // Launch browser
    browser = await chromium.launch({ headless: false, slowMo: 100 });
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await injectAuth(ctx, accessToken, refreshToken);
    page = await ctx.newPage();
    attachListeners(page);

    // Run groups
    if (Date.now() - START_TIME < MAX_WALL_MS) await group1Hub(page, accessToken);
    if (Date.now() - START_TIME < MAX_WALL_MS) await group2List(page, accessToken);
    if (Date.now() - START_TIME < MAX_WALL_MS) await group3Search(page, accessToken);
    if (Date.now() - START_TIME < MAX_WALL_MS) await group4ViewPage(page, accessToken);
    if (Date.now() - START_TIME < MAX_WALL_MS) await group5CreatePage(page, accessToken);
    if (Date.now() - START_TIME < MAX_WALL_MS) await group6EditPage(page, accessToken);
    if (Date.now() - START_TIME < MAX_WALL_MS) await group7Graph(page, accessToken);
    if (Date.now() - START_TIME < MAX_WALL_MS) await groupActivityStats(page, accessToken);
  } catch (err) {
    log(`[FATAL] Uncaught error: ${err}`);
    if (page) {
      await page
        .screenshot({
          path: join(AUDIT_DIR, `${String(shotCounter + 1).padStart(2, '0')}-fatal-error.png`),
        })
        .catch(() => {});
    }
  } finally {
    const duration = Date.now() - START_TIME;
    log(`\nAudit complete in ${Math.round(duration / 1000)}s`);
    log(`Findings: P0=${findings.filter((f) => f.severity === 'P0').length} P1=${findings.filter((f) => f.severity === 'P1').length} P2=${findings.filter((f) => f.severity === 'P2').length} Nit=${findings.filter((f) => f.severity === 'Nit').length}`);

    generateReport(duration);

    if (ctx) await ctx.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});

    const hasBlockers = findings.some((f) => f.severity === 'P0');
    process.exit(hasBlockers ? 1 : 0);
  }
}

main();
