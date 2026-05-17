/**
 * Phase 1 Task 6 — Backfill Defty membership for all existing orgs.
 *
 * One-shot script that:
 *  1. Ensures every existing org has a Defty org_members row.
 *  2. Ensures every (org, human user) pair has a 1:1 DM with Defty so the
 *     conversation shows up in every user's sidebar without them having
 *     to invoke Defty manually.
 *
 * Idempotent — safe to re-run.
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/backfill-defty-membership.ts
 */

import { db } from '../lib/db.js';
import { orgs, orgMembers, users } from '@deft/db/schema';
import { and, eq, ne } from 'drizzle-orm';
import { ensureDeftyMembership, ensureDeftyDm } from '../lib/ensure-defty-membership.js';

async function main(): Promise<void> {
  const allOrgs = await db.select({ id: orgs.id, name: orgs.name }).from(orgs);
  console.log(`[backfill-defty] found ${allOrgs.length} orgs`);

  let membershipOk = 0;
  let membershipFailed = 0;
  for (const org of allOrgs) {
    try {
      await ensureDeftyMembership(org.id);
      membershipOk++;
    } catch (err) {
      console.error(`[backfill-defty] FAILED for org ${org.id} (${org.name}):`, err);
      membershipFailed++;
    }
  }

  console.log(`[backfill-defty] membership complete: ${membershipOk} ok, ${membershipFailed} failed`);

  // DM backfill — every (org, human user) pair gets a 1:1 DM with Defty.
  let dmOk = 0;
  let dmFailed = 0;
  for (const org of allOrgs) {
    // Fetch every active human member of this org. Exclude agents
    // (users.kind = 'agent' or users.is_agent = true).
    const humans = await db.select({ user_id: orgMembers.user_id })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.user_id))
      .where(and(
        eq(orgMembers.org_id, org.id),
        eq(orgMembers.is_active, true),
        ne(users.kind, 'agent'),
        eq(users.is_agent, false),
      ));

    for (const h of humans) {
      try {
        const spaceId = await ensureDeftyDm(org.id, h.user_id);
        console.log(`[backfill-defty-dm] org=${org.id} user=${h.user_id} space=${spaceId}`);
        dmOk++;
      } catch (err) {
        console.error(`[backfill-defty-dm] FAILED org=${org.id} user=${h.user_id}:`, err);
        dmFailed++;
      }
    }
  }

  console.log(`[backfill-defty-dm] complete: ${dmOk} ok, ${dmFailed} failed`);
  console.log(`[backfill-defty] summary: orgs=${allOrgs.length} membership_ok=${membershipOk} membership_failed=${membershipFailed} dm_ok=${dmOk} dm_failed=${dmFailed}`);
  process.exit(membershipFailed + dmFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill-defty] fatal', err);
  process.exit(1);
});
