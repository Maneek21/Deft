import { orgs } from '@deft/db/schema';
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { isStandupDue } from '../../lib/automation-schedule.js';
import { generateDailyStandup } from '../../lib/standup-automation.js';

export async function handleStandupGenerate(job: JobData): Promise<void> {
  const now = new Date();
  const allOrgs = await db.select({ id: orgs.id, name: orgs.name, timezone: orgs.timezone }).from(orgs);
  for (const org of allOrgs) {
    const due = isStandupDue(now, org.timezone || 'UTC');
    if (!due.due) continue;
    try {
      const result = await generateDailyStandup({ orgId: org.id, now });
      if (!result.alreadyExisted) {
        console.log(`[standup-generate] Delivered ${due.dateKey} standup for ${org.name} (job ${job.id})`);
      }
    } catch (error) {
      console.error(`[standup-generate] Failed for org ${org.id}:`, error);
    }
  }
}
