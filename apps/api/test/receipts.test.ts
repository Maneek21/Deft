/**
 * Phase 7 — receipts library unit tests.
 *
 * Run: pnpm --filter @deft/api test -- receipts
 *
 * Covers:
 *   1. generateReceipt inserts a row with a valid HMAC
 *   2. verifyReceipt returns true for a freshly-generated receipt
 *   3. verifyReceipt returns false if action_params_json is tampered in place
 *   4. verifyReceipt returns false if signature_hmac is wrong
 *   5. generateReceipt handles DB failure gracefully (returns null, no throw)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

// Fixture ids
const TEST_USER_ID = 'test-receipts-user';
const TEST_EMP_ID = 'test-receipts-emp';
const TEST_EMP_SLUG = 'receipts-emp';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function seedFixtures() {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Receipts Test User', true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, 'receipts-test@test.local'],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          kind, connection_url, connection_status, is_active, created_by)
       VALUES ($1, $2, $3, 'Receipts Test Emp', $4, 'project_manager',
         'test receipts employee', 'standard', 'openclaw',
         'http://127.0.0.1:19995/receipts', 'pending', true, $3)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [TEST_EMP_ID, ORG_ID, TEST_USER_ID, TEST_EMP_SLUG],
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM action_receipts WHERE employee_id = $1`,
      [TEST_EMP_ID],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE user_id = $1`,
      [TEST_USER_ID],
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = $1`,
      [TEST_EMP_ID],
    );
    await c.query(
      `DELETE FROM users WHERE id = $1`,
      [TEST_USER_ID],
    );
  });
}

async function insertPendingAction(action: string): Promise<string> {
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, agent_employee_id, source, action, params,
         approval_tier, approval_status)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'mcp', $4, '{"title":"t"}'::jsonb,
         'quick', 'approved')
       RETURNING id`,
      [ORG_ID, TEST_USER_ID, TEST_EMP_ID, action],
    );
    return r.rows[0].id as string;
  });
}

before(async () => {
  await seedFixtures();
});

after(async () => {
  await teardownFixtures();
});

// ───────────────────────────────────────────────────────────────────────

test('1. generateReceipt inserts a row with a valid HMAC', async () => {
  const actionId = await insertPendingAction('task_create');
  const { generateReceipt } = await import('../src/lib/receipts.js');

  const receipt = await generateReceipt({
    actionId,
    orgId: ORG_ID,
    employeeId: TEST_EMP_ID,
    proposer: 'employee',
    proposerId: TEST_EMP_ID,
    decision: 'auto_executed',
    actionName: 'task_create',
    actionParams: { title: 'test task', priority: 'p2' },
    resultJson: { id: 'new-task-id' },
  });

  assert.ok(receipt, 'receipt should be returned');
  assert.equal(receipt!.action_id, actionId);
  assert.equal(receipt!.org_id, ORG_ID);
  assert.equal(receipt!.employee_id, TEST_EMP_ID);
  assert.equal(receipt!.decision, 'auto_executed');
  assert.equal(receipt!.action_name, 'task_create');
  assert.ok(
    typeof receipt!.signature_hmac === 'string' && receipt!.signature_hmac.length === 64,
    `signature_hmac should be 64 hex chars, got: ${receipt!.signature_hmac}`,
  );
  assert.match(receipt!.signature_hmac, /^[0-9a-f]{64}$/);

  // Verify the row actually landed.
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT id, signature_hmac FROM action_receipts WHERE id = $1`,
      [receipt!.id],
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].signature_hmac, receipt!.signature_hmac);
  });
});

test('2. verifyReceipt returns true for a freshly-generated receipt', async () => {
  const actionId = await insertPendingAction('task_update');
  const { generateReceipt, verifyReceipt } = await import('../src/lib/receipts.js');

  const receipt = await generateReceipt({
    actionId,
    orgId: ORG_ID,
    employeeId: TEST_EMP_ID,
    proposer: 'employee',
    decision: 'auto_executed',
    actionName: 'task_update',
    actionParams: { task_id: 'abc', patch: { status: 'done' } },
  });

  assert.ok(receipt);
  const ok = await verifyReceipt(receipt!);
  assert.equal(ok, true, 'freshly-generated receipt should verify');
});

test('3. verifyReceipt returns false if action_params_json is tampered in place', async () => {
  const actionId = await insertPendingAction('message_post');
  const { generateReceipt, verifyReceipt } = await import('../src/lib/receipts.js');

  const receipt = await generateReceipt({
    actionId,
    orgId: ORG_ID,
    employeeId: TEST_EMP_ID,
    proposer: 'employee',
    decision: 'auto_executed',
    actionName: 'message_post',
    actionParams: { space_id: 'sp-1', content: 'original content' },
  });

  assert.ok(receipt);
  // Tamper the params in place.
  await withClient(async (c) => {
    await c.query(
      `UPDATE action_receipts SET action_params_json = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ space_id: 'sp-1', content: 'TAMPERED content' }), receipt!.id],
    );
  });

  // Re-fetch and verify.
  const [tampered] = await withClient((c) =>
    c.query(`SELECT * FROM action_receipts WHERE id = $1`, [receipt!.id]).then((r) => r.rows),
  );
  // Normalize the column name casing — pg returns snake_case.
  const ok = await verifyReceipt(tampered as any);
  assert.equal(ok, false, 'tampered receipt must NOT verify');
});

test('4. verifyReceipt returns false if signature_hmac is wrong', async () => {
  const actionId = await insertPendingAction('memory_update');
  const { generateReceipt, verifyReceipt } = await import('../src/lib/receipts.js');

  const receipt = await generateReceipt({
    actionId,
    orgId: ORG_ID,
    employeeId: TEST_EMP_ID,
    proposer: 'employee',
    decision: 'auto_executed',
    actionName: 'memory_update',
    actionParams: { slug: 'page-1', patch: { title: 'new title' } },
  });

  assert.ok(receipt);
  // Build a tampered copy with a bogus signature.
  const badReceipt = { ...receipt!, signature_hmac: 'f'.repeat(64) };
  const ok = await verifyReceipt(badReceipt);
  assert.equal(ok, false, 'receipt with wrong signature must NOT verify');
});

test('5. generateReceipt swallows DB failures and returns null', async () => {
  // Pass a non-existent action_id so the FK constraint fails. The library
  // must log + return null, not propagate the error.
  const { generateReceipt } = await import('../src/lib/receipts.js');

  // Silence console.error for the duration.
  const origErr = console.error;
  const captured: unknown[] = [];
  console.error = (...args: unknown[]) => captured.push(args);

  let thrown: unknown = null;
  let result: unknown = 'unset';
  try {
    result = await generateReceipt({
      actionId: 'ghost-action-that-does-not-exist-deadbeef',
      orgId: ORG_ID,
      employeeId: TEST_EMP_ID,
      proposer: 'employee',
      decision: 'auto_executed',
      actionName: 'task_create',
      actionParams: { title: 'ghost' },
    });
  } catch (err) {
    thrown = err;
  } finally {
    console.error = origErr;
  }

  assert.equal(thrown, null, 'generateReceipt must NOT throw on DB failure');
  assert.equal(result, null, 'generateReceipt must return null on DB failure');
  assert.ok(
    captured.length > 0,
    'generateReceipt should have logged an error on failure',
  );
});
