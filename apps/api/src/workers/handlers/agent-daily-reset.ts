// Handler: agent-daily-reset — resets daily action + cost counters for all
// agent employees.
//
// Task 8.5 extends this handler to zero out `daily_cost_cents` alongside
// the existing `daily_action_count`. The counters live on
// `agent_employees`; the midnight UTC tick is scheduled by
// `job-scheduler.ts` via `ensureCronJob` + a 24h re-enqueue delay.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { agentEmployees } from '@deft/db/schema';
import { sql } from 'drizzle-orm';

export async function handleAgentDailyReset(_job: JobData): Promise<void> {
  console.log(
    '[agent-daily-reset] Resetting daily action + cost counters for all agent employees',
  );

  await db.update(agentEmployees).set({
    daily_action_count: 0,
    daily_cost_cents: 0,
    daily_action_reset_at: sql`now()`,
  });

  console.log(
    '[agent-daily-reset] Daily action + cost counters reset',
  );
}
