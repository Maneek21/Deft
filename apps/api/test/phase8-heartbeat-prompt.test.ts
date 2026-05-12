/**
 * Task 8.2 — `buildHeartbeatPrompt` composition tests.
 *
 * Covers:
 *   1. Skill checklist items are unioned with the employee overrides.
 *   2. Dedup is case-insensitive + whitespace-insensitive.
 *   3. A fresh employee with no skills + no overrides falls back to the
 *      default checklist (never emits an empty prompt).
 *   4. `prompt_sha` excludes timestamps — two consecutive builds for the
 *      same employee hash identically.
 *
 * Run: node --test --import tsx test/phase8-heartbeat-prompt.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function seedEmployee(opts: {
  withOverrides?: string[];
  skillChecklists?: string[][];
}): Promise<{ employeeId: string; orgId: string; userId: string; skillIds: string[] }> {
  const orgId = crypto.randomUUID();
  const userId = `phase8-prompt-user-${crypto.randomUUID()}`;
  const employeeId = `phase8-prompt-emp-${crypto.randomUUID()}`;
  const skillIds: string[] = [];

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Phase 8 Prompt Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.local`],
    );

    const overridesJson = opts.withOverrides
      ? JSON.stringify({ checklist: opts.withOverrides })
      : null;

    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          is_byoa, is_active, heartbeat_enabled,
          heartbeat_interval_min, max_daily_actions, daily_action_count,
          heartbeat_overrides, created_by)
       VALUES
         ($1, $2, $3, 'Phase 8 Prompt', $4, 'project_manager', 'test',
          'standard', true, true, true, 30, 50, 0,
          $5::jsonb, $3)`,
      [
        employeeId,
        orgId,
        userId,
        `slug-${employeeId}`,
        overridesJson,
      ],
    );

    if (opts.skillChecklists && opts.skillChecklists.length > 0) {
      for (let i = 0; i < opts.skillChecklists.length; i++) {
        const skillId = `phase8-prompt-skill-${crypto.randomUUID()}`;
        const cfg = { heartbeat_checklist: opts.skillChecklists[i] };
        await c.query(
          `INSERT INTO skills (id, slug, name, description, version, source,
                                author_user_id, agent_config)
           VALUES ($1, $2, 'Phase 8 Prompt Skill', 'test skill', '0.1.0',
                   'org', $3, $4::jsonb)`,
          [skillId, `phase8-prompt-skill-${i}-${crypto.randomUUID()}`, userId, JSON.stringify(cfg)],
        );
        skillIds.push(skillId);

        await c.query(
          `INSERT INTO agent_employee_skills
             (agent_employee_id, skill_id, installed_version)
           VALUES ($1, $2, '0.1.0')
           ON CONFLICT DO NOTHING`,
          [employeeId, skillId],
        );
      }
    }
  });

  return { employeeId, orgId, userId, skillIds };
}

async function cleanup(fx: {
  employeeId: string;
  userId: string;
  skillIds: string[];
}): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM agent_employee_skills WHERE agent_employee_id = $1`,
      [fx.employeeId],
    );
    if (fx.skillIds.length > 0) {
      await c.query(`DELETE FROM skills WHERE id = ANY($1::text[])`, [fx.skillIds]);
    }
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [fx.employeeId]);
    await c.query(`DELETE FROM users WHERE id = $1`, [fx.userId]);
  });
}

test('buildHeartbeatPrompt unions skill + override checklists and dedups whitespace/case', async () => {
  const fx = await seedEmployee({
    withOverrides: ['Review open tasks', '  review OPEN tasks  ', 'Check PRs'],
    skillChecklists: [['Review open tasks'], ['Summarize yesterday']],
  });
  try {
    const { buildHeartbeatPrompt } = await import('../src/lib/heartbeat-prompt.js');
    const out = await buildHeartbeatPrompt(fx.employeeId);

    // Expected (order preserved: skills first, then overrides, dedup wins):
    // Review open tasks, Summarize yesterday, Check PRs
    assert.ok(out.checklist.length === 3, `expected 3 items, got ${JSON.stringify(out.checklist)}`);
    assert.equal(out.checklist[0], 'Review open tasks');
    assert.equal(out.checklist[1], 'Summarize yesterday');
    assert.equal(out.checklist[2], 'Check PRs');
    assert.ok(out.prompt.includes('## Checklist'));
    assert.ok(out.prompt.includes('Review open tasks'));
    assert.ok(out.prompt.includes('HEARTBEAT_OK'));
    assert.equal(typeof out.prompt_sha, 'string');
    assert.equal(out.prompt_sha.length, 64);
  } finally {
    await cleanup(fx);
  }
});

test('buildHeartbeatPrompt falls back to the default checklist when nothing else is configured', async () => {
  const fx = await seedEmployee({});
  try {
    const { buildHeartbeatPrompt } = await import('../src/lib/heartbeat-prompt.js');
    const out = await buildHeartbeatPrompt(fx.employeeId);
    assert.ok(out.checklist.length > 0);
    assert.ok(out.prompt.includes('## Checklist'));
    assert.ok(out.prompt.length > 100);
  } finally {
    await cleanup(fx);
  }
});

test('buildHeartbeatPrompt returns a stable prompt_sha across back-to-back calls', async () => {
  const fx = await seedEmployee({
    withOverrides: ['Review open tasks', 'Check PRs'],
  });
  try {
    const { buildHeartbeatPrompt } = await import('../src/lib/heartbeat-prompt.js');
    const a = await buildHeartbeatPrompt(fx.employeeId);
    const b = await buildHeartbeatPrompt(fx.employeeId);
    assert.equal(a.prompt_sha, b.prompt_sha);
  } finally {
    await cleanup(fx);
  }
});
