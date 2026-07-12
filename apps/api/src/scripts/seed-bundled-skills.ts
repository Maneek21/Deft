/**
 * Phase 4 Task 4.3 — Seed the bundled skills (agent-only, one per capability pack).
 *
 * Task 16: project-workflow skills (engineering, marketing-campaign,
 * sales-pipeline) retired — 6 bundled skills remain.
 *
 * Idempotent: select-then-insert-or-update keyed on
 * (source='bundled', org_id IS NULL, slug, is_deleted=false). We can't use
 * ON CONFLICT against the partial unique index `skills_source_org_slug_idx`
 * because its key uses `COALESCE(org_id,'')` and Postgres's
 * infer_arbiter_indexes can't normalize the seeder's expression to match
 * (plancat.c:920). Re-running refreshes name/description/version/config in
 * place without breaking FKs held by agent_employee_skills.
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
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { skills, agentEmployeeSkills } from '@deft/db/schema';
import { BUNDLED_SKILLS } from '../lib/bundled-skills.js';

export async function seedBundledSkills(
  opts: { silent?: boolean } = {},
): Promise<number> {
  const log = (msg: string) => {
    if (!opts.silent) console.log(msg);
  };
  log(`[seed-bundled-skills] Upserting ${BUNDLED_SKILLS.length} bundled skills`);

  for (const skill of BUNDLED_SKILLS) {
    const [existing] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.source, 'bundled'),
          isNull(skills.org_id),
          eq(skills.slug, skill.slug),
          eq(skills.is_deleted, false),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(skills)
        .set({
          name: skill.name,
          description: skill.description,
          icon: skill.icon,
          version: skill.version,
          agent_config: skill.agent_config,
          updated_at: sql`now()`,
        })
        .where(eq(skills.id, existing.id));
    } else {
      await db.insert(skills).values({
        id: skill.id,
        org_id: null,
        source: 'bundled',
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        icon: skill.icon,
        version: skill.version,
        agent_config: skill.agent_config,
        is_deleted: false,
        usage_count: 0,
      });
    }
    log(`  upserted ${skill.slug}`);
  }

  const workspaceBundle = BUNDLED_SKILLS.find((skill) => skill.slug === 'deft-workspace');
  if (workspaceBundle) {
    const [workspaceRow] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(
        eq(skills.source, 'bundled'),
        isNull(skills.org_id),
        eq(skills.slug, workspaceBundle.slug),
        eq(skills.is_deleted, false),
      ))
      .limit(1);
    if (!workspaceRow) throw new Error('deft-workspace bundle was not available after seeding');
    const backfill = await db.execute(sql`
      INSERT INTO agent_employee_skills (
        agent_employee_id,
        skill_id,
        installed_at,
        installed_version
      )
      SELECT
        ae.id,
        ${workspaceRow.id},
        NOW(),
        ${workspaceBundle.version}
      FROM agent_employees ae
      WHERE ae.is_deleted = false
      ON CONFLICT (agent_employee_id, skill_id) DO UPDATE
        SET installed_version = EXCLUDED.installed_version
      RETURNING agent_employee_id
    `);
    const backfilledRows = ((backfill as any).rows ?? backfill) as unknown[];
    if (backfilledRows.length > 0) {
      log(`[seed-bundled-skills] synchronized deft-workspace for ${backfilledRows.length} existing agent employees`);
    }
  }

  // Clean up orphaned bundled rows whose slugs are no longer in BUNDLED_SKILLS.
  // This catches stale rows from previous seed runs (e.g. retired capability
  // packs like `web-browsing` / `shell-exec` after Phase 9). We delete junction
  // rows first so FK constraints don't block the skill row delete.
  const currentSlugs = BUNDLED_SKILLS.map((s) => s.slug);
  const orphanRows = await db
    .select({ id: skills.id, slug: skills.slug })
    .from(skills)
    .where(
      and(
        eq(skills.source, 'bundled'),
        isNull(skills.org_id),
        notInArray(skills.slug, currentSlugs),
      ),
    );

  if (orphanRows.length > 0) {
    const orphanIds = orphanRows.map((r) => r.id);
    await db
      .delete(agentEmployeeSkills)
      .where(inArray(agentEmployeeSkills.skill_id, orphanIds));
    await db.delete(skills).where(inArray(skills.id, orphanIds));
    log(
      `[seed-bundled-skills] cleaned ${orphanRows.length} orphan bundled skill rows: ${orphanRows
        .map((r) => r.slug)
        .join(', ')}`,
    );
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
