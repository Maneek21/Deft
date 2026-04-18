/**
 * Phase 4 Task 4.3 — Bundled skills seed verification.
 *
 * Asserts the 9 day-one bundled skills land correctly and the seeder is
 * idempotent. Coming-soon capability-pack slugs must NOT appear.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { seedBundledSkills } from '../src/scripts/seed-bundled-skills.js';
import { BUNDLED_SKILLS } from '../src/lib/bundled-skills.js';
import { CAPABILITY_PACKS } from '../src/lib/capability-packs.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

const EXPECTED_SLUGS = [
  // 6 capability-pack skills
  'deft-workspace',
  'web-browsing',
  'tavily',
  'github',
  'google-calendar',
  'shell-exec',
  // 3 project-workflow skills
  'engineering',
  'marketing-campaign',
  'sales-pipeline',
];

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
  // Run twice to exercise the ON CONFLICT path.
  await seedBundledSkills({ silent: true });
  await seedBundledSkills({ silent: true });
});

test('BUNDLED_SKILLS has exactly 9 definitions matching expected slugs', () => {
  assert.equal(BUNDLED_SKILLS.length, 9);
  const slugs = BUNDLED_SKILLS.map((s) => s.slug).sort();
  assert.deepEqual(slugs, [...EXPECTED_SLUGS].sort());
});

test('seed produces exactly 9 bundled rows', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ count: string }>(
      `SELECT count(*)::text FROM skills
       WHERE source = 'bundled' AND slug = ANY($1::text[]) AND is_deleted = false`,
      [EXPECTED_SLUGS],
    );
    assert.equal(res.rows[0]!.count, '9');
  });
});

test('bundled skills have org_id NULL', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ slug: string; org_id: string | null }>(
      `SELECT slug, org_id FROM skills
       WHERE source = 'bundled' AND slug = ANY($1::text[])`,
      [EXPECTED_SLUGS],
    );
    for (const row of res.rows) {
      assert.equal(row.org_id, null, `${row.slug} should have NULL org_id`);
    }
  });
});

// Task 14: engineering statuses test removed — project_config column dropped from skills table.
// Engineering defaults now hardcoded in project-resolved-config.ts (see engineering-defaults.test.ts).

test('engineering skill ships the 9 Phase-3 task tools', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ agent_config: unknown }>(
      `SELECT agent_config FROM skills
       WHERE source = 'bundled' AND slug = 'engineering'`,
    );
    const cfg = res.rows[0]!.agent_config as { tools?: string[] };
    assert.ok(Array.isArray(cfg.tools));
    assert.equal(cfg.tools!.length, 9);
    for (const t of [
      'comment_on_task',
      'set_priority',
      'set_due_date',
      'add_label',
      'close_task',
      'reopen_task',
      'add_dependency',
      'remove_dependency',
      'list_my_tasks',
    ]) {
      assert.ok(cfg.tools!.includes(t), `engineering must include ${t}`);
    }
  });
});

test('capability-pack bundled skills map 1:1 to available packs', async () => {
  const available = new Set(
    CAPABILITY_PACKS.filter((p) => !p.coming_soon).map((p) => p.slug),
  );
  await withClient(async (c) => {
    for (const packSlug of available) {
      const res = await c.query<{ agent_config: unknown }>(
        `SELECT agent_config FROM skills
         WHERE source = 'bundled' AND slug = $1`,
        [packSlug],
      );
      assert.equal(res.rows.length, 1, `${packSlug} should be seeded`);
      const cfg = res.rows[0]!.agent_config as { capability_packs?: string[] };
      assert.deepEqual(cfg.capability_packs, [packSlug]);
    }
  });
});

test('coming-soon capability packs are NOT seeded as bundled skills', async () => {
  const comingSoon = CAPABILITY_PACKS.filter((p) => p.coming_soon).map((p) => p.slug);
  await withClient(async (c) => {
    if (comingSoon.length === 0) return;
    const res = await c.query<{ slug: string }>(
      `SELECT slug FROM skills
       WHERE source = 'bundled' AND slug = ANY($1::text[])`,
      [comingSoon],
    );
    assert.equal(
      res.rows.length,
      0,
      `coming-soon packs must not ship as bundled skills: ${res.rows
        .map((r) => r.slug)
        .join(', ')}`,
    );
  });
});

// Task 14: marketing-campaign and sales-pipeline project_config tests removed —
// project_config column dropped from skills table (migration 0046).
// These workflow skills are retired in Task 16.
