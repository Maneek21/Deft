import type { JobData } from '../types.js';
import { expireStaleApprovalActions } from '../../lib/attention-maintenance.js';

export async function handleAttentionMaintenance(_job: JobData): Promise<void> {
  const result = await expireStaleApprovalActions();
  if (result.expired > 0) {
    console.log(`[attention-maintenance] Expired ${result.expired} stale approval action(s)`);
  }
}
