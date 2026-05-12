#!/usr/bin/env tsx
/**
 * Phase 7 end-to-end audit — signed audit receipts.
 *
 * Verifies the full receipt lifecycle:
 *   1. An auto-executed MCP write (memory_write via /api/mcp/v1/tools/call)
 *      produces an `agent_actions` row + an `action_receipts` row with a
 *      valid HMAC-SHA256 signature.
 *   2. The action log UI at Settings → Agent surfaces a "View receipt"
 *      button for the new row.
 *   3. Clicking the button opens the receipt modal populated with all
 *      fields (action name, proposer, decision, params, signature).
 *   4. The modal shows a green "Verified" pill because the signature is
 *      intact.
 *   5. Tampering `action_params_json` directly via SQL and re-opening the
 *      modal flips the pill to red "Tampered".
 *
 * Preconditions:
 *   - Deft API dev server live on http://localhost:3001
 *   - Deft web dev server live on http://localhost:3000
 *   - DATABASE_URL set in root .env
 *   - playwright-auth.json present at repo root (run pnpm audit:setup first)
 *
 * Run:
 *   pnpm audit:receipts
 *
 * Verify-before-batch: before launching Playwright, the audit hits
 * /api/mcp/v1/tools/call with memory_write to seed the receipt, then
 * curls /api/agent/actions/:id/receipt via the web app's stored bearer
 * to prove both the MCP auto-exec path and the receipt route work. Only
 * after both succeed do we burn browser credits.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import pg from 'pg';
import { writeFileSync, readFileSync } from 'node:fs';

import { assert } from './lib/assert.js';
import { getStatePath, loginAndSaveState } from './lib/auth.js';

// ─── Constants ─────────────────────────────────────────────────────────

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const CONNECTION_URL = 'http://127.0.0.1:19993/audit-receipts';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const TEST_EMPLOYEE = {
  id: `test-receipts-audit-emp-${Date.now()}`,
  slug: `receipts-audit-emp-${Date.now()}`,
  name: 'Receipts Audit PM',
  role: 'project_manager' as const,
  trust_level: 'autonomous' as const,
};

const TEST_USER = {
  id: `test-receipts-audit-user-${Date.now()}`,
  email: `test-receipts-audit-${Date.now()}@test.local`,
  name: TEST_EMPLOYEE.name,
};

const LAST_RUN_PATH = 'docs/superpowers/audits/audit-receipts.last-run.txt';

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

async function cleanupStaleTestFixtures(): Promise<void> {
  await withClient(async (c) => {
    // Receipts → agent_actions → wiki_pages → agent_employees → users
    const staleEmps = await c.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM agent_employees WHERE slug LIKE 'receipts-audit-emp-%'`,
    );
    if (staleEmps.rows.length === 0) return;
    const empIds = staleEmps.rows.map((r) => r.id);
    const userIds = staleEmps.rows.map((r) => r.user_id);
    await c.query(
      `DELETE FROM action_receipts WHERE employee_id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE agent_employee_id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM wiki_pages WHERE agent_employee_id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM tasks WHERE created_by = ANY($1::text[])`,
      [userIds],
    );
    await c.query(
      `DELETE FROM org_members WHERE user_id = ANY($1::text[])`,
      [userIds],
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM users WHERE id = ANY($1::text[])`,
      [userIds],
    );
    console.log(`  cleaned ${empIds.length} stale test fixture(s)`);
  });
}

async function seedTestEmployee(): Promise<string> {
  const { issueGatewayToken } = await import('../../../apps/api/src/lib/mcp-token.js');

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER.id, TEST_USER.email, TEST_USER.name],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, TEST_USER.id],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          kind, connection_url, connection_status, is_active, created_by)
       VALUES
         ($1, $2, $3, $4, $5, $6, 'test receipts audit employee', $7,
          'openclaw', $8, 'connected', true, $3)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [
        TEST_EMPLOYEE.id,
        ORG_ID,
        TEST_USER.id,
        TEST_EMPLOYEE.name,
        TEST_EMPLOYEE.slug,
        TEST_EMPLOYEE.role,
        TEST_EMPLOYEE.trust_level,
        CONNECTION_URL,
      ],
    );
  });

  return issueGatewayToken(ORG_ID, CONNECTION_URL);
}

async function cleanupTestFixtures(): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM action_receipts WHERE employee_id = $1`,
      [TEST_EMPLOYEE.id],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE agent_employee_id = $1`,
      [TEST_EMPLOYEE.id],
    );
    await c.query(
      `DELETE FROM wiki_pages WHERE agent_employee_id = $1`,
      [TEST_EMPLOYEE.id],
    );
    // task_create via MCP inserts tasks with created_by = shadow user.
    // Wipe them before the user row so the FK doesn't bounce.
    await c.query(
      `DELETE FROM tasks WHERE created_by = $1`,
      [TEST_USER.id],
    );
    await c.query(
      `DELETE FROM org_members WHERE user_id = $1`,
      [TEST_USER.id],
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = $1`,
      [TEST_EMPLOYEE.id],
    );
    await c.query(
      `DELETE FROM users WHERE id = $1`,
      [TEST_USER.id],
    );
  });
}

// ─── Verify-before-batch: seed + curl ──────────────────────────────────

async function triggerAutoExecTaskCreate(rawToken: string): Promise<string> {
  // Find a project to attach the task to.
  const projectId = await withClient(async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM projects WHERE org_id = $1 AND is_archived = false ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (r.rows.length > 0) return r.rows[0]!.id;
    const ins = await c.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, prefix, lead_id, task_counter)
       VALUES ($1, 'Receipts Audit Project', 'RCA', $2, 0)
       RETURNING id`,
      [ORG_ID, TEST_USER.id],
    );
    return ins.rows[0]!.id;
  });

  const title = `receipts-audit-task-${Date.now()}`;
  const res = await fetch(`${API_URL}/api/mcp/v1/tools/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${rawToken}`,
    },
    body: JSON.stringify({
      name: 'task_create',
      arguments: {
        caller_employee_slug: TEST_EMPLOYEE.slug,
        title,
        project_id: projectId,
        priority: 'p2',
      },
    }),
  });
  const body = await res.json();
  assert(
    res.status === 200 && !(body as { isError?: boolean }).isError,
    `task_create returned non-success: ${res.status} ${JSON.stringify(body).slice(0, 400)}`,
  );
  // Pull the resulting task's id.
  const text = (body as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}';
  const parsed = JSON.parse(text);
  assert(parsed.id, `task_create result missing id: ${text.slice(0, 300)}`);
  console.log(`  seeded task ${parsed.id} via MCP auto-exec`);

  // Now look up the matching agent_actions row. The executor inserts an
  // agent_actions row with params.title, so we can find it by title.
  const actionRow = await withClient(async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM agent_actions
       WHERE action = 'task_create' AND agent_employee_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [TEST_EMPLOYEE.id],
    );
    return r.rows[0]?.id ?? null;
  });
  assert(actionRow, 'no agent_actions row found for the seeded task_create');
  console.log(`  agent_actions row: ${actionRow}`);

  // Verify the receipt row exists too.
  const receiptRow = await withClient(async (c) => {
    const r = await c.query<{ id: string; signature_hmac: string }>(
      `SELECT id, signature_hmac FROM action_receipts WHERE action_id = $1`,
      [actionRow],
    );
    return r.rows[0] ?? null;
  });
  assert(receiptRow, 'no action_receipts row for the new action');
  assert(
    receiptRow.signature_hmac.length === 64,
    `receipt signature is not 64 hex chars: ${receiptRow.signature_hmac}`,
  );
  console.log(`  action_receipts row: ${receiptRow.id}`);

  return actionRow!;
}

function readAuthTokenFromState(): string {
  const raw = readFileSync(getStatePath(), 'utf8');
  const state = JSON.parse(raw) as {
    origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
  };
  for (const origin of state.origins ?? []) {
    for (const entry of origin.localStorage ?? []) {
      if (entry.name === 'deft-access-token') return entry.value;
    }
  }
  throw new Error('Could not find deft-access-token in playwright-auth.json');
}

async function preflightReceiptRoute(actionId: string): Promise<void> {
  const token = readAuthTokenFromState();
  const res = await fetch(`${API_URL}/api/agent/actions/${actionId}/receipt`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(
    res.status === 200,
    `Preflight receipt route returned ${res.status} — expected 200`,
  );
  const body = (await res.json()) as { verified?: boolean; receipt?: unknown };
  assert(body.verified === true, `Preflight verified was not true: ${JSON.stringify(body).slice(0, 300)}`);
  assert(body.receipt, `Preflight response missing receipt`);
  console.log('  pre-flight receipt route curl: 200 verified=true');
}

// ─── Playwright test steps ────────────────────────────────────────────

async function screenshotOnFail(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: `audit-failure-${name}.png`, fullPage: true });
    console.error(`    audit-failure-${name}.png saved`);
  } catch {
    // ignore
  }
}

async function openReceiptModal(page: Page, actionId: string): Promise<void> {
  await page.goto(`${WEB_URL}/settings/agent`, { waitUntil: 'networkidle' });

  // The action log list renders rows sorted by created_at desc; the new row
  // is at the top. Click the per-row "View receipt" button we can target by
  // data-testid.
  const button = page.locator(`[data-testid="view-receipt-${actionId}"]`).first();
  await button.waitFor({ state: 'visible', timeout: 15_000 });
  await button.click();

  await page.waitForSelector('[data-testid="receipt-viewer-modal"]', {
    state: 'visible',
    timeout: 10_000,
  });
}

async function assertReceiptModalContents(page: Page, expectedVerified: boolean): Promise<void> {
  const pill = page.locator('[data-testid="receipt-verified-pill"]').first();
  await pill.waitFor({ state: 'visible', timeout: 10_000 });
  const text = (await pill.textContent())?.trim() ?? '';
  if (expectedVerified) {
    assert(text === 'Verified', `expected Verified pill, got "${text}"`);
  } else {
    assert(text === 'Tampered', `expected Tampered pill, got "${text}"`);
  }

  // The signature should be a 64-char hex string.
  const sig = await page.locator('[data-testid="receipt-signature"]').first().textContent();
  assert((sig ?? '').length === 64, `signature is not 64 chars: "${sig}"`);
  assert(/^[0-9a-f]{64}$/.test(sig!), `signature not hex: "${sig}"`);

  // Params block should contain something JSON-like.
  const paramsText = await page.locator('[data-testid="receipt-params"]').first().textContent();
  assert(
    paramsText && paramsText.length > 2,
    `params block is empty: "${paramsText}"`,
  );
}

async function closeModal(page: Page): Promise<void> {
  const closeBtn = page.locator('[data-testid="receipt-close"]').first();
  if (await closeBtn.count() > 0) {
    await closeBtn.click();
    await page.waitForTimeout(300);
  }
}

async function tamperReceiptInPlace(actionId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE action_receipts
       SET action_params_json = $1::jsonb
       WHERE action_id = $2`,
      [JSON.stringify({ title: 'tampered by audit' }), actionId],
    );
  });
  console.log('  tampered action_params_json in place via SQL');
}

// ─── Runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Phase 7 audit — HMAC-signed action receipts\n');
  const runStart = Date.now();

  await preflightHealthChecks();
  await cleanupStaleTestFixtures();

  try {
    await loginAndSaveState();
  } catch (err) {
    console.warn(
      `  loginAndSaveState failed (possibly missing env): ${err instanceof Error ? err.message : err}`,
    );
    console.warn('  falling back to existing playwright-auth.json');
  }

  const rawToken = await seedTestEmployee();
  console.log(`  seeded test employee ${TEST_EMPLOYEE.id}`);

  console.log('  Step 1/5: trigger auto-exec MCP write via task_create');
  const actionId = await triggerAutoExecTaskCreate(rawToken);

  console.log('  Step 2/5: pre-flight receipt route curl');
  await preflightReceiptRoute(actionId);

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
      console.log('  Step 3/5: open Settings → Agent and click View receipt');
      await openReceiptModal(page, actionId);

      console.log('  Step 4/5: assert modal shows Verified (green)');
      await assertReceiptModalContents(page, true);
      await closeModal(page);

      console.log('  Step 5/5: tamper params and re-open modal, expect Tampered (red)');
      await tamperReceiptInPlace(actionId);
      // The UI reads fresh data on open, so just re-click.
      await openReceiptModal(page, actionId);
      await assertReceiptModalContents(page, false);
      await closeModal(page);

      assert(
        consoleErrors.length === 0,
        `browser console errors during flow: ${JSON.stringify(consoleErrors.slice(0, 5))}`,
      );
    } catch (err) {
      exitCode = 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  FAIL: ${msg}`);
      await screenshotOnFail(page, 'receipts');
    }
  } finally {
    await browser.close();
    await cleanupTestFixtures().catch((err) =>
      console.warn(`cleanup failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  const elapsedMs = Date.now() - runStart;
  if (exitCode === 0) {
    const baseline = [
      `Phase 7 HMAC-signed receipts audit — PASS`,
      `run at: ${new Date().toISOString()}`,
      `elapsed_ms: ${elapsedMs}`,
      `api_url: ${API_URL}`,
      `web_url: ${WEB_URL}`,
      `test_employee_slug: ${TEST_EMPLOYEE.slug}`,
      `flow: auto_exec → receipt generated → verified green → tampered → red`,
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
