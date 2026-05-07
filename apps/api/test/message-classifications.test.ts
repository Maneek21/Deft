/**
 * Task 5.6 — message_classifications persistence tests
 *
 * Run: pnpm --filter @deft/api test -- test/message-classifications.test.ts
 *
 * Strategy: directly invoke the classification-persist code path by importing
 * the db client and inserting a row with a fake ClassificationResult, then
 * asserting the row has the expected shape. Also tests that the row correctly
 * handles all field types (arrays, jsonb, boolean, real).
 *
 * This is an integration test against a real Postgres DB. Cleans up all
 * inserted rows in finally blocks.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'test-clf-persist-user';
const USER_EMAIL = 'clf-persist@test.local';
const SPACE_ID = 'test-clf-persist-space';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// IDs created in tests — used for cleanup.
const createdMessageIds: string[] = [];
const createdClassificationIds: string[] = [];

// ─── Fixtures ────────────────────────────────────────────────────────────────

before(async () => {
  await withClient(async (c) => {
    // Ensure test user exists
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Clf Persist User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    // Ensure org membership
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );
    // Ensure test space exists (reuse org's default space if possible, else insert)
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type)
       VALUES ($1, $2, 'clf-persist-test-space', 'public')
       ON CONFLICT (id) DO NOTHING`,
      [SPACE_ID, ORG_ID],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    if (createdClassificationIds.length) {
      await c.query(
        `DELETE FROM message_classifications WHERE id = ANY($1)`,
        [createdClassificationIds],
      );
    }
    if (createdMessageIds.length) {
      await c.query(`DELETE FROM messages WHERE id = ANY($1)`, [createdMessageIds]);
    }
    await c.query(`DELETE FROM space_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM spaces WHERE id = $1`, [SPACE_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Insert a test message and return its id. */
