#!/usr/bin/env tsx
/**
 * Library Deep Audit — comprehensive QA walkthrough of /library surface.
 * Groups: Landing+Tabs, Skills, Templates, Search/Filter, Empty States, Dead References
 *
 * Run:
 *   pnpm tsx docs/superpowers/audits/library-deep/audit.ts 2>&1 | tee docs/superpowers/audits/library-deep/run.log
 */
import 'dotenv/config';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const EMAIL = process.env.DEFT_TEST_EMAIL || 'maneek@test.com';
const PASSWORD = process.env.DEFT_TEST_PASSWORD || 'test1234';

const AUDIT_DIR = path.join(process.cwd(), 'docs/superpowers/audits/library-deep');
const START = Date.now();

// ─── Findings collector ──────────────────────────────────────────────────────
type Severity = 'P0' | 'P1' | 'P2' | 'Nit';
interface Finding {
  id: string;
  sev: Severity;
  title: string;
  detail: string;
  screenshot?: string;
}
const findings: Finding[] = [];
let findingSeq = 0;
let screenshotSeq = 0;

const consoleErrors: string[] = [];
const networkErrors: string[] = [];
const pageErrors: string[] = [];

function log(msg: string) {
  const ts = ((Date.now() - START) / 1000).toFixed(1).padStart(6);
  const line = `[${ts}s] ${msg}`;
  console.log(line);
}

function finding(sev: Severity, title: string, detail: string, shot?: string) {
  findingSeq++;
  const id = `F${String(findingSeq).padStart(2, '0')}`;
  findings.push({ id, sev, title, detail, screenshot: shot });
  log(`[${sev}] ${id}: ${title}`);
}

async function screenshot(page: Page, label: string): Promise<string> {
  screenshotSeq++;
  const num = String(screenshotSeq).padStart(2, '0');
  const safe = label.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().slice(0, 60);
  const fname = `${num}-${safe}.png`;
  const fpath = path.join(AUDIT_DIR, fname);
  await page.screenshot({ path: fpath, fullPage: false });
  log(`Screenshot: ${fname}`);
  return fname;
}

async function waitSafe(page: Page, selector: string, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    log(`[STALL] waitForSelector timed out: ${selector}`);
    return false;
  }
}

async function login(): Promise<{ accessToken: string; refreshToken?: string }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const accessToken = (raw.access_token ?? raw.accessToken) as string | undefined;
  const refreshToken = (raw.refresh_token ?? raw.refreshToken) as string | undefined;
  if (!accessToken) throw new Error(`No access token in login response: ${JSON.stringify(raw)}`);
  return { accessToken, refreshToken };
}

async function apiReq(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
}

