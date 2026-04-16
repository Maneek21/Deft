/**
 * Phase 4 Task 4.6 — JIT skill install tests.
 *
 * Covers ensureSkillInstalled() across all five rule branches:
 *   1. bundled → auto-installs, merges capability_packs, no reprovision for
 *      native employees.
 *   2. org → auto-installs (no capability packs → no reprovision signal).
 *   3. marketplace → returns requires_approval, never touches the junction.
 *   4. already-installed → idempotent short-circuit.
 *   5. openclaw + connected + new capability_packs → flips connection_status
 *      to 'pending' and enqueues deploy-provision (mode:'update').
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/skill-install.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ensureSkillInstalled } from '../src/lib/skill-install.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const TEST_USER_ID = 'test-phase46-skill-install-user';
const NATIVE_EMP_ID = 'test-phase46-skill-install-native';
const OPENCLAW_EMP_ID = 'test-phase46-skill-install-openclaw';

const BUNDLED_SKILL_ID = 'test-phase46-skill-bundled';
const BUNDLED_PACK_SKILL_ID = 'test-phase46-skill-bundled-pack';
const ORG_SKILL_ID = 'test-phase46-skill-org';
const MARKETPLACE_SKILL_ID = 'test-phase46-skill-marketplace';

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
    // Shadow user (is_agent=true) shared by test employees
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, 'phase46-skill-install@test.local', 'Phase4.6 Skill Install User'],
    );

    // Native-kind employee
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         kind, connection_status, is_active, created_by, capability_packs)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'native test', 'standard',
         'native', 'connected', true, $3, NULL)
       ON CONFLICT (id) DO UPDATE SET
         kind = 'native',
         connection_status = 'connected',
         is_active = true,
         capability_packs = NULL,
         daily_action_count = 0`,
      [NATIVE_EMP_ID, ORG_ID, TEST_USER_ID, 'Phase4.6 Native', 'phase46-native'],
    );

    // OpenClaw-kind connected employee
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         kind, connection_status, is_active, created_by, capability_packs,
         connection_url)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'openclaw test', 'standard',
         'openclaw', 'connected', true, $3, NULL, 'http://127.0.0.1:19996/p46')
       ON CONFLICT (id) DO UPDATE SET
         kind = 'openclaw',
         connection_status = 'connected',
         is_active = true,
         capability_packs = NULL,
         daily_action_count = 0`,
      [OPENCLAW_EMP_ID, ORG_ID, TEST_USER_ID, 'Phase4.6 OpenClaw', 'phase46-openclaw'],
    );

    // Bundled skill (no capability packs → isolates the junction insert path)
    await c.query(
      `INSERT INTO skills
        (id, org_id, name, description, slug, source, version, agent_config,
         project_config, is_deleted)
       VALUES ($1, NULL, $2, $3, $4, 'bundled', '1.0.0', '{}'::jsonb,
         '{}'::jsonb, false)
       ON CONFLICT (id) DO NOTHING`,
      [
        BUNDLED_SKILL_ID,
        'Phase4.6 Bundled Skill',
        'JIT install bundled test skill',
        'phase46-bundled',
      ],
    );

    // Bundled skill WITH capability packs → drives the openclaw reprovision
    // path.
    await c.query(
      `INSERT INTO skills
        (id, org_id, name, description, slug, source, version, agent_config,
         project_config, is_deleted)
       VALUES ($1, NULL, $2, $3, $4, 'bundled', '2.0.0',
         '{"capability_packs":["phase46-test-pack"]}'::jsonb,
         '{}'::jsonb, false)
       ON CONFLICT (id) DO NOTHING`,
      [
        BUNDLED_PACK_SKILL_ID,
        'Phase4.6 Bundled Pack Skill',
        'Bundled skill that ships a capability pack',
        'phase46-bundled-pack',
      ],
    );

    // Org skill
    await c.query(
      `INSERT INTO skills
        (id, org_id, name, description, slug, source, version, agent_config,
         project_config, is_deleted)
       VALUES ($1, $2, $3, $4, $5, 'org', '1.2.3', '{}'::jsonb,
         '{}'::jsonb, false)
       ON CONFLICT (id) DO NOTHING`,
      [
        ORG_SKILL_ID,
        ORG_ID,
        'Phase4.6 Org Skill',
        'JIT install org-authored test skill',
        'phase46-org',
      ],
    );

    // Marketplace skill
    await c.query(
      `INSERT INTO skills
        (id, org_id, name, description, slug, source, version, agent_config,
         project_config, is_deleted)
       VALUES ($1, NULL, $2, $3, $4, 'marketplace', '3.0.0', '{}'::jsonb,
         '{}'::jsonb, false)
       ON CONFLICT (id) DO NOTHING`,
      [
        MARKETPLACE_SKILL_ID,
        'Phase4.6 Marketplace Skill',
        'JIT install marketplace test skill',
        'phase46-marketplace',
      ],
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    const empIds = [NATIVE_EMP_ID, OPENCLAW_EMP_ID];
    const skillIds = [
      BUNDLED_SKILL_ID,
      BUNDLED_PACK_SKILL_ID,
      ORG_SKILL_ID,
      MARKETPLACE_SKILL_ID,
    ];

    await c.query(
      `DELETE FROM agent_employee_skills WHERE agent_employee_id = ANY($1::text[])`,
      [empIds],
    );
    // Scrub any deploy-provision jobs this test enqueued.
    await c.query(
      `DELETE FROM job_queue
       WHERE name = 'deploy-provision'
         AND (data->>'employee_id') = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(
      `DELETE FROM skills WHERE id = ANY($1::text[])`,
      [skillIds],
    );
    await c.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
  });
}

before(async () => {
  await seedFixtures();
});

after(async () => {
  await teardownFixtures();
});

test('bundled skill auto-installs and writes junction row', async () => {
  // Fresh slate for the native employee.
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM agent_employee_skills WHERE agent_employee_id = $1`,
      [NATIVE_EMP_ID],
    );
  });

  const r = await ensureSkillInstalled(NATIVE_EMP_ID, BUNDLED_SKILL_ID);
  assert.equal(r.status, 'installed');
  if (r.status === 'installed') {
    assert.equal(r.requires_reprovision, false);
  }

  await withClient(async (c) => {
    const res = await c.query<{ installed_version: string }>(
      `SELECT installed_version FROM agent_employee_skills
       WHERE agent_employee_id = $1 AND skill_id = $2`,
      [NATIVE_EMP_ID, BUNDLED_SKILL_ID],
    );
    assert.equal(res.rows.length, 1, 'junction row must exist');
    assert.equal(res.rows[0]!.installed_version, '1.0.0');
  });
});

test('org skill auto-installs with source=org', async () => {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM agent_employee_skills
       WHERE agent_employee_id = $1 AND skill_id = $2`,
      [NATIVE_EMP_ID, ORG_SKILL_ID],
    );
  });

  const r = await ensureSkillInstalled(NATIVE_EMP_ID, ORG_SKILL_ID);
  assert.equal(r.status, 'installed');
  if (r.status === 'installed') {
    assert.equal(r.requires_reprovision, false);
  }

  await withClient(async (c) => {
    const res = await c.query<{ installed_version: string }>(
      `SELECT installed_version FROM agent_employee_skills
       WHERE agent_employee_id = $1 AND skill_id = $2`,
      [NATIVE_EMP_ID, ORG_SKILL_ID],
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0]!.installed_version, '1.2.3');
  });
});

test('marketplace skill requires approval and never mutates junction', async () => {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM agent_employee_skills
       WHERE agent_employee_id = $1 AND skill_id = $2`,
      [NATIVE_EMP_ID, MARKETPLACE_SKILL_ID],
    );
  });

  const r = await ensureSkillInstalled(NATIVE_EMP_ID, MARKETPLACE_SKILL_ID);
  assert.equal(r.status, 'requires_approval');
  if (r.status === 'requires_approval') {
    assert.equal(r.skill.source, 'marketplace');
    assert.equal(r.skill.id, MARKETPLACE_SKILL_ID);
    assert.equal(r.skill.name, 'Phase4.6 Marketplace Skill');
  }

  await withClient(async (c) => {
    const res = await c.query(
      `SELECT 1 FROM agent_employee_skills
       WHERE agent_employee_id = $1 AND skill_id = $2`,
      [NATIVE_EMP_ID, MARKETPLACE_SKILL_ID],
    );
    assert.equal(
      res.rows.length,
      0,
      'marketplace must NOT create a junction row',
    );
  });
});

test('already-installed short-circuits with status=already_installed', async () => {
  // Ensure the bundled skill is installed, then call again.
  await ensureSkillInstalled(NATIVE_EMP_ID, BUNDLED_SKILL_ID);
  const second = await ensureSkillInstalled(NATIVE_EMP_ID, BUNDLED_SKILL_ID);
  assert.equal(second.status, 'already_installed');

  await withClient(async (c) => {
    const res = await c.query(
      `SELECT count(*)::int as n FROM agent_employee_skills
       WHERE agent_employee_id = $1 AND skill_id = $2`,
      [NATIVE_EMP_ID, BUNDLED_SKILL_ID],
    );
    assert.equal(res.rows[0]!.n, 1, 'junction must still have exactly one row');
  });
});

test('connected openclaw employee with pack delta flips to pending + enqueues deploy-provision', async () => {
  // Reset the openclaw employee to a clean connected/no-packs baseline.
  await withClient(async (c) => {
    await c.query(
      `UPDATE agent_employees
         SET connection_status = 'connected',
             capability_packs = NULL
       WHERE id = $1`,
      [OPENCLAW_EMP_ID],
    );
    await c.query(
      `DELETE FROM agent_employee_skills WHERE agent_employee_id = $1`,
      [OPENCLAW_EMP_ID],
    );
    await c.query(
      `DELETE FROM job_queue
       WHERE name = 'deploy-provision'
         AND (data->>'employee_id') = $1`,
      [OPENCLAW_EMP_ID],
    );
  });

  const r = await ensureSkillInstalled(OPENCLAW_EMP_ID, BUNDLED_PACK_SKILL_ID);
  assert.equal(r.status, 'installed');
  if (r.status === 'installed') {
    assert.equal(r.requires_reprovision, true);
  }

  await withClient(async (c) => {
    // capability_packs merged
    const empRes = await c.query<{
      capability_packs: string[] | null;
      connection_status: string;
    }>(
      `SELECT capability_packs, connection_status FROM agent_employees WHERE id = $1`,
      [OPENCLAW_EMP_ID],
    );
    assert.deepEqual(empRes.rows[0]!.capability_packs, ['phase46-test-pack']);
    assert.equal(empRes.rows[0]!.connection_status, 'pending');

    // deploy-provision job enqueued with mode=update
    const jobRes = await c.query<{ data: { employee_id: string; mode: string } }>(
      `SELECT data FROM job_queue
       WHERE name = 'deploy-provision'
         AND (data->>'employee_id') = $1`,
      [OPENCLAW_EMP_ID],
    );
    assert.equal(jobRes.rows.length, 1, 'exactly one deploy-provision job');
    assert.equal(jobRes.rows[0]!.data.mode, 'update');
    assert.equal(jobRes.rows[0]!.data.employee_id, OPENCLAW_EMP_ID);
  });
});
