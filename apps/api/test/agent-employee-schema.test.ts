/**
 * Phase 2 schema smoke test — OpenClaw agent employee + sidecar tables.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/agent-employee-schema.test.ts
 *
 * Verifies:
 *   1. Alex PM seed row has kind='native'.
 *   2. New sidecar tables exist (agent_employee_templates, agent_session_turns, action_receipts, space_memory).
 *   3. wiki_pages has embedding pgvector column.
 *   4. A valid semver template row inserts cleanly.
 *   5. An invalid version ('banana') is rejected (via DB CHECK or Zod/regex).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { SEMVER_REGEX, isValidSemver } from '@deft/shared/schemas';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ALEX_PM_ID = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

test('Alex PM seed row has kind=native', async () => {
  await withClient(async (c) => {
    const r = await c.query(
      'SELECT id, kind FROM agent_employees WHERE id = $1',
      [ALEX_PM_ID]
    );
    assert.equal(r.rows.length, 1, 'Alex PM row must exist');
    assert.equal(r.rows[0].kind, 'native', 'Alex PM must be marked kind=native');
  });
});

test('all new sidecar tables exist', async () => {
  await withClient(async (c) => {
    const expected = [
      'agent_employee_templates',
      'agent_session_turns',
      'action_receipts',
      'space_memory',
    ];
    const r = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [expected]
    );
    const found = new Set(r.rows.map((row: { table_name: string }) => row.table_name));
    for (const t of expected) {
      assert.ok(found.has(t), `missing table ${t}`);
    }
  });
});

test('new agent_employees columns exist', async () => {
  await withClient(async (c) => {
    const expected = [
      'kind',
      'connection_url',
      'gateway_token_encrypted',
      'mcp_token_hash',
      'connection_status',
      'template_slug',
      'template_version',
      'trigger_subscriptions',
      'provider_hint',
    ];
    const r = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'agent_employees' AND column_name = ANY($1)`,
      [expected]
    );
    const found = new Set(r.rows.map((row: { column_name: string }) => row.column_name));
    for (const col of expected) {
      assert.ok(found.has(col), `missing agent_employees column ${col}`);
    }
  });
});

test('wiki_pages has pgvector embedding column', async (t) => {
  await withClient(async (c) => {
    const avail = await c.query(
      "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'"
    );
    if (avail.rows.length === 0) {
      // Local dev Postgres on Windows (native install) may not ship pgvector.
      // Migration 0011 is still shipped and will apply in docker + prod.
      t.skip('pgvector extension not available on this Postgres — see Phase 2 handoff notes');
      return;
    }
    const ext = await c.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector'"
    );
    assert.equal(ext.rows.length, 1, 'pgvector extension must be enabled');
    const col = await c.query(
      `SELECT data_type, udt_name FROM information_schema.columns
       WHERE table_name = 'wiki_pages' AND column_name = 'embedding'`
    );
    assert.equal(col.rows.length, 1, 'wiki_pages.embedding column must exist');
    assert.equal(col.rows[0].udt_name, 'vector', 'embedding column must use vector type');
  });
});

test('agent_action_log action_receipts has real FK to agent_actions', async () => {
  await withClient(async (c) => {
    const r = await c.query(`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = 'action_receipts'
        AND kcu.column_name = 'action_id'
        AND ccu.table_name = 'agent_actions'
    `);
    assert.ok(r.rows.length >= 1, 'action_receipts.action_id must FK to agent_actions.id');
  });
});

test('valid semver template inserts cleanly', async () => {
  assert.ok(isValidSemver('1.2.3'), 'shared isValidSemver must accept 1.2.3');
  assert.ok(SEMVER_REGEX.test('0.1.0'), 'SEMVER_REGEX must accept 0.1.0');

  await withClient(async (c) => {
    const slug = `smoke-test-template-${Date.now()}`;
    try {
      await c.query(
        `INSERT INTO agent_employee_templates
          (id, slug, name, version, role, description, soul_md, agents_md,
           user_md_template, tools_md, default_tools, default_trust_level,
           model_recommendation, source, is_public)
         VALUES (gen_random_uuid()::text,$1,$2,$3,'project_manager',$4,$5,$6,$7,$8,$9,'standard',$10,'first-party',true)`,
        [
          slug,
          'Smoke Test Template',
          '1.2.3',
          'Schema smoke test',
          '# SOUL',
          '# AGENTS',
          '# USER',
          '# TOOLS',
          ['create_task'],
          'anthropic/claude-opus-4-6',
        ]
      );
    } finally {
      await c.query('DELETE FROM agent_employee_templates WHERE slug = $1', [slug]);
    }
  });
});

test('invalid semver is rejected', async () => {
  assert.equal(isValidSemver('banana'), false, 'isValidSemver must reject banana');
  assert.equal(SEMVER_REGEX.test('banana'), false, 'SEMVER_REGEX must reject banana');

  await withClient(async (c) => {
    const slug = `smoke-test-invalid-${Date.now()}`;
    let threw = false;
    try {
      await c.query(
        `INSERT INTO agent_employee_templates
          (id, slug, name, version, role, description, soul_md, agents_md,
           user_md_template, tools_md, default_tools, default_trust_level,
           model_recommendation, source, is_public)
         VALUES (gen_random_uuid()::text,$1,$2,'banana','project_manager',$3,$4,$5,$6,$7,$8,'standard',$9,'first-party',true)`,
        [
          slug,
          'Invalid Version',
          'Should fail',
          '# SOUL',
          '# AGENTS',
          '# USER',
          '# TOOLS',
          ['create_task'],
          'anthropic/claude-opus-4-6',
        ]
      );
      // If insert succeeded we must clean up so the test is idempotent.
      await c.query('DELETE FROM agent_employee_templates WHERE slug = $1', [slug]);
    } catch (err) {
      threw = true;
    }
    assert.ok(threw, 'DB CHECK must reject version=banana');
  });
});