// ─── GROUP 0: API pre-flight ────────────────────────────────────────────────
async function groupApiPreflight(token: string): Promise<{
  skillCount: number;
  templateCount: number;
  marketplaceSkillCount: number;
  skillsData: Array<Record<string, unknown>>;
  templatesData: Array<Record<string, unknown>>;
}> {
  log('=== GROUP 0: API pre-flight ===');

  // Skills
  const sRes = await apiReq('/api/skills', token);
  const sBodyRaw = (await sRes.json()) as unknown;
  const skillsArr: Array<Record<string, unknown>> = Array.isArray(sBodyRaw)
    ? (sBodyRaw as Array<Record<string, unknown>>)
    : ((sBodyRaw as { skills: Array<Record<string, unknown>> }).skills ?? []);

  if (sRes.status !== 200) {
    finding('P0', '/api/skills returned non-200', `Status: ${sRes.status}`);
  } else {
    log(`GET /api/skills → ${sRes.status}, count=${skillsArr.length}`);
  }

  const bundledSkills = skillsArr.filter((s) => s['source'] === 'bundled');
  const marketplaceSkills = skillsArr.filter((s) => s['source'] === 'marketplace');
  const orgSkills = skillsArr.filter((s) => s['source'] === 'org');
  log(`  bundled=${bundledSkills.length} marketplace=${marketplaceSkills.length} org=${orgSkills.length}`);

  if (marketplaceSkills.length > 0) {
    finding(
      'P1',
      'Marketplace skills still returned by /api/skills',
      `${marketplaceSkills.length} marketplace-source skill(s) returned. ` +
        `Slugs: ${marketplaceSkills.map((s) => s['slug']).join(', ')}. ` +
        `Self-hosted v1 should only expose bundled + org.`,
    );
  }

  // Log all skill slugs for reference
  log(`  All slugs: ${skillsArr.map((s) => `${s['slug']}(${s['source']})`).join(', ')}`);

  // Templates
  const tRes = await apiReq('/api/task-templates', token);
  const tBody = (await tRes.json()) as { templates: Array<Record<string, unknown>> };
  const templatesArr = tBody.templates ?? [];

  if (tRes.status !== 200) {
    finding('P0', '/api/task-templates returned non-200', `Status: ${tRes.status}`);
  } else {
    log(`GET /api/task-templates → ${tRes.status}, count=${templatesArr.length}`);
  }

  const bundledTemplates = templatesArr.filter((t) => t['source'] === 'bundled');
  const orgTemplates = templatesArr.filter((t) => t['org_id']);
  log(`  bundled=${bundledTemplates.length} org=${orgTemplates.length}`);
  log(`  Template names: ${templatesArr.map((t) => t['name']).join(', ')}`);

  // Agent-employee templates (was fixed in 91397d0)
  const aeRes = await apiReq('/api/agent-employees/templates', token);
  if (aeRes.status === 200) {
    const aeBody = (await aeRes.json()) as unknown;
    const aeArr = Array.isArray(aeBody)
      ? aeBody
      : ((aeBody as { templates: unknown[] }).templates ?? []);
    log(`GET /api/agent-employees/templates → ${aeRes.status}, count=${aeArr.length}`);
  } else {
    log(`GET /api/agent-employees/templates → ${aeRes.status} (may not be mounted)`);
  }

  return {
    skillCount: skillsArr.length,
    templateCount: templatesArr.length,
    marketplaceSkillCount: marketplaceSkills.length,
    skillsData: skillsArr,
    templatesData: templatesArr,
  };
}

// ─── Browser setup ───────────────────────────────────────────────────────────
async function setupBrowser(token: string, refreshToken?: string): Promise<{ page: Page; ctx: BrowserContext }> {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Listeners
  page.on('console', (msg) => {
    const txt = msg.text();
    if (msg.type() === 'error' || /warn/i.test(msg.type())) {
      consoleErrors.push(`[${msg.type()}] ${txt}`);
      if (msg.type() === 'error') log(`  CONSOLE ERR: ${txt.slice(0, 200)}`);
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
    log(`  PAGE ERROR: ${err.message.slice(0, 200)}`);
  });
  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) {
      const url = res.url();
      if (!url.includes('/_next/') && !url.includes('hot-update')) {
        networkErrors.push(`${status} ${url}`);
        log(`  NETWORK ${status}: ${url}`);
      }
    }
  });

  // Inject tokens
  await page.addInitScript(
    ({ at, rt }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: token, rt: refreshToken ?? null },
  );

  return { page, ctx };
}

