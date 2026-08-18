import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import { closeDb } from '../src/lib/db.js';
import { maintainAttentionSystem } from '../src/lib/attention-maintenance.js';
import { syncApprovalToAttention } from '../src/lib/attention.js';
import { verifyReceipt } from '../src/lib/receipts.js';
import { agentEmployeeRoutes } from '../src/routes/agent-employees.js';

const TEST_DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL;
const canRun = Boolean(
  TEST_DATABASE_URL && /(?:test|ci)/i.test(new URL(TEST_DATABASE_URL).pathname),
);
const suffix = randomUUID();
const ORG_ID = `module-terminal-org-${suffix}`;
const ADMIN_ID = `module-terminal-admin-${suffix}`;
const TTL_SHADOW_ID = `module-terminal-ttl-shadow-${suffix}`;
const TTL_EMPLOYEE_ID = `module-terminal-ttl-employee-${suffix}`;
const DELETE_SHADOW_ID = `module-terminal-delete-shadow-${suffix}`;
const DELETE_EMPLOYEE_ID = `module-terminal-delete-employee-${suffix}`;
const ADMIN_EMAIL = `module-terminal-admin-${suffix}@test.local`;

let client: pg.Client | null = null;
let app: Hono | null = null;

async function insertPendingAction(input: {
  employeeId: string;
  shadowUserId: string;
  action: string;
  params: Record<string, unknown>;
  stale?: boolean;
}) {
  assert.ok(client);
  const result = await client.query(
    `INSERT INTO agent_actions
       (id, org_id, user_id, agent_employee_id, source, action, params,
        approval_tier, approval_status, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'mcp', $4, $5::jsonb,
       'full', 'pending',
       CASE WHEN $6 THEN NOW() - INTERVAL '48 hours' ELSE NOW() END,
       NOW())
     RETURNING *`,
    [
      ORG_ID,
      input.shadowUserId,
      input.employeeId,
      input.action,
      JSON.stringify(input.params),
      input.stale ?? false,
    ],
  );
  const action = result.rows[0];
  await syncApprovalToAttention(action, { deliver: false });
  return action;
}

async function insertWorkIntent(employeeId: string, label: string): Promise<string> {
  assert.ok(client);
  const result = await client.query(
    `INSERT INTO work_intents
       (id, org_id, source_user_id, agent_employee_id, kind, status, title,
        summary, proposed_action, proposed_params, dedupe_key)
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'task_candidate', 'proposed',
       $4, $4, 'module_record_update', '{}'::jsonb, $5)
     RETURNING id`,
    [ORG_ID, ADMIN_ID, employeeId, label, `module-terminal:${suffix}:${label}`],
  );
  return result.rows[0].id;
}

before(async () => {
  if (!canRun || !TEST_DATABASE_URL) return;
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, 'Module terminalization', $2)`,
    [ORG_ID, `module-terminal-${suffix.slice(0, 12)}`],
  );
  await client.query(
    `INSERT INTO users (id, email, name, is_agent)
     VALUES ($1, $2, 'Module Terminal Admin', false),
            ($3, $4, 'TTL Shadow', true),
            ($5, $6, 'Delete Shadow', true)`,
    [
      ADMIN_ID,
      ADMIN_EMAIL,
      TTL_SHADOW_ID,
      `module-terminal-ttl-${suffix}@test.local`,
      DELETE_SHADOW_ID,
      `module-terminal-delete-${suffix}@test.local`,
    ],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES (gen_random_uuid()::text, $1, $2, 'owner', true)`,
    [ORG_ID, ADMIN_ID],
  );
  await client.query(
    `INSERT INTO agent_employees
       (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
        is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'TTL Employee', $4, 'custom', 'test', 'conservative', true, true, $7),
            ($5, $2, $6, 'Delete Employee', $8, 'custom', 'test', 'conservative', true, true, $7)`,
    [
      TTL_EMPLOYEE_ID,
      ORG_ID,
      TTL_SHADOW_ID,
      `module-terminal-ttl-${suffix.slice(0, 10)}`,
      DELETE_EMPLOYEE_ID,
      DELETE_SHADOW_ID,
      ADMIN_ID,
      `module-terminal-delete-${suffix.slice(0, 10)}`,
    ],
  );

  app = new Hono();
  app.use('*', async (context, next) => {
    context.set('user', {
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      org_id: ORG_ID,
      role: 'owner',
    } as any);
    await next();
  });
  app.route('/api/agent-employees', agentEmployeeRoutes);
});

after(async () => {
  if (client) {
    await client.query('DELETE FROM attention_items WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM action_receipts WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM module_mutation_receipts WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM work_intents WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM agent_actions WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM agent_employees WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM org_members WHERE org_id = $1', [ORG_ID]);
    await client.query(
      'DELETE FROM users WHERE id = ANY($1::text[])',
      [[ADMIN_ID, TTL_SHADOW_ID, DELETE_SHADOW_ID]],
    );
    await client.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]);
    await client.end();
  }
  await closeDb();
});

