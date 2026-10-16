import { runAppAutomationScan } from '../../lib/app-automation-runtime.js';
import type { JobData } from '../types.js';

export async function handleAppAutomationScan(job: JobData): Promise<void> {
  await runAppAutomationScan(new Date(), job.signal,
    job.lockToken ? { id: job.id, lockToken: job.lockToken } : undefined);
}