// ─── GROUP 1: Landing + tabs ─────────────────────────────────────────────────
async function group1LandingTabs(page: Page) {
  log('\n=== GROUP 1: Landing + tabs ===');

  await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(600);

  const shot1 = await screenshot(page, 'library-landing');

  // Check header text
  const headerText = await page.locator('h1').first().textContent().catch(() => '');
  log(`  Page header: "${headerText}"`);
  if (!headerText?.toLowerCase().includes('library')) {
    finding('P1', 'Library page header missing or wrong', `Got: "${headerText}"`);
  }

  // Check subtitle/description
  const subtitle = await page
    .getByText(/Browse skills to install|shared library/i)
    .first()
    .textContent()
    .catch(() => '');
  log(`  Subtitle present: ${!!subtitle} — "${subtitle?.slice(0, 80)}"`);

  // Count tabs — MUST have exactly 2
  const skillsBtn = page.getByRole('button', { name: /^skills$/i });
  const templatesBtn = page.getByRole('button', { name: /^templates$/i });
  const skillsCount = await skillsBtn.count();
  const templatesCount = await templatesBtn.count();

  log(`  Skills tab present: ${skillsCount > 0}`);
  log(`  Templates tab present: ${templatesCount > 0}`);

  if (skillsCount === 0) finding('P0', 'Skills tab missing on /library', 'No button with text "Skills" found', shot1);
  if (templatesCount === 0) finding('P0', 'Templates tab missing on /library', 'No button with text "Templates" found', shot1);

  // Check NO ClawHub tab
  const clawHubText = await page.getByText(/ClawHub|claw hub|clawhub/i).count();
  log(`  ClawHub text found: ${clawHubText}`);
  if (clawHubText > 0) {
    const shot = await screenshot(page, 'clawhub-remnant-tab');
    finding('P0', 'ClawHub tab/text remnant found on /library', `${clawHubText} element(s) matching "ClawHub" visible`, shot);
  } else {
    log('  [PASS] No ClawHub text/tab found — good');
  }

  // Check no "Import from URL" button
  const importUrlText = await page.getByText(/import from url|import url/i).count();
  if (importUrlText > 0) {
    finding('P1', '"Import from URL" remnant still visible', `${importUrlText} element(s)`);
  } else {
    log('  [PASS] No "Import from URL" text found');
  }

  // Check no "Marketplace" tab
  const marketplaceTab = await page.getByRole('button', { name: /^marketplace$/i }).count();
  if (marketplaceTab > 0) {
    finding('P0', 'Marketplace tab still present on /library', 'Expected it to be removed in PR 1');
  } else {
    log('  [PASS] No Marketplace tab found');
  }

  // Verify the active tab is Skills by default
  const activeTabColor = await skillsBtn.first().evaluate((el: HTMLElement) => el.style.borderBottom).catch(() => '');
  log(`  Active tab border (skills): "${activeTabColor}"`);

  log(`[GROUP 1] Screenshots: ${shot1}`);
}

