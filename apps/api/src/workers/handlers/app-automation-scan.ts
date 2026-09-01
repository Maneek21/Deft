import { runAppAutomationScan } from '../../lib/app-automation-runtime.js';
import type { JobData } from '../types.js';

export async function handleAppAutomationScan(_job: JobData): Promise<void> {
  await runAppAutomationScan();
}
