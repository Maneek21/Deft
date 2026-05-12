/**
 * Task 3.1 — resolveAssignee canonical helper.
 *
 * Covers:
 *   1. Exact case-insensitive name match returns the user
 *   2. Partial ilike match returns the user when unique
 *   3. Agent-employee-only user (no org_members row) is resolvable
 *   4. Missing name returns null
 *   5. Ambiguous partial match returns null + console.warn
 *
 * Run: cd apps/api && node --test --import tsx test/resolve-assignee.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const U_ALICE = 'test-resolve-alice';
const U_ALICIA = 'test-resolve-alicia';
const U_AGENT_SHADOW = 'test-resolve-agent-shadow';
const AGENT_EMP_ID = 'test-resolve-agent-emp';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

before(async () => {
  await withClient(async (c) => {
    // Alice (exact + partial match target)
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Alice Smith', false)
       ON CONFLICT (id) DO NOTHING`,
      [U_ALICE, 'resolve-alice@test.local'],
    );
    // Alicia (for ambiguous "Ali" match)
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Alicia Jones', false)
       ON CONFLICT (id) DO NOTHING`,
      [U_ALICIA, 'resolve-alicia@test.local'],
    );
    // Shadow user for agent employee
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Pixel Agent', true)
       ON CONFLICT (id) DO NOTHING`,
      [U_AGENT_SHADOW, 'resolve-agent-shadow@test.local'],
    );

    // Add Alice + Alicia as members
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, U_ALICE],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, U_ALICIA],
    );

    // Agent employee row — shadow user is NOT in org_members; resolution
    // must still find it via the agent_employees branch.
    await c.query(
      `INSERT INTO agent_employees (
         id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         max_daily_actions, created_by, is_active, is_byoa
       ) VALUES ($1, $2, $3, 'Pixel Agent', 'pixel-resolve', 'project_manager',
                 'you are pixel', 'conservative', 50, $3, true, true)
       ON CONFLICT (id) DO NOTHING`,
      [AGENT_EMP_ID, ORG_ID, U_AGENT_SHADOW],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [AGENT_EMP_ID]);
    await c.query(`DELETE FROM org_members WHERE user_id IN ($1, $2)`, [U_ALICE, U_ALICIA]);
    await c.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [U_ALICE, U_ALICIA, U_AGENT_SHADOW]);
  });
});

test('exact case-insensitive name match resolves human user', async () => {
  const { resolveAssignee } = await import('../src/lib/resolve-assignee.js');
  const r = await resolveAssignee('alice smith', ORG_ID);
  assert.ok(r, 'expected a result');
  assert.equal(r!.id, U_ALICE);
  assert.equal(r!.kind, 'user');
  assert.equal(r!.is_agent, false);
});

test('partial ilike match resolves when unique', async () => {
  const { resolveAssignee } = await import('../src/lib/resolve-assignee.js');
  // "Smith" uniquely matches Alice
  const r = await resolveAssignee('Smith', ORG_ID);
  assert.ok(r);
  assert.equal(r!.id, U_ALICE);
});

test('agent-employee user (no org_members row) is resolvable', async () => {
  const { resolveAssignee } = await import('../src/lib/resolve-assignee.js');
  const r = await resolveAssignee('Pixel', ORG_ID);
  assert.ok(r, 'expected agent employee match');
  assert.equal(r!.id, U_AGENT_SHADOW);
  assert.equal(r!.kind, 'agent');
  assert.equal(r!.is_agent, true);
});

test('name not in org returns null', async () => {
  const { resolveAssignee } = await import('../src/lib/resolve-assignee.js');
  const r = await resolveAssignee('Nobody XYZ', ORG_ID);
  assert.equal(r, null);
});

test('ambiguous partial match returns null + warns', async () => {
  const { resolveAssignee } = await import('../src/lib/resolve-assignee.js');
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: any[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  try {
    // "Ali" matches Alice + Alicia
    const r = await resolveAssignee('Ali', ORG_ID);
    assert.equal(r, null);
    assert.ok(
      warnings.some((w) => w.includes('ambiguous')),
      `expected warn, got: ${warnings.join(' | ')}`,
    );
  } finally {
    console.warn = origWarn;
  }
});