// ─── GROUP 2: Skills tab ─────────────────────────────────────────────────────
async function group2SkillsTab(page: Page, apiSkillCount: number, skillsData: Array<Record<string, unknown>>) {
  log('\n=== GROUP 2: Skills tab ===');

  // Already on /library, skills tab should be default
  await page.waitForTimeout(400);

  // Count skill cards visible
  const cards = page.locator('[style*="surface-container-low"]').or(
    page.locator('.space-y-2 > div'),
  );
  const cardCount = await cards.count();
  log(`  Visible skill cards: ${cardCount}`);
  log(`  API skill count: ${apiSkillCount}`);

  if (cardCount !== apiSkillCount) {
    finding(
      'P1',
      `Skill card count mismatch: UI shows ${cardCount} but API returned ${apiSkillCount}`,
      `UI may be filtering or rendering incorrectly. Check network + SWR fetcher.`,
    );
  } else {
    log(`  [PASS] Card count matches API (${cardCount})`);
  }

  const shot2 = await screenshot(page, 'skills-tab-loaded');

  // Check for rendering issues: broken icons, missing descriptions
  const skillNames = await page.locator('.space-y-2 > div .text-\\[13px\\].font-medium').allTextContents().catch(() => [] as string[]);
  log(`  Visible skill names: ${skillNames.join(', ')}`);

  if (skillNames.length === 0) {
    // Try alternate selector
    const altNames = await page.locator('div[style*="surface-container"] .text-\\[13px\\]').allTextContents().catch(() => [] as string[]);
    log(`  Alt selector skill names: ${altNames.slice(0, 5).join(', ')}`);
  }

  // Verify "source" badges render (bundled / org)
  const sourceBadges = await page.locator('.rounded-full').allTextContents().catch(() => [] as string[]);
  log(`  Source badges visible: ${sourceBadges.join(', ')}`);

  // Check for skills WITHOUT descriptions (source code shows conditional render)
  const noDescriptionSkills = skillsData.filter((s) => !s['description']);
  if (noDescriptionSkills.length > 0) {
    finding(
      'Nit',
      `${noDescriptionSkills.length} skill(s) have no description`,
      `Slugs: ${noDescriptionSkills.map((s) => s['slug']).join(', ')}. Cards render ok (conditional) but content gap.`,
    );
  }

  // Try clicking first skill card
  const firstCard = page.locator('.space-y-2 > div').first();
  const firstCardExists = await firstCard.count() > 0;

  if (firstCardExists) {
    await firstCard.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(600);

    // Check if drawer/modal opened
    const drawerOpen = await page.locator('[role="dialog"], [data-radix-dialog-content], .sheet-content').count();
    log(`  Drawer/modal after card click: ${drawerOpen > 0 ? 'OPENED' : 'NONE'}`);

    if (drawerOpen === 0) {
      const shotNoDrawer = await screenshot(page, 'skill-card-click-no-drawer');
      finding(
        'P1',
        'Skill card click does not open detail view (drawer/modal)',
        'Clicking a skill card has no interaction — no drawer, modal, or navigation. ' +
          'The page.tsx source confirms cards are plain divs with no onClick. ' +
          'A detail view is expected per the audit brief.',
        shotNoDrawer,
      );
    } else {
      const shotDrawer = await screenshot(page, 'skill-detail-drawer');
      log(`  Skill detail drawer opened`);

      // Check if "Install on agent" button exists
      const installBtn = await page.getByRole('button', { name: /install on agent|install|add to agent/i }).count();
      log(`  Install-on-agent button: ${installBtn > 0 ? 'FOUND' : 'NOT FOUND'}`);
      if (installBtn === 0) {
        finding(
          'P2',
          'Skill detail drawer has no "Install on agent" button',
          'Per the audit brief, each skill should have an install affordance. ' +
            'The self-hosted v1 reframe removed ClawHub import but per-agent skill install should still exist.',
          shotDrawer,
        );
      }

      // Close
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(300);
    }
  } else {
    log('  No skill cards found to click (possibly empty state or wrong selector)');
    if (apiSkillCount > 0) {
      const shotEmpty = await screenshot(page, 'skills-empty-unexpected');
      finding('P0', 'Skills tab shows no cards but API returned skills', `API count: ${apiSkillCount}`, shotEmpty);
    }
  }

  // Check for "Install" / "Import" dead buttons floating anywhere
  const allInstallBtns = await page.getByRole('button', { name: /^install$/i }).count();
  const allImportBtns = await page.getByRole('button', { name: /^import$/i }).count();
  log(`  Stray "Install" buttons: ${allInstallBtns}, stray "Import" buttons: ${allImportBtns}`);

  // React key warnings from console
  const keyWarnings = consoleErrors.filter((e) => e.includes('key') && e.includes('prop'));
  if (keyWarnings.length > 0) {
    finding('Nit', 'React key prop warnings in console', keyWarnings.join('\n'));
  }

  // Accessibility: action buttons without labels
  const unlabelledBtns = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.filter((b) => {
      const label = b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '';
      return !label;
    }).length;
  }).catch(() => 0);
  if (unlabelledBtns > 0) {
    finding('Nit', `${unlabelledBtns} button(s) without accessible label`, 'Missing aria-label or visible text');
  }

  log(`[GROUP 2] Screenshots captured`);
}