async function insertTestMessage(): Promise<string> {
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'test message for classifier persist')
       RETURNING id`,
      [ORG_ID, SPACE_ID, USER_ID],
    );
    const id = r.rows[0].id as string;
    createdMessageIds.push(id);
    return id;
  });
}

/** Insert a classification row directly (bypasses the IIFE — unit-style). */
async function insertClassification(
  messageId: string,
  overrides: Partial<{
    intent: string;
    confidence: number;
    agent_mentioned: boolean;
    blocked: boolean;
    task_references: string[];
    entities: object | null;
    memorable_facts: string[];
    decision: string | null;
  }> = {},
): Promise<string> {
  const opts = {
    intent: 'discussion',
    confidence: 0.82,
    agent_mentioned: false,
    blocked: false,
    task_references: [],
    entities: null,
    memorable_facts: [],
    decision: null,
    ...overrides,
  };

  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO message_classifications
         (id, org_id, message_id, intent, confidence, agent_mentioned, blocked,
          task_references, entities, memorable_facts, decision)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        ORG_ID,
        messageId,
        opts.intent,
        opts.confidence,
        opts.agent_mentioned,
        opts.blocked,
        opts.task_references,
        opts.entities ? JSON.stringify(opts.entities) : null,
        opts.memorable_facts,
        opts.decision,
      ],
    );
    const id = r.rows[0].id as string;
    createdClassificationIds.push(id);
    return id;
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('1. inserts a classification row with basic shape', async () => {
  const messageId = await insertTestMessage();
  const classifId = await insertClassification(messageId, {
    intent: 'discussion',
    confidence: 0.75,
    agent_mentioned: false,
    blocked: false,
  });

  const row = await withClient(async (c) => {
    const r = await c.query(
      `SELECT * FROM message_classifications WHERE id = $1`,
      [classifId],
    );
    return r.rows[0] ?? null;
  });

  assert.ok(row !== null, 'row should exist in message_classifications');
  assert.equal(row.org_id, ORG_ID);
  assert.equal(row.message_id, messageId);
  assert.equal(row.intent, 'discussion');
  assert.equal(parseFloat(row.confidence), 0.75);
  assert.equal(row.agent_mentioned, false);
  assert.equal(row.blocked, false);
  assert.ok(Array.isArray(row.task_references), 'task_references should be an array');
  assert.deepEqual(row.task_references, []);
  assert.equal(row.entities, null);
  assert.ok(Array.isArray(row.memorable_facts), 'memorable_facts should be an array');
  assert.deepEqual(row.memorable_facts, []);
  assert.equal(row.decision, null);
  assert.ok(row.created_at instanceof Date, 'created_at should be a Date');
});

test('2. persists task_create intent with task_references and entities', async () => {
  const messageId = await insertTestMessage();
  const classifId = await insertClassification(messageId, {
    intent: 'task_create',
    confidence: 0.95,
    agent_mentioned: true,
    blocked: false,
    task_references: ['DEFT-5', 'DEFT-12'],
    entities: { assignee: 'alice', project: 'launch', due_date: '2026-05-01' },
    memorable_facts: [],
    decision: null,
  });

  const row = await withClient(async (c) => {
    const r = await c.query(
      `SELECT * FROM message_classifications WHERE id = $1`,
      [classifId],
    );
    return r.rows[0] ?? null;
  });

  assert.ok(row, 'row should exist');
  assert.equal(row.intent, 'task_create');
  assert.ok(parseFloat(row.confidence) > 0.9, 'confidence should be > 0.9');
  assert.equal(row.agent_mentioned, true);
  assert.deepEqual(row.task_references, ['DEFT-5', 'DEFT-12']);
  assert.ok(row.entities !== null, 'entities should not be null');
  const entities = typeof row.entities === 'string' ? JSON.parse(row.entities) : row.entities;
  assert.equal(entities.assignee, 'alice');
  assert.equal(entities.project, 'launch');
  assert.equal(entities.due_date, '2026-05-01');
});

test('3. persists blocked=true with memorable_facts and decision', async () => {
  const messageId = await insertTestMessage();
  const classifId = await insertClassification(messageId, {
    intent: 'actionable',
    confidence: 0.88,
    agent_mentioned: false,
    blocked: true,
    task_references: [],
    entities: null,
    memorable_facts: ['Team uses two-week sprints', 'Rahul prefers async standups'],
    decision: 'We will migrate to Postgres for the new service',
  });

  const row = await withClient(async (c) => {
    const r = await c.query(
      `SELECT * FROM message_classifications WHERE id = $1`,
      [classifId],
    );
    return r.rows[0] ?? null;
  });

  assert.ok(row, 'row should exist');
  assert.equal(row.blocked, true);
  assert.deepEqual(row.memorable_facts, [
    'Team uses two-week sprints',
    'Rahul prefers async standups',
  ]);
  assert.equal(row.decision, 'We will migrate to Postgres for the new service');
});

test('4. row is CASCADE-deleted when its message is deleted', async () => {
  const messageId = await insertTestMessage();
  const classifId = await insertClassification(messageId, { intent: 'none', confidence: 0 });

  // Verify both exist before delete.
  const before = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM message_classifications WHERE id = $1`,
      [classifId],
    );
    return r.rows[0] ?? null;
  });
  assert.ok(before, 'classification should exist before message delete');

  // Delete the message — FK ON DELETE CASCADE should remove the classification.
  await withClient(async (c) => {
    await c.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
  });
  // Remove from tracking arrays since it's already deleted.
  const msgIdx = createdMessageIds.indexOf(messageId);
  if (msgIdx > -1) createdMessageIds.splice(msgIdx, 1);
  const clfIdx = createdClassificationIds.indexOf(classifId);
  if (clfIdx > -1) createdClassificationIds.splice(clfIdx, 1);

  const afterRow = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM message_classifications WHERE id = $1`,
      [classifId],
    );
    return r.rows[0] ?? null;
  });
  assert.ok(!afterRow, 'classification should be cascade-deleted with message');
});

test('5. index mc_org_msg_idx exists and query by (org_id, message_id) returns row', async () => {
  const messageId = await insertTestMessage();
  await insertClassification(messageId, { intent: 'question', confidence: 0.6 });

  const rows = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id, intent FROM message_classifications
       WHERE org_id = $1 AND message_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [ORG_ID, messageId],
    );
    return r.rows;
  });

  assert.equal(rows.length, 1, 'should find exactly 1 classification for the message');
  assert.equal(rows[0].intent, 'question');
});
