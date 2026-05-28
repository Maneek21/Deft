/**
 * Canonical test fixtures with FIXED ids.
 *
 * The apps/api/test suite hardcodes specific org / user / agent ids that
 * match the original dev-database snapshot the tests were authored against
 * (e.g. task-update-trust, reminder-fire, people-graph, agent-employee-schema,
 * agent-tools-task-mutations). CI builds the DB fresh (`db:push-full` +
 * `db:seed:demo`), and seed-demo uses RANDOM ids — so these fixed-id rows are
 * absent and the dependent tests fail with FK violations or 0-row assertions.
 *
 * This script idempotently upserts exactly the fixed-id rows those tests
 * require. Run it in CI AFTER `db:seed:demo` and BEFORE the test suite.
 * Safe to run repeatedly: every insert is ON CONFLICT DO NOTHING and only
 * touches its own fixed ids — it never mutates seed-demo or real data.
 */
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/api/src/scripts -> repo root is four levels up.
loadEnv({ path: resolve(__dirname, '..', '..', '..', '..', '.env') });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[seed-test-fixtures] DATABASE_URL is required');
  process.exit(1);
}

// ── Fixed ids referenced by the apps/api/test suite ──────────────────────────
const ORG_A = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6'; // task-mutations, reminder-fire, people-graph, memory-extract
const ORG_B = '760b7a2b-a4ce-4b75-897c-c86d8e5d8047'; // task-update-trust
const USER_MANEEK = 'd4f985f6-6c37-4102-a7e8-32e22cfbe962'; // reminder-fire (reminder owner)
const USER_ALEXPM = '329fe0f6-39b3-4f66-8e6d-539ad7f4906a'; // people-graph (citing author) + Alex PM shadow user
const USER_PRIYA = '07308d0d-199a-479d-a2e3-fefdf7cdbac9'; // people-graph (cited author)
const EMP_ALEXPM = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633'; // agent-employee-schema "Alex PM seed row exists"

async function main() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    // Tests in apps/api/test login as maneek@test.com / test1234 (the repo
    // convention). Pre-hash here so the fixture is self-contained — neither
    // the demo seed nor any other script needs to know about it.
    const maneekHash = await bcrypt.hash('test1234', 12);

    await c.query(
      `INSERT INTO orgs (id, name, slug) VALUES
         ($1, 'Test Fixtures Org A', 'test-fixtures-org-a'),
         ($2, 'Test Fixtures Org B', 'test-fixtures-org-b')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B],
    );

    await c.query(
      `INSERT INTO users (id, name, email, password_hash, kind, is_agent, email_verified) VALUES
         ($1, 'Maneek (fixture)', 'maneek@test.com',         $4,   'human', false, true),
         ($2, 'Alex PM (fixture)', 'alexpm-fixture@test.local', NULL, 'agent', true,  true),
         ($3, 'Priya (fixture)',  'priya-fixture@test.local',  NULL, 'human', false, true)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash)`,
      [USER_MANEEK, USER_ALEXPM, USER_PRIYA, maneekHash],
    );

    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES
         (gen_random_uuid()::text, $1, $2, 'owner',  true),
         (gen_random_uuid()::text, $1, $3, 'member', true),
         (gen_random_uuid()::text, $1, $4, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_A, USER_MANEEK, USER_ALEXPM, USER_PRIYA],
    );

    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
       VALUES
         ($1, $2, $3, 'Alex PM', 'alex-pm-fixture', 'project_manager',
          'Test fixture project-manager agent.', 'standard', true, true, $4)
       ON CONFLICT (id) DO NOTHING`,
      [EMP_ALEXPM, ORG_A, USER_ALEXPM, USER_MANEEK],
    );

    // people-graph's detectRelationships() early-returns when the org has zero
    // people_interactions rows — before the wiki-citation knowledge_dependency
    // logic the people-graph tests exercise. Seed one so it proceeds.
    await c.query(
      `INSERT INTO people_interactions (id, org_id, user_a_id, user_b_id, interaction_count, recency_weighted_score)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 1, 1)
       ON CONFLICT DO NOTHING`,
      [ORG_A, USER_ALEXPM, USER_PRIYA],
    );

    // task-update-trust reuses "the first project in the org"; with none it
    // mints one led by its ephemeral user, then teardown deletes that user and
    // trips projects_lead_id_users_id_fk. Give ORG_B a reusable project.
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id)
       VALUES ('fixture-project-org-b', $1, 'Test Fixtures Project B', 'TFB', $2)
       ON CONFLICT (id) DO NOTHING`,
      [ORG_B, USER_MANEEK],
    );

    console.log('[seed-test-fixtures] canonical fixed-id fixtures ensured (orgs, users, members, Alex PM, interaction, project)');
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error('[seed-test-fixtures] failed:', err);
  process.exit(1);
});