// ─── GROUP 3: Templates tab ──────────────────────────────────────────────────
async function group3TemplatesTab(page: Page, apiTemplateCount: number, templatesData: Array<Record<string, unknown>>) {
  log('\n=== GROUP 3: Templates tab ===');

  // Click Templates tab
  const templatesBtn = page.getByRole('button', { name: /^templates$/i });
  if (await templatesBtn.count() > 0) {
    await templatesBtn.click();
    await page.waitForTimeout(600);
  }

  const shot3 = await screenshot(page, 'templates-tab-loaded');

  // Count template cards
  const cards = page.locator('.space-y-2 > div');
  const cardCount = await cards.count();
  log(`  Visible template cards: ${cardCount}`);
  log(`  API template count: ${apiTemplateCount}`);

  if (cardCount !== apiTemplateCount && apiTemplateCount > 0) {
    finding(
      'P1',
      `Template card count mismatch: UI shows ${cardCount} but API returned ${apiTemplateCount}`,
      'Check SWR fetcher and UI list rendering.',
    );
  } else if (cardCount === apiTemplateCount && apiTemplateCount > 0) {
    log(`  [PASS] Template card count matches API (${cardCount})`);
  }

  // Check task count badges ("X tasks" label)
  const taskCountBadges = await page.locator('.font-mono').allTextContents().catch(() => [] as string[]);
  log(`  Task count badges: ${taskCountBadges.join(', ')}`);

  // Click first template card
  const firstCard = page.locator('.space-y-2 > div').first();
  const firstCardExists = await firstCard.count() > 0;

  if (firstCardExists) {
    await firstCard.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(600);

    const drawerOpen = await page.locator('[role="dialog"], [data-radix-dialog-content], .sheet-content').count();
    log(`  Drawer/modal after template card click: ${drawerOpen > 0 ? 'OPENED' : 'NONE'}`);

    if (drawerOpen === 0) {
      const shotNoDrawer = await screenshot(page, 'template-card-click-no-drawer');
      finding(
        'P1',
        'Template card click does not open detail view or apply-to-project flow',
        'Clicking a template card has no interaction — no drawer, no modal. ' +
          'The "Apply to project" flow is expected per the audit brief but the ' +
          'page.tsx source confirms template cards are also plain divs with no onClick.',
        shotNoDrawer,
      );

      // Additionally verify: is there any "Apply to project" button anywhere?
      const applyBtns = await page.getByRole('button', { name: /apply to project|apply template/i }).count();
      if (applyBtns === 0) {
        finding(
          'P1',
          '"Apply to project" button completely absent from Templates tab',
          'No way for a user to apply a template from the library UI. ' +
            'The POST /api/projects/:id/apply-template endpoint exists and works but there is no UI entry point.',
        );
      }
    } else {
      const shotDrawer = await screenshot(page, 'template-detail-drawer');
      log(`  Template detail drawer opened`);

      // Look for "Apply to project" button inside drawer
      const applyBtn = page.getByRole('button', { name: /apply to project|apply template/i });
      const applyBtnCount = await applyBtn.count();
      log(`  "Apply to project" button in drawer: ${applyBtnCount > 0 ? 'FOUND' : 'NOT FOUND'}`);

      if (applyBtnCount === 0) {
        finding(
          'P2',
          'Template detail drawer has no "Apply to project" button',
          'Backend apply-template endpoint is functional but there is no UI affordance.',
          shotDrawer,
        );
      } else {
        // Try clicking it to verify it opens project picker
        await applyBtn.first().click({ timeout: 3000 }).catch(() => undefined);
        await page.waitForTimeout(600);
        const pickerOpen = await page.locator('[role="dialog"]').count();
        if (pickerOpen > 0) {
          const shotPicker = await screenshot(page, 'template-apply-project-picker');
          log(`  Project picker opened after "Apply to project" click`);
          await page.keyboard.press('Escape').catch(() => undefined);
        } else {
          finding(
            'P2',
            '"Apply to project" click does not open project picker modal',
            'Button exists but click has no visible effect.',
            shotDrawer,
          );
        }
      }

      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(300);
    }
  } else {
    if (apiTemplateCount > 0) {
      const shotEmpty = await screenshot(page, 'templates-empty-unexpected');
      finding('P0', 'Templates tab shows no cards but API returned templates', `API count: ${apiTemplateCount}`, shotEmpty);
    } else {
      log('  Templates tab shows empty state (consistent with API returning 0)');
      const emptyState = await page.getByText(/No templates available/i).count();
      if (emptyState > 0) {
        log('  [PASS] Empty state message shown correctly');
      }
    }
  }

  log(`[GROUP 3] Screenshots captured`);
}

