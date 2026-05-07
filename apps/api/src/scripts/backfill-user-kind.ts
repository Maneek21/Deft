/**
 * Backfill script: users.kind for Phase 1 agent-chat unification.
 *
 * Sets kind='agent' for all rows with is_agent=true.
 * Sets kind='human' for all other rows (explicit backfill, not NULL).
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/backfill-user-kind.ts
 */

import { db } from '../lib/db.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Backfilling users.kind...');

  // Step 1: Set kind='agent' for all is_agent=true rows
  const agentResult = await db.execute(sql`
    UPDATE users
    SET kind = 'agent'
    WHERE is_agent = true
  `);
  console.log(`Updated ${agentResult.rowCount} agent rows to kind='agent'`);

  // Step 2: Set kind='human' for all other rows
  const humanResult = await db.execute(sql`
    UPDATE users
    SET kind = 'human'
    WHERE is_agent = false OR is_agent IS NULL
  `);
  console.log(`Updated ${humanResult.rowCount} human rows to kind='human'`);

  // Step 3: Verify no NULLs remain
  const nullCheck = await db.execute(sql`
    SELECT COUNT(*) as null_count FROM users WHERE kind IS NULL
  `);
  const nullCount = (nullCheck.rows[0] as { null_count: number }).null_count;
  if (nullCount > 0) {
    throw new Error(`Found ${nullCount} rows with kind=NULL after backfill`);
  }
  console.log('Verification passed: no NULL kinds');

  // Step 4: Verify consistency
  const inconsistent = await db.execute(sql`
    SELECT COUNT(*) as mismatch_count FROM users WHERE is_agent = true AND kind != 'agent'
  `);
  const mismatchCount = (inconsistent.rows[0] as { mismatch_count: number }).mismatch_count;
  if (mismatchCount > 0) {
    throw new Error(`Found ${mismatchCount} rows with is_agent=true but kind!='agent'`);
  }
  console.log('Consistency check passed: all is_agent=true rows have kind=\'agent\'');

  console.log('Backfill complete!');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
