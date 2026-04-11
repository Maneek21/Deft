// Handler: people-graph — nightly People Graph processing for all orgs
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { orgs } from '@deft/db/schema';
import { runFullPeopleGraph } from '../../services/people-graph.js';

export async function handlePeopleGraph(job: JobData): Promise<void> {
  console.log(`[people-graph] Running nightly People Graph build (job ${job.id})`);

  const allOrgs = await db.select({ id: orgs.id, name: orgs.name }).from(orgs);

  for (const org of allOrgs) {
    try {
      await runFullPeopleGraph(org.id);
    } catch (err) {
      console.error(`[people-graph] Error processing org "${org.name}" (${org.id}):`, err);
      // Continue to next org — don't let one failure block all others
    }
  }

  console.log(`[people-graph] Nightly build complete for ${allOrgs.length} org(s)`);
}