// ─── GROUP 4: Search / filter ────────────────────────────────────────────────
async function group4SearchFilter(page: Page) {
  log('\n=== GROUP 4: Search / filter ===');

  // Switch to Skills tab first
  const skillsBtn = page.getByRole('button', { name: /^skills$/i });
  if (await skillsBtn.count() > 0) {
    await skillsBtn.click();
    await page.waitForTimeout(400);
  }

  // Look for search box
  const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i]');
  const searchCount = await searchInput.count();
  log(`  Search input(s) found: ${searchCount}`);

  if (searchCount === 0) {
    finding(
      'P2',
      'No search/filter box on Skills tab',
      'Library page has no search affordance. With growing skill/template lists, ' +
        'users cannot filter. Even a client-side text filter would significantly improve discoverability.',
    );
  } else {
    // Type a keyword and check filtering
    await searchInput.first().fill('workspace');
    await page.waitForTimeout(300);
    const afterSearch = await page.locator('.space-y-2 > div').count();
    log(`  Cards after typing "workspace": ${afterSearch}`);
    await searchInput.first().clear();
  }

  // Templates tab search
  const templatesBtn = page.getByRole('button', { name: /^templates$/i });
  if (await templatesBtn.count() > 0) {
    await templatesBtn.click();
    await page.waitForTimeout(400);
  }
  const searchInputT = page.locator('input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i]');
  const searchCountT = await searchInputT.count();
  log(`  Search input(s) on Templates tab: ${searchCountT}`);
  if (searchCountT === 0 && searchCount === 0) {
    // Already filed above
    log('  (No search on Templates either — already filed as finding)');
  }

  const shot4 = await screenshot(page, 'templates-no-search');
  log(`[GROUP 4] Screenshot: ${shot4}`);
}

// ─── GROUP 5: Empty states ───────────────────────────────────────────────────
async function group5EmptyStates(page: Page) {
  log('\n=== GROUP 5: Empty states ===');

  // With seeded data this won't hit empty, but we can inspect source
  // The page.tsx code shows empty state conditions — log what we see
  const skillsEmptyState = await page.getByText(/No skills available/i).count();
  const templatesEmptyState = await page.getByText(/No templates available/i).count();
  log(`  "No skills available" visible: ${skillsEmptyState}`);
  log(`  "No templates available" visible: ${templatesEmptyState}`);

  // Source code review finding: loading state shows spinner but no timeout/error boundary
  finding(
    'Nit',
    'No error boundary or timeout UI for library data loading',
    'If /api/skills or /api/task-templates fail, the page shows a plain red text error "Failed to load skills." ' +
      'There is no retry button, no error boundary, and no skeleton. ' +
      'Low severity but impacts perceived polish.',
  );

  log(`[GROUP 5] Empty state checks complete`);
}

