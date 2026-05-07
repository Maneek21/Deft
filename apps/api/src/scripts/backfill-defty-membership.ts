/**
 * Phase 1 Task 6 — Backfill Defty membership for all existing orgs.
 *
 * One-shot script that ensures every existing org has a Defty org_members row.
 * Run once after migration 0063 (agent-chat unification Phase 1).
 * Idempotent — safe to re-run.
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/backfill-defty-membership.ts
 */

import { db } from '../lib/db.js';
import { orgs } from '@deft/db/schema';
import { ensureDeftyMembership } from '../lib/ensure-defty-membership.js';

async function main(): Promise<void> {
  const allOrgs = await db.select({ id: orgs.id, name: orgs.name }).from(orgs);
  console.log(`[backfill-defty] found ${allOrgs.length} orgs`);

  let ok = 0;
  let failed = 0;
  for (const org of allOrgs) {
    try {
      await ensureDeftyMembership(org.id);
      ok++;
    } catch (err) {
      console.error(`[backfill-defty] FAILED for org ${org.id} (${org.name}):`, err);
      failed++;
    }
  }

  console.log(`[backfill-defty] complete: ${ok} ok, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill-defty] fatal', err);
  process.exit(1);
});
