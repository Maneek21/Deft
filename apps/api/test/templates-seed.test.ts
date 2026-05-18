/**
 * Phase 9 — seed-templates script verification tests.
 *
 * Asserts that the seed script produces exactly 8 well-formed first-party
 * templates and that every template meets the quality invariants laid out
 * in the plan:
 *
 *   1. idempotent — running twice keeps 8 rows
 *   2. valid semver in version
 *   3. all four markdown fields non-empty
 *   4. default_capability_packs references only real pack slugs
 *   5. default_trigger_subscriptions are reasonable trigger kinds
 *   6. role values are valid agentEmployeeRoleEnum entries
 *   7. alex-pm model == claude-sonnet-4-6
 *   8. on-call + cfo model == claude-opus-4-6
 *   9. community model == claude-haiku
 *  10. AGENTS.md contains `deft_platform_context` (platform_context rule)
 *  11. AGENTS.md contains `queued_for_approval` (approval rule)
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { seedTemplates, TEMPLATE_META } from '../src/scripts/seed-templates.js';
import { CAPABILITY_PACKS } from '../src/lib/capability-packs.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const VALID_ROLES = [
  'project_manager',
  'engineering_lead',
  'executive_assistant',
  'custom',
  // Task 61 — added so the 5 remapped first-party templates pass this check.
  'product_designer',
  'qa_engineer',
  'customer_success',
  'community_manager',
  'cfo',
  // Defty system template uses the 'superintendent' role.
  'superintendent',
];
const EXPECTED_SLUGS = [
  'defty',
  'alex-pm',
  'designer',
  'qa',
  'cs',
  'community',
  'on-call',
  'cfo',
  'devops',
];

// trigger_kind is free-form per plan §4.3 but we sanity-check with a prefix
// whitelist so a typo like `cron::standup` doesn't slip through.
const VALID_TRIGGER_PREFIXES = ['cron:', 'event:', 'webhook:'];

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
  // Run the seed twice to exercise the idempotency path.
  await seedTemplates({ silent: true });
  await seedTemplates({ silent: true });
});

test('seed produces exactly 9 first-party template rows', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ count: string }>(
      `SELECT count(*)::text FROM agent_employee_templates
       WHERE slug = ANY($1::text[])`,
      [EXPECTED_SLUGS],
    );
    assert.equal(res.rows[0]!.count, '9');
  });
});

test('all 9 templates have valid semver in version', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ slug: string; version: string }>(
      `SELECT slug, version FROM agent_employee_templates
       WHERE slug = ANY($1::text[])`,
      [EXPECTED_SLUGS],
    );
    for (const row of res.rows) {
      assert.match(row.version, SEMVER_RE, `${row.slug} has invalid version ${row.version}`);
    }
  });
});

test('all 9 templates have non-empty markdown fields', async () => {
  await withClient(async (c) => {
    const res = await c.query<{
      slug: string;
      soul_md: string;
      agents_md: string;
      user_md_template: string;
      tools_md: string;
    }>(
      `SELECT slug, soul_md, agents_md, user_md_template, tools_md
       FROM agent_employee_templates WHERE slug = ANY($1::text[])`,
      [EXPECTED_SLUGS],
    );
    for (const row of res.rows) {
      assert.ok(row.soul_md.length > 100, `${row.slug}.soul_md too short`);
      assert.ok(row.agents_md.length > 100, `${row.slug}.agents_md too short`);
      assert.ok(row.user_md_template.length > 50, `${row.slug}.user_md_template too short`);
      assert.ok(row.tools_md.length > 100, `${row.slug}.tools_md too short`);
    }
  });
});

test('all 9 templates declare valid default_capability_packs', async () => {
  const validSlugs = new Set(CAPABILITY_PACKS.map((p) => p.slug));
  await withClient(async (c) => {
    const res = await c.query<{ slug: string; default_capability_packs: string[] | null }>(
      `SELECT slug, default_capability_packs FROM agent_employee_templates
       WHERE slug = ANY($1::text[])`,
      [EXPECTED_SLUGS],
    );
    for (const row of res.rows) {
      assert.ok(
        Array.isArray(row.default_capability_packs) && row.default_capability_packs.length > 0,
        `${row.slug}.default_capability_packs must be non-empty`,
      );
      for (const packSlug of row.default_capability_packs!) {
        assert.ok(
          validSlugs.has(packSlug),
          `${row.slug} references unknown pack ${packSlug}`,
        );
      }
    }
  });
});

test('all 9 templates have valid default_trigger_subscriptions', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ slug: string; default_trigger_subscriptions: string[] | null }>(
      `SELECT slug, default_trigger_subscriptions FROM agent_employee_templates
       WHERE slug = ANY($1::text[])`,
      [EXPECTED_SLUGS],
    );
    for (const row of res.rows) {
      const subs = row.default_trigger_subscriptions ?? [];
      for (const sub of subs) {
        const ok = VALID_TRIGGER_PREFIXES.some((p) => sub.startsWith(p));
        assert.ok(ok, `${row.slug} has invalid trigger kind "${sub}"`);
      }
    }
  });
});

test('all 9 templates have role values from agentEmployeeRoleEnum', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ slug: string; role: string }>(
      `SELECT slug, role FROM agent_employee_templates
       WHERE slug = ANY($1::text[])`,
      [EXPECTED_SLUGS],
    );
    for (const row of res.rows) {
      assert.ok(
        VALID_ROLES.includes(row.role),
        `${row.slug} has invalid role ${row.role}`,
      );
    }
  });
});

test('alex-pm uses claude-sonnet-4-6', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ model_recommendation: string }>(
      `SELECT model_recommendation FROM agent_employee_templates WHERE slug = 'alex-pm'`,
    );
    assert.equal(res.rows[0]!.model_recommendation, 'anthropic/claude-sonnet-4-6');
  });
});

test('on-call and cfo use claude-opus-4-6', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ slug: string; model_recommendation: string }>(
      `SELECT slug, model_recommendation FROM agent_employee_templates
       WHERE slug IN ('on-call', 'cfo')`,
    );
    assert.equal(res.rows.length, 2);
    for (const row of res.rows) {
      assert.equal(
        row.model_recommendation,
        'anthropic/claude-opus-4-6',
        `${row.slug} should use opus`,
      );
    }
  });
});

test('community uses claude-haiku', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ model_recommendation: string }>(
      `SELECT model_recommendation FROM agent_employee_templates WHERE slug = 'community'`,
    );
    assert.equal(
      res.rows[0]!.model_recommendation,
      'anthropic/claude-haiku-4-5-20251001',
    );
  });
});

test('every AGENTS.md contains deft_platform_context instruction', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ slug: string; agents_md: string }>(
      `SELECT slug, agents_md FROM agent_employee_templates
       WHERE slug = ANY($1::text[])`,
      [EXPECTED_SLUGS],
    );
    for (const row of res.rows) {
      assert.ok(
        row.agents_md.includes('deft_platform_context'),
        `${row.slug}.agents_md must mention deft_platform_context`,
      );
    }
  });
});

test('every AGENTS.md contains queued_for_approval rule', async () => {
  await withClient(async (c) => {
    const res = await c.query<{ slug: string; agents_md: string }>(
      `SELECT slug, agents_md FROM agent_employee_templates
       WHERE slug = ANY($1::text[])`,
      [EXPECTED_SLUGS],
    );
    for (const row of res.rows) {
      assert.ok(
        row.agents_md.includes('queued_for_approval'),
        `${row.slug}.agents_md must mention queued_for_approval`,
      );
    }
  });
});

test('TEMPLATE_META has exactly 9 templates matching expected slugs', () => {
  assert.equal(TEMPLATE_META.length, 9);
  const slugs = TEMPLATE_META.map((t) => t.slug).sort();
  assert.deepEqual(slugs, [...EXPECTED_SLUGS].sort());
});
