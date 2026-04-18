/**
 * Phase 4 Task 4.3 — Seed the 9 day-one bundled skills.
 *
 * Idempotent: uses the (source, COALESCE(org_id,''), slug) unique index
 * from migration 0035 as the conflict target. Re-running refreshes
 * name/description/version/config in place without breaking FKs held by
 * agent_employee_skills or project_skills.
 *
 * Run:
 *   pnpm --filter @deft/api exec tsx src/scripts/seed-bundled-skills.ts
 *   # or from repo root:
 *   pnpm tsx apps/api/src/scripts/seed-bundled-skills.ts
 *
 * Importable: `seedBundledSkills({ silent: true })` returns the row count.
 */
import { fileURLToPath } from 'node:url';
import { db } from '../lib/db.js';
import { sql } from 'drizzle-orm';
import { BUNDLED_SKILLS } from '../lib/bundled-skills.js';

export async function seedBundledSkills(
  opts: { silent?: boolean } = {},
): Promise<number> {
  const log = (msg: string) => {
    if (!opts.silent) console.log(msg);
  };
  log(`[seed-bundled-skills] Upserting ${BUNDLED_SKILLS.length} bundled skills`);

  for (const skill of BUNDLED_SKILLS) {
    // Raw SQL: the declarative Drizzle unique index can't model
    // COALESCE(org_id,''), so we target the partial unique index by name.
    await db.execute(sql`
      INSERT INTO skills (
        id, org_id, source, slug, name, description, icon, version,
        agent_config, is_deleted, usage_count
      ) VALUES (
        ${skill.id},
        NULL,
        'bundled',
        ${skill.slug},
        ${skill.name},
        ${skill.description},
        ${skill.icon},
        ${skill.version},
        ${JSON.stringify(skill.agent_config)}::jsonb,
        false,
        0
      )
      ON CONFLICT (source, (COALESCE(org_id,'')), slug) WHERE is_deleted = false
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        icon = EXCLUDED.icon,
        version = EXCLUDED.version,
        agent_config = EXCLUDED.agent_config,
        updated_at = now()
    `);
    log(`  upserted ${skill.slug}`);
  }

  log(`[seed-bundled-skills] Done. Seeded ${BUNDLED_SKILLS.length} skills.`);
  return BUNDLED_SKILLS.length;
}

// Run when invoked directly.
const entryPath = fileURLToPath(import.meta.url);
const invokedDirectly =
  process.argv[1] === entryPath ||
  process.argv[1]?.replace(/\\/g, '/') === entryPath.replace(/\\/g, '/');
if (invokedDirectly) {
  seedBundledSkills()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed-bundled-skills] FAILED:', err);
      process.exit(1);
    });
}
