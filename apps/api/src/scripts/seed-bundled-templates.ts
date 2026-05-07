/**
 * Idempotent seeder for bundled task templates. Re-run on deploy; upserts
 * by (source, COALESCE(org_id,''), slug).
 *
 *   pnpm tsx apps/api/src/scripts/seed-bundled-templates.ts
 */
import { fileURLToPath } from 'node:url';
import { db } from '../lib/db.js';
import { sql } from 'drizzle-orm';
import { BUNDLED_TEMPLATES } from '../lib/bundled-templates.js';

export async function seedBundledTemplates(
  opts: { silent?: boolean } = {},
): Promise<number> {
  const log = (msg: string) => {
    if (!opts.silent) console.log(msg);
  };
  log(`[seed-bundled-templates] Upserting ${BUNDLED_TEMPLATES.length} bundled templates`);

  for (const tpl of BUNDLED_TEMPLATES) {
    await db.execute(sql`
      INSERT INTO task_templates (
        id, org_id, source, slug, name, description, icon, version, tasks, is_deleted, usage_count
      ) VALUES (
        ${tpl.id},
        NULL,
        'bundled',
        ${tpl.slug},
        ${tpl.name},
        ${tpl.description},
        ${tpl.icon},
        ${tpl.version},
        ${JSON.stringify(tpl.tasks)}::jsonb,
        false,
        0
      )
      ON CONFLICT (source, (COALESCE(org_id,'')), slug) WHERE is_deleted = false
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        icon = EXCLUDED.icon,
        version = EXCLUDED.version,
        tasks = EXCLUDED.tasks,
        updated_at = now()
    `);
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
