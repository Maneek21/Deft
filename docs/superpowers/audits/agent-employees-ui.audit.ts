#!/usr/bin/env tsx
/**
 * Phase 6.5 audit — Settings → Agent employees list + pending approvals UI.
 *
 * Preconditions:
 *   - Deft API dev server live on http://localhost:3001
 *   - Deft web dev server live on http://localhost:3000
 *   - DATABASE_URL set in root .env
 *   - DEFT_TEST_EMAIL / DEFT_TEST_PASSWORD set for the login helper
 *
 * Run:
 *   pnpm audit:agent-employees-ui
 *
 * The audit seeds a single test OpenClaw employee, a pending task_create
 * action it owns, and a session_turns row. Then it drives the browser
 * through:
 *   1. employees list shows the test row with kind/triggers/pending badge
 *   2. pending-approvals section lists the action
 *   3. click the employee → drawer opens, shows turns + pending
 *   4. reject the action with a reason → DB flips to rejected
 *   5. insert another pending action → approve via button → DB flips to
 *      approved + executed_at set
 *   6. cleanup and write baseline
 *
 * Verify-before-batch: BEFORE launching Playwright, we POST to the reject
 * route with a disposable pending row to confirm the backend wiring works.
 * This protects against wasted Playwright runs when the API is broken.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import pg from 'pg';
import { writeFileSync } from 'node:fs';

import { assert } from './lib/assert.js';
import { getStatePath, loginAndSaveState } from './lib/auth.js';

// ─── Constants ─────────────────────────────────────────────────────────

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const RUN_SUFFIX = Date.now();
const TEST_EMPLOYEE = {
  id: `test-ui-emp-${RUN_SUFFIX}`,
  slug: `test-ui-emp-${RUN_SUFFIX}`,
  name: `Test UI Employee ${RUN_SUFFIX}`,
  connection_url: 'http://localhost:18789',
};
// Phase 11 — sibling employee sharing TEST_EMPLOYEE.connection_url so the
// Gateway Health card aggregates two rows under one Gateway entry.
const TEST_EMPLOYEE_SIBLING = {
  id: `test-ui-emp-sibling-${RUN_SUFFIX}`,
  slug: `test-ui-emp-sibling-${RUN_SUFFIX}`,
  name: `Test UI Employee Sibling ${RUN_SUFFIX}`,
};
const TEST_USER_ID = `test-ui-shadow-${RUN_SUFFIX}`;

const LAST_RUN_PATH = 'docs/superpowers/audits/agent-employees-ui.last-run.txt';

// ─── DB helpers ────────────────────────────────────────────────────────

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
  const apiRes = await fetch(`${API_URL}/health`).catch(() => null);
  assert(apiRes && apiRes.ok, `Deft API not reachable at ${API_URL}/health — run pnpm dev:api`);

  const webRes = await fetch(`${WEB_URL}/login`).catch(() => null);
  assert(webRes && webRes.status < 500, `Deft web not reachable at ${WEB_URL} — run pnpm dev:web`);
  console.log('  preflight: API + web reachable');
}

async function seedTestEmployee(): Promise<{ projectId: string; spaceId: string }> {
  return withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, `${TEST_USER_ID}@test.local`, TEST_EMPLOYEE.name],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, TEST_USER_ID],
    );

    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          kind, connection_url, connection_status, template_slug, template_version,
          trigger_subscriptions, is_active, created_by)
       VALUES
         ($1, $2, $3, $4, $5, 'project_manager', 'test ui employee', 'standard',
          'openclaw', $6, 'connected', 'pm', '1.0.0',
          ARRAY['cron:standup', 'webhook:pr-merged']::text[], true, $3)
       ON CONFLICT (id) DO UPDATE SET
         kind = 'openclaw',
         connection_url = $6,
         connection_status = 'connected',
         template_slug = 'pm',
         template_version = '1.0.0',
         trigger_subscriptions = ARRAY['cron:standup', 'webhook:pr-merged']::text[],
         is_active = true`,
      [
        TEST_EMPLOYEE.id,
        ORG_ID,
        TEST_USER_ID,
        TEST_EMPLOYEE.name,
        TEST_EMPLOYEE.slug,
        TEST_EMPLOYEE.connection_url,
      ],
    );

    // Phase 11 — sibling employee sharing the same connection_url. Both
    // rows should roll up into a single Gateway Health card.
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          kind, connection_url, connection_status, template_slug, template_version,
          trigger_subscriptions, is_active, last_gateway_ping_at, gateway_ping_fail_count,
          created_by)
       VALUES
         ($1, $2, $3, $4, $5, 'engineering_lead', 'test ui employee sibling', 'standard',
          'openclaw', $6, 'connected', 'engineering-lead', '1.0.0',
          ARRAY['cron:standup']::text[], true, now(), 0, $3)
       ON CONFLICT (id) DO UPDATE SET
         kind = 'openclaw',
         connection_url = $6,
         connection_status = 'connected',
         template_slug = 'engineering-lead',
         template_version = '1.0.0',
         trigger_subscriptions = ARRAY['cron:standup']::text[],
         is_active = true,
         last_gateway_ping_at = now(),
         gateway_ping_fail_count = 0`,
      [
        TEST_EMPLOYEE_SIBLING.id,
        ORG_ID,
        TEST_USER_ID,
        TEST_EMPLOYEE_SIBLING.name,
        TEST_EMPLOYEE_SIBLING.slug,
        TEST_EMPLOYEE.connection_url,
      ],
    );

    // Find a project + space to target.
    const proj = await c.query(
      `SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    const projectId: string = proj.rows.length > 0
      ? proj.rows[0].id
      : (await c.query(
          `INSERT INTO projects (org_id, name, prefix, lead_id, task_counter)
           VALUES ($1, 'UI Audit Project', 'UIA', $2, 0)
           RETURNING id`,
          [ORG_ID, TEST_USER_ID],
        )).rows[0].id;

    const sp = await c.query(
      `SELECT id FROM spaces WHERE org_id = $1 AND is_archived = false
       ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    assert(sp.rows.length > 0, 'no space available for audit');
    const spaceId: string = sp.rows[0].id;

    // Phase 10 — seed 3 session_turns rows with varied trigger_kinds,
    // latencies, and results so the session inspector can render + filter
    // without hitting an empty state.
    await c.query(
      `INSERT INTO agent_session_turns
         (id, org_id, employee_id, trigger_kind, input_messages_json,
          tool_calls_json, raw_reply_text, latency_ms, model_name,
          tokens_in, tokens_out, result)
       VALUES
         (gen_random_uuid()::text, $1, $2, 'cron:standup', $3::jsonb,
          $4::jsonb, 'Daily standup posted.', 1234, 'anthropic/claude-sonnet-4-6',
          512, 256, 'success'),
         (gen_random_uuid()::text, $1, $2, 'chat_mention', $5::jsonb,
          '[]'::jsonb, 'Roger that.', 850, 'anthropic/claude-sonnet-4-6',
          128, 64, 'success'),
         (gen_random_uuid()::text, $1, $2, 'webhook:pr-merged', '[]'::jsonb,
          '[]'::jsonb, null, 5600, 'anthropic/claude-sonnet-4-6',
          0, 0, 'error')`,
      [
        ORG_ID,
        TEST_EMPLOYEE.id,
        JSON.stringify([
          { role: 'system', content: 'You are alex-pm.' },
          { role: 'user', content: 'Kick off the standup.' },
        ]),
        JSON.stringify([
          { type: 'tool_use', name: 'memory_recall', input: { query: 'standup' }, output: { facts: [] } },
        ]),
        JSON.stringify([
          { role: 'system', content: 'You are alex-pm.' },
          { role: 'user', content: '@alex-pm what is the status?' },
        ]),
      ],
    );

    return { projectId, spaceId };
  });
}

async function insertPendingAction(
  projectId: string,
  spaceId: string,
  title: string,
): Promise<string> {
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO agent_actions
         (id, org_id, user_id, agent_employee_id, source, action, params,
          approval_tier, approval_status)
       VALUES
         (gen_random_uuid()::text, $1, $2, $3, 'mcp', 'task_create', $4::jsonb,
          'quick', 'pending')
       RETURNING id`,
      [
        ORG_ID,
        TEST_USER_ID,
        TEST_EMPLOYEE.id,
        JSON.stringify({
          caller_employee_slug: TEST_EMPLOYEE.slug,
          title,
          project_id: projectId,
          space_id: spaceId,
          priority: 'p2',
        }),
      ],
    );
    return r.rows[0].id as string;
  });
}

async function cleanupAll(): Promise<void> {
  await withClient(async (c) => {
    // Phase 7 added action_receipts with a real FK to agent_actions.id —
    // drop receipts first so the agent_actions delete doesn't violate FK.
    await c.query(
      `DELETE FROM action_receipts WHERE action_id IN (SELECT id FROM agent_actions WHERE agent_employee_id = $1)`,
      [TEST_EMPLOYEE.id],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE agent_employee_id = $1`,
      [TEST_EMPLOYEE.id],
    );
    await c.query(
      `DELETE FROM agent_session_turns WHERE employee_id = $1`,
      [TEST_EMPLOYEE.id],
    );
    await c.query(
      `DELETE FROM tasks WHERE created_by = $1`,
      [TEST_USER_ID],
    );
    await c.query(
      `DELETE FROM messages WHERE user_id = $1`,
      [TEST_USER_ID],
    );
    await c.query(
      `DELETE FROM org_members WHERE user_id = $1`,
      [TEST_USER_ID],
    );
    // Phase 11 — remove the sibling row before the parent so no dangling FKs.
    await c.query(
      `DELETE FROM agent_employees WHERE id IN ($1, $2)`,
      [TEST_EMPLOYEE.id, TEST_EMPLOYEE_SIBLING.id],
    );
    await c.query(
      `DELETE FROM users WHERE id = $1`,
      [TEST_USER_ID],
    );
  });
}

async function getAccessTokenFromStorageState(): Promise<string> {
  // Re-use what Playwright saved — but we need it for the curl verify step
  // BEFORE we open a browser, so just hit the login endpoint directly.
  const email = process.env.DEFT_TEST_EMAIL;
  const password = process.env.DEFT_TEST_PASSWORD;
  assert(!!email && !!password, 'DEFT_TEST_EMAIL and DEFT_TEST_PASSWORD must be set');

  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert(res.ok, `login for curl verify failed: ${res.status}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const token = (raw.access_token ?? raw.accessToken) as string | undefined;
  assert(!!token, `login response missing token: ${JSON.stringify(raw).slice(0, 200)}`);
  return token!;
}

// ─── verify-before-batch: single curl against the reject route ────────

async function curlVerifyBackend(projectId: string, spaceId: string): Promise<void> {
  const token = await getAccessTokenFromStorageState();
  const disposableId = await insertPendingAction(
    projectId,
    spaceId,
    `verify-before-batch-${RUN_SUFFIX}`,
  );
  const res = await fetch(
    `${API_URL}/api/agent/actions/${disposableId}/reject`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ reason: 'curl verify step' }),
    },
  );
  const raw = await res.text();
  assert(
    res.ok,
    `verify-before-batch reject returned ${res.status}: ${raw}`,
  );
  const body = JSON.parse(raw) as { status?: string };
  assert(
    body.status === 'rejected',
    `verify-before-batch expected status=rejected got ${JSON.stringify(body)}`,
  );

  // DB-level confirmation.
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status, error FROM agent_actions WHERE id = $1`,
      [disposableId],
    );
    assert(
      r.rows[0]?.approval_status === 'rejected',
      `verify-before-batch DB did not flip: ${JSON.stringify(r.rows[0])}`,
    );
    assert(
      r.rows[0]?.error === 'curl verify step',
      `verify-before-batch reason not persisted: ${JSON.stringify(r.rows[0])}`,
    );
  });
  console.log('  verify-before-batch: reject route + DB transition OK');
}

// ─── Playwright steps ─────────────────────────────────────────────────

async function screenshotOnFail(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: `audit-failure-${name}.png`, fullPage: true });
    console.error(`    audit-failure-${name}.png saved`);
  } catch {
    // ignore
  }
}

async function assertEmployeeRowVisible(page: Page): Promise<void> {
  const row = page.locator(`[data-testid="employee-row-${TEST_EMPLOYEE.slug}"]`);
  await row.waitFor({ state: 'visible', timeout: 15_000 });

  const text = (await row.innerText()).toLowerCase();
  assert(
    text.includes('openclaw'),
    `employee row should show OpenClaw kind badge, got: ${text}`,
  );
  assert(
    text.includes('cron:standup'),
    `employee row should show cron:standup chip, got: ${text}`,
  );
  assert(
    text.includes('webhook:pr-merged'),
    `employee row should show webhook:pr-merged chip, got: ${text}`,
  );
  const pendingBadge = page.locator(
    `[data-testid="employee-pending-${TEST_EMPLOYEE.slug}"]`,
  );
  await pendingBadge.waitFor({ state: 'visible', timeout: 5_000 });
  const badgeText = (await pendingBadge.innerText()).toLowerCase();
  assert(
    /\d\s*pending/.test(badgeText),
    `pending badge should show count, got: ${badgeText}`,
  );
  console.log('  step 1: employees list row OK');
}

async function assertPendingSectionShows(page: Page, actionId: string): Promise<void> {
  const row = page.locator(`[data-testid="pending-row-${actionId}"]`);
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  const text = (await row.innerText()).toLowerCase();
  assert(
    text.includes('task_create'),
    `pending row should show task_create, got: ${text}`,
  );
  console.log('  step 2: pending approvals section OK');
}

async function assertDrawerOpensAndShowsTurn(page: Page): Promise<void> {
  const row = page.locator(`[data-testid="employee-row-${TEST_EMPLOYEE.slug}"]`);
  await row.click();
  const drawer = page.locator('[data-testid="employee-drawer"]');
  await drawer.waitFor({ state: 'visible', timeout: 5_000 });
  const drawerText = (await drawer.innerText()).toLowerCase();
  assert(
    drawerText.includes('1234ms'),
    `drawer should show seeded 1234ms latency, got: ${drawerText.slice(0, 400)}`,
  );
  assert(
    drawerText.includes('success'),
    `drawer should show seeded success result, got: ${drawerText.slice(0, 400)}`,
  );
  // Pending approvals in the drawer section.
  assert(
    drawerText.includes('task_create'),
    `drawer should surface the pending task_create, got: ${drawerText.slice(0, 400)}`,
  );
  console.log('  step 3: drawer opens + turns + pending OK');
}

async function assertSessionInspector(page: Page): Promise<void> {
  // Phase 10 — the drawer should render all 3 seeded turns, each with a
  // result pill, trigger kind chip, and latency metric.
  const turnRows = page.locator('[data-testid^="turn-row-"]');
  await turnRows.first().waitFor({ state: 'visible', timeout: 5_000 });
  const turnCount = await turnRows.count();
  assert(
    turnCount >= 3,
    `expected at least 3 session turn rows, got ${turnCount}`,
  );

  // Expand the first turn — it should reveal tabs (input / tools / reply / metrics).
  await turnRows.first().click();
  const expanded = page.locator('[data-testid^="turn-expanded-"]').first();
  await expanded.waitFor({ state: 'visible', timeout: 3_000 });
  const expandedText = (await expanded.innerText()).toLowerCase();
  assert(
    expandedText.includes('input'),
    `expanded turn should show Input tab label, got: ${expandedText.slice(0, 300)}`,
  );
  assert(
    expandedText.includes('tools'),
    `expanded turn should show Tools tab label, got: ${expandedText.slice(0, 300)}`,
  );
  assert(
    expandedText.includes('reply'),
    `expanded turn should show Reply tab label, got: ${expandedText.slice(0, 300)}`,
  );
  console.log('  step 3b: session inspector expand + tabs OK');
}

async function assertGatewayHealth(page: Page): Promise<void> {
  // Phase 11 — the "Gateway health" section should show one card for the
  // shared connection_url with both seeded employees rolled up under it.
  // Close any open drawer so the section above the list is visible.
  const drawerClose = page.locator('[data-testid="drawer-close"]');
  if (await drawerClose.isVisible().catch(() => false)) {
    await drawerClose.click();
    await page
      .locator('[data-testid="employee-drawer"]')
      .waitFor({ state: 'hidden', timeout: 3_000 })
      .catch(() => {});
  }

  const section = page.locator('[data-testid="gateway-health-section"]');
  await section.waitFor({ state: 'visible', timeout: 5_000 });

  const host = new URL(TEST_EMPLOYEE.connection_url).host;
  const card = page.locator(`[data-testid="gateway-health-card-${host}"]`);
  await card.waitFor({ state: 'visible', timeout: 5_000 });

  const statusPill = page.locator(`[data-testid="gateway-health-status-${host}"]`);
  await statusPill.waitFor({ state: 'visible', timeout: 3_000 });
  const pillText = (await statusPill.innerText()).toLowerCase();
  assert(
    pillText.includes('connected'),
    `gateway status pill should read "Connected", got: ${pillText}`,
  );

  // Both seeded employees should appear inside the card.
  const cardText = await card.innerText();
  assert(
    cardText.includes(TEST_EMPLOYEE.name),
    `gateway card should list ${TEST_EMPLOYEE.name}, got: ${cardText.slice(0, 400)}`,
  );
  assert(
    cardText.includes(TEST_EMPLOYEE_SIBLING.name),
    `gateway card should list ${TEST_EMPLOYEE_SIBLING.name}, got: ${cardText.slice(0, 400)}`,
  );

  const memberRows = card.locator('[data-testid^="gateway-health-member-"]');
  const memberCount = await memberRows.count();
  assert(
    memberCount >= 2,
    `expected at least 2 gateway member rows, got ${memberCount}`,
  );
  console.log('  step 3d: gateway health card shows both employees OK');
}

async function assertConfirmDangerousFlow(page: Page): Promise<void> {
  // Phase 11 closed the drawer to check gateway health above the list.
  // Reopen it here so the upgrade button inside the drawer is clickable.
  const drawer = page.locator('[data-testid="employee-drawer"]');
  if (!(await drawer.isVisible().catch(() => false))) {
    await page
      .locator(`[data-testid="employee-row-${TEST_EMPLOYEE.slug}"]`)
      .click();
    await drawer.waitFor({ state: 'visible', timeout: 5_000 });
  }

  // Click the upgrade button to open the modal.
  await page.locator('[data-testid="upgrade-autonomous-btn"]').click();
  const modal = page.locator('[data-testid="confirm-upgrade-autonomous"]');
  await modal.waitFor({ state: 'visible', timeout: 3_000 });

  const input = page.locator('[data-testid="confirm-upgrade-autonomous-input"]');
  const confirmBtn = page.locator('[data-testid="confirm-upgrade-autonomous-confirm"]');

  // Wrong word → button still disabled.
  await input.fill('autonomous'); // lowercase ≠ AUTONOMOUS
  assert(
    await confirmBtn.isDisabled(),
    'confirm button should stay disabled when the typed word does not match exactly',
  );

  // Clear and type the right word.
  await input.fill('');
  await input.fill('AUTONOMOUS');
  assert(
    await confirmBtn.isEnabled(),
    'confirm button should enable once the typed word matches',
  );

  // Cancel — modal should close without changing trust_level.
  await page.locator('[data-testid="confirm-upgrade-autonomous-cancel"]').click();
  await modal.waitFor({ state: 'hidden', timeout: 3_000 });
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT trust_level FROM agent_employees WHERE id = $1`,
      [TEST_EMPLOYEE.id],
    );
    assert(
      r.rows[0]?.trust_level === 'standard',
      `cancel must not flip trust_level, got: ${JSON.stringify(r.rows[0])}`,
    );
  });

  // Reopen, type correct word, confirm → DB flips.
  await page.locator('[data-testid="upgrade-autonomous-btn"]').click();
  await modal.waitFor({ state: 'visible', timeout: 3_000 });
  await input.fill('AUTONOMOUS');
  await confirmBtn.click();
  await modal.waitFor({ state: 'hidden', timeout: 5_000 });

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT trust_level FROM agent_employees WHERE id = $1`,
      [TEST_EMPLOYEE.id],
    );
    assert(
      r.rows[0]?.trust_level === 'autonomous',
      `confirm should flip trust_level to autonomous, got: ${JSON.stringify(r.rows[0])}`,
    );
  });
  console.log('  step 3c: ConfirmDangerous upgrade flow OK');

  // Close the drawer before the next test step expects the pending row.
  await page.locator('[data-testid="drawer-close"]').click();
  await page
    .locator('[data-testid="employee-drawer"]')
    .waitFor({ state: 'hidden', timeout: 3_000 });
}

async function rejectAction(page: Page, actionId: string): Promise<void> {
  await page.locator(`[data-testid="reject-${actionId}"]`).click();
  const input = page.locator('[data-testid="reject-reason-input"]');
  await input.waitFor({ state: 'visible', timeout: 3_000 });
  await input.fill('audit reject path');
  await page.locator('[data-testid="reject-confirm"]').click();
  // Wait for the row to disappear.
  await page
    .locator(`[data-testid="pending-row-${actionId}"]`)
    .waitFor({ state: 'detached', timeout: 5_000 });

  // DB-level confirmation.
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status, error FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert(
      r.rows[0]?.approval_status === 'rejected',
      `reject did not flip DB: ${JSON.stringify(r.rows[0])}`,
    );
    assert(
      r.rows[0]?.error === 'audit reject path',
      `reject reason not persisted: ${JSON.stringify(r.rows[0])}`,
    );
  });
  console.log('  step 4: reject flow + DB transition OK');
}

async function approveAction(page: Page, actionId: string): Promise<void> {
  // Trigger a fresh fetch so the newly-inserted row shows up.
  await page.reload({ waitUntil: 'networkidle' });
  const row = page.locator(`[data-testid="pending-row-${actionId}"]`);
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator(`[data-testid="approve-${actionId}"]`).click();
  await row.waitFor({ state: 'detached', timeout: 10_000 });

  // DB — we do NOT expect a real task to land because the audit environment
  // uses synthetic params; the approval_status + executed_at transition is
  // the real signal that the route fired.
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status, executed_at FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert(
      r.rows[0]?.approval_status === 'approved',
      `approve did not flip DB: ${JSON.stringify(r.rows[0])}`,
    );
    assert(
      r.rows[0]?.executed_at !== null,
      `approve did not set executed_at: ${JSON.stringify(r.rows[0])}`,
    );
  });
  console.log('  step 5: approve flow + DB transition OK');
}

// ─── Runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Phase 6.5 audit — Settings → Agent employees + pending approvals\n');
  const runStart = Date.now();

  await preflightHealthChecks();

  // Make sure we have a browser session.
  try {
    await loginAndSaveState();
  } catch (err) {
    console.warn(
      `  loginAndSaveState: ${err instanceof Error ? err.message : err} (falling back to saved state)`,
    );
  }

  const { projectId, spaceId } = await seedTestEmployee();
  console.log(`  seeded test employee ${TEST_EMPLOYEE.id} (slug=${TEST_EMPLOYEE.slug})`);

  // Verify-before-batch: cheap curl hitting the reject route.
  await curlVerifyBackend(projectId, spaceId);

  // The main pending action we'll target with the UI reject path.
  const rejectActionId = await insertPendingAction(
    projectId,
    spaceId,
    `audit-reject-${RUN_SUFFIX}`,
  );

  const headless = process.env.AUDIT_HEADLESS !== 'false';
  const browser: Browser = await chromium.launch({ headless });
  const consoleErrors: string[] = [];
  let exitCode = 0;
  try {
    const ctx = await browser.newContext({
      storageState: getStatePath(),
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const txt = msg.text();
        if (txt.includes('Failed to load resource')) return;
        consoleErrors.push(txt);
      }
    });

    try {
      console.log('  navigating to Settings → Agent');
      await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'networkidle' });

      await assertEmployeeRowVisible(page);
      await assertPendingSectionShows(page, rejectActionId);
      await assertDrawerOpensAndShowsTurn(page);
      await assertSessionInspector(page);
      await assertGatewayHealth(page);
      await assertConfirmDangerousFlow(page);
      await rejectAction(page, rejectActionId);

      // Insert a second pending action and approve it.
      const approveActionId = await insertPendingAction(
        projectId,
        spaceId,
        `audit-approve-${RUN_SUFFIX}`,
      );
      await approveAction(page, approveActionId);

      console.log('  step 6: no browser console errors during the flow');
      assert(
        consoleErrors.length === 0,
        `browser console errors during flow: ${JSON.stringify(consoleErrors.slice(0, 5))}`,
      );
    } catch (err) {
      exitCode = 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  FAIL: ${msg}`);
      await screenshotOnFail(page, 'agent-employees-ui');
    }
  } finally {
    await browser.close();
    await cleanupAll().catch((err) =>
      console.warn(`cleanup failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  const elapsedMs = Date.now() - runStart;
  if (exitCode === 0) {
    const baseline = [
      `Phase 6.5 agent employees UI audit — PASS`,
      `run at: ${new Date().toISOString()}`,
      `elapsed_ms: ${elapsedMs}`,
      `api_url: ${API_URL}`,
      `web_url: ${WEB_URL}`,
      `test_employee_slug: ${TEST_EMPLOYEE.slug}`,
      ``,
    ].join('\n');
    writeFileSync(LAST_RUN_PATH, baseline);
    console.log(`\n  PASS — baseline written to ${LAST_RUN_PATH} (${elapsedMs}ms)`);
    process.exit(0);
  }
  console.error(`\n  FAIL — audit did not complete cleanly (${elapsedMs}ms)`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Audit runner crashed:', err);
  process.exit(1);
});
