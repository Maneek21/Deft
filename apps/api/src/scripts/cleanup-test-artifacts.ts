#!/usr/bin/env tsx
/**
 * One-time cleanup of orphaned BYOA-audit test artifacts in the test org.
 * Idempotent — re-running deletes nothing if state is already clean.
 *
 * wikiPages uses soft delete (`is_deleted` boolean), so this script flips
 * `is_deleted=true` on matching rows that aren't already deleted. The
 * `eq(is_deleted, false)` filter is what makes the script idempotent on
 * re-run (already-deleted rows are skipped).
 *
 * Org filter is mandatory — the script never touches data outside the
 * fixed `TEST_ORG_ID` constant.
 *
 * Usage: pnpm exec tsx apps/api/src/scripts/cleanup-test-artifacts.ts
 */
import 'dotenv/config';
import { db } from '../lib/db.js';
import { wikiPages } from '@deft/db/schema';
import { and, or, eq, like, sql } from 'drizzle-orm';

const TEST_ORG_ID = '760b7a2b-a4ce-4b75-897c-c86d8e5d8047';

async function main() {
  const wikiResult = await db
    .update(wikiPages)
    .set({ is_deleted: true, updated_at: sql`now()` })
    .where(
      and(
        eq(wikiPages.org_id, TEST_ORG_ID),
        eq(wikiPages.is_deleted, false),
        or(
          like(wikiPages.title, 'Code Indentation%'),
          like(wikiPages.title, 'Code Style:%'),
          like(wikiPages.title, 'harness:%'),
          like(wikiPages.slug, 'wiki-audit-%'),
          like(wikiPages.slug, 'audit-note-%'),
          like(wikiPages.slug, 'harness-%'),
        ),
      ),
    )
    .returning({ slug: wikiPages.slug, title: wikiPages.title });

  console.log(`Deleted ${wikiResult.length} wiki pages:`);
  for (const r of wikiResult) console.log(`  - ${r.slug} (${r.title})`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
