import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';

import { closeDb } from '../src/lib/db.js';
import {
  markWorkIntentConvertedForAction,
  markWorkIntentDismissedForAction,
  markWorkIntentFailedForAction,
  markWorkIntentsExpiredForActions,
} from '../src/lib/work-intents.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const TEST_DATABASE_URL = safeTestDatabaseUrl();
const canRun = Boolean(TEST_DATABASE_URL);
const suffix = randomUUID();
const ORG_ID = `wi-provenance-org-${suffix}`;
const OTHER_ORG_ID = `wi-provenance-other-org-${suffix}`;
const OWNER_ID = `wi-provenance-owner-${suffix}`;
const AGENT_USER_ID = `wi-provenance-agent-${suffix}`;

let client: pg.Client | null = null;
let intentCounter = 0;

async function insertIntent(orgId = ORG_ID): Promise<string> {
  assert.ok(client);
  intentCounter += 1;
  const result = await client.query(
    `INSERT INTO work_intents
       (id, org_id, source_user_id, kind, status, title, summary,
        proposed_action, proposed_params, dedupe_key)
     VALUES (gen_random_uuid()::text, $1, $2, 'task_candidate', 'proposed',
       'Provenance intent', 'Provenance intent', 'task_create', '{}'::jsonb, $3)
     RETURNING id`,
    [orgId, OWNER_ID, `wi-provenance:${suffix}:${intentCounter}`],
  );
  return result.rows[0].id as string;
}

async function insertAction(input: {
  source: string;
  workIntentId: string;
  orgId?: string;
  storedParams?: Record<string, unknown>;
}): Promise<{ id: string; params: Record<string, unknown> }> {
  assert.ok(client);
  const params = { title: 'Provenance task', work_intent_id: input.workIntentId };
  const result = await client.query(
    `INSERT INTO agent_actions
       (id, org_id, user_id, source, action, params, approval_tier, approval_status)
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'task_create', $4::jsonb, 'quick', 'pending')
     RETURNING id`,
    [input.orgId ?? ORG_ID, AGENT_USER_ID, input.source, JSON.stringify(input.storedParams ?? params)],
  );
  return { id: result.rows[0].id as string, params };
}

