#!/usr/bin/env tsx
/**
 * Phase 8 audit — Deploy Employee wizard (BYO path).
 *
 * Exercises the setup wizard end-to-end against the local OpenClaw Docker
 * container. The Railway path is NOT audited here — it requires a real
 * Railway account and an external OAuth redirect that Playwright can't
 * complete in a clean test environment. Railway integration has its own
 * unit tests (test/railway-oauth.test.ts + test/railway-provider.test.ts).
 *
 * Preconditions:
 *   - Deft API dev server live at http://localhost:3001
 *   - Deft web dev server live at http://localhost:3000
 *   - OpenClaw Docker container live at http://127.0.0.1:18789
 *   - DEFT_TEST_EMAIL + DEFT_TEST_PASSWORD set for the audit test user
 *
 * Run:
 *   pnpm audit:deploy-wizard
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import pg from 'pg';
import { writeFileSync } from 'node:fs';

import { assert } from './lib/assert.js';
import { getStatePath, loginAndSaveState } from './lib/auth.js';

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const OPENCLAW_URL = 'http://127.0.0.1:18789';
const OPENCLAW_TOKEN = 'd4f5ef9e8bd3771c0399cbf9f237b0bc5909ecbafa4c9055';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

const LAST_RUN_PATH = 'docs/superpowers/audits/deploy-wizard.last-run.txt';

const TEST_SLUG = `byo-wizard-${Date.now()}`;
const TEST_NAME = 'BYO Wizard Audit Employee';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function preflightHealthChecks(): Promise<void> {
  const ocRes = await fetch(`${OPENCLAW_URL}/health`).catch(() => null);
  assert(
    ocRes && ocRes.ok,
    'OpenClaw Docker container not reachable at http://127.0.0.1:18789/health',
  );

  const apiRes = await fetch(`${API_URL}/health`).catch(() => null);
  assert(apiRes && apiRes.ok, `Deft API not reachable at ${API_URL}/health`);

  const webRes = await fetch(`${WEB_URL}/login`).catch(() => null);
  assert(webRes && webRes.status < 500, `Deft web not reachable at ${WEB_URL}`);
  console.log('  preflight: all three services reachable');
}

async function cleanupStaleFixtures(): Promise<void> {
  // Remove any test rows from crashed prior runs. Matches by slug prefix so
  // we never touch unrelated data.
  await withClient(async (c) => {
    // Break the FK cycle: wipe provider_instance_id on stale employee rows
    // before deleting provider_instances.
    const stale = await c.query<{ id: string; provider_instance_id: string | null; user_id: string }>(
      `SELECT id, provider_instance_id, user_id FROM agent_employees
       WHERE org_id = $1 AND slug LIKE 'byo-wizard-%'`,
      [ORG_ID],
    );
    if (stale.rows.length === 0) return;
    const empIds = stale.rows.map((r) => r.id);
    const shadowIds = stale.rows.map((r) => r.user_id);

    await c.query(
      `UPDATE agent_employees SET provider_instance_id = NULL WHERE id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM provider_instances WHERE employee_id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM action_receipts WHERE employee_id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM agent_session_turns WHERE employee_id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE agent_employee_id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM org_members WHERE user_id = ANY($1::text[])`,
      [shadowIds],
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM users WHERE id = ANY($1::text[])`,
      [shadowIds],
    );
    console.log(`  cleaned ${stale.rows.length} stale wizard test row(s) from prior runs`);
  });
}

async function cleanupCurrentRun(): Promise<void> {
  await withClient(async (c) => {
    const rows = await c.query<{ id: string; user_id: string; provider_instance_id: string | null }>(
      `SELECT id, user_id, provider_instance_id FROM agent_employees
       WHERE org_id = $1 AND slug = $2`,
      [ORG_ID, TEST_SLUG],
    );
    if (rows.rows.length === 0) return;
    const empId = rows.rows[0]!.id;
    const shadowId = rows.rows[0]!.user_id;
    await c.query(
      `UPDATE agent_employees SET provider_instance_id = NULL WHERE id = $1`,
      [empId],
    );
    await c.query(
      `DELETE FROM provider_instances WHERE employee_id = $1`,
      [empId],
    );
    await c.query(
      `DELETE FROM action_receipts WHERE employee_id = $1`,
      [empId],
    );
    await c.query(
      `DELETE FROM agent_session_turns WHERE employee_id = $1`,
      [empId],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE agent_employee_id = $1`,
      [empId],
    );
    await c.query(
      `DELETE FROM org_members WHERE user_id = $1`,
      [shadowId],
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = $1`,
      [empId],
    );
    await c.query(
      `DELETE FROM users WHERE id = $1`,
      [shadowId],
    );
    console.log('  cleaned up test employee + shadow user');
  });
}

// Phase 9 — all 8 first-party templates ship. Wizard step 1 renders 8
// clickable cards (not 1 + 7 coming-soon placeholders).
const EXPECTED_TEMPLATE_SLUGS = [
  'alex-pm',
  'designer',
  'qa',
  'cs',
  'community',
  'on-call',
  'cfo',
  'devops',
];

// Expected default packs for alex-pm on step 2 (matches the §17 catalog +
// capability-packs.ts TEMPLATE_DEFAULT_PACKS).
const ALEX_PM_EXPECTED_PACKS = [
  'deft-workspace',
  'web-browsing',
  'tavily',
  'github',
  'google-calendar',
];

async function verifyAllTemplateCardsClickable(page: Page): Promise<void> {
  for (const slug of EXPECTED_TEMPLATE_SLUGS) {
    const card = page.locator(`[data-testid="role-card-${slug}"]`);
    const count = await card.count();
    assert(count === 1, `Template card ${slug} should render exactly once (found ${count})`);
    const isDisabled = await card.first().isDisabled();
    assert(!isDisabled, `Template card ${slug} should be enabled in Phase 9`);

    // Click each card — this verifies the card renders its description
    // and flips selection state without errors. We don't proceed past
    // step 1 here.
    await card.first().click();
    const descriptionText = await card.first().innerText();
    assert(
      descriptionText.length > 20,
      `Template card ${slug} must render a non-trivial description`,
    );
  }
  console.log(`  all ${EXPECTED_TEMPLATE_SLUGS.length} role cards clickable + describe themselves`);
}

async function verifyAlexPmDefaultPacks(page: Page): Promise<void> {
  // After clicking alex-pm, move to step 2 and verify the preview shows
  // the expected default-capability-packs for this template.
  await page.click('[data-testid="role-card-alex-pm"]');
  await page.waitForSelector('[data-testid="wizard-slug-input"]');
  // We need a slug + name filled in to proceed, so feed placeholder values.
  await page.fill('[data-testid="wizard-slug-input"]', `${TEST_SLUG}-preview`);
  await page.fill('[data-testid="wizard-name-input"]', 'preview');
  await page.click('[data-testid="wizard-next"]');

  // On step 2, every default pack should have its checkbox pre-checked.
  await page.waitForSelector('[data-testid="capability-pack-deft-workspace"]');
  for (const packSlug of ALEX_PM_EXPECTED_PACKS) {
    const locator = page.locator(`[data-testid="capability-pack-${packSlug}"] input`);
    const count = await locator.count();
    assert(count > 0, `capability-pack-${packSlug} checkbox not rendered`);
    const checked = await locator.first().isChecked();
    assert(checked, `capability-pack-${packSlug} should be checked by default for alex-pm`);
  }
  console.log(`  alex-pm defaults match expected capability packs: ${ALEX_PM_EXPECTED_PACKS.join(', ')}`);

  // Go back to step 1 so the main runWizard flow starts clean.
  await page.click('[data-testid="wizard-back"]').catch(async () => {
    // If back button isn't present, reload the page and restart.
    await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'networkidle' });
    await page.click('[data-testid="deploy-new-employee"]');
    await page.waitForSelector('[data-testid="deploy-wizard"]');
  });
}

async function runWizard(page: Page): Promise<string> {
  await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'networkidle' });
  await page.click('[data-testid="deploy-new-employee"]');
  await page.waitForSelector('[data-testid="deploy-wizard"]');

  // Phase 9 — verify all 8 cards render + are clickable BEFORE the main
  // deploy flow. This is the expanded step-1 coverage.
  await verifyAllTemplateCardsClickable(page);
  await verifyAlexPmDefaultPacks(page);

  // Re-enter the wizard to run the deploy flow fresh.
  await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'networkidle' });
  await page.click('[data-testid="deploy-new-employee"]');
  await page.waitForSelector('[data-testid="deploy-wizard"]');

  // Step 1 — role template + unique slug
  await page.click('[data-testid="role-card-alex-pm"]');
  await page.waitForSelector('[data-testid="wizard-slug-input"]');
  await page.fill('[data-testid="wizard-slug-input"]', TEST_SLUG);
  await page.fill('[data-testid="wizard-name-input"]', TEST_NAME);
  await page.click('[data-testid="wizard-next"]');

  // Step 2 — capability packs (accept defaults, don't fill secrets)
  await page.waitForSelector('[data-testid="capability-pack-deft-workspace"]');
  await page.click('[data-testid="wizard-next"]');

  // Step 3 — provider = BYO
  await page.click('[data-testid="provider-card-byo"]');
  await page.fill('[data-testid="byo-url-input"]', OPENCLAW_URL);
  await page.fill('[data-testid="byo-token-input"]', OPENCLAW_TOKEN);
  await page.click('[data-testid="wizard-next"]');

  // Step 4 — triggers (pick cron:standup). Label wraps the input; check
  // via the input element directly so React's onChange fires.
  await page.locator('[data-testid="trigger-cron\\:standup"] input').check();

  // Capture the POST body so we can echo it if provision fails.
  let capturedBody: string | null = null;
  page.on('request', (req) => {
    if (req.url().includes('/api/agents/deploy/start') && req.method() === 'POST') {
      capturedBody = req.postData();
    }
  });

  const [deployResp] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/agents/deploy/start') && res.request().method() === 'POST',
      { timeout: 15000 },
    ),
    page.click('[data-testid="wizard-deploy"]'),
  ]);
  const deployStatus = deployResp.status();
  if (deployStatus !== 200) {
    const body = await deployResp.text();
    throw new Error(
      `Deploy endpoint failed: ${deployStatus} ${body}\n  Request body: ${capturedBody}`,
    );
  }

  // Step 5 → 6: wait for provisioning to flip + handshake to render.
  // Since BYO provisioning is a no-op, the wizard may auto-advance to step 6
  // faster than Playwright can observe the step-5 heading. We wait for the
  // handshake heading directly.
  await page
    .waitForSelector('h3:has-text("6. Handshake test")', { timeout: 30000 })
    .catch(async (err) => {
      const snap = await page.screenshot().catch(() => null);
      if (snap) {
        (await import('node:fs')).writeFileSync(
          'docs/superpowers/audits/deploy-wizard-failure.png',
          snap,
        );
      }
      throw err;
    });

  // Wait for success text or failure text (30s).
  await page
    .waitForSelector('text=/Handshake succeeded|Handshake failed/', { timeout: 30000 })
    .catch(() => {});
  // Continue if handshake succeeded.
  const succeeded = await page.locator('text=Handshake succeeded').count();
  if (succeeded > 0) {
    await page.click('text=Continue');
  } else {
    const snap = await page.screenshot().catch(() => null);
    if (snap) {
      (await import('node:fs')).writeFileSync(
        'docs/superpowers/audits/deploy-wizard-handshake-failure.png',
        snap,
      );
    }
    throw new Error('Handshake did not succeed within 30s — see deploy-wizard-handshake-failure.png');
  }

  // Step 7 — approval summary + finish
  await page.waitForSelector('text=Deploy complete — Finish', { timeout: 10000 });
  await page.click('[data-testid="wizard-finish"]');
  await page.waitForURL((url) => url.pathname.startsWith('/settings/agent'));

  // Return the employee slug we seeded.
  return TEST_SLUG;
}

async function verifyEmployeePersisted(): Promise<void> {
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT kind, deployment_provider, connection_status, connection_url,
              capability_packs, trigger_subscriptions
       FROM agent_employees WHERE org_id = $1 AND slug = $2`,
      [ORG_ID, TEST_SLUG],
    );
    assert(r.rows.length === 1, 'Wizard should have inserted exactly one employee row');
    const row = r.rows[0];
    assert(row.kind === 'openclaw', `expected kind=openclaw, got ${row.kind}`);
    assert(
      row.deployment_provider === 'byo',
      `expected deployment_provider=byo, got ${row.deployment_provider}`,
    );
    assert(
      row.connection_url === OPENCLAW_URL,
      `expected connection_url=${OPENCLAW_URL}, got ${row.connection_url}`,
    );
    assert(
      Array.isArray(row.capability_packs) && row.capability_packs.includes('deft-workspace'),
      'deft-workspace should be present in capability_packs',
    );
    assert(
      Array.isArray(row.trigger_subscriptions) && row.trigger_subscriptions.includes('cron:standup'),
      'cron:standup should be present in trigger_subscriptions',
    );
  });
  console.log('  employee row persisted correctly');
}

async function main(): Promise<void> {
  console.log('Phase 8 — Deploy wizard audit (BYO path)');
  await preflightHealthChecks();
  await cleanupStaleFixtures();

  await loginAndSaveState();
  const statePath = getStatePath();

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: statePath });
  const page = await ctx.newPage();
  try {
    await runWizard(page);
    await verifyEmployeePersisted();

    writeFileSync(
      LAST_RUN_PATH,
      `Deploy wizard audit PASSED at ${new Date().toISOString()}\n` +
        `  Employee slug: ${TEST_SLUG}\n` +
        `  Provider: byo\n` +
        `  Connection URL: ${OPENCLAW_URL}\n`,
    );
    console.log('  audit PASSED');
  } finally {
    await cleanupCurrentRun();
    await ctx.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error('audit FAILED:', err);
  process.exitCode = 1;
});
