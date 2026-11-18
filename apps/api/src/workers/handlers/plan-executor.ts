import { logId } from '../../lib/log-metadata.js';
import type { JobData } from '../types.js';
import { executePlan } from '../../lib/agent-plans.js';

interface PlanExecutorData {
  planId: string;
  orgId: string;
  userId: string;
}

export async function handlePlanExecutor(job: JobData): Promise<void> {
  const { planId, orgId, userId } = job.data as PlanExecutorData;
  console.log(`[plan-executor] Executing plan ${logId(planId)} for org ${logId(orgId)}`);
  await executePlan(planId, orgId, userId);
}