async function intentRow(id: string) {
  assert.ok(client);
  const result = await client.query(
    `SELECT status, converted_action_id, converted_task_id, converted_by, converted_at,
            dismissed_by, dismissed_at, failure_reason, metadata
       FROM work_intents WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

/** Every intent field the lifecycle helpers can write must stay as it was. */
async function assertIntentUnchanged(id: string, before: Record<string, unknown>) {
  assert.deepEqual(await intentRow(id), before);
  assert.equal(before.status, 'proposed');
}

type Helper = (action: { id: string; params: unknown }, orgId: string) => Promise<unknown>;

const helpers: Array<{ name: string; status: string; apply: Helper }> = [
  {
    name: 'converted',
    status: 'converted',
    apply: (action, orgId) => markWorkIntentConvertedForAction({
      actionId: action.id,
      orgId,
      actionParams: action.params,
      result: { task_id: null, slug: 'provenance-page', title: 'Provenance page', type: 'doc' },
      convertedBy: OWNER_ID,
    }),
  },
  {
    name: 'dismissed',
    status: 'dismissed',
    apply: (action, orgId) => markWorkIntentDismissedForAction({
      actionId: action.id,
      orgId,
      actionParams: action.params,
      dismissedBy: OWNER_ID,
      reason: 'not needed',
    }),
  },
  {
    name: 'failed',
    status: 'failed',
    apply: (action, orgId) => markWorkIntentFailedForAction({
      actionId: action.id,
      orgId,
      actionParams: action.params,
      reason: 'execution failed',
    }),
  },
  {
    name: 'expired',
    status: 'expired',
    apply: (action, orgId) => markWorkIntentsExpiredForActions({
      orgId,
      actions: [{ id: action.id, params: action.params }],
    }),
  },
];

before(async () => {
  if (!canRun || !TEST_DATABASE_URL) return;
  client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    `INSERT INTO orgs (id, name, slug)
     VALUES ($1, 'WorkIntent provenance', $2), ($3, 'WorkIntent provenance other', $4)`,
    [ORG_ID, `wi-prov-${suffix.slice(0, 12)}`, OTHER_ORG_ID, `wi-prov-other-${suffix.slice(0, 12)}`],
  );
  await client.query(
    `INSERT INTO users (id, email, name, is_agent)
     VALUES ($1, $2, 'Provenance Owner', false), ($3, $4, 'Provenance Agent', true)`,
    [OWNER_ID, `${OWNER_ID}@test.local`, AGENT_USER_ID, `${AGENT_USER_ID}@test.local`],
  );
});

after(async () => {
  if (client) {
    await client.query('DELETE FROM work_intents WHERE org_id = ANY($1::text[])', [[ORG_ID, OTHER_ORG_ID]]);
    await client.query('DELETE FROM agent_actions WHERE org_id = ANY($1::text[])', [[ORG_ID, OTHER_ORG_ID]]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[OWNER_ID, AGENT_USER_ID]]);
    await client.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [[ORG_ID, OTHER_ORG_ID]]);
    await client.end();
  }
  await closeDb();
});

for (const helper of helpers) {
  test(`work-intent ${helper.name} applies to the intent's own capture action`, { skip: !canRun }, async () => {
    const intentId = await insertIntent();
    const action = await insertAction({ source: 'defty_capture', workIntentId: intentId });
    await helper.apply(action, ORG_ID);
    const row = await intentRow(intentId);
    assert.equal(row.status, helper.status);
    assert.equal(row.converted_action_id, action.id);
  });

  test(`work-intent ${helper.name} leaves the intent unchanged for a non-capture action`, { skip: !canRun }, async () => {
    const intentId = await insertIntent();
    const before = await intentRow(intentId);
    for (const source of ['mcp', 'mcp_api', 'defty', 'agent_chat']) {
      const action = await insertAction({ source, workIntentId: intentId });
      await helper.apply(action, ORG_ID);
    }
    await assertIntentUnchanged(intentId, before);
  });

  test(`work-intent ${helper.name} leaves the intent unchanged for a non-capture action with scrubbed params`, { skip: !canRun }, async () => {
    const intentId = await insertIntent();
    const before = await intentRow(intentId);
    for (const storedParams of [{}, { changed_fields: ['email'] }]) {
      const action = await insertAction({ source: 'mcp', workIntentId: intentId, storedParams });
      await helper.apply(action, ORG_ID);
    }
    await assertIntentUnchanged(intentId, before);
  });

  test(`work-intent ${helper.name} leaves the intent unchanged for another intent's capture action`, { skip: !canRun }, async () => {
    const intentId = await insertIntent();
    const before = await intentRow(intentId);
    const otherIntentId = await insertIntent();
    const otherCapture = await insertAction({ source: 'defty_capture', workIntentId: otherIntentId });
    await helper.apply({ id: otherCapture.id, params: { work_intent_id: intentId } }, ORG_ID);
    await assertIntentUnchanged(intentId, before);
    assert.equal((await intentRow(otherIntentId)).status, 'proposed');
  });

  test(`work-intent ${helper.name} leaves the intent unchanged for a capture action in another org`, { skip: !canRun }, async () => {
    const intentId = await insertIntent();
    const before = await intentRow(intentId);
    const foreign = await insertAction({
      source: 'defty_capture',
      workIntentId: intentId,
      orgId: OTHER_ORG_ID,
    });
    await helper.apply(foreign, ORG_ID);
    await helper.apply(foreign, OTHER_ORG_ID);
    await assertIntentUnchanged(intentId, before);
  });
}

test('expiry batch expires the intent through its capture action regardless of order', { skip: !canRun }, async () => {
  const intentId = await insertIntent();
  const capture = await insertAction({ source: 'defty_capture', workIntentId: intentId });
  const other = await insertAction({ source: 'mcp', workIntentId: intentId });
  const count = await markWorkIntentsExpiredForActions({
    orgId: ORG_ID,
    actions: [
      { id: capture.id, params: capture.params },
      { id: other.id, params: other.params },
    ],
  });
  assert.equal(count, 1);
  const row = await intentRow(intentId);
  assert.equal(row.status, 'expired');
  assert.equal(row.converted_action_id, capture.id);
});

test('expiry skips entries without an action id', { skip: !canRun }, async () => {
  const intentId = await insertIntent();
  const count = await markWorkIntentsExpiredForActions({
    orgId: ORG_ID,
    actions: [{ id: null, params: { work_intent_id: intentId } }],
  });
  assert.equal(count, 0);
  assert.equal((await intentRow(intentId)).status, 'proposed');
});
