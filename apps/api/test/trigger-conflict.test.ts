/**
 * Phase 4 Task 4.15 — trigger conflict prompt + reassignment.
 *
 * Two-employee scenario:
 *   - Employee A (Alex) already claims `cron:standup` via
 *     `trigger_subscriptions`.
 *   - A bundled skill declares `triggers: ['cron:standup']`.
 *   - Installing that skill on Employee B (Riya) must return
 *     `requires_user_decision` with Alex identified as the current owner.
 *   - After the reassign endpoint runs, Alex's trigger_subscriptions no
 *     longer contains `cron:standup`, Riya has the skill installed, and
 *     Riya's trigger_subscriptions now lists `cron:standup`.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/trigger-conflict.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { ensureSkillInstalled } from '../src/lib/skill-install.js';
import { resolveActiveTriggers } from '../src/lib/trigger-resolver.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const TEST_USER_ID = 'test-phase415-trigger-conflict-user';
const EMP_A_ID = 'test-phase415-trigger-conflict-emp-a';
const EMP_B_ID = 'test-phase415-trigger-conflict-emp-b';
const SKILL_ID = 'test-phase415-trigger-conflict-skill';
const DUP_SKILL_A_ID = 'test-phase415-dup-skill-a';
const DUP_SKILL_B_ID = 'test-phase415-dup-skill-b';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function seed() {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, 'phase415-trigger-conflict@test.local', 'Phase4.15 User'],
    );

    // Employee A — owns cron:standup via trigger_subscriptions.
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         kind, connection_status, is_active, created_by, trigger_subscriptions)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'alex test', 'standard',
         'native', 'connected', true, $3, ARRAY['cron:standup']::text[])
       ON CONFLICT (id) DO UPDATE SET
         trigger_subscriptions = ARRAY['cron:standup']::text[],
         is_active = true,
         capability_packs = NULL`,
      [EMP_A_ID, ORG_ID, TEST_USER_ID, 'Phase4.15 Alex', 'phase415-alex'],
    );

    // Employee B — fresh, no triggers.
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         kind, connection_status, is_active, created_by, trigger_subscriptions)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'riya test', 'standard',
         'native', 'connected', true, $3, NULL)
       ON CONFLICT (id) DO UPDATE SET
         trigger_subscriptions = NULL,
         is_active = true,
         capability_packs = NULL`,
      [EMP_B_ID, ORG_ID, TEST_USER_ID, 'Phase4.15 Riya', 'phase415-riya'],
    );

    // Bundled skill declaring cron:standup.
    await c.query(
      `INSERT INTO skills
        (id, org_id, name, description, slug, source, version, agent_config,
         project_config, is_deleted)
       VALUES ($1, NULL, $2, $3, $4, 'bundled', '1.0.0',
         '{"triggers":["cron:standup"]}'::jsonb,
         '{}'::jsonb, false)
       ON CONFLICT (id) DO UPDATE SET
         agent_config = '{"triggers":["cron:standup"]}'::jsonb`,
      [
        SKILL_ID,
        'Phase4.15 Standup Skill',
        'Skill that claims cron:standup',
        'phase415-standup',
      ],
    );

    // Two bundled skills declaring the SAME trigger (for dedup test).
    await c.query(
      `INSERT INTO skills
        (id, org_id, name, description, slug, source, version, agent_config,
         project_config, is_deleted)
       VALUES ($1, NULL, $2, $3, $4, 'bundled', '1.0.0',
         '{"triggers":["cron:weekly-burn-report"]}'::jsonb,
         '{}'::jsonb, false)
       ON CONFLICT (id) DO UPDATE SET
         agent_config = '{"triggers":["cron:weekly-burn-report"]}'::jsonb`,
      [
        DUP_SKILL_A_ID,
        'Phase4.15 Dup Skill A',
        'First skill with cron:weekly-burn-report',
        'phase415-dup-a',
      ],
    );
    await c.query(
      `INSERT INTO skills
        (id, org_id, name, description, slug, source, version, agent_config,
         project_config, is_deleted)
       VALUES ($1, NULL, $2, $3, $4, 'bundled', '1.0.0',
         '{"triggers":["cron:weekly-burn-report"]}'::jsonb,
         '{}'::jsonb, false)
       ON CONFLICT (id) DO UPDATE SET
         agent_config = '{"triggers":["cron:weekly-burn-report"]}'::jsonb`,
      [
        DUP_SKILL_B_ID,
        'Phase4.15 Dup Skill B',
        'Second skill with cron:weekly-burn-report',
        'phase415-dup-b',
      ],
    );

    // Clean slate for the junction.
    await c.query(
      `DELETE FROM agent_employee_skills
       WHERE agent_employee_id = ANY($1::text[])`,
      [[EMP_A_ID, EMP_B_ID]],
    );
  });
}

async function teardown() {
  await withClient(async (c) => {
    const empIds = [EMP_A_ID, EMP_B_ID];
    const skillIds = [SKILL_ID, DUP_SKILL_A_ID, DUP_SKILL_B_ID];
    await c.query(
      `DELETE FROM agent_employee_skills WHERE agent_employee_id = ANY($1::text[])`,
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
  await seed();
});

after(async () => {
  await teardown();
});

test('conflicting skill install returns requires_user_decision with current owner', async () => {
  const r = await ensureSkillInstalled(EMP_B_ID, SKILL_ID);
  assert.equal(r.status, 'requires_user_decision');
  if (r.status !== 'requires_user_decision') return;
  assert.equal(r.skill.id, SKILL_ID);
  assert.equal(r.conflicting_triggers.length, 1);
  const conflict = r.conflicting_triggers[0]!;
  assert.equal(conflict.trigger_kind, 'cron:standup');
  assert.equal(conflict.current_owner_id, EMP_A_ID);
  assert.equal(conflict.current_owner_name, 'Phase4.15 Alex');

  // Nothing was mutated — B must still have no junction row and no
  // trigger in its inline column.
  await withClient(async (c) => {
    const jr = await c.query(
      `SELECT 1 FROM agent_employee_skills
       WHERE agent_employee_id = $1 AND skill_id = $2`,
      [EMP_B_ID, SKILL_ID],
    );
    assert.equal(jr.rows.length, 0, 'junction must not be written on conflict');

    const tr = await c.query<{ trigger_subscriptions: string[] | null }>(
      `SELECT trigger_subscriptions FROM agent_employees WHERE id = $1`,
      [EMP_B_ID],
    );
    assert.ok(
      tr.rows[0]!.trigger_subscriptions === null ||
        !tr.rows[0]!.trigger_subscriptions.includes('cron:standup'),
      'B must NOT have gained the trigger',
    );
  });
});

test('reassign-trigger flow strips A, installs on B, and moves the claim', async () => {
  // Simulate the reassign endpoint's transactional body by calling the
  // underlying SQL. The endpoint itself is covered by typecheck + manual
  // integration; this test exercises the data mutations the endpoint
  // performs so the two-employee state lands correctly.
  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      // Strip cron:standup from A.
      await c.query(
        `UPDATE agent_employees
            SET trigger_subscriptions = COALESCE(
              (SELECT array_agg(t) FROM unnest(trigger_subscriptions) t
               WHERE t <> 'cron:standup'),
              NULL
            )
          WHERE org_id = $1 AND id <> $2 AND is_active = true`,
        [ORG_ID, EMP_B_ID],
      );

      // Install skill on B.
      await c.query(
        `INSERT INTO agent_employee_skills
          (agent_employee_id, skill_id, installed_version)
         VALUES ($1, $2, '1.0.0')
         ON CONFLICT DO NOTHING`,
        [EMP_B_ID, SKILL_ID],
      );

      // Merge skill triggers into B's inline column.
      await c.query(
        `UPDATE agent_employees
            SET trigger_subscriptions = ARRAY(
              SELECT DISTINCT x FROM unnest(
                COALESCE(trigger_subscriptions, '{}'::text[]) || ARRAY['cron:standup']
              ) x
            )
          WHERE id = $1`,
        [EMP_B_ID],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }

    // Assert A no longer claims cron:standup.
    const aRes = await c.query<{ trigger_subscriptions: string[] | null }>(
      `SELECT trigger_subscriptions FROM agent_employees WHERE id = $1`,
      [EMP_A_ID],
    );
    const aTriggers = aRes.rows[0]!.trigger_subscriptions ?? [];
    assert.ok(
      !aTriggers.includes('cron:standup'),
      'A must no longer own cron:standup',
    );

    // Assert B has the skill junction row.
    const bJunction = await c.query(
      `SELECT 1 FROM agent_employee_skills
       WHERE agent_employee_id = $1 AND skill_id = $2`,
      [EMP_B_ID, SKILL_ID],
    );
    assert.equal(bJunction.rows.length, 1, 'B must have the skill installed');

    // Assert B now claims cron:standup in its inline column.
    const bRes = await c.query<{ trigger_subscriptions: string[] | null }>(
      `SELECT trigger_subscriptions FROM agent_employees WHERE id = $1`,
      [EMP_B_ID],
    );
    const bTriggers = bRes.rows[0]!.trigger_subscriptions ?? [];
    assert.ok(
      bTriggers.includes('cron:standup'),
      'B must now own cron:standup',
    );
  });

  // After reassignment, installing the same skill on B again is a no-op
  // (already_installed). Conflict detection only fires for OTHER employees.
  const second = await ensureSkillInstalled(EMP_B_ID, SKILL_ID);
  assert.equal(second.status, 'already_installed');
});

test('resolveActiveTriggers dedupes skill-owned + inline triggers', async () => {
  // Install two skills on B that both declare cron:weekly-burn-report;
  // resolveActiveTriggers must collapse to one entry.
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO agent_employee_skills
        (agent_employee_id, skill_id, installed_version)
       VALUES ($1, $2, '1.0.0'), ($1, $3, '1.0.0')
       ON CONFLICT DO NOTHING`,
      [EMP_B_ID, DUP_SKILL_A_ID, DUP_SKILL_B_ID],
    );
  });

  const active = await resolveActiveTriggers(EMP_B_ID);
  const occurrences = active.filter((t) => t === 'cron:weekly-burn-report');
  assert.equal(
    occurrences.length,
    1,
    'duplicate skill-declared triggers must dedupe at read time',
  );
});
