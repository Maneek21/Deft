/**
 * Platform-bundle seed orchestrator — runs the three idempotent bundle seeders
 * that ship with every Deft install:
 *
 *   1. Bundled skills (the per-capability-pack agent-only skills + deft-mcp-client)
 *   2. Bundled task templates (first-party project starter templates)
 *   3. First-party employee templates (Defty, Alex PM, Designer, QA, …)
 *
 * Idempotent: every step upserts on the relevant slug-uniqueness index, so
 * re-runs are safe. Used by the root `pnpm db:seed` and `pnpm db:seed:demo`
 * scripts after the @deft/db prod-safe / demo seed runs.
 *
 * Run:
 *   pnpm --filter @deft/api exec tsx src/scripts/seed-platform-bundles.ts
 */
import { fileURLToPath } from 'node:url';
import { seedBundledSkills } from './seed-bundled-skills.js';
import { seedBundledTemplates } from './seed-bundled-templates.js';
import { seedTemplates } from './seed-templates.js';

export async function seedPlatformBundles(
  opts: { silent?: boolean } = {},
): Promise<{ skills: number; templates: number; employeeTemplates: number }> {
  const log = (msg: string) => {
    if (!opts.silent) console.log(msg);
  };

  log('[seed-platform-bundles] starting platform bundle seed');
  const skills = await seedBundledSkills({ silent: opts.silent });
  const templates = await seedBundledTemplates({ silent: opts.silent });
  const employeeTemplates = await seedTemplates({ silent: opts.silent });
  log(
    `[seed-platform-bundles] done — ${skills} skills, ${templates} task templates, ${employeeTemplates} employee templates`,
  );
  return { skills, templates, employeeTemplates };
}

// Run when invoked directly.
const entryPath = fileURLToPath(import.meta.url);
const invokedDirectly =
  process.argv[1] === entryPath ||
  process.argv[1]?.replace(/\\/g, '/') === entryPath.replace(/\\/g, '/');
if (invokedDirectly) {
  seedPlatformBundles()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed-platform-bundles] FAILED:', err);
      process.exit(1);
    });
}