test('TTL terminalizes module actions with one verified receipt and closes linked lifecycle', { skip: !canRun }, async () => {
  assert.ok(client);
  const workIntentId = await insertWorkIntent(TTL_EMPLOYEE_ID, 'ttl');
  const privateValue = `ttl-private-${suffix}@example.test`;
  const rawKey = `ttl-raw-key-${suffix}`;
  const action = await insertPendingAction({
    employeeId: TTL_EMPLOYEE_ID,
    shadowUserId: TTL_SHADOW_ID,
    action: 'module_record_update',
    stale: true,
    params: {
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      record_id: `ttl-record-${suffix}`,
      expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
      expected_revision: 3,
      patch: { email: privateValue, notes: 'ttl private note' },
      unset_fields: [],
      idempotency_key: rawKey,
      work_intent_id: workIntentId,
    },
  });

  const first = await maintainAttentionSystem(new Date());
  assert.ok(first.expired >= 1);
  await maintainAttentionSystem(new Date());

  const terminal = await client.query(
    `SELECT approval_status, params, error, executed_at
       FROM agent_actions WHERE id = $1`,
    [action.id],
  );
  assert.equal(terminal.rows[0].approval_status, 'expired');
  assert.equal(terminal.rows[0].error, 'Approval expired');
  assert.ok(terminal.rows[0].executed_at);
  assert.match(terminal.rows[0].params.idempotency_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(terminal.rows[0].params.input_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal('idempotency_key' in terminal.rows[0].params, false);
  assert.equal('patch' in terminal.rows[0].params, false);
  assert.doesNotMatch(JSON.stringify(terminal.rows[0].params), new RegExp(`${privateValue}|${rawKey}|ttl private note`));

  const receipts = await client.query(
    `SELECT * FROM action_receipts WHERE action_id = $1 AND decision = 'expired'`,
    [action.id],
  );
  assert.equal(receipts.rows.length, 1);
  assert.equal(await verifyReceipt(receipts.rows[0]), true);
  assert.doesNotMatch(
    JSON.stringify(receipts.rows[0].action_params_json),
    new RegExp(`${privateValue}|${rawKey}|ttl private note`),
  );

  const attention = await client.query(
    `SELECT state, resolution FROM attention_items
      WHERE org_id = $1 AND source_type = 'agent_action' AND source_id = $2`,
    [ORG_ID, action.id],
  );
  assert.equal(attention.rows[0].state, 'resolved');
  assert.equal(attention.rows[0].resolution, 'expired');
  const intent = await client.query(
    'SELECT status, failure_reason FROM work_intents WHERE id = $1',
    [workIntentId],
  );
  assert.equal(intent.rows[0].status, 'expired');
  assert.equal(intent.rows[0].failure_reason, 'Approval expired');
});

test('employee DELETE uses module terminalization while preserving generic expiry behavior', { skip: !canRun }, async () => {
  assert.ok(client && app);
  const workIntentId = await insertWorkIntent(DELETE_EMPLOYEE_ID, 'delete');
  const privateValue = `delete-private-${suffix}@example.test`;
  const rawKey = `delete-raw-key-${suffix}`;
  const moduleAction = await insertPendingAction({
    employeeId: DELETE_EMPLOYEE_ID,
    shadowUserId: DELETE_SHADOW_ID,
    action: 'module_record_create',
    params: {
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      data: { name: 'Delete Private', email: privateValue },
      expected_manifest_digest: `sha256:${'b'.repeat(64)}`,
      idempotency_key: rawKey,
      work_intent_id: workIntentId,
    },
  });
  const genericAction = await insertPendingAction({
    employeeId: DELETE_EMPLOYEE_ID,
    shadowUserId: DELETE_SHADOW_ID,
    action: 'task_create',
    params: { title: 'legacy generic params remain unchanged' },
  });

  const response = await app.request(`/api/agent-employees/${DELETE_EMPLOYEE_ID}`, {
    method: 'DELETE',
  });
  assert.equal(response.status, 200);

  const rows = await client.query(
    `SELECT id, approval_status, params, error, executed_at
       FROM agent_actions WHERE id = ANY($1::text[])`,
    [[moduleAction.id, genericAction.id]],
  );
  const terminal = rows.rows.find((row) => row.id === moduleAction.id);
  const generic = rows.rows.find((row) => row.id === genericAction.id);
  assert.equal(terminal.approval_status, 'expired');
  assert.equal(terminal.error, 'Agent employee removed');
  assert.ok(terminal.executed_at);
  assert.equal('data' in terminal.params, false);
  assert.equal('idempotency_key' in terminal.params, false);
  assert.match(terminal.params.idempotency_digest, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(terminal.params), new RegExp(`${privateValue}|${rawKey}`));

  assert.equal(generic.approval_status, 'expired');
  assert.equal(generic.executed_at, null);
  assert.equal(generic.error, null);
  assert.equal(generic.params.title, 'legacy generic params remain unchanged');

  const receipt = await client.query(
    `SELECT * FROM action_receipts WHERE action_id = $1 AND decision = 'expired'`,
    [moduleAction.id],
  );
  assert.equal(receipt.rows.length, 1);
  assert.equal(await verifyReceipt(receipt.rows[0]), true);
  const genericReceipt = await client.query(
    'SELECT count(*)::int AS count FROM action_receipts WHERE action_id = $1',
    [genericAction.id],
  );
  assert.equal(genericReceipt.rows[0].count, 0);

  const attention = await client.query(
    `SELECT state, resolution FROM attention_items
      WHERE org_id = $1 AND source_type = 'agent_action' AND source_id = $2`,
    [ORG_ID, moduleAction.id],
  );
  assert.equal(attention.rows[0].state, 'resolved');
  assert.equal(attention.rows[0].resolution, 'employee_removed');
  const intent = await client.query(
    'SELECT status, failure_reason FROM work_intents WHERE id = $1',
    [workIntentId],
  );
  assert.equal(intent.rows[0].status, 'expired');
  assert.equal(intent.rows[0].failure_reason, 'Agent employee removed');
});
