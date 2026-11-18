// Handler: burnout-detect — runs burnout detection across all orgs
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { orgs } from '@deft/db/schema';
import { detectBurnout } from '../../services/burnout-detector.js';

export async function handleBurnoutDetect(job: JobData): Promise<void> {
  console.log("[burnout-detect] Running burnout detection check (job <redacted>)");

  // Query all orgs
  const allOrgs = await db.select().from(orgs);

  for (const org of allOrgs) {
    try {
      await detectBurnout(org.id);
      console.log("[burnout-detect] Burnout detection completed for org \"<redacted>\"");
    } catch (err) {
      console.error("[burnout-detect] Error processing org <redacted>:"
      );
      // Continue to next org
    }
  }
}
