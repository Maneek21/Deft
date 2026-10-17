import { getAppRunRuntime } from '../../lib/app-run-runtime.js';
import { isAppResourceSyncSchedulerEnabled,isAppAttachmentBrokerEnabled } from '../../lib/env.js';
import { scanAppResourceSyncBindings } from '../../lib/app-resource-sync-scanner.js';
import type { JobData } from '../types.js';

export async function handleAppResourceSyncScan(job: JobData): Promise<void> {
  if (!isAppResourceSyncSchedulerEnabled()) return;
  if (!job.lockToken) throw new Error('Resource sync scan requires a leased delivery');
  const runtime = await getAppRunRuntime();
  const observation=isAppAttachmentBrokerEnabled()?await (await import('../../lib/app-attachment-runtime.js')).getAppAttachmentRuntime():undefined;
  const result = await scanAppResourceSyncBindings({ id: job.id,
    lockToken: job.lockToken, signal: job.signal }, runtime.resourceSyncAdmission,observation?.admission);
  console.info('[app-resource-sync] scan', result);
}
