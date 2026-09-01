import { runAppAutomationFire } from '../../lib/app-automation-runtime.js';
import type { JobData } from '../types.js';

export async function handleAppAutomationFire(job: JobData): Promise<void> {
  await runAppAutomationFire(job);
}
