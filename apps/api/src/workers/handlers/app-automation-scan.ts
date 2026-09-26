import { runAppAutomationScan } from '../../lib/app-automation-runtime.js';
import type { JobData } from '../types.js';

export async function handleAppAutomationScan(job: JobData): Promise<void> {
  await runAppAutomationScan(new Date(), job.signal);
}