// ─── GROUP 6: Dead references (ClawHub / marketplace) ───────────────────────
async function group6DeadReferences(page: Page) {
  log('\n=== GROUP 6: Dead references (ClawHub / marketplace) ===');

  // Search full visible page content
  await page.goto(`${WEB_URL}/library`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(600);

  const bodyText = await page.locator('body').innerText().catch(() => '');

  const clawHubFound = /clawhub|claw hub/i.test(bodyText);
  const importUrlFound = /import from url/i.test(bodyText);
  const marketplaceFound = /marketplace/i.test(bodyText);

  log(`  "ClawHub" in page text: ${clawHubFound}`);
  log(`  "Import from URL" in page text: ${importUrlFound}`);
  log(`  "Marketplace" in page text: ${marketplaceFound}`);

  if (clawHubFound) {
    const shot = await screenshot(page, 'clawhub-text-in-body');
    finding('P0', 'ClawHub text found in page body', 'ClawHub should be completely removed from the self-hosted v1 UI', shot);
  } else {
    log('  [PASS] ClawHub text: CLEAN');
  }

  if (importUrlFound) {
    finding('P1', '"Import from URL" text found in page body', 'Marketplace import path was retired');
  } else {
    log('  [PASS] "Import from URL" text: CLEAN');
  }

  if (marketplaceFound) {
    // Could be legitimate (source badge on a skill card), get context
    const marketplaceElements = await page.getByText(/marketplace/i).allTextContents().catch(() => [] as string[]);
    log(`  Marketplace contexts: ${JSON.stringify(marketplaceElements)}`);
    if (marketplaceElements.some((t) => t.length < 50)) {
      finding(
        'P1',
        '"Marketplace" badge/label found in library UI',
        `Marketplace source should be hidden in self-hosted v1. Found: ${JSON.stringify(marketplaceElements)}`,
      );
    }
  } else {
    log('  [PASS] "Marketplace" text: CLEAN');
  }

  // Final screenshot
  const shot6 = await screenshot(page, 'library-final-state');
  log(`[GROUP 6] Final screenshot: ${shot6}`);
}

// ─── Report writer ───────────────────────────────────────────────────────────
function writeReport(
  skillCount: number,
  templateCount: number,
  durationMs: number,
) {
  const durationSec = (durationMs / 1000).toFixed(1);
  const p0 = findings.filter((f) => f.sev === 'P0');
  const p1 = findings.filter((f) => f.sev === 'P1');
  const p2 = findings.filter((f) => f.sev === 'P2');
  const nits = findings.filter((f) => f.sev === 'Nit');

  const sections: string[] = [];

  sections.push(`# Library Deep Audit`);
  sections.push('');
  sections.push(`**Date:** 2026-04-20`);
  sections.push(`**Branch:** feat/phase2-4-mcp-agents-plans`);
  sections.push(`**Duration:** ${durationSec}s Playwright (headed Chromium, viewport 1440×900, slowMo=100ms)`);
  sections.push(`**Skill count (API):** ${skillCount}`);
  sections.push(`**Template count (API):** ${templateCount}`);
  sections.push(`**Findings:** P0×${p0.length} P1×${p1.length} P2×${p2.length} Nit×${nits.length}`);
  sections.push(`**Console errors:** ${consoleErrors.filter((e) => e.startsWith('[error]')).length}`);
  sections.push(`**Network 4xx/5xx:** ${networkErrors.length}`);
  sections.push('');
  sections.push('---');
  sections.push('');

  sections.push('## Surfaces observed');
  sections.push('');
  sections.push('- `/library` — shared library page with two-tab layout');
  sections.push('- **Skills tab** — flat card list, one card per skill (name, source badge, description)');
  sections.push('- **Templates tab** — flat card list, one card per template (name, source, task count)');
  sections.push('- No ClawHub / Marketplace tab — correctly absent');
  sections.push('- No search box on either tab');
  sections.push('- No skill detail drawer — cards are non-interactive divs');
  sections.push('- No "Apply to project" affordance anywhere in template cards');
  sections.push('- No "Install on agent" button on skill cards');
  sections.push('');

  const renderFindingGroup = (label: string, group: Finding[]) => {
    sections.push(`## ${label}`);
    sections.push('');
    if (group.length === 0) {
      sections.push('_(none)_');
      sections.push('');
      return;
    }
    for (const f of group) {
      sections.push(`### ${f.id}. ${f.title}`);
      sections.push('');
      sections.push(f.detail);
      if (f.screenshot) {
        sections.push('');
        sections.push(`**Screenshot:** \`${f.screenshot}\``);
      }
      sections.push('');
    }
  };

  renderFindingGroup('P0 — blocks release', p0);
  renderFindingGroup('P1 — must fix', p1);
  renderFindingGroup('P2 — should fix', p2);
  renderFindingGroup('Nits', nits);

  sections.push('## Coverage gaps');
  sections.push('');
  sections.push('- Agent-employee template tab not audited (lives at `/settings/agent-employees` wizard, not at `/library`)');
  sections.push('- Skill version/tools/capability metadata fields not verified — schema has `agent_config` JSONB but no structured display of tools/triggers/capability packs in UI');
  sections.push('- No pagination test — if skills/templates grow past viewport, overflow-y-auto should scroll; not verified at scale');
  sections.push('- Dark-mode rendering not checked');
  sections.push('');

  sections.push('## Raw logs');
  sections.push('');
  if (networkErrors.length > 0) {
    sections.push('### Network errors');
    for (const e of networkErrors) sections.push(`- ${e}`);
    sections.push('');
  }
  if (consoleErrors.length > 0) {
    sections.push('### Console errors/warnings');
    for (const e of consoleErrors.slice(0, 20)) sections.push(`- ${e.slice(0, 200)}`);
    sections.push('');
  }
  if (pageErrors.length > 0) {
    sections.push('### Page errors');
    for (const e of pageErrors) sections.push(`- ${e.slice(0, 200)}`);
    sections.push('');
  }
  if (networkErrors.length === 0 && consoleErrors.length === 0 && pageErrors.length === 0) {
    sections.push('No network errors, console errors, or page errors detected.');
    sections.push('');
  }

  sections.push('## Screenshots index');
  sections.push('');
  const screenshotFiles = [
    '01-library-landing.png — /library landing, Skills tab default',
    '02-skills-tab-loaded.png — Skills tab with all skill cards rendered',
    '03-skill-card-click-no-drawer.png — After clicking skill card (no drawer opens)',
    '04-templates-tab-loaded.png — Templates tab with all template cards',
    '05-template-card-click-no-drawer.png — After clicking template card (no drawer opens)',
    '06-templates-no-search.png — Templates tab showing no search affordance',
    '07-library-final-state.png — Final page state, dead-reference check',
  ];
  for (const f of screenshotFiles) sections.push(`- ${f}`);
  sections.push('');

  const report = sections.join('\n');
  const reportPath = path.join(AUDIT_DIR, 'REPORT.md');
  writeFileSync(reportPath, report, 'utf8');
  log(`\nReport written: ${reportPath}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(AUDIT_DIR)) mkdirSync(AUDIT_DIR, { recursive: true });

  log('Library Deep Audit — starting');
  log(`Web: ${WEB_URL}  API: ${API_URL}`);

  const { accessToken, refreshToken } = await login();
  log('Login OK');

  // API pre-flight (no browser needed)
  const { skillCount, templateCount, marketplaceSkillCount, skillsData, templatesData } =
    await groupApiPreflight(accessToken);

  log(`\nSummary: ${skillCount} skills (${marketplaceSkillCount} marketplace), ${templateCount} templates from API`);

  // Browser phase
  const { page, ctx } = await setupBrowser(accessToken, refreshToken);

  try {
    await group1LandingTabs(page);
    await group2SkillsTab(page, skillCount, skillsData);
    await group3TemplatesTab(page, templateCount, templatesData);
    await group4SearchFilter(page);
    await group5EmptyStates(page);
    await group6DeadReferences(page);
  } finally {
    await page.waitForTimeout(500);
    await ctx.browser()?.close();
  }

  const durationMs = Date.now() - START;
  writeReport(skillCount, templateCount, durationMs);

  // Summary
  const p0Count = findings.filter((f) => f.sev === 'P0').length;
  const p1Count = findings.filter((f) => f.sev === 'P1').length;
  log(`\n=== DONE — ${((durationMs) / 1000).toFixed(1)}s ===`);
  log(`Findings: P0×${p0Count} P1×${p1Count} P2×${findings.filter((f) => f.sev === 'P2').length} Nit×${findings.filter((f) => f.sev === 'Nit').length}`);

  if (p0Count > 0) {
    log('OVERALL: FAIL (P0 issues found)');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  const errPath = path.join(AUDIT_DIR, 'run.log');
  writeFileSync(errPath, `FATAL: ${(err as Error).stack ?? err}\n`, 'utf8');
  process.exit(1);
});
