/**
 * Idempotent seeder for bundled task templates. Re-run on deploy; uses
 * a select-then-insert-or-update keyed on
 * (source='bundled', org_id IS NULL, slug, is_deleted=false). We can't use
 * ON CONFLICT against the partial unique index
 * `task_templates_source_org_slug_idx` because its key uses
 * `COALESCE(org_id,'')` and Postgres's infer_arbiter_indexes can't normalize
 * the seeder's expression to match (plancat.c:920).
 *
 *   pnpm tsx apps/api/src/scripts/seed-bundled-templates.ts
 */
import { fileURLToPath } from 'node:url';
import { db } from '../lib/db.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { taskTemplates } from '@deft/db/schema';
import { BUNDLED_TEMPLATES } from '../lib/bundled-templates.js';

export async function seedBundledTemplates(
  opts: { silent?: boolean } = {},
): Promise<number> {
  const log = (msg: string) => {
    if (!opts.silent) console.log(msg);
  };
  log(`[seed-bundled-templates] Upserting ${BUNDLED_TEMPLATES.length} bundled templates`);

  for (const tpl of BUNDLED_TEMPLATES) {
    const [existing] = await db
      .select({ id: taskTemplates.id })
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.source, 'bundled'),
          isNull(taskTemplates.org_id),
          eq(taskTemplates.slug, tpl.slug),
          eq(taskTemplates.is_deleted, false),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(taskTemplates)
        .set({
          name: tpl.name,
          description: tpl.description,
          icon: tpl.icon,
          version: tpl.version,
          tasks: tpl.tasks,
          updated_at: sql`now()`,
        })
        .where(eq(taskTemplates.id, existing.id));
    } else {
      await db.insert(taskTemplates).values({
        id: tpl.id,
        org_id: null,
        source: 'bundled',
        slug: tpl.slug,
        name: tpl.name,
        description: tpl.description,
        icon: tpl.icon,
        version: tpl.version,
        tasks: tpl.tasks,
        is_deleted: false,
        usage_count: 0,
      });
    }
  }
  log(`[seed-bundled-templates] Done`);
  return BUNDLED_TEMPLATES.length;
}

const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();
if (isMain) {
  seedBundledTemplates().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
